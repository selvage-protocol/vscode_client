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
  overFileBound,
  sortGrant,
} from '../src/bridge/grant.ts';

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
