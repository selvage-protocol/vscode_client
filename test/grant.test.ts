/**
 * The grant's shape, pinned without an editor: what a host may publish, how a listing is
 * ordered, and what a receiver derives from one.
 *
 * Every rule here is one a peer's or a file system's input could otherwise break — a path that
 * escapes the folder, a name the defaults exclude, a listing a client must not re-sort — so
 * each is checked against the shape it is supposed to reject and the one it must keep.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GRANT_BINARY_SUFFIXES,
  GRANT_EXCLUDED_DIRS,
  MAX_GRANT_FILE_BYTES,
  MAX_GRANT_PATH_BYTES,
  grantUnion,
  isBinaryNamedPath,
  isGrantedPath,
  isIgnoredPath,
  overFileBound,
  sortGrant,
} from '../src/bridge/grant.ts';
import type { IgnoreSource } from '../src/bridge/grant.ts';

test('a granted path is workspace-relative, and one that could resolve elsewhere is not', () => {
  for (const good of [
    'README.md',
    'src/main.rs',
    'src/deep/nested/file.txt',
    '.github/workflows/ci.yml',
    'environment',
    'a file with spaces.txt',
    'envelope.ts',
  ]) {
    assert.equal(isGrantedPath(good), true, `${good} should be part of the grant`);
  }

  for (const bad of [
    '',
    '   ',
    '/etc/passwd',
    'src/../../etc/passwd',
    '..',
    './src/main.rs',
    'src//main.rs',
    'src/./main.rs',
    'src\\main.rs',
    'C:\\Windows\\system32',
  ]) {
    assert.equal(isGrantedPath(bad), false, `${bad} must not be part of the grant`);
  }
});

test('the defaults DESIGN.md names are excluded, and so is the tree that makes a walk pathological', () => {
  for (const excluded of [
    '.git/config',
    '.git',
    'src/.git/HEAD',
    '.env',
    'src/.env',
    '.env.local',
    'src/.env.production.local',
    '.envrc',
    'src/.envrc',
    '.npmrc',
    '.pypirc',
  ]) {
    assert.equal(isGrantedPath(excluded), false, `${excluded} must not be listed`);
  }
  for (const dir of GRANT_EXCLUDED_DIRS) {
    assert.equal(isGrantedPath(`${dir}/anything.txt`), false, `${dir}/ must not be walked`);
    assert.equal(isGrantedPath(dir), false, `${dir} must not be listed`);
  }
});

test('excludes fold only where the filesystem does, and match exactly elsewhere', () => {
  // On a case-sensitive checkout `Build/` is an ordinary directory, not `build/`: Linux
  // pays nothing for macOS's filesystem.
  for (const platform of ['linux', 'freebsd']) {
    for (const ordinary of ['Build/output.o', 'Vendor/lib.js', 'TARGET/x', '.GIT/config']) {
      assert.equal(
        isGrantedPath(ordinary, platform),
        true,
        `${ordinary} should be shareable on ${platform}`,
      );
    }
    for (const excluded of ['build/output.o', '.git/config', 'node_modules/dep/index.js']) {
      assert.equal(
        isGrantedPath(excluded, platform),
        false,
        `${excluded} must not be listed on ${platform}`,
      );
    }
  }
  // Where the filesystem folds, the folded forms are stopped too.
  for (const platform of ['darwin', 'win32']) {
    for (const folded of [
      '.GIT/config',
      'src/.Git/HEAD',
      'NODE_MODULES/left-pad/index.js',
      'Node_Modules/left-pad/index.js',
      'TARGET/debug/build',
      'Build/output.o',
      'Vendor/lib.js',
      '.Env',
      'src/.Env.Local',
      '.AWS/credentials',
      '.NPMRC',
      'certs/chain.PEM',
      'certs/server.KEY',
    ]) {
      assert.equal(
        isGrantedPath(folded, platform),
        false,
        `${folded} must not be listed on ${platform}`,
      );
    }
  }
  // An unknown host keeps the fold: sharing less is the safer error.
  assert.equal(isGrantedPath('Build/output.o', ''), false);
  // The lowercase forms stay excluded everywhere, and ordinary names stay listed.
  assert.equal(isGrantedPath('.git/config'), false);
  assert.equal(isGrantedPath('src/main.rs'), true);
  assert.equal(isGrantedPath('GITIGNORE'), true, 'a prefix of an excluded name is not one');
});

test('secret-bearing .env files are out, templates stay shareable', () => {
  for (const secret of [
    '.env',
    'src/.env',
    '.env.local',
    '.env.production.local',
    'src/.env.staging.local',
    '.env.ci.local',
  ]) {
    assert.equal(isGrantedPath(secret), false, `${secret} must not be listed`);
  }
  // Templates carry no secrets: the pairing flow that shares them keeps working.
  for (const template of [
    '.env.example',
    'src/.env.example',
    '.env.sample',
    '.env.staging.sample',
    '.env.template',
    '.env.production.template',
  ]) {
    assert.equal(isGrantedPath(template), true, `${template} should be part of the grant`);
  }
  // `.env.<name>` without `.local` is configuration, not secret, by decision: denying the
  // whole family back would take the templates with it. Stated, not smuggled.
  assert.equal(isGrantedPath('.env.production'), true);
  assert.equal(isGrantedPath('src/.env.development'), true);
  // The fold follows the platform, like the directories.
  assert.equal(isGrantedPath('.ENV', 'darwin'), false);
  assert.equal(isGrantedPath('.Env.Local', 'darwin'), false);
  assert.equal(isGrantedPath('.ENV', 'linux'), true);
  assert.equal(isGrantedPath('.env.example', 'darwin'), true);
});

test('secret file names match the leaf only, never a whole directory', () => {
  // A directory named like a key is not a key: the subtree stays in the room.
  for (const ordinary of [
    'id_rsa_backup/keys.txt',
    'id_ed25519-old/keys.txt',
    'configs/.npmrc/notes.txt',
    '.envrc.d/notes.txt',
    'notes/keyboard-shortcuts.md',
  ]) {
    assert.equal(isGrantedPath(ordinary), true, `${ordinary} should be part of the grant`);
  }
  // The leaf rule itself is unchanged: keys and secret files are still out.
  for (const secret of [
    'id_rsa',
    '.ssh/id_rsa',
    '.ssh/id_rsa.pub',
    'src/id_rsa_notes.md',
    '.envrc',
    'configs/.npmrc',
    'certs/server.pem',
    'certs/server.key',
  ]) {
    assert.equal(isGrantedPath(secret), false, `${secret} must not be listed`);
  }
  // A rename past a suffix rule re-shares the file: accident-guard, not boundary, stated
  // where the excludes are defined rather than chased here.
  for (const renamed of ['certs/server.pem.bak', '.npmrc.bak', '.envrc.bak', 'my.pem.bak']) {
    assert.equal(isGrantedPath(renamed), true, `${renamed} re-shares by rename, stated`);
  }
});

test('credential stores and private keys are never part of the grant', () => {
  for (const secret of [
    '.aws/credentials',
    'src/.aws/config',
    '.envrc',
    '.npmrc',
    '.pypirc',
    'id_rsa',
    '.ssh/id_rsa',
    '.ssh/id_ed25519',
    '.ssh/id_ecdsa',
    '.ssh/id_dsa',
    '.ssh/id_rsa.pub',
    'certs/server.pem',
    'certs/chain.pem',
    'certs/server.key',
    '.netrc',
    'home/_netrc',
    '.git-credentials',
    '.pgpass',
    'public/.htpasswd',
    '.ssh/config',
    '.ssh/known_hosts',
    'home/.ssh/authorized_keys',
    '.gnupg/pubring.kbx',
    'certs/client.p12',
    'certs/client.pfx',
    'android/release.keystore',
    'server/truststore.jks',
    'keys/deploy.ppk',
    'infra/terraform.tfstate',
    'infra/terraform.tfstate.backup',
  ]) {
    assert.equal(isGrantedPath(secret), false, `${secret} must not be listed`);
  }
  // Near-misses stay listed: the rule names secrets, not substrings of ordinary files.
  // The key prefixes match broadly on purpose: a copied key with a suffix is still a
  // key, and the cost of leaving out a notes file is not a secret in the room.
  assert.equal(isGrantedPath('src/id_rsa_notes.md'), false);
  for (const ordinary of [
    'mykey.txt',
    'pem.pem.pem.bak',
    'monkey.txt',
    'docs/ssh.md',
    'infra/main.tf',
    'netrc.md',
    'src/keystore.ts',
    'docs/ppk.md',
  ]) {
    assert.equal(isGrantedPath(ordinary), true, `${ordinary} should be part of the grant`);
  }
});

test('a name that spoofs a tree or picker row is not a path the room shares', () => {
  for (const spoofed of [
    'a\u0000b.txt',
    'a\u001fb.txt',
    'a\u007fb.txt',
    'a\u009fb.txt',
    'src/a\u202eb.txt',
    'src/a\u202ab.txt',
    'src/a\u200fb.txt',
    'src/a\u200eb.txt',
    'src/a\u2066b.txt',
    'src/a\u061cb.txt',
    'src/a\ufeffb.txt',
    'src/a\u2028b.txt',
    'src/a\u2029b.txt',
    'src/a\u000ab.txt',
  ]) {
    assert.equal(isGrantedPath(spoofed), false, `${JSON.stringify(spoofed)} must not be listed`);
  }
  // Visible non-ASCII names are ordinary files, not spoofs.
  for (const ordinary of ['ünïcode/日本語.md', 'a\u00e9b.txt', '😀.txt']) {
    assert.equal(isGrantedPath(ordinary), true, `${ordinary} should be part of the grant`);
  }
});

test('a path is bounded in bytes, which is what the server bounds', () => {
  const justInside = `a/${'b'.repeat(MAX_GRANT_PATH_BYTES - 2)}`;
  assert.equal(justInside.length, MAX_GRANT_PATH_BYTES);
  assert.equal(isGrantedPath(justInside), true);
  assert.equal(isGrantedPath(`a/${'b'.repeat(MAX_GRANT_PATH_BYTES - 1)}`), false);

  // Counted in bytes, not code units: an astral character is four bytes and two units.
  const astral = '😀'.repeat(MAX_GRANT_PATH_BYTES / 4);
  assert.equal(isGrantedPath(astral), true);
  assert.equal(isGrantedPath(`${astral}😀`), false);
});

test('the size gate counts bytes without encoding a buffer that cannot be over', (t) => {
  // The gate is asked of every shared buffer on every keystroke, so what it must not do is
  // encode the whole buffer to learn what its length already answers. The counter below is
  // the cost: an encoder constructed on the fast path is a failure, not a slow test.
  const Encoder = globalThis.TextEncoder;
  let encodes = 0;
  globalThis.TextEncoder = class {
    encode(input?: string): Uint8Array {
      encodes += 1;
      return new Encoder().encode(input);
    }
  } as unknown as typeof Encoder;
  t.after(() => {
    globalThis.TextEncoder = Encoder;
  });

  const counts = (text: string): { over: boolean; encodes: number } => {
    encodes = 0;
    return { over: overFileBound(text), encodes };
  };

  // Under a third of the bound: bytes cannot exceed the bound, so the length decides.
  const small = counts('a'.repeat(MAX_GRANT_FILE_BYTES / 3));
  assert.deepEqual(small, { over: false, encodes: 0 });
  // Past the bound in code units: bytes are never fewer, so nothing needs encoding.
  const long = counts('a'.repeat(MAX_GRANT_FILE_BYTES + 1));
  assert.deepEqual(long, { over: true, encodes: 0 });
  // In the range where the answer depends on the characters, the exact count is used.
  assert.deepEqual(counts('é'.repeat(MAX_GRANT_FILE_BYTES / 2 + 1)), {
    over: true,
    encodes: 1,
  });
  assert.deepEqual(counts('a'.repeat(MAX_GRANT_FILE_BYTES / 2)), {
    over: false,
    encodes: 1,
  });
});

test('a listing is written ascending by UTF-16 code unit, not by code point or byte', () => {
  // Vector `022`: the surrogate U+D83D sorts before U+FF46 as code units, while the code
  // point behind the surrogate pair is the greater one. `R` (U+0052) leads both.
  const paths = ['ｆ.txt', 'README.md', '😀.txt', 'src/main.rs'];
  const byCodeUnit = ['README.md', 'src/main.rs', '😀.txt', 'ｆ.txt'];
  assert.deepEqual(sortGrant(paths), byCodeUnit);
  assert.deepEqual(paths, ['ｆ.txt', 'README.md', '😀.txt', 'src/main.rs'], 'the input moved');

  // The other two orders a client could reach for, both of which §5 forbids: a code-point
  // sort puts the astral path last and a byte sort last of all.
  const points = (value: string): number[] => [...value].map((one) => one.codePointAt(0) ?? 0);
  const byCodePoint = [...paths].sort((left, right) => {
    const a = points(left);
    const b = points(right);
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
      if (a[index] !== b[index]) {
        return (a[index] ?? 0) - (b[index] ?? 0);
      }
    }
    return a.length - b.length;
  });
  assert.notDeepEqual(byCodePoint, byCodeUnit, 'the orders this test distinguishes are the same');
  const byBytes = [...paths].sort((left, right) =>
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')),
  );
  assert.notDeepEqual(byBytes, byCodeUnit);
});

test('what a window offers is the grant unioned with the room\u2019s open documents', () => {
  assert.deepEqual(
    grantUnion(['src/main.rs', 'README.md'], ['docs/notes.md', 'src/main.rs']),
    ['README.md', 'docs/notes.md', 'src/main.rs'],
  );
  // A server with no grant still offers everything the room holds open.
  assert.deepEqual(grantUnion([], ['b.rs', 'a.rs']), ['a.rs', 'b.rs']);
  assert.deepEqual(grantUnion([], []), []);
});

// A room lists the paths a host may serve, and a host that has not been updated still names a
// file whose bytes no session can carry: the guest is then offered one it can never fetch, and
// finds that out by asking. The name is what both gates judge by, because a walk reads no bytes.
test('a name that declares a format a room cannot carry is refused and not offered', () => {
  for (const path of [
    'bundle.zip',
    'blob.bin',
    'src/assets/logo.png',
    'docs/logo.PNG',
    'build/app.wasm',
    'vendor/libz.so',
    'notes.db.sqlite3',
  ]) {
    assert.equal(isBinaryNamedPath(path), true, `${path} declares a format a room cannot carry`);
  }
  // A name is a declaration and not proof: what is shareable keeps its place, whether the
  // name declares a text format or nothing at all. `.pdf` is the deliberate absence — a
  // text-only PDF is a file the read serves, so listing one is what agrees with the read.
  for (const path of [
    'README.md',
    'src/main.rs',
    'docs/report.pdf',
    'data.bin.txt',
    'src/images.ts',
    'chart.eps',
    'build/Makefile',
  ]) {
    assert.equal(isBinaryNamedPath(path), false, `${path} does not declare one`);
  }
  // The leaf decides, so a directory named after a format is governed by the directory
  // excludes alone, and a leaf that is nothing but the suffix declares no name.
  assert.equal(isBinaryNamedPath('dist/notes.txt'), false);
  assert.equal(isBinaryNamedPath('.zip'), false);
  // Folding is the name's and not the filesystem's: `.JPG` declares the same format as `.jpg`
  // wherever it sits, which is the opposite of what the directory and secret excludes do.
  assert.equal(isBinaryNamedPath('IMG_01.JPG'), true);
  assert.equal(isBinaryNamedPath('img_01.jpg'), true);

  for (const suffix of GRANT_BINARY_SUFFIXES) {
    assert.equal(isBinaryNamedPath(`file${suffix}`), true, `${suffix} was not matched`);
    assert.equal(suffix, suffix.toLowerCase(), `${suffix} is not spelled in folded form`);
  }

  // And the offering drops what the room's listing may still name, so a guest is not offered
  // a path no fetch can fill, whether or not its host was updated.
  assert.deepEqual(
    grantUnion(['src/main.rs', 'bundle.zip'], ['logo.png', 'src/main.rs']),
    ['src/main.rs'],
  );
});

// A host's own ignore files, read off plain strings: the layer that narrows what a session
// shares by itself and what a peer may ask for, above the name-only excludes a receiver also
// applies. Every rule below is gitignore(5)'s, and each one is pinned against the shape it
// decides: where a pattern is anchored, the three `**` positions, the directory-only trailing
// slash, negation and the directory that stops it, one source overriding another, and the lines
// git calls invalid.

/** One source per entry, lowest precedence first, as a host reads them off its disk. */
function ignoring(
  ...entries: readonly (readonly [string, string])[]
): IgnoreSource[] {
  return entries.map(([dir, text]) => ({ dir, text }));
}

test('a folder with no ignore file leaves everything in, and a source governs only what is under it', () => {
  assert.equal(isIgnoredPath([], 'anything/at/all.txt', false), false);

  const below = ignoring(['sub', 'note.txt\nsibling\n']);
  assert.equal(isIgnoredPath(below, 'sub/note.txt', false), true);
  assert.equal(isIgnoredPath(below, 'sub/deep/note.txt', false), true, 'the name matches any depth');
  assert.equal(isIgnoredPath(below, 'sub/sibling/x.txt', false), true, 'a directory match takes its tree');
  assert.equal(isIgnoredPath(below, 'note.txt', false), false, 'the source does not govern above itself');
  assert.equal(isIgnoredPath(below, 'other/note.txt', false), false);
  assert.equal(isIgnoredPath(below, 'sub', true), false, 'nor the directory it is in');
});

test('a pattern matches where it is anchored, and at any depth where it is not', () => {
  const anchored = ignoring(['', '/build\nsrc/gen\n']);
  assert.equal(isIgnoredPath(anchored, 'build', true), true);
  assert.equal(isIgnoredPath(anchored, 'build/out.js', false), true);
  assert.equal(isIgnoredPath(anchored, 'nested/build', true), false, 'a leading slash anchors');
  assert.equal(isIgnoredPath(anchored, 'src/gen', false), true);
  assert.equal(isIgnoredPath(anchored, 'nested/src/gen', false), false, 'a middle slash anchors');

  const loose = ignoring(['', 'build\n*.tmp\n']);
  assert.equal(isIgnoredPath(loose, 'nested/build/out.js', false), true);
  assert.equal(isIgnoredPath(loose, 'a/b/c.tmp', false), true);
  assert.equal(isIgnoredPath(loose, 'buildtools/out.js', false), false, 'a name that only starts alike');
  assert.equal(isIgnoredPath(loose, 'x.tmp/y', false), true, 'an ignored directory takes its tree');
});

test('`*` and `?` do not cross a slash', () => {
  const ones = ignoring(['', 'a?c\nlogs/*\n']);
  assert.equal(isIgnoredPath(ones, 'abc', false), true);
  assert.equal(isIgnoredPath(ones, 'a/c', false), false, '`?` is one character, and a slash is not it');
  assert.equal(isIgnoredPath(ones, 'logs/x.log', false), true);
  assert.equal(isIgnoredPath(ones, 'logs/deep', true), true);
  assert.equal(isIgnoredPath(ones, 'logs/deep/x.log', false), true, 'the matched directory is enough');
  assert.equal(isIgnoredPath(ones, 'other/logs/x.log', false), false, 'a middle slash anchors it');
});

test('`**` spans directories in each of the three positions', () => {
  const leading = ignoring(['', '**/generated\n']);
  assert.equal(isIgnoredPath(leading, 'generated', true), true);
  assert.equal(isIgnoredPath(leading, 'a/b/generated', true), true);
  assert.equal(isIgnoredPath(leading, 'a/generated/x.txt', false), true);
  assert.equal(isIgnoredPath(leading, 'regenerated', true), false);

  const trailing = ignoring(['', 'logs/**\n']);
  assert.equal(isIgnoredPath(trailing, 'logs', true), false, '`logs/**` is what is inside logs');
  assert.equal(isIgnoredPath(trailing, 'logs/a', true), true);
  assert.equal(isIgnoredPath(trailing, 'logs/a/b/c.txt', false), true);

  const middle = ignoring(['', 'a/**/b\n']);
  assert.equal(isIgnoredPath(middle, 'a/b', true), true, 'zero directories in between');
  assert.equal(isIgnoredPath(middle, 'a/x/y/b', true), true);
  assert.equal(isIgnoredPath(middle, 'a/x/y/b/z.txt', false), true);
  assert.equal(isIgnoredPath(middle, 'x/a/b', true), false, 'a middle slash anchors the pattern');

  // Consecutive asterisks are one anywhere else, which is `*`: it never crosses a slash.
  const regular = ignoring(['', 'a**b\nx**/y\n']);
  assert.equal(isIgnoredPath(regular, 'aXXb', true), true);
  assert.equal(isIgnoredPath(regular, 'x/y', false), true);
  assert.equal(isIgnoredPath(regular, 'xzz/y', false), true);
  assert.equal(isIgnoredPath(regular, 'x/z/y', false), false, 'the run stops at the slash');
  assert.equal(isIgnoredPath(regular, 'q/x/y', false), false);
  assert.equal(isIgnoredPath(regular, 'aXX/b', false), false);
});

test('a trailing slash makes a pattern directory-only', () => {
  const ones = ignoring(['', 'out/\ndocs/build/\n']);
  assert.equal(isIgnoredPath(ones, 'out', true), true);
  assert.equal(isIgnoredPath(ones, 'out', false), false, 'a file named `out` is not the directory');
  assert.equal(isIgnoredPath(ones, 'a/out', true), true, 'no other slash, so any depth matches');
  assert.equal(isIgnoredPath(ones, 'docs/build', true), true);
  assert.equal(isIgnoredPath(ones, 'a/docs/build', true), false, 'the middle slash anchors it');
});

test('a negation re-includes, and an ignored directory stops it', () => {
  const ones = ignoring(['', '*.log\n!keep.log\n']);
  assert.equal(isIgnoredPath(ones, 'a.log', false), true);
  assert.equal(isIgnoredPath(ones, 'keep.log', false), false);
  assert.equal(isIgnoredPath(ones, 'deep/keep.log', false), false, 'the name matches any depth');

  // Git never descends into an ignored directory, so nothing inside one can be re-included.
  const trapped = ignoring(['', 'build/\n!build/keep.txt\n']);
  assert.equal(isIgnoredPath(trapped, 'build/keep.txt', false), true);
  assert.equal(isIgnoredPath(trapped, 'build/keep/x.txt', false), true);

  // What is inside a directory is not the directory: a negation that re-includes one is a
  // directory git descends into.
  const reopened = ignoring(['', 'build/*\n!build/keep/\n']);
  assert.equal(isIgnoredPath(reopened, 'build/keep', true), false);
  assert.equal(isIgnoredPath(reopened, 'build/keep/x.txt', false), false);
  assert.equal(isIgnoredPath(reopened, 'build/other.txt', false), true);
});

test('a path under an ignored directory is left out however deep it is', () => {
  const ones = ignoring(['', 'out/\n']);
  for (const path of ['out/x', 'out/a/b/c.txt', 'deep/out/a/b.txt']) {
    assert.equal(isIgnoredPath(ones, path, false), true, `${path} is under an ignored directory`);
  }
  for (const path of ['output/x.txt', 'out.txt']) {
    assert.equal(isIgnoredPath(ones, path, false), false, `${path} is not under one`);
  }
  assert.equal(isIgnoredPath(ones, 'out', false), false, 'the file of that name is not the directory');
});

test('sources are read lowest precedence first, and the last match decides', () => {
  // The first two share a directory because `<folder>/.git/info/exclude` stands beside the
  // folder's own `.gitignore`: the `.gitignore` is the higher precedence of the two, and it
  // overrides rather than being overridden.
  const ones = ignoring(
    ['', '*.log\n*.tmp\n'],
    ['', '!keep.log\n'],
    ['sub', '!note.tmp\n'],
  );
  assert.equal(isIgnoredPath(ones, 'debug.log', false), true);
  assert.equal(isIgnoredPath(ones, 'keep.log', false), false, 'a `.gitignore` overrides info/exclude');
  assert.equal(isIgnoredPath(ones, 'a.tmp', false), true);
  assert.equal(isIgnoredPath(ones, 'sub/a.log', false), true);
  assert.equal(isIgnoredPath(ones, 'sub/note.tmp', false), false, 'the deeper source decides');
  assert.equal(isIgnoredPath(ones, 'note.tmp', false), true, 'and does not govern above itself');

  // The same two sources the other way round decide the other way, which is the order rather
  // than the patterns.
  const reversed = ignoring(['', '!keep.log\n'], ['', '*.log\n']);
  assert.equal(isIgnoredPath(reversed, 'keep.log', false), true);
});

test('comments, blanks, escaped characters and trailing spaces', () => {
  const ones = ignoring(['', '# a comment\n\n\\#literal\n\\!bang\nspace\\ \ntrail   \n\\a\n']);
  for (const path of ['#literal', '!bang']) {
    assert.equal(isIgnoredPath(ones, path, false), true, `a backslash makes the first ${path} literal`);
  }
  assert.equal(isIgnoredPath(ones, 'space ', false), true, 'an escaped space is part of the name');
  assert.equal(isIgnoredPath(ones, 'space', false), false);
  assert.equal(isIgnoredPath(ones, 'trail', false), true, 'trailing spaces are dropped');
  assert.equal(isIgnoredPath(ones, 'trail   ', false), false, 'and that name is not the pattern');
  assert.equal(isIgnoredPath(ones, 'a', false), true, 'a backslash escapes an ordinary character');
  for (const path of ['# a comment', 'literal', 'bang']) {
    assert.equal(isIgnoredPath(ones, path, false), false, `${path} is named by no pattern`);
  }
});

test('character classes, negated classes and the classes fnmatch(3) names', () => {
  const ones = ignoring(['', '[abc].txt\n[!xyz].log\nd[]]e\n[]]b.txt\n[[:digit:]]g\nq[![:space:]]z\n']);
  assert.equal(isIgnoredPath(ones, 'b.txt', false), true);
  assert.equal(isIgnoredPath(ones, 'z.txt', false), false, 'a class is the set of characters it names');
  assert.equal(isIgnoredPath(ones, 'a.log', false), true, 'a negated class matches what it does not name');
  assert.equal(isIgnoredPath(ones, 'x.log', false), false);
  assert.equal(isIgnoredPath(ones, 'd]e', false), true);
  assert.equal(isIgnoredPath(ones, ']b.txt', false), true, 'a `]` first in a class is a member');
  assert.equal(isIgnoredPath(ones, 'b]b.txt', false), false);
  assert.equal(isIgnoredPath(ones, '4g', false), true);
  assert.equal(isIgnoredPath(ones, 'ag', false), false);
  assert.equal(isIgnoredPath(ones, 'qaz', false), true);
  assert.equal(isIgnoredPath(ones, 'q z', false), false);
});

test('a line git calls invalid names nothing', () => {
  const ones = ignoring(['', 'trailing\\\nunclosed[a-z\nnamed[[:nope:]]x\n']);
  for (const path of ['trailing', 'uncloseda', 'unclosed[a-z', 'namedx']) {
    assert.equal(isIgnoredPath(ones, path, false), false, `${path} is named by no valid pattern`);
  }
});

test('ignore patterns fold case only where the filesystem folds', () => {
  const ones = ignoring(['', 'build/\n*.LOG\n']);
  for (const platform of ['darwin', 'win32', '']) {
    assert.equal(isIgnoredPath(ones, 'BUILD', true, platform), true, `BUILD folds on ${platform}`);
    assert.equal(isIgnoredPath(ones, 'a.log', false, platform), true, `a.log folds on ${platform}`);
  }
  for (const platform of ['linux', 'freebsd']) {
    assert.equal(isIgnoredPath(ones, 'BUILD', true, platform), false, `BUILD is another name on ${platform}`);
    assert.equal(isIgnoredPath(ones, 'a.log', false, platform), false, `a.log is another name on ${platform}`);
  }
  // The source's own directory folds with its patterns: on a folding filesystem `Sub` in a
  // source's `dir` and `sub/` in a path name one directory.
  const below = ignoring(['Sub', 'note.txt\n']);
  assert.equal(isIgnoredPath(below, 'sub/note.txt', false, 'darwin'), true);
  assert.equal(isIgnoredPath(below, 'sub/note.txt', false, 'linux'), false);
});

test('a source is compiled once for the object and never once per platform', () => {
  // A walk asks about every entry of a directory with the same source objects, so a compiled
  // form is remembered on the object itself. What the answer is may not depend on which call
  // asked first, on how often it was asked, or on which platform asked before it — so every
  // question below is asked in both orders, and both objects are asked on both platforms.
  const ones = ignoring(['', 'BUILD/\n*.LOG\n']);
  const questions: ReadonlyArray<readonly [string, boolean, string, boolean]> = [
    ['build', true, 'darwin', true],
    ['build', true, 'linux', false],
    ['BUILD', true, 'linux', true],
    ['a.log', false, 'darwin', true],
    ['A.LOG', false, 'linux', true],
    ['a.log', false, 'linux', false],
  ];
  for (const order of [questions, [...questions].reverse()]) {
    for (const [path, isDirectory, platform, expected] of order) {
      assert.equal(
        isIgnoredPath(ones, path, isDirectory, platform),
        expected,
        `${path} on ${platform}`,
      );
    }
  }

  // A fold decision is remembered beside the other one rather than instead of it: the same object
  // answers each platform with its own reading, whichever was asked first.
  for (const order of [
    ['linux', 'darwin', 'linux'],
    ['darwin', 'linux', 'darwin'],
  ] as const) {
    const source = ignoring(['', 'Mixed/\n']);
    const expected = { linux: false, darwin: true } as const;
    for (const platform of order) {
      assert.equal(
        isIgnoredPath(source, 'mixed', true, platform),
        expected[platform],
        `mixed on ${platform} after ${order.join(' then ')}`,
      );
    }
  }

  // Two objects are two sources, however alike they read: neither one's compiled form answers for
  // the other, asked in either order.
  const first = ignoring(['', 'one.txt\n']);
  const second = ignoring(['', 'two.txt\n']);
  assert.equal(isIgnoredPath(first, 'one.txt', false), true);
  assert.equal(isIgnoredPath(second, 'one.txt', false), false);
  assert.equal(isIgnoredPath(first, 'one.txt', false), true);
  assert.equal(isIgnoredPath(second, 'two.txt', false), true);
  assert.equal(isIgnoredPath(first, 'two.txt', false), false);
});
