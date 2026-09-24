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
 * Whether a buffer is over the largest file a session carries.
 *
 * UTF-8 bytes are never fewer than UTF-16 code units and never more than three times as
 * many, so a buffer under a third of the bound is under it from its length alone. This is
 * asked of every shared buffer on every keystroke, so only a buffer in the top of that
 * range — where the answer depends on what the characters are — pays for the exact count.
 */
export function overFileBound(text: string): boolean {
  if (text.length > MAX_GRANT_FILE_BYTES) {
    return true;
  }
  if (text.length * 3 <= MAX_GRANT_FILE_BYTES) {
    return false;
  }
  return new TextEncoder().encode(text).length > MAX_GRANT_FILE_BYTES;
}

/**
 * Directory names that are never part of the grant. Dependency trees and build outputs are
 * what a working copy should not share, and they are also what makes a walk pathological.
 * Matched case-insensitively only where the host filesystem folds case (macOS, Windows):
 * there `.GIT/config` and `Node_Modules/…` name the same files as their lowercase forms,
 * while on a case-sensitive checkout `Build/` is an ordinary directory and stays shareable.
 * What this cannot see is a name that merely looks the same — a fullwidth lookalike, an
 * unnormalized form — which the byte comparison lets through; those stay out of reach of
 * this list, and are said as a residual where it matters.
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
 * File names that are never part of the grant: per-user secrets beside `.env`. Matched
 * against the leaf segment only (see `isGrantedPath`), folding case like the directories.
 * Beside the package-registry tokens: the machine logins curl, git and ftp read (`.netrc`,
 * Windows' `_netrc`), git's stored credentials, PostgreSQL's password file and an Apache
 * password file. None of them is a file a project needs another person to see.
 */
const GRANT_EXCLUDED_FILES: readonly string[] = [
  '.envrc',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.pgpass',
  '.htpasswd',
];

/**
 * Directory names whose whole tree is never part of the grant: credential stores. `.ssh` and
 * `.gnupg` go whole, not only their key files: `config`, `known_hosts`, `authorized_keys` and
 * a keyring say which machines and people this host trusts, which is not the project's to share.
 * A directory list, so it governs every segment; folding case like the directories above.
 */
const GRANT_SECRET_DIRS: readonly string[] = ['.aws', '.ssh', '.gnupg'];

/** File-name prefixes of private keys, matched against the leaf segment only. */
const GRANT_SECRET_KEY_PREFIXES: readonly string[] = [
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
];

/**
 * File-name suffixes of private keys, matched against the leaf segment only.
 * Errs toward secrecy: a public `id_rsa.pub` is left out with the private key beside it.
 * PKCS#12 bundles (`.p12`, `.pfx`) and Java keystores (`.jks`, `.keystore`) carry a private
 * key the same way. A local Terraform state (`.tfstate` and its `.tfstate.backup`) holds every
 * secret the configuration it describes was given, in plain text.
 */
const GRANT_SECRET_KEY_SUFFIXES: readonly string[] = [
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.tfstate',
  '.tfstate.backup',
];

/**
 * File-name suffixes of formats a room cannot carry: an archive or compressed stream, an
 * image, a font, a media container, a compiled object, a database, or a raw blob.
 *
 * A document is one `Y.Text`, so every file of one of these formats has bytes no session can
 * put into one, and the read refuses every one of them as `binary`. A listing that named one
 * offered a guest a file it could never fetch, and left the guest to find that out by asking.
 *
 * The walk is what this list is for, and it cannot read: reading every file to decide whether
 * to name it would read a whole project to publish a name list, so a name is the one thing a
 * walk can judge a file by. The list is a floor and not a classification, and a name is a
 * declaration rather than proof of content. So a binary file whose name declares no format
 * (`data`, `dump.db`) is still listed and still refused with the truth, and a text file that
 * wears one of these names (`LICENSE.zip`) is left out of the listing with them.
 *
 * `.pdf` is deliberately absent: a text-only PDF is a file the read serves, so listing it is
 * what agrees with the read. Matched against the leaf segment only, and folded: a format's
 * spelling is a convention of its name rather than a fact about a filesystem, so `IMG_01.JPG`
 * is a JPEG on every platform.
 */
export const GRANT_BINARY_SUFFIXES: readonly string[] = [
  '.3gp',
  '.7z',
  '.a',
  '.aac',
  '.aif',
  '.aiff',
  '.apk',
  '.asar',
  '.avif',
  '.avi',
  '.avro',
  '.bin',
  '.bmp',
  '.bz2',
  '.cab',
  '.class',
  '.dll',
  '.dmg',
  '.doc',
  '.docx',
  '.dylib',
  '.ear',
  '.elf',
  '.eot',
  '.epub',
  '.exe',
  '.flac',
  '.flv',
  '.gif',
  '.gguf',
  '.gz',
  '.h5',
  '.hdf5',
  '.heic',
  '.heif',
  '.ico',
  '.iso',
  '.jar',
  '.jpeg',
  '.jp2',
  '.jpg',
  '.jxl',
  '.ko',
  '.lib',
  '.lz4',
  '.m4a',
  '.m4v',
  '.mdb',
  '.mkv',
  '.mov',
  '.mp3',
  '.mp4',
  '.mpeg',
  '.mpg',
  '.node',
  '.npy',
  '.npz',
  '.nupkg',
  '.o',
  '.obj',
  '.odp',
  '.ods',
  '.odt',
  '.oga',
  '.ogg',
  '.onnx',
  '.opus',
  '.otf',
  '.parquet',
  '.pb',
  '.pickle',
  '.pkl',
  '.png',
  '.ppt',
  '.pptx',
  '.psd',
  '.pyd',
  '.pyc',
  '.pyo',
  '.rar',
  '.rlib',
  '.rmeta',
  '.rpm',
  '.safetensors',
  '.so',
  '.sqlite',
  '.sqlite3',
  '.svgz',
  '.tar',
  '.tflite',
  '.tgz',
  '.tif',
  '.tiff',
  '.ttc',
  '.ttf',
  '.vsix',
  '.war',
  '.wasm',
  '.wav',
  '.webm',
  '.webp',
  '.whl',
  '.wmv',
  '.woff',
  '.woff2',
  '.xls',
  '.xlsx',
  '.xz',
  '.zip',
  '.zst',
];

/**
 * Whether a segment carries a character that spoofs a tree or picker row: a control, a
 * line or paragraph separator breaking a single-line surface, a bidirectional override
 * or isolate, or a zero-width no-break space. Names a shape to refuse, not a rendering
 * guarantee — what the editor draws with what is left is its own. (A backslash and the
 * C1/DEL bytes are legal in Unix names; refusing them trades a rare name for a spoofed row.)
 */
function hasUnsafeChar(segment: string): boolean {
  for (const char of segment) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
    if (
      code === 0x61c ||
      code === 0x200e ||
      code === 0x200f ||
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a secret-bearing environment file leaf is named: `.env` itself and the `.local`
 * files the tooling convention gitignores (`.env.local`, `.env.<name>.local`). Templates
 * (`.env.example` and the `.sample`/`.template` siblings) carry no secrets and stay
 * shareable; anything else under `.env.*` — `.env.production` included — is configuration,
 * not secret, and stays shareable too. That last half is deliberate, and the one place this
 * rule knowingly shares a name that can hold a real secret: denying the whole `.env.*`
 * family back would take the templates with it, which is the break this rule exists to undo.
 */
function isEnvSecret(leaf: string): boolean {
  if (leaf === '.env' || leaf === '.env.local') {
    return true;
  }
  return leaf.startsWith('.env.') && leaf.endsWith('.local') && leaf.length > '.env.local'.length;
}

/**
 * Whether the host's filesystem folds case: the default macOS and Windows ones do, Linux
 * does not. The excludes fold only there, so a Linux `Build/` is an ordinary directory
 * while a macOS `.GIT/` is still stopped. An unknown host keeps the fold: sharing less is
 * the safer error.
 */
function foldsCase(platform: string): boolean {
  return platform === '' || platform === 'darwin' || platform === 'win32';
}

/** This host's platform, or `''` when it cannot be read. Passed explicitly in tests. */
function hostPlatform(): string {
  const proc = (globalThis as { process?: { platform?: unknown } }).process;
  const platform = proc?.platform;
  return typeof platform === 'string' ? platform : '';
}

/** Whether a folded-or-exact leaf names a private key file. */
function isSecretKeyName(folded: string): boolean {
  for (const prefix of GRANT_SECRET_KEY_PREFIXES) {
    if (folded.startsWith(prefix)) {
      return true;
    }
  }
  for (const suffix of GRANT_SECRET_KEY_SUFFIXES) {
    if (folded.length > suffix.length && folded.endsWith(suffix)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a path's name declares a format a room cannot carry (`GRANT_BINARY_SUFFIXES`).
 *
 * The leaf segment only, so a directory named after one of these formats is governed by the
 * directory excludes alone. Folded unconditionally: a file's format is what its name declares,
 * and `.JPG` declares the same one as `.jpg` on a case-sensitive checkout too. A leaf that is
 * nothing but the suffix (`.zip`) has no name a format could be declared on and is not matched.
 */
export function isBinaryNamedPath(path: string): boolean {
  const segments = path.split('/');
  const leaf = (segments[segments.length - 1] ?? '').toLowerCase();
  return GRANT_BINARY_SUFFIXES.some(
    (suffix) => leaf.length > suffix.length && leaf.endsWith(suffix),
  );
}

/**
 * Whether a workspace-relative path is one a host may publish or serve.
 *
 * Workspace-relative and `/`-separated, with no leading slash, no `.` or `..` segment and no
 * backslash: a grant is a list of names the host chose, and a name that resolves somewhere
 * else is not one of them. `.git/**` and `.env` are the defaults `DESIGN.md` §4.2 names.
 *
 * `platform` is the host's (`process.platform` when omitted): the directory and secret-name
 * excludes fold case only where the filesystem does, and tests pass it explicitly to pin
 * both halves. Secret-*name* patterns match the leaf segment only; a directory segment is
 * governed solely by the directory-exclude lists, so a whole subtree never disappears on
 * a filename pattern.
 *
 * These excludes are accident-guards against opening or publishing the wrong file, not a
 * security boundary against a host deliberately sharing its own disk: a rename past a rule
 * (`server.pem` to `server.pem.bak`) re-shares the file, and that is the host's own choice.
 * Chasing renames would take the shareable templates back out with them, so the bypass
 * stays, stated.
 */
export function isGrantedPath(path: string, platform: string = hostPlatform()): boolean {
  if (path.trim() === '' || path.includes('\\')) {
    return false;
  }
  if (new TextEncoder().encode(path).length > MAX_GRANT_PATH_BYTES) {
    return false;
  }
  const fold = foldsCase(platform);
  const segments = path.split('/');
  const leaf = segments.length - 1;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? '';
    if (segment === '' || segment === '.' || segment === '..') {
      return false;
    }
    if (hasUnsafeChar(segment)) {
      return false;
    }
    const name = fold ? segment.toLowerCase() : segment;
    if (GRANT_EXCLUDED_DIRS.includes(name) || GRANT_SECRET_DIRS.includes(name)) {
      return false;
    }
    if (
      index === leaf &&
      (GRANT_EXCLUDED_FILES.includes(name) || isEnvSecret(name) || isSecretKeyName(name))
    ) {
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
 *
 * A path whose name declares a format a room cannot carry is not offered, whatever the room's
 * listing says: a host that has not been updated still names its binaries, and nothing here can
 * fill one. The walk that builds a listing draws the same line (`GRANT_BINARY_SUFFIXES`), so
 * the two agree on the formats a name declares and neither claims more than a name can say.
 */
export function grantUnion(
  grant: Iterable<string>,
  documents: Iterable<string>,
): string[] {
  const offered = [...grant, ...documents].filter((path) => !isBinaryNamedPath(path));
  return sortGrant(new Set(offered));
}
