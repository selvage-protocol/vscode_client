/**
 * The document policy, on its own: line endings, the smallest change between two texts,
 * and the comparison that replaces an echo guard. All of it is pure, which is the point —
 * `npm run test:fast` runs these with no editor, no socket and no server.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyChange,
  diff,
  matchesReplica,
  render,
  toCrdt,
} from '../src/bridge/editing.ts';
import { peerColour, translucent } from '../src/bridge/cursors.ts';
import { isVirtual, parseVirtualUri, virtualUri } from '../src/bridge/virtual.ts';

test('the replica holds LF, and a document renders with its own line endings', () => {
  assert.equal(toCrdt('a\r\nb\r\n'), 'a\nb\n');
  assert.equal(toCrdt('a\nb\n'), 'a\nb\n');
  assert.equal(toCrdt(''), '');
  // A lone CR is not a line ending an editor here produces, and inventing one would edit a
  // document the user cannot see changed.
  assert.equal(toCrdt('a\rb'), 'a\rb');

  assert.equal(render('a\nb\n', '\n'), 'a\nb\n');
  assert.equal(render('a\nb\n', '\r\n'), 'a\r\nb\r\n');
  assert.equal(render('', '\r\n'), '');

  // The round trip a CRLF document lives in: its buffer keeps CRLF, the replica never sees
  // one, and the difference does not make the buffer look like a change (§SPIKES 3).
  const buffer = 'line one\r\nline two\r\n';
  assert.equal(render(toCrdt(buffer), '\r\n'), buffer);
  assert.equal(matchesReplica(buffer, toCrdt(buffer)), true);
});

test('a diff replaces only what differs, wherever it is', () => {
  assert.deepEqual(diff('abc', 'abc'), { start: 0, end: 0, text: '' });
  assert.deepEqual(diff('abc', 'abd'), { start: 2, end: 3, text: 'd' });
  assert.deepEqual(diff('abc', 'abc def'), { start: 3, end: 3, text: ' def' });
  assert.deepEqual(diff('abc def', 'abc'), { start: 3, end: 7, text: '' });
  assert.deepEqual(diff('', 'whole'), { start: 0, end: 0, text: 'whole' });
  assert.deepEqual(diff('whole', ''), { start: 0, end: 5, text: '' });
  assert.deepEqual(diff('aaa', 'aaaa'), { start: 3, end: 3, text: 'a' });
  assert.deepEqual(diff('aaaa', 'aaa'), { start: 3, end: 4, text: '' });

  // A change in the middle leaves both ends alone: this is what keeps a remote edit from
  // collapsing undo granularity or resetting folding.
  const from = 'one\ntwo\nthree\nfour\n';
  const to = 'one\ntwo\nTHREE\nfour\n';
  const change = diff(from, to);
  assert.deepEqual(change, { start: 8, end: 13, text: 'THREE' });
  assert.equal(applyChange(from, change), to);
});

test('applying a diff reproduces the target text', () => {
  const cases: Array<[string, string]> = [
    ['', ''],
    ['', 'a'],
    ['a', ''],
    ['a\nb\n', 'a\nb\nc\n'],
    ['line one\nline two\n', 'line one\nXline two\n'],
    ['same', 'same'],
    ['\r\n', '\n'],
  ];
  for (const [from, to] of cases) {
    assert.equal(applyChange(from, diff(from, to)), to, `${JSON.stringify(from)} → ${to}`);
  }
});

test('a buffer that already holds the replica is not a change, in either line ending', () => {
  assert.equal(matchesReplica('a\n', 'a\n'), true);
  assert.equal(matchesReplica('a\r\n', 'a\n'), true);
  assert.equal(matchesReplica('a\n', 'a'), false);
  assert.equal(matchesReplica('', ''), true);
});

test('a guest document URI round-trips, and its room is not case-folded', () => {
  assert.equal(virtualUri('r-0aF1', 'src/main.rs'), 'selvage:/src/main.rs?room=r-0aF1');
  assert.deepEqual(parseVirtualUri(virtualUri('r-0aF1', 'src/main.rs')), {
    roomId: 'r-0aF1',
    path: 'src/main.rs',
  });

  // A path and a room are not this client's to normalise: a name with a space, a `?`, a
  // `#` or a non-ASCII character has to come back exactly, or the provider reads the wrong
  // document.
  for (const path of ['a b/c?d#e.txt', 'ünïcode/日本語.md', 'x%20y/z', 'dir/sub/file.ts']) {
    const uri = virtualUri('r-CASE', path);
    assert.deepEqual(parseVirtualUri(uri), { roomId: 'r-CASE', path }, uri);
  }

  assert.equal(isVirtual(virtualUri('r-1', 'a.ts')), true);
  assert.equal(isVirtual('file:///tmp/a.ts'), false);

  // A document this client cannot name is one it must not open.
  assert.equal(parseVirtualUri('file:///tmp/a.ts'), undefined);
  assert.equal(parseVirtualUri('selvage:/a.ts'), undefined);
  assert.equal(parseVirtualUri('selvage:/a.ts?room='), undefined);
  assert.equal(parseVirtualUri('selvage:/?room=r-1'), undefined);
});

test('a peer colour is a function of the peer id, the same on every client', () => {
  const first = peerColour('p-1a2b');
  assert.equal(peerColour('p-1a2b'), first);
  assert.match(first, /^#[0-9a-f]{6}$/);
  assert.notEqual(peerColour('p-1a2b'), undefined);

  // Not a constant: different peers have to be tellable apart often enough to be useful.
  const ids = ['p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6', 'p-7', 'p-8', 'p-9', 'p-10'];
  const colours = new Set(ids.map(peerColour));
  assert.ok(colours.size >= 4, `ten peers got ${colours.size} colours`);

  assert.equal(translucent('#e06c75', 1), '#e06c75ff');
  assert.equal(translucent('#e06c75', 0.25), '#e06c7540');
  assert.equal(translucent('#e06c75', 0), '#e06c7500');
});
