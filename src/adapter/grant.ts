/**
 * The grant, read off a working copy.
 *
 * Everything decidable about a listing — which paths it may name, in what order it is written,
 * how a tree is derived from it, and where a walk over a folder stops — is in `src/bridge/`,
 * because all three clients have to agree on it. What is left here is the editor's half: walking
 * folders through `vscode.workspace.fs`, so a remote or virtual workspace is read the way the
 * editor reads it, and resolving a room path back to the file it names.
 */

import * as vscode from 'vscode';

import { MAX_GRANT_FILE_BYTES, isGrantedPath, isIgnoredPath, walkListing } from '../bridge/index.ts';
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
 * so a remote or virtual workspace is read the way the editor reads it, and an entry's own type
 * is reduced to what a listing carries (`kindOf`).
 */
const GRANT_SOURCE: ListingWalkSource<vscode.Uri> = {
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
 * it is simply no ignore file. The window between that entry check and the read is the leaf read's
 * own stated residual — `vscode.workspace.fs` exposes no `realpath` — and not a second one.
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
 * alone (`isBinaryNamedPath`).
 */
export async function isShareableFile(uri: vscode.Uri): Promise<boolean> {
  const info = await shareableInfo(uri);
  return typeof info !== 'string';
}

/**
 * The leaf's own stat when it is the shape a session will carry, or the cause it is not.
 * One rule in two shapes: `isShareableFile` is the yes-or-no of it, a read wants the reason.
 */
async function shareableInfo(uri: vscode.Uri): Promise<vscode.FileStat | GrantRefusal> {
  let info: vscode.FileStat;
  try {
    info = await vscode.workspace.fs.stat(uri);
  } catch {
    return 'missing';
  }
  if (info.type !== vscode.FileType.File) {
    return 'not-a-file';
  }
  return info.size > MAX_GRANT_FILE_BYTES ? 'too-large' : info;
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
 * The file a room path names, or why this window has none for it.
 *
 * This is the path a *peer* named, so it is checked rather than trusted: the excludes and the
 * segment rules of `isGrantedPath` apply to it, because a guest that guessed `.env` or
 * `.git/config` must not be able to ask for what the grant deliberately leaves out, and so does
 * the folder's own ignore layer, because what the listing does not carry is not this window's to
 * serve either. Every segment on the way to the file must be a plain directory of the folder as
 * well, so a guessed path that travels *through* a symbolic link is refused too — no such path
 * was listed, and what it would read is outside the folder.
 *
 * The order is the bound: the path is resolved first, so the ignore files this reads are the
 * ones of directories this window has already found to be plain directories of the folder. A
 * directory swapped for a link between that resolution and these reads is the window the leaf's
 * own read has, and is the same stated residual rather than a second one.
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
 * itself a link out is not read either.
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
 * exactly a directory. The leaf is left to the caller, which reads it only as a plain file.
 *
 * Each segment also has to be spelled as the directory lists it: on a case-insensitive mount
 * `.GIT` stats as a directory when only `.git` is on disk, and the grant excludes only the
 * spelling it names. An exact entry check refuses the folded variant before it resolves, and
 * what it refuses is a name this window cannot see, which is `missing`.
 *
 * What this cannot see, because the API does not expose it: a segment that is followed by the
 * editor's own file system without reporting a link (a mount point, a provider that resolves
 * links itself), and a link put in place between this walk and the read that follows it.
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
 * A file's text, or why a session cannot carry it.
 *
 * The size and type the listing already asked of this file, then the bytes themselves: a
 * document is one `Y.Text`, and a room carries text, so a NUL byte or a byte sequence that is
 * not valid UTF-8 is not something to put into one. The listing deliberately stays with the
 * first half — a walk that read every file to decide whether to name it would read a whole
 * project to publish a name list, and the host's own disk is not read for a peer until the
 * peer asks (`DESIGN.md` §4.2) — so a binary can be listed and is refused here.
 */
export async function grantedText(uri: vscode.Uri): Promise<GrantedRead> {
  const info = await shareableInfo(uri);
  if (typeof info === 'string') {
    return { kind: 'refused', cause: info };
  }
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch {
    return { kind: 'refused', cause: 'missing' };
  }
  const text = decodableText(bytes);
  return text === undefined ? { kind: 'refused', cause: 'binary' } : { kind: 'text', text };
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
