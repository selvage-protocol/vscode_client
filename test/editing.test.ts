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
  hasCarriageReturn,
  matchesReplica,
  render,
  toBufferOffset,
  toCrdt,
  toReplicaOffset,
} from '../src/bridge/editing.ts';
import { peerColour, translucent } from '../src/bridge/cursors.ts';

/**
 * The positions in `text` that are one half of an astral character without the other — the
 * code units no editor, no JSON decoder and no CRDT index can be handed on their own.
 */
function loneSurrogates(text: string): number[] {
  const found: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
      } else {
        found.push(index);
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      found.push(index);
    }
  }
  return found;
}

/** Whether `offset` is between the two code units of one astral character in `text`. */
function splitsPair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) {
    return false;
  }
  const high = text.charCodeAt(offset - 1);
  const low = text.charCodeAt(offset);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

/**
 * Everything wrong with the change `diff` worked out for this pair: it has to be applicable,
 * neither of its ends may be inside a character of either text, its `text` may not hold a
 * lone surrogate that `to` does not already hold itself, and — when both texts are whole —
 * no end of it may give up more than it has to. Only a `to` that holds half a character
 * leaves more than one well-formed change that gets there.
 */
function faults(from: string, to: string): string[] {
  const change = diff(from, to);
  const endTo = change.start + change.text.length;
  const found: string[] = [];
  const whole = loneSurrogates(from).length === 0 && loneSurrogates(to).length === 0;
  if (applyChange(from, change) !== to) found.push('does not reproduce the second text');
  if (change.text !== to.slice(change.start, endTo)) found.push('text is not from the second text');
  if (splitsPair(from, change.start)) found.push('start inside a character of the first text');
  if (splitsPair(from, change.end)) found.push('end inside a character of the first text');
  if (splitsPair(to, change.start)) found.push('start inside a character of the second text');
  if (splitsPair(to, endTo)) found.push('text ends inside a character of the second text');
  if (whole && loneSurrogates(change.text).length > 0) found.push('text holds a lone surrogate');
  if (whole && change.text.length > 0) {
    if (
      change.start < change.end &&
      from[change.start] === to[change.start] &&
      !splitsPair(from, change.start + 1) &&
      !splitsPair(to, change.start + 1)
    ) {
      found.push('start could have been one code unit later');
    }
    if (
      change.end > change.start &&
      from[change.end - 1] === to[endTo - 1] &&
      !splitsPair(from, change.end - 1) &&
      !splitsPair(to, endTo - 1)
    ) {
      found.push('end could have been one code unit earlier');
    }
  }
  return found;
}

/** A deterministic source of numbers in [0, 1), so the property below is the same every run. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

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

test('a change is never cut through the middle of a surrogate pair', () => {
  // Two astral characters that share a high surrogate leave the boundary between the halves,
  // and the change carried the low surrogate on its own — `{"start":2,"end":3,"text":"\ude00"}`
  // — which a strict decoder (`vim.json.decode`) refuses. The range gives up one code unit
  // at each end instead, so the change is still an edit an editor can make.
  assert.deepEqual(diff('a\u{1F601}b\n', 'a\u{1F600}b\n'), { start: 1, end: 3, text: '\u{1F600}' });
  // The same character at the start of a text, at its end, and two of them together.
  assert.deepEqual(diff('\u{1F601}x', '\u{1F600}x'), { start: 0, end: 2, text: '\u{1F600}' });
  assert.deepEqual(diff('x\u{1F601}', 'x\u{1F600}'), { start: 1, end: 3, text: '\u{1F600}' });
  assert.deepEqual(diff('a\u{1F601}\u{1F601}b', 'a\u{1F600}\u{1F600}b'), {
    start: 1,
    end: 5,
    text: '\u{1F600}\u{1F600}',
  });
  // An insertion next to one, and a deletion of one: the boundary moves at both ends, then
  // at neither, because the range already covers the whole character.
  assert.deepEqual(diff('a\u{1F600}b', 'a\u{1F601}\u{1F600}b'), { start: 1, end: 3, text: '\u{1F601}\u{1F600}' });
  assert.deepEqual(diff('a\u{1F600}\u{1F601}b', 'a\u{1F600}b'), { start: 3, end: 5, text: '' });
  // A pair the second text completes: the first ends in half a character, and the change
  // carries the whole one.
  assert.deepEqual(diff('a\ud83d', 'a\u{1F601}'), { start: 1, end: 2, text: '\u{1F601}' });
});

test('every pair of texts over a small alphabet gets a whole-character change', () => {
  // Exhaustive rather than sampled, and each half of an emoji is an alphabet symbol on its
  // own: every way a boundary can land inside a character is in here, including the ones a
  // text that has already lost half of one produces.
  const symbols = ['a', 'b', '\u{1F600}', '\u{1F601}', '\ud83d', '\ude00'];
  const texts = [''];
  for (let length = 1; length <= 3; length += 1) {
    const build = (prefix: string, left: number): void => {
      if (left === 0) {
        texts.push(prefix);
        return;
      }
      for (const symbol of symbols) {
        build(prefix + symbol, left - 1);
      }
    };
    build('', length);
  }
  assert.equal(texts.length, 259, 'the sweep is smaller than it reads');
  for (const from of texts) {
    for (const to of texts) {
      assert.deepEqual(faults(from, to), [], `${JSON.stringify(from)} → ${JSON.stringify(to)}`);
    }
  }
});

test('random pairs of texts, astral characters included, get a whole-character change', () => {
  // The sweep is small and exhaustive; this is long and sampled, and half of the pairs are a
  // mutated copy of the other text — a shared context is where a boundary falls inside a
  // character. A seed rather than a clock, so a failure is a case anyone can rerun.
  const symbols = ['a', 'b', ' ', '\n', 'é', '日', '\u{1F600}', '\u{1F601}', '\u{1F603}', '\u{1F680}', '\u{1F9F5}', '𝔘', '𝕏'];
  const random = lcg(0x5e1a9e);
  const pick = (): string => symbols[Math.floor(random() * symbols.length)] ?? 'a';
  const make = (length: number): string[] => Array.from({ length }, () => pick());
  let pairs = 0;
  for (let round = 0; round < 2000; round += 1) {
    const parts = make(1 + Math.floor(random() * 24));
    let other: string[];
    if (round % 2 === 0) {
      other = [...parts];
      const edits = 1 + Math.floor(random() * 3);
      for (let edit = 0; edit < edits; edit += 1) {
        const at = Math.floor(random() * (other.length + 1));
        const kind = random();
        if (kind < 0.4) other.splice(at, 0, pick());
        else if (kind < 0.7) other.splice(at, 1);
        else if (at < other.length) other[at] = pick();
      }
    } else {
      other = make(1 + Math.floor(random() * 24));
    }
    const from = parts.join('');
    const to = other.join('');
    pairs += 1;
    assert.deepEqual(faults(from, to), [], `${JSON.stringify(from)} → ${JSON.stringify(to)}`);
  }
  assert.equal(pairs, 2000);
});

test('half a character the second text holds is carried, and nothing claims otherwise', () => {
  // The one shape the invariant cannot cover, stated rather than left to be discovered: `to`
  // holds a lone surrogate, so any change that gets the buffer there carries it. No editor
  // here produces such a text, and a peer's cannot cross the wire — the y-protocols encoder
  // has no encoding for half a character and writes U+FFFD instead.
  const change = diff('ab\n', 'a\ud83db\n');
  assert.deepEqual(change, { start: 1, end: 1, text: '\ud83d' });
  assert.equal(applyChange('ab\n', change), 'a\ud83db\n');
  assert.deepEqual(loneSurrogates(change.text), [0]);
});

test('a buffer that already holds the replica is not a change, in either line ending', () => {
  assert.equal(matchesReplica('a\n', 'a\n'), true);
  assert.equal(matchesReplica('a\r\n', 'a\n'), true);
  assert.equal(matchesReplica('a\n', 'a'), false);
  assert.equal(matchesReplica('', ''), true);
});

test('a buffer offset maps onto the replica and back, CRLF included', () => {
  const buffer = 'line one\r\nline two\r\n';
  const replica = toCrdt(buffer);
  assert.equal(replica.length, 18);
  assert.equal(buffer.length, 20);

  // Every replica offset round-trips, which is what a caret placed and then read back does.
  for (let offset = 0; offset <= replica.length; offset += 1) {
    assert.equal(toReplicaOffset(buffer, toBufferOffset(buffer, offset)), offset);
  }
  assert.equal(toReplicaOffset(buffer, 10), 9, 'the caret after the first line break');
  assert.equal(toReplicaOffset(buffer, 20), 18, 'the caret at end of file is the replica end');
  assert.equal(toBufferOffset(buffer, 9), 10);
  assert.equal(toBufferOffset(buffer, 18), 20);

  // LF is the identity, so an LF document is not taxed by the conversion.
  assert.equal(toReplicaOffset('abc', 2), 2);
  assert.equal(toBufferOffset('abc', 2), 2);
  assert.equal(toReplicaOffset('', 0), 0);
  assert.equal(toBufferOffset('', 0), 0);
});

test('an offset conversion told a document has no carriage return is the loop\'s own answer', () => {
  // `hasCarriageReturn` is what a caller that has already looked at the whole buffer passes
  // down, and the conversion then has no loop to run. The answer it gives has to be the
  // answer the loop gives: a mixed document, a lone `\r`, astral characters and an empty one.
  const mixed = 'one\r\ntwo\nthree\rfour\r\n\u{1f600}five\n';
  const cases = [mixed, mixed.replaceAll('\r', ''), 'a\rb\r\nc', '', '\r\n\r\n', 'no endings at all'];
  for (const text of cases) {
    const carriageReturn = hasCarriageReturn(text);
    assert.equal(carriageReturn, text.indexOf('\r') !== -1, JSON.stringify(text));
    for (let offset = 0; offset <= text.length; offset += 1) {
      assert.equal(
        toReplicaOffset(text, offset, carriageReturn),
        toReplicaOffset(text, offset),
        `toReplicaOffset(${JSON.stringify(text)}, ${offset})`,
      );
      assert.equal(
        toBufferOffset(text, offset, carriageReturn),
        toBufferOffset(text, offset),
        `toBufferOffset(${JSON.stringify(text)}, ${offset})`,
      );
    }
  }
  // A document with no `\r` in it: every offset is its own, no code unit moves.
  assert.equal(hasCarriageReturn('one\ntwo\n'), false);
  assert.equal(toReplicaOffset('one\ntwo\n', 7, false), 7);
  assert.equal(toBufferOffset('one\ntwo\n', 7, false), 7);
  assert.equal(toReplicaOffset('', 0, false), 0);
  assert.equal(toBufferOffset('', 0, false), 0);
  // Past the end of the text is the end of the text, and before its start is its start —
  // the two bounds the loop cannot walk beyond.
  assert.equal(toReplicaOffset('one\n', 99, false), 4);
  assert.equal(toBufferOffset('one\n', 99, false), 4);
  assert.equal(toReplicaOffset('one\n', -3, false), 0);
  assert.equal(toBufferOffset('one\n', -3, false), 0);
});

test('an offset conversion told there is no carriage return does not read the text again', () => {
  // The whole point of the answer being passed down: a caller that has already looked at the
  // buffer is not made to look at it again, one code unit at a time, per endpoint per peer.
  // A text that throws when it is read is what says the conversion read nothing.
  const reads: string[] = [];
  const unreadable: Record<string, unknown> = { length: 5 };
  for (let index = 0; index < 5; index += 1) {
    Object.defineProperty(unreadable, String(index), {
      get() {
        reads.push(String(index));
        return 'x';
      },
    });
  }
  Object.defineProperty(unreadable, 'indexOf', {
    value: () => {
      reads.push('indexOf');
      return -1;
    },
  });
  assert.equal(toReplicaOffset(unreadable as unknown as string, 3, false), 3);
  assert.equal(toBufferOffset(unreadable as unknown as string, 3, false), 3);
  assert.deepEqual(reads, [], 'the conversion scanned a text it was told needed no scan');
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
