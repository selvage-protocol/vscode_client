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
  '.terraform',
  'Pods',
  '_build',
  'deps',
  '.dart_tool',
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
 * key the same way, and so does a PuTTY private key (`.ppk`), which is text a room would carry.
 * A local Terraform state (`.tfstate` and its `.tfstate.backup`) holds every
 * secret the configuration it describes was given, in plain text.
 */
const GRANT_SECRET_KEY_SUFFIXES: readonly string[] = [
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.ppk',
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
 * One ignore source a host read: the directory it governs ('' is the shared root) and its
 * text.
 */
export interface IgnoreSource {
  readonly dir: string;
  readonly text: string;
}

/** One element of a compiled pattern segment. */
type Element =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'any' }
  | { readonly kind: 'star' }
  | { readonly kind: 'class'; readonly negated: boolean; readonly members: readonly Member[] };

/** One member of a character class: a range, or one of the classes `fnmatch(3)` names. */
type Member =
  | { readonly kind: 'range'; readonly from: string; readonly to: string }
  | { readonly kind: 'named'; readonly name: string };

/** One `/`-separated segment of a compiled pattern. */
interface Segment {
  /** `**` alone: zero or more directories, and one or more where it ends the pattern. */
  readonly deep: boolean;
  readonly elements: readonly Element[];
}

/** One line of an ignore file, as the pattern it compiled to. */
interface IgnorePattern {
  readonly negated: boolean;
  /** A trailing `/`: the pattern matches a directory, never a file. */
  readonly directoryOnly: boolean;
  /** A `/` at the start or in the middle: relative to the source's own directory. */
  readonly anchored: boolean;
  readonly segments: readonly Segment[];
}

const BOM = '\ufeff';

/** The class names of `fnmatch(3)`'s bracket expressions, ASCII as git's own matcher is. */
const POSIX_CLASSES: Readonly<Record<string, ((code: number) => boolean) | undefined>> = {
  alnum: (code) =>
    (code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a),
  alpha: (code) => (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a),
  blank: (code) => code === 0x20 || code === 0x09,
  cntrl: (code) => code < 0x20 || code === 0x7f,
  digit: (code) => code >= 0x30 && code <= 0x39,
  graph: (code) => code > 0x20 && code < 0x7f,
  lower: (code) => code >= 0x61 && code <= 0x7a,
  print: (code) => code >= 0x20 && code < 0x7f,
  punct: (code) =>
    code > 0x20 &&
    code < 0x7f &&
    !((code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a)),
  space: (code) => code === 0x20 || (code >= 0x09 && code <= 0x0d),
  upper: (code) => code >= 0x41 && code <= 0x5a,
  xdigit: (code) =>
    (code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x66) || (code >= 0x41 && code <= 0x46),
};

/**
 * Whether a workspace-relative path is left out by the ignore sources that govern it.
 *
 * The sources are a host's own read of its disk, and they arrive lowest precedence first:
 * `<folder>/.git/info/exclude`, then the `.gitignore` of every directory from the shared root
 * down to the one holding the path. The last pattern that matches decides, a negation matches
 * like any other, and a source governs what is strictly inside the directory it names — never
 * that directory itself — with its patterns read against the path relative to it. A pattern
 * that matches a directory stops git there, so an ignored ancestor leaves out everything below
 * it however a deeper source reads (`gitignore(5)`).
 *
 * `isDirectory` decides a directory-only pattern (`foo/`), and `platform` folds case the way
 * `isGrantedPath` does, only where the host's filesystem folds. `path` is `/`-separated and
 * relative to the shared root, in the spelling the sources' own `dir` values use.
 *
 * The ignore layer is the host's: it reads its own disk, and a receiver has no ignore files to
 * read, so this stays out of `isGrantedPath` and a listing is refused by name alone.
 */
export function isIgnoredPath(
  sources: readonly IgnoreSource[],
  path: string,
  isDirectory: boolean,
  platform: string = hostPlatform(),
): boolean {
  const fold = foldsCase(platform);
  const compiled = sources.map((source) => compiledSource(source, fold));
  const segments = (fold ? path.toLowerCase() : path).split('/');
  // Git never descends into an ignored directory, so nothing inside one can be re-included:
  // an ignored ancestor decides the path before its own patterns are read.
  for (let depth = 1; depth < segments.length; depth += 1) {
    if (decides(compiled, segments, depth, true)) {
      return true;
    }
  }
  return decides(compiled, segments, segments.length, isDirectory);
}

/** A compiled source: the directory it governs, and the patterns to hold a path against it. */
interface CompiledSource {
  readonly base: readonly string[];
  readonly patterns: readonly IgnorePattern[];
}

/** One source's compiled forms, by fold decision: two platforms can ask about the same object. */
interface CompiledForms {
  folded?: CompiledSource;
  exact?: CompiledSource;
}

/**
 * The compiled form of each source object a caller has handed over. Keyed on the object rather
 * than on its text, and holding both fold decisions, so `foldsCase`'s answer never leaks across
 * a platform. `dir` and `text` are read-only, so a remembered form cannot go stale.
 */
const COMPILED = new WeakMap<IgnoreSource, CompiledForms>();

/**
 * `source` compiled, remembered on the object itself. A walk hands the same objects to every
 * entry of a directory, so this is what keeps one ignore file's lines being read once per walk
 * rather than once per entry of the tree it governs.
 */
function compiledSource(source: IgnoreSource, fold: boolean): CompiledSource {
  let forms = COMPILED.get(source);
  if (forms === undefined) {
    forms = {};
    COMPILED.set(source, forms);
  }
  const remembered = fold ? forms.folded : forms.exact;
  if (remembered !== undefined) {
    return remembered;
  }
  const compiled: CompiledSource = {
    base: source.dir === '' ? [] : (fold ? source.dir.toLowerCase() : source.dir).split('/'),
    patterns: compileIgnoreText(fold ? source.text.toLowerCase() : source.text),
  };
  if (fold) {
    forms.folded = compiled;
  } else {
    forms.exact = compiled;
  }
  return compiled;
}

/**
 * Whether the last pattern matching the path's first `depth` segments leaves it out.
 *
 * Sources are read lowest precedence first and the patterns of one source in file order, so
 * the later of two matches wins, which is the rule `gitignore(5)` states for both.
 */
function decides(
  sources: readonly CompiledSource[],
  segments: readonly string[],
  depth: number,
  isDirectory: boolean,
): boolean {
  let ignored = false;
  for (const source of sources) {
    if (source.base.length >= depth || !startsAt(segments, source.base)) {
      continue;
    }
    const relative = segments.slice(source.base.length, depth);
    for (const pattern of source.patterns) {
      if (matchesPattern(pattern, relative, isDirectory)) {
        ignored = !pattern.negated;
      }
    }
  }
  return ignored;
}

/** Whether `segments` begins with `base`, which is how a source governs a path inside it. */
function startsAt(segments: readonly string[], base: readonly string[]): boolean {
  return base.every((segment, index) => segments[index] === segment);
}

/** Whether one pattern matches the path relative to the source that holds it. */
function matchesPattern(
  pattern: IgnorePattern,
  relative: readonly string[],
  isDirectory: boolean,
): boolean {
  if (pattern.directoryOnly && !isDirectory) {
    return false;
  }
  if (!pattern.anchored) {
    // No `/` but the trailing one, so the name matches at any depth below the source.
    const leaf = pattern.segments[0];
    return leaf !== undefined && segmentMatches(leaf.elements, relative[relative.length - 1] ?? '');
  }
  return segmentsMatch(pattern.segments, relative);
}

/** Whether a path matches a whole anchored pattern, its `**` segments spanning directories. */
function segmentsMatch(pattern: readonly Segment[], path: readonly string[]): boolean {
  const width = path.length + 1;
  const failed = new Uint8Array((pattern.length + 1) * width);

  const at = (element: number, index: number): boolean => {
    // Each position is tried once: a `**` branches over the rest of the path, and without this
    // a pattern of several of them revisits the same positions exponentially.
    if (failed[element * width + index] !== 0) {
      return false;
    }
    const segment = pattern[element];
    let matched: boolean;
    if (segment === undefined) {
      matched = index === path.length;
    } else if (segment.deep && element + 1 === pattern.length) {
      // A trailing `/**` matches what is inside a directory, never the directory itself.
      matched = index < path.length;
    } else if (segment.deep) {
      matched = false;
      for (let next = index; next <= path.length && !matched; next += 1) {
        matched = at(element + 1, next);
      }
    } else {
      matched =
        index < path.length &&
        segmentMatches(segment.elements, path[index] ?? '') &&
        at(element + 1, index + 1);
    }
    if (!matched) {
      failed[element * width + index] = 1;
    }
    return matched;
  };

  return at(0, 0);
}

/** Whether one name matches one segment: `*` and `?` never cross a `/`, which a name has none of. */
function segmentMatches(elements: readonly Element[], name: string): boolean {
  let element = 0;
  let index = 0;
  let star = -1;
  let starIndex = 0;
  while (index < name.length) {
    if (elements[element]?.kind === 'star') {
      star = element;
      starIndex = index;
      element += 1;
      continue;
    }
    const current = elements[element];
    if (current !== undefined && elementMatches(current, name[index] ?? '')) {
      element += 1;
      index += 1;
      continue;
    }
    if (star === -1) {
      return false;
    }
    starIndex += 1;
    index = starIndex;
    element = star + 1;
  }
  while (elements[element]?.kind === 'star') {
    element += 1;
  }
  return element === elements.length;
}

/** Whether one character matches one element. A `*` is consumed by the caller's own branch. */
function elementMatches(element: Element, char: string): boolean {
  if (element.kind === 'literal') {
    return element.value === char;
  }
  if (element.kind === 'any') {
    return true;
  }
  if (element.kind === 'class') {
    const found = element.members.some((member) => memberMatches(member, char));
    return element.negated ? !found : found;
  }
  return true;
}

/** Whether one character is in a class member: a range, or a named class. */
function memberMatches(member: Member, char: string): boolean {
  if (member.kind === 'range') {
    return char >= member.from && char <= member.to;
  }
  return POSIX_CLASSES[member.name]?.(char.codePointAt(0) ?? 0) ?? false;
}

/**
 * The patterns of one ignore file, in the order the file writes them.
 *
 * A line's trailing spaces go unless a backslash escapes one, `#` and `!` introduce a comment
 * and a negation unless escaped, blanks are skipped, a trailing `/` makes a pattern
 * directory-only, and a `/` anywhere but the end anchors it to the source's directory. A line
 * git calls invalid — a trailing backslash, an unterminated bracket, a class name that is not
 * one — never matches anything, so it is dropped.
 *
 * `text` arrives already folded where the host folds; case is the caller's, because the two
 * sides of a case-insensitive comparison have to be folded the same way.
 */
function compileIgnoreText(text: string): IgnorePattern[] {
  const patterns: IgnorePattern[] = [];
  const body = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  for (const raw of body.split('\n')) {
    const line = trimTrailingSpaces(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    let pattern = line;
    let negated = false;
    if (pattern.startsWith('\\#') || pattern.startsWith('\\!')) {
      pattern = pattern.slice(1);
    } else if (pattern.startsWith('!')) {
      negated = true;
      pattern = pattern.slice(1);
    }
    let directoryOnly = false;
    if (pattern.endsWith('/')) {
      directoryOnly = true;
      pattern = pattern.slice(0, -1);
    }
    let anchored = false;
    if (pattern.startsWith('/')) {
      anchored = true;
      pattern = pattern.slice(1);
    } else if (pattern.includes('/')) {
      anchored = true;
    }
    if (pattern === '') {
      continue;
    }
    const segments: Segment[] = [];
    let valid = true;
    for (const piece of pattern.split('/')) {
      const elements = compileSegment(piece);
      if (elements === undefined) {
        valid = false;
        break;
      }
      const deep = piece === '**';
      // Consecutive `**` segments are one, and the last of them is the one that decides how
      // many directories the run spans.
      if (deep && segments[segments.length - 1]?.deep === true) {
        segments.pop();
      }
      segments.push({ deep, elements });
    }
    if (valid) {
      patterns.push({ negated, directoryOnly, anchored, segments });
    }
  }
  return patterns;
}

/** A line's trailing spaces, dropped unless a backslash escapes one of them. */
function trimTrailingSpaces(line: string): string {
  let last = -1;
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    if (char === '\\') {
      index += 2;
      last = -1;
      continue;
    }
    if (char === ' ') {
      if (last === -1) {
        last = index;
      }
    } else {
      last = -1;
    }
    index += 1;
  }
  return last === -1 ? line : line.slice(0, last);
}

/**
 * One `/`-separated piece of a pattern, or `undefined` when git would call it invalid: a
 * backslash that escapes nothing is a pattern that never matches.
 */
function compileSegment(piece: string): readonly Element[] | undefined {
  const elements: Element[] = [];
  let index = 0;
  while (index < piece.length) {
    const char = piece[index] ?? '';
    if (char === '\\') {
      const literal = piece[index + 1];
      if (literal === undefined) {
        return undefined;
      }
      elements.push({ kind: 'literal', value: literal });
      index += 2;
      continue;
    }
    if (char === '*') {
      // Consecutive asterisks are one here: only a `**` piece of its own spans a directory.
      if (elements[elements.length - 1]?.kind !== 'star') {
        elements.push({ kind: 'star' });
      }
      index += 1;
      continue;
    }
    if (char === '?') {
      elements.push({ kind: 'any' });
      index += 1;
      continue;
    }
    if (char === '[') {
      const parsed = compileClass(piece, index);
      if (parsed === undefined) {
        return undefined;
      }
      elements.push(parsed.element);
      index = parsed.next;
      continue;
    }
    elements.push({ kind: 'literal', value: char });
    index += 1;
  }
  return elements;
}

/** A bracket expression and the index after it, or `undefined` when it is not one. */
function compileClass(
  piece: string,
  start: number,
): { element: Element; next: number } | undefined {
  let index = start + 1;
  let negated = false;
  if (piece[index] === '!' || piece[index] === '^') {
    negated = true;
    index += 1;
  }
  const members: Member[] = [];
  let first = true;
  while (index < piece.length) {
    let char = piece[index] ?? '';
    if (char === ']' && !first) {
      return { element: { kind: 'class', negated, members }, next: index + 1 };
    }
    first = false;
    if (char === '\\') {
      const literal = piece[index + 1];
      if (literal === undefined) {
        return undefined;
      }
      char = literal;
      index += 2;
    } else if (char === '[' && piece[index + 1] === ':') {
      const close = piece.indexOf(':]', index + 2);
      const name = close === -1 ? '' : piece.slice(index + 2, close);
      if (!Object.hasOwn(POSIX_CLASSES, name)) {
        return undefined;
      }
      members.push({ kind: 'named', name });
      index = close + 2;
      continue;
    } else {
      index += 1;
    }
    const after = piece[index + 1];
    if (piece[index] === '-' && after !== undefined && after !== ']') {
      let to = after;
      let next = index + 2;
      if (to === '\\') {
        const literal = piece[index + 2];
        if (literal === undefined) {
          return undefined;
        }
        to = literal;
        next = index + 3;
      }
      members.push({ kind: 'range', from: char, to });
      index = next;
      continue;
    }
    members.push({ kind: 'range', from: char, to: char });
  }
  return undefined;
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
