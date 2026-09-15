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
  GRANT_EXCLUDED_DIRS,
  MAX_GRANT_PATH_BYTES,
  grantChildren,
  grantUnion,
  isGrantedPath,
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
    '.env.production',
    // The family goes with the name: a file that is a template for secrets is not worth the
    // one real secret a narrower rule would miss.
    '.env.example',
    'src/.env.example',
    '.ENV',
    'src/.Env.Local',
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

test('excludes hold on case-folding checkouts, where .GIT is .git', () => {
  for (const folded of [
    '.GIT/config',
    'src/.Git/HEAD',
    'NODE_MODULES/left-pad/index.js',
    'Node_Modules/left-pad/index.js',
    'TARGET/debug/build',
    '.Env',
    'SRC/.ENv.PRODUCTION',
    '.AWS/credentials',
    '.NPMRC',
  ]) {
    assert.equal(isGrantedPath(folded), false, `${folded} must not be listed`);
  }
  // The lowercase forms stay excluded, and ordinary names stay listed.
  assert.equal(isGrantedPath('.git/config'), false);
  assert.equal(isGrantedPath('src/main.rs'), true);
  assert.equal(isGrantedPath('GITIGNORE'), true, 'a prefix of an excluded name is not one');
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
    'certs/chain.PEM',
    'certs/server.key',
    'certs/server.KEY',
  ]) {
    assert.equal(isGrantedPath(secret), false, `${secret} must not be listed`);
  }
  // Near-misses stay listed: the rule names secrets, not substrings of ordinary files.
  // The key prefixes match broadly on purpose: a copied key with a suffix is still a
  // key, and the cost of leaving out a notes file is not a secret in the room.
  assert.equal(isGrantedPath('src/id_rsa_notes.md'), false);
  for (const ordinary of ['mykey.txt', 'pem.pem.pem.bak', 'monkey.txt']) {
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

test('a tree is derived by splitting the listing, and directories are the implication', () => {
  const paths = ['README.md', 'src/main.rs', 'src/deep/nested.rs', 'docs/guide/intro.md'];

  assert.deepEqual(grantChildren(paths), [
    { name: 'docs', path: 'docs', directory: true },
    { name: 'src', path: 'src', directory: true },
    { name: 'README.md', path: 'README.md', directory: false },
  ]);
  assert.deepEqual(grantChildren(paths, 'src'), [
    { name: 'deep', path: 'src/deep', directory: true },
    { name: 'main.rs', path: 'src/main.rs', directory: false },
  ]);
  assert.deepEqual(grantChildren(paths, 'src/deep'), [
    { name: 'nested.rs', path: 'src/deep/nested.rs', directory: false },
  ]);
  assert.deepEqual(grantChildren(paths, 'docs/guide'), [
    { name: 'intro.md', path: 'docs/guide/intro.md', directory: false },
  ]);

  // Nothing is invented: a directory only exists because a path goes through it.
  assert.deepEqual(grantChildren(paths, 'src/deep/nested.rs'), []);
  assert.deepEqual(grantChildren(paths, 'nope'), []);
  assert.deepEqual(grantChildren([], ''), []);
});

test('a path that is both a directory and a file is drawn as the directory', () => {
  // `doc.open` will accept anything non-blank, so a listing can name `src` beside `src/main.rs`.
  assert.deepEqual(grantChildren(['src', 'src/main.rs']), [
    { name: 'src', path: 'src', directory: true },
  ]);
});

test('a tree draws no row for a path the grant would never publish', () => {
  // A server-supplied listing becomes tree rows, picker entries and URIs: whatever the
  // receipt gate let through — or whatever a hostile listing carried before it — draws
  // nothing here unless the grant would publish it.
  assert.deepEqual(
    grantChildren(['src/main.rs', '../etc/passwd', '.env', 'a\\b.txt', 'src/../../x']),
    [{ name: 'src', path: 'src', directory: true }],
  );
  assert.deepEqual(grantChildren(['.env', '..', 'src//x']), []);
});
