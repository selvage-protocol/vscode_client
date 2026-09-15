/**
 * The grant's shape: which paths a host may publish, how a listing is ordered, and how a
 * receiver derives a tree from what it was given.
 *
 * The rules here are the host's, and they are deliberately editor-free: the two clients are
 * different editors, not different products, so what a session shares — the folder, the names
 * it leaves out, the file it will not carry — has to be the same on both sides (`DESIGN.md`
 * §4.2, `PROTOCOL.md` §5). A host enumerates its own working copy; a receiver never resolves a
 * path against anything, it derives.
 */

/**
 * The most paths one listing carries.
 *
 * The server's own policy bound is far larger (100 000 paths), and a listing over the
 * transport's frame bound never arrives at all — it ends the connection the way a dropped
 * socket does (`PROTOCOL.md` §2.1, §5). This is the host's, so a pathological tree is a
 * short listing rather than a wedged session.
 */
export const MAX_GRANT_PATHS = 5000;

/** The longest path in a listing, in bytes, taken from the server's own bound. */
export const MAX_GRANT_PATH_BYTES = 4096;

/**
 * The largest file a host will put into a document. A whole file becomes one `Y.Text` insert,
 * bounded only by the transport's 16 MiB frame bound, so a large asset is refused rather than
 * allowed to fail the first sync with no `session.error` (`PROTOCOL.md` §2.1).
 */
export const MAX_GRANT_FILE_BYTES = 1024 * 1024;

/**
 * Directory names that are never part of the grant. Dependency trees and build outputs are
 * what a working copy should not share, and they are also what makes a walk pathological.
 * Matched exactly: a file system that folds case is the file system's business.
 */
export const GRANT_EXCLUDED_DIRS: readonly string[] = [
  '.git',
  '.hg',
  '.svn',
  '.gradle',
  '.idea',
  '.vscode-test',
  'node_modules',
  'vendor',
  'target',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
];

/**
 * Whether a workspace-relative path is one a host may publish or serve.
 *
 * Workspace-relative and `/`-separated, with no leading slash, no `.` or `..` segment and no
 * backslash: a grant is a list of names the host chose, and a name that resolves somewhere
 * else is not one of them. `.git/**` and `.env` are the defaults `DESIGN.md` §4.2 names, and
 * the family of `.env` files is excluded with it rather than the one name alone.
 */
export function isGrantedPath(path: string): boolean {
  if (path.trim() === '' || path.includes('\\')) {
    return false;
  }
  if (new TextEncoder().encode(path).length > MAX_GRANT_PATH_BYTES) {
    return false;
  }
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      return false;
    }
    if (GRANT_EXCLUDED_DIRS.includes(segment)) {
      return false;
    }
    if (segment === '.env' || segment.startsWith('.env.')) {
      return false;
    }
  }
  return true;
}

/**
 * A listing in the order a publishing client MUST write it: ascending by Unicode code unit,
 * which is the unit `PROTOCOL.md` §5 fixes the order in.
 *
 * `Array.prototype.sort` with no comparator orders strings exactly that way — a supplementary
 * character, which is a surrogate pair, sorts among the surrogates rather than where its code
 * point would put it, and a code-point or byte sort would order such a path differently
 * (vector `022`). The empty comparator is therefore the whole rule, not an oversight.
 */
export function sortGrant(paths: Iterable<string>): string[] {
  return [...paths].sort();
}

/**
 * What one window offers: the room's grant, and the paths the room holds open.
 *
 * The union is deliberate rather than the grant alone, so a server that has no grant — one
 * older than `doc.grant`, which answers `unknown_method` — still offers everything the room
 * knows. Ordering is the listing's.
 */
export function grantUnion(
  grant: Iterable<string>,
  documents: Iterable<string>,
): string[] {
  return sortGrant(new Set([...grant, ...documents]));
}

/** One entry of a tree derived from a listing. Directories are synthesized, never carried. */
export interface GrantChild {
  /** The last segment, which is what a tree draws. */
  name: string;
  /** The workspace-relative path, which is what opening it addresses. */
  path: string;
  directory: boolean;
}

/**
 * The immediate children of `directory` in a listing, derived by splitting the paths.
 *
 * A listing carries files and no directory entry at all (`PROTOCOL.md` §5): `src/main.rs`
 * implies a `src`, and that implication is a rendering decision of the receiver's. Directories
 * come first and each group is ordered by code unit, which is how a file tree is read.
 */
export function grantChildren(
  paths: Iterable<string>,
  directory = '',
): GrantChild[] {
  const prefix = directory === '' ? '' : `${directory}/`;
  const byName = new Map<string, GrantChild>();
  for (const path of paths) {
    if (!path.startsWith(prefix) || path === directory) {
      continue;
    }
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    const name = slash === -1 ? rest : rest.slice(0, slash);
    if (name === '') {
      continue;
    }
    const child = byName.get(name);
    if (child === undefined) {
      byName.set(name, { name, path: `${prefix}${name}`, directory: slash !== -1 });
    } else if (slash !== -1) {
      // A path that is both a directory and a file is a tree entry either way; the
      // directory is the one that can be gone into.
      child.directory = true;
    }
  }
  return [...byName.values()].sort((left, right) => {
    if (left.directory !== right.directory) {
      return left.directory ? -1 : 1;
    }
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
}
