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
    '.envrc',
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
  ]) {
    assert.equal(isGrantedPath(excluded), false, `${excluded} must not be listed`);
  }
  for (const dir of GRANT_EXCLUDED_DIRS) {
    assert.equal(isGrantedPath(`${dir}/anything.txt`), false, `${dir}/ must not be walked`);
    assert.equal(isGrantedPath(dir), false, `${dir} must not be listed`);
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
