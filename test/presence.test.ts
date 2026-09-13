/**
 * The anchor shape `spec/PROTOCOL.md` §8.1 freezes, read at the parser: what a receiver
 * accepts, what it normalises, and what leaves it with no selection at all. Resolution
 * against a replica is the engine's half, in `engine.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as Y from 'yjs';

import { parseAwarenessState, toAnchor } from '../src/engine/presence.ts';

const PATH = 'src/main.rs';

/** The anchor a sender publishes for an offset into a seeded document. */
function anchorAt(index: number, assoc = 0): unknown {
  const doc = new Y.Doc();
  const text = doc.getText(PATH);
  text.insert(0, 'fn main() {}\n');
  return toAnchor(Y.createRelativePositionFromTypeIndex(text, index, assoc));
}

test('a published anchor carries exactly one scope and no index (§8.1)', () => {
  const middle = anchorAt(4) as Record<string, unknown>;
  assert.deepEqual(Object.keys(middle).sort(), ['assoc', 'item']);
  assert.equal(typeof (middle.item as Record<string, unknown>).client, 'number');
  assert.equal(typeof (middle.item as Record<string, unknown>).clock, 'number');

  // A position with no element to name is the `tname` form, and tname is the path.
  const end = anchorAt(13) as Record<string, unknown>;
  assert.deepEqual(Object.keys(end).sort(), ['assoc', 'tname']);
  assert.equal(end.tname, PATH);
});

test('the old offset shape is no longer a selection', () => {
  const state = parseAwarenessState({ path: PATH, selection: { anchor: 0, head: 2 } });
  assert.equal(state?.path, PATH);
  assert.equal(state?.selection, undefined, 'an integer is not an anchor');
});

test('unknown keys are ignored, in the state and in an anchor alike (§8.1)', () => {
  const anchor = { ...(anchorAt(4) as Record<string, unknown>), mystery: 'ignored' };
  const state = parseAwarenessState({
    path: PATH,
    selection: { anchor, head: anchor, hint: 'also ignored' },
    future_member: { nested: true },
  });
  assert.equal(state?.path, PATH);
  assert.ok(state?.selection !== undefined, 'an unknown key is never a protocol break');
  assert.deepEqual(Object.keys(state.selection.anchor).sort(), ['assoc', 'item']);
});

test('assoc normalises to after (>= 0) or before (< 0), and defaults to after', () => {
  const item = (anchorAt(4) as { item: unknown }).item;
  const parse = (assoc: unknown): number | undefined => {
    const selection = parseAwarenessState({
      path: PATH,
      selection: { anchor: { item, assoc }, head: { item, assoc } },
    })?.selection;
    return selection?.anchor.assoc;
  };
  assert.equal(parse(0), 0);
  assert.equal(parse(-1), -1);
  assert.equal(parse(7), 0, 'any non-negative value is "after"');
  assert.equal(parse(-7), -1, 'any negative value is "before"');
  assert.equal(parse(undefined), 0, 'an omitted assoc defaults to after');
});

test('a malformed anchor yields no selection, rather than a guessed position', () => {
  const item = (anchorAt(4) as { item: unknown }).item;
  const good = { item, assoc: 0 };
  const rejected: unknown[] = [
    null,
    'not an object',
    42,
    {},
    { assoc: 0 },
    { item: { client: 1 }, assoc: 0 },
    { item: { client: 'one', clock: 0 }, assoc: 0 },
    { tname: 12, assoc: 0 },
    { item, tname: PATH, assoc: 0 },
  ];
  for (const anchor of rejected) {
    assert.equal(
      parseAwarenessState({ path: PATH, selection: { anchor, head: good } })?.selection,
      undefined,
      `anchor ${JSON.stringify(anchor)} is not a position`,
    );
    // Either endpoint failing is enough to carry the selection away (§8.1).
    assert.equal(
      parseAwarenessState({ path: PATH, selection: { anchor: good, head: anchor } })
        ?.selection,
      undefined,
      `head ${JSON.stringify(anchor)} is not a position`,
    );
  }
});
