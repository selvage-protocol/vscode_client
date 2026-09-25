/**
 * The anchor shape `PROTOCOL.md` §8.1
 * (https://github.com/selvage-protocol/specification) freezes, read at the parser: what a receiver
 * accepts, what it normalises, and what leaves it with no selection at all. Resolution
 * against a replica is the engine's half, in `test/peer-adapter.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as Y from 'yjs';

import { parseAwarenessState, toAnchor } from '../src/engine/presence.ts';
import type { Anchor } from '../src/engine/presence.ts';

const PATH = 'src/main.rs';
const SEED = 'fn main() {}\n';

/** A document holding `SEED`, and its text. */
function seeded(path = PATH): { doc: Y.Doc; text: Y.Text } {
  const doc = new Y.Doc();
  const text = doc.getText(path);
  text.insert(0, SEED);
  return { doc, text };
}

/** The anchor this client publishes for an offset, built through the library. */
function published(index: number, assoc = 0): Anchor {
  return toAnchor(Y.createRelativePositionFromTypeIndex(seeded().text, index, assoc));
}

test("a published anchor is the library's own JSON: scope and element together", () => {
  // yjs names the scope (`tname`) and the element within it (`item`), and §8.1 carries
  // both. Asserted against the library rather than a shape written out here, so that a
  // change in what yjs emits fails this test instead of passing silently.
  const relative = Y.createRelativePositionFromTypeIndex(seeded().text, 4);
  const native = JSON.parse(
    JSON.stringify(Y.relativePositionToJSON(relative)),
  ) as Record<string, unknown>;

  assert.deepEqual(Object.keys(native).sort(), ['assoc', 'item', 'tname']);
  assert.equal(native.tname, PATH);
  assert.deepEqual(
    toAnchor(relative),
    native,
    'the engine ships what the library produced, unedited',
  );

  // A position with no element to name is the scope alone: the end of the text...
  assert.deepEqual(published(SEED.length), { assoc: 0, tname: PATH });
  // ...and anywhere in an empty one.
  const empty = new Y.Doc();
  assert.deepEqual(
    toAnchor(Y.createRelativePositionFromTypeIndex(empty.getText('empty.rs'), 0)),
    { assoc: 0, tname: 'empty.rs' },
  );
});

test("the library's shape round-trips through the parser and still resolves", () => {
  const { doc, text } = seeded();
  const shipped: unknown = JSON.parse(
    JSON.stringify(
      Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, 4)),
    ),
  );

  const selection = parseAwarenessState({
    path: PATH,
    selection: { anchor: shipped, head: shipped },
  })?.selection;
  assert.ok(selection !== undefined, "a yjs peer's anchor is not malformed");
  assert.equal(selection.anchor.tname, PATH);
  assert.equal(typeof selection.anchor.item, 'object');

  const resolved = Y.createAbsolutePositionFromRelativePosition(
    Y.createRelativePositionFromJSON(selection.anchor),
    doc,
  );
  assert.equal(resolved?.index, 4, 'the item is authoritative for the position');
});

test('the old offset shape is no longer a selection', () => {
  const state = parseAwarenessState({ path: PATH, selection: { anchor: 0, head: 2 } });
  assert.equal(state?.path, PATH);
  assert.equal(state?.selection, undefined, 'an integer is not an anchor');
});

test('unknown keys are ignored, in the state and in an anchor alike (§8.1)', () => {
  const anchor = { ...published(4), mystery: 'ignored' };
  const state = parseAwarenessState({
    path: PATH,
    selection: { anchor, head: anchor, hint: 'also ignored' },
    future_member: { nested: true },
  });
  assert.equal(state?.path, PATH);
  assert.ok(state?.selection !== undefined, 'an unknown key is never a protocol break');
  assert.deepEqual(
    Object.keys(state.selection.anchor).sort(),
    ['assoc', 'item', 'tname'],
    'the unknown key is dropped and the known ones survive',
  );
});

test('assoc normalises to after (>= 0) or before (< 0), and defaults to after', () => {
  const { item } = published(4);
  const parse = (assoc: unknown): number | undefined => {
    const anchor = { item, tname: PATH, assoc };
    return parseAwarenessState({
      path: PATH,
      selection: { anchor, head: anchor },
    })?.selection?.anchor.assoc;
  };
  assert.equal(parse(0), 0);
  assert.equal(parse(-1), -1);
  assert.equal(parse(7), 0, 'any non-negative value is "after"');
  assert.equal(parse(-7), -1, 'any negative value is "before"');
  assert.equal(parse(1.5), 0, 'any number is an assoc, whatever its precision');
  assert.equal(parse(-1.5), -1);
  assert.equal(parse(undefined), 0, 'an omitted assoc defaults to after');

  // A member that is not a number is not an assoc: the anchor goes, and the path stays —
  // the receiving client has one thing left it can read (§8.1).
  for (const unreadable of ['0', 'after', null, {}]) {
    const state = parseAwarenessState({
      path: PATH,
      selection: { anchor: { item, tname: PATH, assoc: unreadable }, head: { item, assoc: 0 } },
    });
    assert.equal(state?.selection, undefined, `assoc ${JSON.stringify(unreadable)} is not one`);
    assert.equal(state?.path, PATH, 'the path survives an unreadable anchor');
  }
});

test('an element without a scope is a position, not a malformed anchor', () => {
  // Exactly what a `yrs` client publishes for a caret inside a root type (§8.1): the
  // element alone. Reading a scope as mandatory would render no cursor for every peer on
  // the reference client, which is a silent interop failure with nothing on the wire.
  const item = { client: 9, clock: 1 };
  const parsed = parseAwarenessState({
    path: PATH,
    selection: { anchor: { item, assoc: 0 }, head: { item, assoc: 0 } },
  })?.selection;
  assert.deepEqual(parsed, {
    anchor: { item, assoc: 0 },
    head: { item, assoc: 0 },
  });

  // The scope is optional; `item` is what decides the position when both are there.
  assert.deepEqual(
    parseAwarenessState({
      path: PATH,
      selection: { anchor: { item, tname: PATH, assoc: 0 }, head: { item, assoc: 0 } },
    })?.selection?.anchor,
    { item, tname: PATH, assoc: 0 },
  );
});

test('a malformed anchor yields no selection, rather than a guessed position', () => {
  const { item } = published(4);
  const good = published(4);
  // No name at all, both scopes at once, or a member that cannot be read: malformed.
  const rejected: unknown[] = [
    null,
    'not an object',
    42,
    {},
    { assoc: 0 },
    { item, tname: PATH, type: { client: 1, clock: 0 }, assoc: 0 },
    { tname: PATH, type: { client: 1, clock: 0 }, assoc: 0 },
    { tname: PATH, item: { client: 1 }, assoc: 0 },
    { tname: PATH, item: { client: 'one', clock: 0 }, assoc: 0 },
    { tname: 12, assoc: 0 },
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
