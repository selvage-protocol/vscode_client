/**
 * The grant, read off a working copy.
 *
 * Everything decidable about a listing — which paths it may name, in what order it is written,
 * how a tree is derived from it — is in `src/bridge/grant.ts`, because both clients have to
 * agree on it. What is left here is the editor's half: walking folders through
 * `vscode.workspace.fs`, so a remote or virtual workspace is read the way the editor reads it,
 * and resolving a room path back to the file it names.
 */

import * as vscode from 'vscode';

import {
  MAX_GRANT_FILE_BYTES,
  MAX_GRANT_PATHS,
  isGrantedPath,
  sortGrant,
} from '../bridge/index.ts';

/**
 * How many entries a walk will look at before it stops. The path count is the listing's own
 * bound; this is the one that keeps a directory tree with a hundred thousand entries in it from
 * costing a hundred thousand stats before the first path is ever published.
 */
export const MAX_GRANT_NODES = 20_000;

/**
 * The listing of a set of folders, as the file system held it when the walk ran: files only,
 * ascending by UTF-16 code unit.
 *
 * The count is a bound and not an error: a tree larger than it produces a truncated listing,
 * which is a project view missing some names rather than a wedged session. Each directory's
 * entries are visited in name order so that which paths survive the truncation does not depend
 * on the file system's own order.
 */
export async function enumerateGrant(
  folders: readonly vscode.WorkspaceFolder[],
): Promise<string[]> {
  const paths: string[] = [];
  const budget = { nodes: MAX_GRANT_NODES };
  // Two folders need their names in front, or two `src/main.rs` would be one room path.
  const qualified = folders.length > 1;
  for (const folder of folders) {
    await walk(folder.uri, '', qualified ? `${folder.name}/` : '', paths, budget);
  }
  return sortGrant(paths);
}

async function walk(
  dir: vscode.Uri,
  relative: string,
  prefix: string,
  out: string[],
  budget: { nodes: number },
): Promise<void> {
  if (out.length >= MAX_GRANT_PATHS || budget.nodes <= 0) {
    return;
  }
  let entries: Array<[string, vscode.FileType]>;
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    // A directory that cannot be listed is one this host cannot share; it is not a fault the
    // session should hear about, because the grant is a listing and not a promise.
    return;
  }
  entries.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  for (const [name, type] of entries) {
    if (out.length >= MAX_GRANT_PATHS || budget.nodes <= 0) {
      return;
    }
    budget.nodes -= 1;
    const child = relative === '' ? name : `${relative}/${name}`;
    if (!isGrantedPath(child)) {
      continue;
    }
    const target = vscode.Uri.joinPath(dir, name);
    // `FileType` is a bit set, and a link to a directory carries the directory bit as well as
    // its own, so the link is tested first: a symbolic link is neither a file this host can
    // vouch for nor one it should follow, because it can point anywhere, including out of the
    // folder being shared. Nothing behind a link is listed, and nothing behind it is descended
    // into.
    if ((type & vscode.FileType.SymbolicLink) !== 0) {
      continue;
    }
    if ((type & vscode.FileType.Directory) !== 0) {
      await walk(target, child, prefix, out, budget);
      continue;
    }
    // A listing carries files and never directories.
    if (type !== vscode.FileType.File) {
      continue;
    }
    if (await isShareableFile(target)) {
      out.push(`${prefix}${child}`);
    }
  }
}

/** A regular file small enough for one `Y.Text`, which is all a document can be. */
export async function isShareableFile(uri: vscode.Uri): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return stat.type === vscode.FileType.File && stat.size <= MAX_GRANT_FILE_BYTES;
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
 * The file a room path names, or `undefined` when no folder this session captured contains one.
 *
 * This is the path a *peer* named, so it is checked rather than trusted: the excludes and the
 * segment rules of `isGrantedPath` apply to it, because a guest that guessed `.env` or
 * `.git/config` must not be able to ask for what the grant deliberately leaves out. Every
 * segment on the way to the file must be a plain directory of the folder as well, so a guessed
 * path that travels *through* a symbolic link is refused too — no such path was listed, and
 * what it would read is outside the folder.
 */
export async function grantedFile(
  folders: readonly vscode.WorkspaceFolder[],
  path: string,
): Promise<vscode.Uri | undefined> {
  const resolved = withinFolders(folders, path);
  if (resolved === undefined || !isGrantedPath(resolved.relative)) {
    return undefined;
  }
  if (!(await throughPlainDirectories(resolved.folder.uri, resolved.relative))) {
    return undefined;
  }
  return vscode.Uri.joinPath(resolved.folder.uri, resolved.relative);
}

/**
 * True when every directory between the folder and the file is a plain directory of that folder.
 *
 * `vscode.workspace.fs` has no `realpath`, and `Uri.joinPath` resolves nothing: it joins strings.
 * A path that travels through a symbolic link therefore lands on a real file somewhere else
 * entirely, while the leaf's own `stat` reports an ordinary file. A link's own `stat` reports the
 * `SymbolicLink` bit, so the path is walked one segment at a time and every segment has to be
 * exactly a directory. The leaf is left to the caller, which reads it only as a plain file.
 *
 * What this cannot see, because the API does not expose it: a segment that is followed by the
 * editor's own file system without reporting a link (a mount point, a provider that resolves
 * links itself), and a link put in place between this walk and the read that follows it.
 */
async function throughPlainDirectories(folder: vscode.Uri, relative: string): Promise<boolean> {
  const segments = relative.split('/');
  let head = folder;
  for (const segment of segments.slice(0, -1)) {
    head = vscode.Uri.joinPath(head, segment);
    if (!(await isPlainDirectory(head))) {
      return false;
    }
  }
  return true;
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
