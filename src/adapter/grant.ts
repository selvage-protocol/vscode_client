/**
 * The grant, read off a working copy.
 *
 * Everything decidable about a listing — which paths it may name, in what order it is written,
 * how a tree is derived from it, and where a walk over a folder stops — is in `src/bridge/`,
 * because all three clients have to agree on it. What is left here is the editor's half: walking
 * folders through `vscode.workspace.fs`, so a remote or virtual workspace is listed the way the
 * editor lists it, and resolving a room path back to the file it names. A read a *peer* asked for
 * in a folder of this machine is the one exception: it resolves and reads in one step, over Node's
 * own file system, because `vscode.workspace.fs` hands back a path rather than a descriptor and a
 * path can be swapped for a link between the walk and the read. A folder this process has no path
 * into keeps the window's own read (`readGrantedUri`), for the same reason.
 */

import * as vscode from 'vscode';
import { constants, existsSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import { MAX_GRANT_FILE_BYTES, hostPlatform, isGrantedPath, isIgnoredPath, walkListing } from '../bridge/index.ts';
import type {
  GrantRefusal,
  GrantedRead,
  IgnoreSource,
  ListingCut,
  ListingWalkResult,
  ListingWalkSource,
  WalkEntry,
} from '../bridge/index.ts';

/**
 * Which bound stopped a walk, as this adapter's consumers read it: the bridge's own `ListingCut`,
 * under the name they already import.
 */
export type GrantCut = ListingCut;

/** What one walk found: the listing, and the bound that left the folder short of it. */
export type GrantEnumeration = ListingWalkResult;

/** The ignore file any directory of a folder may state for its children. */
const IGNORE_FILE = '.gitignore';

/** The repository exclude a `.git` directory may state, under `info/`. */
const EXCLUDE_FILE = 'exclude';

/**
 * This window's file system, as the walk's seam: every read goes through `vscode.workspace.fs`,
 * so a remote or virtual workspace is read the way the editor reads it, an entry's own type is
 * reduced to what a listing carries (`kindOf`), and the platform is the one this window runs on,
 * named here rather than read by the walk.
 */
const GRANT_SOURCE: ListingWalkSource<vscode.Uri> = {
  platform: hostPlatform(),
  entries: (dir) => listDirectory(dir),
  ignoreText: (dir, entries) => readIgnoreFile(dir, IGNORE_FILE, entries),
  shareable: (dir, name) => isShareableFile(vscode.Uri.joinPath(dir, name)),
  child: (dir, name) => Promise.resolve(vscode.Uri.joinPath(dir, name)),
  rootIgnores: (dir, entries) => rootIgnores(dir, entries),
};

/**
 * The listing of a set of folders, as the file system held it when the walk ran: files only,
 * ascending by UTF-16 code unit, with the bound that stopped it short of the folder.
 *
 * The rule is the bridge's (`walkListing` in `src/bridge/listing-walk.ts`), which is the whole
 * of why this is the same walk in all three clients: the stops, the charge points and the cut
 * reason do not vary with the editor. What is here is the editor's half — `vscode.workspace.fs`
 * and the folder's own ignore sources.
 *
 * The listing is what this window shares by itself, so the folder's own ignore files narrow it
 * the way they narrow a `git status`: `<folder>/.git/info/exclude` and every `.gitignore` at or
 * below the folder. Nothing above the folder is read, which is a real difference from `git
 * status` — a folder shared from inside a repository does not honor the rules above it, because
 * the folder is the bound on what a host reads for the room.
 */
export async function enumerateGrant(
  folders: readonly vscode.WorkspaceFolder[],
): Promise<GrantEnumeration> {
  const roots = folders.map((folder) => ({ dir: folder.uri, name: folder.name }));
  return await walkListing(GRANT_SOURCE, roots);
}

/**
 * The ignore sources that govern everything under a shared folder: its `.git/info/exclude`, if
 * it has one, and the lowest precedence source there is — every `.gitignore` overrides it.
 *
 * A folder need not be a repository, `.git` may be a file rather than a directory (a linked
 * worktree, a submodule), and a read may fail; each of those is a folder with no repository
 * exclude, which is what an absent one means. A `.git` or an `info` that is a link to something
 * outside the folder is not read either: the entry's type is what says a name is a directory,
 * and a `stat` of the name would follow the link.
 *
 * `entries` is the root's own listing, which the walk that calls this has just read: the root is
 * not listed a second time for its excludes, and `.git` and `info` are different directories.
 */
async function rootIgnores(
  folder: vscode.Uri,
  entries: readonly WalkEntry[],
): Promise<IgnoreSource[]> {
  if (!holdsKind(entries, '.git', 'directory')) {
    return [];
  }
  const git = vscode.Uri.joinPath(folder, '.git');
  if (!(await entryHasKind(git, 'info', 'directory'))) {
    return [];
  }
  const text = await readIgnoreFile(vscode.Uri.joinPath(git, 'info'), EXCLUDE_FILE);
  return text === undefined ? [] : [{ dir: '', text }];
}

/**
 * The kind of one entry of this window's listing, as a listing carries it.
 *
 * `FileType` is a bit set, and a link to a directory carries the directory bit as well as its
 * own, so the link is tested first: a symbolic link is neither a file this host can vouch for
 * nor one it should follow, because it can point anywhere, including out of the folder being
 * shared. Exactly `FileType.File` is a file and exactly `FileType.Directory` is a directory;
 * every other type, and every bit set carrying more than the one bit, is an entry a listing
 * cannot name.
 */
function kindOf(type: vscode.FileType): WalkEntry['kind'] {
  if ((type & vscode.FileType.SymbolicLink) !== 0) {
    return 'other';
  }
  if (type === vscode.FileType.File) {
    return 'file';
  }
  return type === vscode.FileType.Directory ? 'directory' : 'other';
}

/** `dir`'s own listing as the entries a listing carries, or `undefined` when it cannot be read. */
async function listDirectory(dir: vscode.Uri): Promise<WalkEntry[] | undefined> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    return entries.map(([name, type]) => ({ name, kind: kindOf(type) }));
  } catch {
    return undefined;
  }
}

/** Whether a listing holds `name` as exactly `kind`, and not as a link or a bit-set of one. */
function holdsKind(entries: readonly WalkEntry[], name: string, kind: WalkEntry['kind']): boolean {
  return entries.some((entry) => entry.name === name && entry.kind === kind);
}

/** Whether `dir`'s own listing holds `name` as exactly `kind`. */
async function entryHasKind(
  dir: vscode.Uri,
  name: string,
  kind: WalkEntry['kind'],
): Promise<boolean> {
  const entries = await listDirectory(dir);
  return entries !== undefined && holdsKind(entries, name, kind);
}

/**
 * The text of the ignore file `name` at `dir`, or `undefined` when there is no ignore file this
 * window reads.
 *
 * `name` has to be an ordinary file by its *entry's* type in `dir`'s listing — an exact name with
 * no `SymbolicLink` bit and exactly `FileType.File` — before a byte is read. The entry type is
 * what `readDirectory` reports and is what this file already trusts for the walk and
 * `hasExactChild`; a `stat` of the name follows a link and reports its target instead. Without
 * this, a `.gitignore` that is a link to a file outside the shared folder is read as the folder's
 * own rule, and a `.git` that is a link to a repository elsewhere supplies its `info/exclude`: both
 * read out of the folder, which is the bound. A name that is not an ordinary file is not an error,
 * it is simply no ignore file. The window between that entry check and the read belongs to the
 * callers that read through the editor's own file system: `grantedFile`, which answers a URI the
 * editor resolves again, and a folder this process has no path into, which keeps that read for a
 * peer as well (`readGrantedUri`). A folder of this machine's own disk is not read this way for a
 * peer: that descent reads the same ignore files inside the directory descriptors it holds
 * (`ignoreInside`).
 *
 * `listing` is `dir`'s entries when the caller already holds them, so a walk does not read the
 * same directory twice.
 */
async function readIgnoreFile(
  dir: vscode.Uri,
  name: string,
  listing?: readonly WalkEntry[],
): Promise<string | undefined> {
  const entries = listing ?? (await listDirectory(dir));
  if (entries === undefined || !holdsKind(entries, name, 'file')) {
    return undefined;
  }
  try {
    return decodableText(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, name)));
  } catch {
    return undefined;
  }
}

/**
 * A regular file small enough for one `Y.Text`, which is all a document can be. This is the
 * half of the read's rule a walk can afford: a file's bytes are not read to decide whether to
 * name it, so a listing names files a session may carry and not only those it will — a file
 * whose name declares a format a session cannot carry is a separate rule, drawn from the name
 * alone (`isBinaryNamedPath`). A link reports its own type, so a link is not a file a listing
 * can name.
 *
 * This is the walk's own question, over the editor's view of the folder; the read a peer asked
 * for answers for itself, from the descriptor it reads through (`readLeaf`).
 */
export async function isShareableFile(uri: vscode.Uri): Promise<boolean> {
  try {
    const info = await vscode.workspace.fs.stat(uri);
    return info.type === vscode.FileType.File && info.size <= MAX_GRANT_FILE_BYTES;
  } catch {
    return false;
  }
}

/**
 * The room path a file URI is shared under, or `undefined` when it is not inside one of the
 * folders this session captured.
 *
 * The folders are the ones held at invite time, so a folder added to the window afterwards is
 * not quietly added to the grant. Containment is the whole test here: the excludes bound what a
 * session shares *by itself*, while a user opening a file in their own window is the user's own
 * act, and the two are not the same statement. Whether an opened file then reaches the room
 * is the bridge's own gate (`seed` in `src/bridge/bridge.ts`), not this function's.
 */
export function roomPathOf(
  folders: readonly vscode.WorkspaceFolder[],
  uri: vscode.Uri,
): string | undefined {
  for (const folder of folders) {
    const relative = relativeWithin(folder.uri.path, uri.path);
    if (relative === undefined || relative === '') {
      continue;
    }
    return folders.length > 1 ? `${folder.name}/${relative}` : relative;
  }
  return undefined;
}

/** `path` as it reads inside `base`, or `undefined` when it is not inside it. */
function relativeWithin(base: string, path: string): string | undefined {
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

/**
 * The file a room path names, or why this window has none for it.
 *
 * `not-granted` is the name: a path that escapes the folders this session captured, or one the
 * grant leaves out — by name (`isGrantedPath`) or by an ignore file of the folder's own. It is
 * kept apart from the rest so that the bridge can say nothing at all about such a path — a
 * refusal would confirm that the guess was worth making.
 */
export type GrantedFile =
  | { readonly uri: vscode.Uri }
  | { readonly refusal: GrantRefusal };

/**
 * The file a room path names, as a URI this window can open, or why it has none for it.
 *
 * This is the path a *peer* named, so it is checked rather than trusted: the excludes and the
 * segment rules of `isGrantedPath` apply to it, because a guest that guessed `.env` or
 * `.git/config` must not be able to ask for what the grant deliberately leaves out, and so does
 * the folder's own ignore layer, because what the listing does not carry is not this window's to
 * serve either. Every segment on the way to the file must be a plain directory of the folder as
 * well, so a guessed path that travels *through* a symbolic link is refused too — no such path
 * was listed, and what it would read is outside the folder.
 *
 * The answer is a URI, so the editor resolves the name again when it opens it, and a segment or
 * a leaf swapped for a link in between is that second resolution's to follow: the window is the
 * editor's own and not one this function can close. It is what the follow that opens a peer's
 * path in this window uses (`openRoomPath`). Handing a peer the *bytes* of a file is a different
 * shape, and it is `readGrantedText`, which never answers with a name.
 *
 * The order is the bound: the path is resolved first, so the ignore files this reads are the
 * ones of directories this window has already found to be plain directories of the folder.
 */
export async function grantedFile(
  folders: readonly vscode.WorkspaceFolder[],
  path: string,
): Promise<GrantedFile> {
  const resolved = withinFolders(folders, path);
  if (resolved === undefined || !isGrantedPath(resolved.relative)) {
    return { refusal: 'not-granted' };
  }
  const refusal = await resolutionRefusal(resolved.folder.uri, resolved.relative);
  if (refusal !== undefined) {
    return { refusal };
  }
  // A path that exists but is ignored is refused `not-granted`, the silent no an excluded name
  // gets: it says the grant leaves this out and not that a guess was worth making. A path that
  // does not exist was already refused `missing` above, because the name cannot be seen at all.
  const ignores = await governingIgnores(resolved.folder.uri, resolved.relative);
  if (isIgnoredPath(ignores, resolved.relative, false)) {
    return { refusal: 'not-granted' };
  }
  return { uri: vscode.Uri.joinPath(resolved.folder.uri, resolved.relative) };
}

/**
 * The ignore sources that govern a path inside a folder: `<folder>/.git/info/exclude`, then the
 * `.gitignore` of every directory from the folder down to the one holding the path.
 *
 * Lowest precedence first, and only directories the path's own resolution has already accepted,
 * so no step here travels through a link out of the folder; each ignore file is also read only
 * where its own parent lists it as an ordinary file (`readIgnoreFile`), so a `.gitignore` that is
 * itself a link out is not read either. This is `grantedFile`'s reading of them, on the way to a
 * URI the editor opens; a peer's read reads the same sources through the directory descriptors
 * it holds (`openInside`).
 */
async function governingIgnores(folder: vscode.Uri, relative: string): Promise<IgnoreSource[]> {
  // The folder's exclude is refused when the folder cannot be listed at all: a folder this
  // window cannot read has no repository exclude to hand, which is what an absent one means.
  const sources = await rootIgnores(folder, (await listDirectory(folder)) ?? []);
  const segments = relative.split('/');
  segments.pop();
  for (let depth = 0; depth <= segments.length; depth += 1) {
    const dir = segments.slice(0, depth).join('/');
    const where = dir === '' ? folder : vscode.Uri.joinPath(folder, dir);
    const text = await readIgnoreFile(where, '.gitignore');
    if (text !== undefined) {
      sources.push({ dir, text });
    }
  }
  return sources;
}

/**
 * Why a room path does not name a file of the folder, walking it one segment at a time, or
 * `undefined` when every step is where it should be.
 *
 * `vscode.workspace.fs` has no `realpath`, and `Uri.joinPath` resolves nothing: it joins strings.
 * A path that travels through a symbolic link therefore lands on a real file somewhere else
 * entirely, while the leaf's own `stat` reports an ordinary file. A link's own `stat` reports the
 * `SymbolicLink` bit, so the path is walked one segment at a time and every segment has to be
 * exactly a directory. The leaf is left to the caller, which hands the editor the URI to open.
 *
 * Each segment also has to be spelled as the directory lists it: on a case-insensitive mount
 * `.GIT` stats as a directory when only `.git` is on disk, and the grant excludes only the
 * spelling it names. An exact entry check refuses the folded variant before it resolves, and
 * what it refuses is a name this window cannot see, which is `missing`.
 *
 * What this cannot see, because the API does not expose it: a segment that is followed by the
 * editor's own file system without reporting a link (a mount point, a provider that resolves
 * links itself), and a link put in place between this walk and the editor's own open of the URI
 * it answers with.
 */
async function resolutionRefusal(
  folder: vscode.Uri,
  relative: string,
): Promise<GrantRefusal | undefined> {
  const segments = relative.split('/');
  let head = folder;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? '';
    if (!(await hasExactChild(head, segment))) {
      return 'missing';
    }
    head = vscode.Uri.joinPath(head, segment);
    if (index < segments.length - 1 && !(await isPlainDirectory(head))) {
      return 'not-a-file';
    }
  }
  return undefined;
}

async function hasExactChild(dir: vscode.Uri, name: string): Promise<boolean> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    return entries.some(([entry]) => entry === name);
  } catch {
    return false;
  }
}

async function isPlainDirectory(uri: vscode.Uri): Promise<boolean> {
  try {
    return (await vscode.workspace.fs.stat(uri)).type === vscode.FileType.Directory;
  } catch {
    return false;
  }
}

/** A room path split into the captured folder it belongs to and its path inside it. */
function withinFolders(
  folders: readonly vscode.WorkspaceFolder[],
  path: string,
): { folder: vscode.WorkspaceFolder; relative: string } | undefined {
  if (folders.length === 0 || path === '') {
    return undefined;
  }
  if (folders.length === 1) {
    const only = folders[0];
    return only === undefined ? undefined : { folder: only, relative: path };
  }
  const slash = path.indexOf('/');
  const name = slash === -1 ? path : path.slice(0, slash);
  const folder = folders.find((candidate) => candidate.name === name);
  if (folder === undefined || slash === -1) {
    return undefined;
  }
  return { folder, relative: path.slice(slash + 1) };
}

/**
 * `O_NOFOLLOW` where the platform has it, so a name that is a link is refused by the open
 * itself rather than by an `lstat` of the same name that a rename can get behind. Windows has
 * none, and there the walk by name (`walkByName`) is the only thing that refuses a link.
 */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

/** The shared folder itself: a link at the root *is* the folder the front-end named. */
const FOLDER = constants.O_RDONLY | constants.O_DIRECTORY;

/** A step inside it: a directory, and never a link to one. */
const STEP = FOLDER | NO_FOLLOW;

/** A leaf: the file itself, and never a link to one. */
const LEAF = constants.O_RDONLY | NO_FOLLOW;

/**
 * Whether this process takes each step inside the descriptor of the directory before it.
 *
 * Linux publishes a process's open descriptors under `/proc/self/fd`, and a name under one of those
 * is looked up in the directory that descriptor holds rather than through the name again. Node
 * offers no other way to name the child of a directory that is already open, so a platform without
 * it takes the steps by name and checks each one (`walkByName`), which is what macOS and Windows do
 * and what this host cannot reach: `/proc` is where the descent needs it. Passing `value` sets the
 * reading and answers with it, so a test can read the way those platforms read.
 */
const steps = { pinned: existsSync('/proc/self/fd') };

export function pinnedSteps(value?: boolean): boolean {
  if (value !== undefined) {
    steps.pinned = value;
  }
  return steps.pinned;
}

/** A refusal, shaped the way the bridge reads one. */
type Refused = { readonly kind: 'refused'; readonly cause: GrantRefusal };

function refused(cause: GrantRefusal): Refused {
  return { kind: 'refused', cause };
}

/**
 * The directory holding the path's leaf, and the ignore sources that govern the path: the folder
 * itself where the platform can address a directory it already holds, its path where it cannot.
 */
type OpenedFolder =
  | {
      readonly handle: FileHandle;
      readonly sources: readonly IgnoreSource[];
      readonly entries: readonly WalkEntry[] | undefined;
    }
  | Refused;

/** The same, for a platform that cannot address a directory that is already open. */
type NamedFolder =
  | {
      readonly path: string;
      readonly sources: readonly IgnoreSource[];
      readonly entries: readonly WalkEntry[] | undefined;
    }
  | Refused;

/**
 * A file's text, read for a peer, or why this window will not serve it.
 *
 * A folder of this machine is the one place a host reads its own disk because someone else asked
 * rather than because the person at the machine acted, so the path is not resolved and then used:
 * every component is opened with `O_NOFOLLOW` inside the descriptor of the component before it,
 * every name has to be an entry of the directory that holds it spelled exactly as that directory
 * lists it, and the bytes come from the descriptor whose type and size were read. A name checked
 * and then resolved again is two readings of one name — a directory that is a plain directory when
 * it is checked is a link somewhere else by the time the next name is resolved, and the file
 * system reports neither reading to the other — which is how a path a walk refused is read out of
 * the folder on the peer's behalf.
 *
 * The rules are `grantedFile`'s, in the same order, because the answer a peer gets has to be the
 * one the listing agrees with: `isGrantedPath`'s exclusions and segment rules, then the folder's
 * own ignore files, read from the directories this descent itself accepted, so a `.gitignore` or a
 * `.git` that is a link out is not read either, then the leaf's type, its size, and its bytes.
 *
 * What is left, and it is not a link: a segment that is a *mount point* rather than a link. The
 * file system reports it as a directory, so a step through one is a step through a directory, and
 * only comparing the file systems' identities (`st_dev`) at each step would see it. Planting one
 * takes `CAP_SYS_ADMIN`.
 *
 * A folder this process has no path into is the one case with no component to resolve at all: a
 * virtual workspace, a container, a repository the window reads through the editor. Its read is the
 * window's own (`readGrantedUri`), behind the same rules and answering the same words.
 */
export async function readGrantedText(
  folders: readonly vscode.WorkspaceFolder[],
  path: string,
): Promise<GrantedRead> {
  const resolved = withinFolders(folders, path);
  if (resolved === undefined || !isGrantedPath(resolved.relative)) {
    return refused('not-granted');
  }
  const root = localPath(resolved.folder);
  if (root === undefined) {
    // The rules and the refusals in front of the read below are `grantedFile`'s own, asked of the
    // same path, so the two halves cannot disagree about what the grant shares.
    const found = await grantedFile(folders, path);
    return 'refusal' in found ? refused(found.refusal) : await readGrantedUri(found.uri);
  }
  const segments = resolved.relative.split('/');
  const leaf = segments.pop();
  if (leaf === undefined) {
    return refused('not-granted');
  }
  if (pinnedSteps()) {
    const directory = await openInside(root, segments);
    if ('kind' in directory) {
      return directory;
    }
    try {
      if (!holdsName(directory.entries, leaf)) {
        return refused('missing');
      }
      return await readLeaf(inside(directory.handle, leaf), directory.sources, resolved.relative);
    } finally {
      await directory.handle.close().catch(() => undefined);
    }
  }
  const directory = await walkByName(root, segments);
  if ('kind' in directory) {
    return directory;
  }
  if (!holdsName(directory.entries, leaf)) {
    return refused('missing');
  }
  return await readLeaf(join(directory.path, leaf), directory.sources, resolved.relative);
}

/**
 * The folder on this extension host's own disk, or `undefined` when it is not a `file:` folder.
 *
 * Only a `file:` folder has a descriptor to descend: a virtual scheme is the editor's own view of
 * a store this process cannot resolve a component of, and every rule of the descent is about
 * resolving components. Such a folder is still listed, and its read is the window's own
 * (`readGrantedUri`) rather than this process's.
 */
function localPath(folder: vscode.WorkspaceFolder): string | undefined {
  return folder.uri.scheme === 'file' ? folder.uri.fsPath : undefined;
}

/**
 * A granted file's text over the window's own file system, or why this window will not serve it.
 *
 * A folder this process has no path into — `vscode-vfs://`, a container, a repository the window
 * reads through the editor — has no component to resolve, and `vscode.workspace.fs` hands back a
 * path rather than a descriptor to pin a step inside, so its read is the window's own: the name is
 * `stat`ed and then read. A link planted in the window between those two readings is followed, and
 * an ordinary file swapped in there is served; that is the provider's window rather than this
 * adapter's, because the store is not this machine's disk, which is the one a concurrent local
 * writer can reach into. The grant's checks still bound the read — they are `grantedFile`'s, asked
 * of the same path, and the folder's own ignore files are read for it — and the words are the same:
 * a name the window has not got is `missing`, one that is not a plain file is `not-a-file`, and the
 * bound and the text decoder are what the descriptor read applies as well.
 */
async function readGrantedUri(uri: vscode.Uri): Promise<GrantedRead> {
  let info: vscode.FileStat;
  try {
    info = await vscode.workspace.fs.stat(uri);
  } catch {
    return refused('missing');
  }
  if (info.type !== vscode.FileType.File) {
    return refused('not-a-file');
  }
  if (info.size > MAX_GRANT_FILE_BYTES) {
    return refused('too-large');
  }
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch {
    return refused('missing');
  }
  const text = decodableText(bytes);
  return text === undefined ? refused('binary') : { kind: 'text', text };
}

/** A name inside a directory that is already open: `/proc/self/fd/<fd>` is that directory. */
function inside(directory: FileHandle, name = ''): string {
  return join('/proc/self/fd', String(directory.fd), name);
}

/**
 * Why a step could not be taken.
 *
 * A name that is not there, or one this window cannot open, is `missing`, which is the shared
 * vocabulary's own word for a file that is absent, deleted since the listing, or unreadable;
 * anything else the file system refuses — a link where a directory has to be, a name that is not
 * one — is `not-a-file`.
 */
function stepRefusal(error: unknown): GrantRefusal {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' ? 'missing' : 'not-a-file';
}

/**
 * The kind of one entry a directory's own listing carries. A link is tested first, whatever it
 * points at: what a step is about to resolve must be a directory of this folder, and what a leaf
 * must be is a plain file.
 */
function entryKind(entry: Dirent): WalkEntry['kind'] {
  if (entry.isSymbolicLink()) {
    return 'other';
  }
  if (entry.isFile()) {
    return 'file';
  }
  return entry.isDirectory() ? 'directory' : 'other';
}

/** A directory's own entries, read through its descriptor, or `undefined` when it cannot be read. */
async function listInside(directory: FileHandle): Promise<WalkEntry[] | undefined> {
  const entries = await readdir(inside(directory), { withFileTypes: true }).catch(() => undefined);
  return entries?.map((entry) => ({ name: entry.name, kind: entryKind(entry) }));
}

/** The same for a directory named by path: the platform that cannot pin a step reads by name. */
async function listByName(dir: string): Promise<WalkEntry[] | undefined> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => undefined);
  return entries?.map((entry) => ({ name: entry.name, kind: entryKind(entry) }));
}

/**
 * Whether a listing carries `name` exactly as the path spelled it, entry name and nothing else.
 *
 * A file system that folds case or ignores Unicode normalization resolves a name no entry
 * carries, while the ignore check above ran on the spelling the peer sent, so without this a path
 * could pass that check and then open the file it meant to leave out. A directory this window
 * cannot list carries nothing, so a name under one is `missing`, the same refusal a name the
 * folder does not hold gets.
 */
function holdsName(entries: readonly WalkEntry[] | undefined, name: string): boolean {
  return entries?.some((entry) => entry.name === name) ?? false;
}

/**
 * The bytes at `path` as an ignore file's text, or `undefined` when they are not one this window
 * reads.
 *
 * The open is `O_NOFOLLOW` where the platform has it, and the type comes from the descriptor the
 * open returned rather than from the name again, so the type and the bytes are one object's.
 */
async function readIgnoreText(path: string): Promise<string | undefined> {
  const handle = await open(path, LEAF).catch(() => undefined);
  if (handle === undefined) {
    return undefined;
  }
  try {
    const info = await handle.stat().catch(() => undefined);
    if (info === undefined || !info.isFile()) {
      return undefined;
    }
    const bytes = await handle.readFile().catch(() => undefined);
    return bytes === undefined ? undefined : decodableText(bytes);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * The text of the ignore file `name` inside `dir`, or `undefined` when the directory holds no
 * ignore file this window reads.
 *
 * `name` counts only where that directory's own listing reports it as an ordinary file: a link, a
 * directory and a FIFO are each no ignore file, and a link is exactly what a `stat` of the name
 * follows. Both the listing and the read name the child through `dir`'s descriptor, so neither
 * resolves a name through a directory anywhere but the one the path's resolution found and
 * accepted.
 */
async function ignoreInside(
  dir: FileHandle,
  name: string,
  listing?: readonly WalkEntry[],
): Promise<string | undefined> {
  const entries = listing ?? (await listInside(dir));
  if (entries === undefined || !holdsKind(entries, name, 'file')) {
    return undefined;
  }
  return readIgnoreText(inside(dir, name));
}

/**
 * The same for a platform that cannot address a directory that is already open. The listing and
 * the read are two resolutions of one name, so a name swapped for a link between them is
 * followed: that is `walkByName`'s window and not a second one.
 */
async function ignoreByName(
  dir: string,
  name: string,
  listing?: readonly WalkEntry[],
): Promise<string | undefined> {
  const entries = listing ?? (await listByName(dir));
  if (entries === undefined || !holdsKind(entries, name, 'file')) {
    return undefined;
  }
  return readIgnoreText(join(dir, name));
}

/**
 * `<root>/.git/info/exclude`, read inside the root's own descriptor, or `undefined` when the
 * folder has no repository exclude — which is what an absent one means, not a fault.
 *
 * `.git` and `info` are opened with `O_NOFOLLOW`, so a `.git` that is a link to a repository
 * elsewhere is refused where a directory has to be rather than read as this folder's repository,
 * and each name also has to be an entry of the directory that holds it, spelled exactly as that
 * directory lists it: that is the check `excludeByName` makes on its side, and it keeps the listing
 * the read already holds authoritative, so a `.git` such a listing never carried is not read even
 * if it appears in the folder before the open.
 *
 * A platform that cannot address an open directory does not come here; it goes through
 * `excludeByName`, which reads the same rule off the root's listing.
 */
async function excludeInside(
  directory: FileHandle,
  entries: readonly WalkEntry[] | undefined,
): Promise<string | undefined> {
  if (!holdsKind(entries ?? [], '.git', 'directory')) {
    return undefined;
  }
  const git = await open(inside(directory, '.git'), STEP).catch(() => undefined);
  if (git === undefined) {
    return undefined;
  }
  try {
    if (!holdsKind((await listInside(git)) ?? [], 'info', 'directory')) {
      return undefined;
    }
    const info = await open(inside(git, 'info'), STEP).catch(() => undefined);
    if (info === undefined) {
      return undefined;
    }
    try {
      return await ignoreInside(info, EXCLUDE_FILE);
    } finally {
      await info.close().catch(() => undefined);
    }
  } finally {
    await git.close().catch(() => undefined);
  }
}

/** The same rule read off the root's entries, for a platform that cannot address an open directory. */
async function excludeByName(root: string, entries: readonly WalkEntry[]): Promise<IgnoreSource[]> {
  if (!holdsKind(entries, '.git', 'directory')) {
    return [];
  }
  const git = join(root, '.git');
  const info = await listByName(git);
  if (info === undefined || !holdsKind(info, 'info', 'directory')) {
    return [];
  }
  const text = await ignoreByName(join(git, 'info'), EXCLUDE_FILE);
  return text === undefined ? [] : [{ dir: '', text }];
}

/**
 * The directory holding the path's leaf, opened one step at a time *inside the descriptor of the
 * step before it*, and the ignore sources that govern the path: the repository exclude at the
 * root first, then the `.gitignore` of every directory from the root down to that one, lowest
 * precedence first.
 *
 * A step is opened `O_NOFOLLOW` and has to be an entry of the directory it is opened in, spelled
 * exactly as that directory lists it (`holdsName`), so a link is refused where a directory has to
 * be — by the open itself and not by a check of the same name — and a name the file system would
 * resolve under another spelling is `missing`. The listing that decides the name is the same one
 * the directory's own ignore file is read from, so a directory is not listed twice.
 */
async function openInside(root: string, segments: readonly string[]): Promise<OpenedFolder> {
  const folder = await open(root, FOLDER).catch((error: unknown) => refused(stepRefusal(error)));
  if ('kind' in folder) {
    return folder;
  }
  let directory = folder;
  let relative = '';
  const sources: IgnoreSource[] = [];
  // The root is listed once, before its exclude is read: the entries are what says whether it holds
  // a `.git` directory, and they are the same ones its own ignore file is read from.
  let entries = await listInside(directory);
  const exclude = await excludeInside(directory, entries);
  if (exclude !== undefined) {
    sources.push({ dir: '', text: exclude });
  }
  for (let depth = 0; ; depth += 1) {
    const own = await ignoreInside(directory, IGNORE_FILE, entries);
    if (own !== undefined) {
      sources.push({ dir: relative, text: own });
    }
    if (depth === segments.length) {
      return { handle: directory, sources, entries };
    }
    const segment = segments[depth] ?? '';
    if (!holdsName(entries, segment)) {
      await directory.close().catch(() => undefined);
      return refused('missing');
    }
    const next = await open(inside(directory, segment), STEP).catch((error: unknown) =>
      refused(stepRefusal(error)),
    );
    await directory.close().catch(() => undefined);
    if ('kind' in next) {
      return next;
    }
    directory = next;
    relative = relative === '' ? segment : `${relative}/${segment}`;
    entries = await listInside(directory);
  }
}

/**
 * The same walk by name, for a platform that cannot address a directory that is already open:
 * every step has to be a plain directory of the folder, spelled exactly as the directory holding
 * it lists it, before the name is resolved, and the ignore files are listed and read by name. The
 * check and the resolution of the step after it are two readings of one name — see
 * `readGrantedText` — so what a link planted between them reaches is the residual, and entering it
 * takes a concurrent local writer.
 */
async function walkByName(root: string, segments: readonly string[]): Promise<NamedFolder> {
  // The root is listed once: `excludeByName` reads the repository exclude off the entries held
  // here rather than listing the folder again for itself.
  const listed = await listByName(root);
  const sources: IgnoreSource[] = [...(await excludeByName(root, listed ?? []))];
  let head = root;
  let relative = '';
  for (let depth = 0; ; depth += 1) {
    const entries = depth === 0 ? listed : await listByName(head);
    const own = await ignoreByName(head, IGNORE_FILE, entries);
    if (own !== undefined) {
      sources.push({ dir: relative, text: own });
    }
    if (depth === segments.length) {
      return { path: head, sources, entries };
    }
    const segment = segments[depth] ?? '';
    if (!holdsName(entries, segment)) {
      return refused('missing');
    }
    head = join(head, segment);
    const info = await lstat(head).catch(() => undefined);
    if (info === undefined) {
      return refused('missing');
    }
    if (!info.isDirectory()) {
      return refused('not-a-file');
    }
    relative = relative === '' ? segment : `${relative}/${segment}`;
  }
}

/**
 * A leaf's text, or why this window will not serve it.
 *
 * The type and the size are read by name and then again through the descriptor the bytes are read
 * from, so the bytes are the object that was measured, and that object is a plain file of this
 * folder rather than a link out of it. The open resolves the name a second time, so an ordinary
 * file that takes the name's place after the lookup is served — its own type, size and bytes, read
 * through the descriptor that measured it — which is a different file of the same directory and not
 * an escape. A document is one `Y.Text` and a room carries text, so a NUL byte or a
 * byte sequence that is not valid UTF-8 is not something to put into one (`decodableText`), and a
 * plain file over `MAX_GRANT_FILE_BYTES` is more than a session will carry.
 *
 * The name is read once before the ignore rule as well, which is the order the caller's answers
 * already have: a path that does not exist is `missing` whatever the ignore files say about the
 * name, and one that exists and they leave out is `not-granted`, the silent no an excluded name
 * gets, rather than a refusal that says the guess was worth making.
 */
async function readLeaf(
  name: string,
  ignores: readonly IgnoreSource[],
  path: string,
): Promise<GrantedRead> {
  const info = await lstat(name).catch(() => undefined);
  if (info === undefined) {
    return refused('missing');
  }
  if (isIgnoredPath(ignores, path, false)) {
    return refused('not-granted');
  }
  if (!info.isFile()) {
    return refused('not-a-file');
  }
  if (info.size > MAX_GRANT_FILE_BYTES) {
    return refused('too-large');
  }
  const handle = await open(name, LEAF).catch((error: unknown) => refused(stepRefusal(error)));
  if ('kind' in handle) {
    return handle;
  }
  try {
    const opened = await handle.stat().catch(() => undefined);
    if (opened === undefined) {
      return refused('missing');
    }
    if (!opened.isFile()) {
      return refused('not-a-file');
    }
    if (opened.size > MAX_GRANT_FILE_BYTES) {
      return refused('too-large');
    }
    const bytes = await handle.readFile().catch(() => undefined);
    if (bytes === undefined) {
      return refused('missing');
    }
    const text = decodableText(bytes);
    return text === undefined ? refused('binary') : { kind: 'text', text };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * A file's text, or `undefined` when the bytes are not text a session can carry: a NUL byte or
 * a byte sequence that is not valid UTF-8. A binary turned into a `Y.Text` would be corrupted
 * into replacement characters, and the room's own save policy would write it back over the
 * host's file.
 */
export function decodableText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) {
    return undefined;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
