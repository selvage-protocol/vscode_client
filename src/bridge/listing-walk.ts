/**
 * The listing walk, once for every client: how a host turns a folder it was handed into the
 * names a room is offered, and where it stops.
 *
 * `PROTOCOL.md` §13.3 holds one listing to 100 000 paths and to 4 MiB of their UTF-8 bytes, and
 * a host imposes a work budget of its own on top. The stops and the charge points are the same
 * rule whichever editor enumerates (`DESIGN.md` §4.2), so they live here rather than in each
 * adapter, and an adapter is a seam: it reads a directory, reads one ignore file, and answers
 * whether one candidate is shareable, in its own file system's words.
 *
 * Nothing here touches an editor, a filesystem or a clock: the walk is the rule, and what is
 * editor-specific — `vscode.workspace.fs`, a `FileSystemDirectoryHandle`, `node:fs` — is the
 * `ListingWalkSource` a caller hands in.
 */

import { listingBound, listingPathBytes } from '../engine/limits.ts';
import type { ListingBound, ListingCeiling } from '../engine/limits.ts';
import {
  MAX_GRANT_LISTING_BYTES,
  MAX_GRANT_NODES,
  MAX_GRANT_PATHS,
  isBinaryNamedPath,
  isGrantedPath,
  isIgnoredPath,
  sortGrant,
} from './grant.ts';
import type { IgnoreSource } from './grant.ts';

/** What a walk stops at: §13.3's two bounds, from the grant's one home for them. */
const WALK_CEILING: ListingCeiling = {
  paths: MAX_GRANT_PATHS,
  bytes: MAX_GRANT_LISTING_BYTES,
};

/**
 * Which bound stopped a walk: §13.3's two, or the work it pays for. A budget cut is the walk's
 * own — what it spends on directory reads and shareability checks — and not a listing bound.
 *
 * `paths` and `bytes` are recorded only where a file the walk would have named did not fit, so
 * a listing that holds every shareable file of the folder reports no cut. A spent budget leaves
 * the rest of the folder unread, so `budget` says the walk stopped and not that anything was
 * left out.
 */
export type ListingCut = ListingBound | 'budget';

/**
 * One entry of a directory, as each adapter's own type reduces to it.
 *
 * `file` is an ordinary file and nothing else: a symbolic link, a socket, a device, a type the
 * host cannot name, and VS Code's bit set that carries more than the one bit, are all `other`,
 * because a listing names files and only the entry type says whether an entry will be read at
 * all. An adapter that refuses an entry by its type maps it to `other`; that refusal costs the
 * walk nothing and settles no bound.
 */
export interface WalkEntry {
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'other';
}

/**
 * The editor's half of one walk, in the host it read and the five calls the rule needs:
 *
 * - `platform` is the host itself, in the spelling `process.platform` uses — `'linux'`,
 *   `'darwin'`, `'win32'` — or `''` for a host that cannot say. The two name gates fold case only
 *   where the host's file system does, so this is what decides whether a `Build/` is an excluded
 *   name or an ordinary directory, and a host that does not know its own platform keeps the fold:
 *   sharing less is the safer error. The walk reads the platform here and nowhere else.
 * - `entries(dir)` is the directory's own listing — its entries in the file system's own order,
 *   which the walk sorts — or `undefined` when this host cannot read it. A directory that cannot
 *   be listed is one the host cannot share: it is skipped in silence and is not a cut.
 * - `ignoreText(dir, entries)` is the text of the `.gitignore` that `dir`'s own listing holds as
 *   an ordinary file, or `undefined` when it holds none. The listing is handed back so a
 *   directory is never read twice, and the entry's *type* decides whether the name is an ignore
 *   file at all: a `stat` of the name would follow a link out of the folder being shared.
 * - `shareable(dir, name)` is the one check a candidate costs, and the whole of what a walk
 *   knows of a file's content: whether the host will carry it in a document.
 * - `child(dir, name)` is the directory that entry names, or `undefined` when it can no longer
 *   be reached. Nothing is read here, so nothing is charged for it.
 * - `rootIgnores(dir, entries)` is the ignore sources that govern everything under a shared
 *   root — `<root>/.git/info/exclude` is the one — lowest precedence first, read from the
 *   root's own entries rather than by listing the root again.
 */
export interface ListingWalkSource<Dir> {
  readonly platform: string;
  entries(dir: Dir): Promise<readonly WalkEntry[] | undefined>;
  ignoreText(dir: Dir, entries: readonly WalkEntry[]): Promise<string | undefined>;
  shareable(dir: Dir, name: string): Promise<boolean>;
  child(dir: Dir, name: string): Promise<Dir | undefined>;
  rootIgnores(dir: Dir, entries: readonly WalkEntry[]): Promise<readonly IgnoreSource[]>;
}

/**
 * One folder a walk starts from: the directory itself, and the name its paths are prefixed with
 * when a session shares more than one folder. Two folders need their names in front, or two
 * `src/main.rs` would be one room path.
 */
export interface ListingRoot<Dir> {
  readonly dir: Dir;
  readonly name: string;
}

/** What one walk found: the listing, the directories it entered, and the bound that stopped it. */
export interface ListingWalkResult {
  readonly paths: string[];
  /**
   * Every directory the walk descended into, as a room path, in visit order.
   *
   * A listing carries files, so a directory is in it only through the files inside it, and a
   * caller that draws a folder — or offers one to a peer — has no other way to know a directory
   * the walk entered holds none. A directory whose own read then failed is here too: it is a
   * directory the folder holds, whatever could be read under it.
   */
  readonly entered: string[];
  readonly cut: ListingCut | undefined;
}

/**
 * The listing of a set of folders, as the file system held it when the walk ran: files only,
 * ascending by UTF-16 code unit, with the bound that stopped it short of the folder.
 *
 * The walk stops at whichever binds first — `MAX_GRANT_PATHS` listed paths,
 * `MAX_GRANT_LISTING_BYTES` of their UTF-8 bytes, or the work budget — and one budget is shared
 * across every root, so a session sharing two folders pays for what it reads of both. Each
 * directory's entries are visited in name order so that which paths survive a cut does not
 * depend on the file system's own order.
 *
 * The budget pays for the work that costs a call: one node for a directory this walk reads, one
 * for the shareability check it asks of a candidate file. A name it can drop on its own — an
 * excluded or ignored one, a binary-named one, an entry that is not a plain file — costs
 * nothing, because the assets a tree carries are no part of what it shares.
 */
export async function walkListing<Dir>(
  source: ListingWalkSource<Dir>,
  roots: readonly ListingRoot<Dir>[],
): Promise<ListingWalkResult> {
  const state: WalkState = { paths: [], entered: [], bytes: 0, nodes: MAX_GRANT_NODES, cut: undefined };
  const qualified = roots.length > 1;
  for (const root of roots) {
    if (state.cut !== undefined) {
      break;
    }
    await walk(source, root.dir, '', qualified ? `${root.name}/` : '', [], state);
  }
  return { paths: sortGrant(state.paths), entered: state.entered, cut: state.cut };
}

/**
 * What one walk carries as it descends: the listing, the directories it entered, the size of the
 * listing in path bytes, the work it has left to spend, and the bound that stopped it.
 */
interface WalkState {
  readonly paths: string[];
  readonly entered: string[];
  bytes: number;
  nodes: number;
  cut: ListingCut | undefined;
}

async function walk<Dir>(
  source: ListingWalkSource<Dir>,
  dir: Dir,
  relative: string,
  prefix: string,
  inherited: readonly IgnoreSource[],
  state: WalkState,
): Promise<void> {
  if (state.cut !== undefined) {
    return;
  }
  // Entering a directory is a read, and a read is what the budget pays for.
  if (state.nodes <= 0) {
    state.cut = 'budget';
    return;
  }
  state.nodes -= 1;
  const listed = await source.entries(dir);
  if (listed === undefined) {
    // A directory that cannot be listed is one this host cannot share; it is not a fault the
    // session should hear about, because the grant is a listing and not a promise.
    return;
  }
  // The shared root's own ignore sources come from the entries just read, so the root is listed
  // once per walk and its `.git` and `info` are different directories from it.
  const beneath = relative === '' ? await source.rootIgnores(dir, listed) : inherited;
  // This directory's own ignore file governs its children, and it is read whether or not some
  // pattern would leave it out, as git reads it; `.gitignore` itself stays a shareable name.
  const own = await source.ignoreText(dir, listed);
  const ignores = own === undefined ? beneath : [...beneath, { dir: relative, text: own }];
  const entries = [...listed].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  const platform = source.platform;
  for (const entry of entries) {
    if (state.cut !== undefined) {
      return;
    }
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
    const directory = entry.kind === 'directory';
    // Two gates by name, and neither reads a byte: what a room never shares at all, and what
    // this folder's own ignore files leave out. An ignored directory is not descended into, so
    // the tree below it costs the walk nothing.
    if (!isGrantedPath(child, platform) || isIgnoredPath(ignores, child, directory, platform)) {
      continue;
    }
    // A link, a socket and every other entry type a listing cannot carry: nothing is read for
    // one, and nothing behind it can be reached.
    if (entry.kind === 'other') {
      continue;
    }
    if (directory) {
      state.entered.push(`${prefix}${child}`);
      const below = await source.child(dir, entry.name);
      if (below !== undefined) {
        await walk(source, below, child, prefix, ignores, state);
      }
      continue;
    }
    // A file whose name declares a format a room cannot carry is left out, because the read
    // refuses every file of that format as `binary`: naming it offered a guest a file no fetch
    // could fill. The rule is the name alone and it is a floor — this walk reads no bytes, so a
    // binary whose name declares no format stays listed and gets that refusal for asking
    // (`GRANT_BINARY_SUFFIXES`).
    if (isBinaryNamedPath(child)) {
      continue;
    }
    // The shareability check is the one call this entry costs, whether or not it ends in a name.
    // A budget spent here stops the walk with the rest of the folder unread, and what that hides
    // cannot be told apart from a listing that is whole.
    if (state.nodes <= 0) {
      state.cut = 'budget';
      return;
    }
    state.nodes -= 1;
    if (!(await source.shareable(dir, entry.name))) {
      continue;
    }
    // The listing's own bound is decided here, on a file this walk would have named and would
    // not have fitted: a candidate it declines for any other reason cannot make the room's
    // listing short of the folder, so it does not decide a bound either.
    const path = `${prefix}${child}`;
    const size = listingPathBytes(path);
    const bound = listingBound(WALK_CEILING, state.paths.length, state.bytes, size);
    if (bound !== undefined) {
      state.cut = bound;
      return;
    }
    state.paths.push(path);
    state.bytes += size;
  }
}
