/**
 * Spike 1 (§7 risk 1): does a cursor survive a concurrent edit, and in what unit is an
 * offset measured?
 *
 * The experiment is run over the primitives the engine uses: two `Y.Doc`s exchanging
 * y-protocols frames, with the awareness state carried in a `message_type = 1` frame.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

import {
  applyFrame,
  encodeAwareness,
  encodeUpdate,
} from '../../src/engine/sync.ts';
import { parseAwarenessState } from '../../src/engine/presence.ts';
import type { Selection } from '../../src/engine/presence.ts';

/** A peer: a document plus the awareness state it publishes. */
interface Replica {
  doc: Y.Doc;
  text: Y.Text;
  awareness: Awareness;
}

function replica(seed: string): Replica {
  const doc = new Y.Doc();
  const text = doc.getText('src/main.rs');
  const awareness = new Awareness(doc);
  // y-protocols starts its own 15 s / 30 s tick. The engine stops it, because the server's
  // keepalive is the session's clock (§8.2) — and it would also hold this process open.
  clearInterval(awareness._checkInterval);
  if (seed !== '') {
    text.insert(0, seed);
  }
  return { doc, text, awareness };
}

/** Sends this replica's state to the other, as the server relays one binary frame. */
function sync(from: Replica, to: Replica): void {
  const update = Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc));
  applyFrame(encodeUpdate(update), to.doc, to.awareness, 'spike:sync');
}

const SEED = 'const answer = 42;\nlet total = 0;\n';
/** The two characters a cursor is supposed to be sitting on. */
const SELECTED = 'le';

test('spike 1: absolute offsets drift under a concurrent edit; relative positions do not', () => {
  const lineStart = SEED.indexOf('let');
  const selection: Selection = {
    anchor: lineStart,
    head: lineStart + SELECTED.length,
  };
  assert.equal(SEED.slice(selection.anchor, selection.head), SELECTED);

  const ada = replica(SEED);
  const bob = replica('');
  sync(ada, bob);
  assert.equal(bob.text.toString(), SEED, 'the seed arrives over the wire');

  // Ada publishes her caret in the shape the spec carries today (§8.1).
  ada.awareness.setLocalState({ path: 'src/main.rs', selection });
  bob.awareness.setLocalState({ path: 'src/main.rs' });
  applyFrame(
    encodeAwareness(ada.awareness, [ada.doc.clientID]),
    bob.doc,
    bob.awareness,
    'spike:awareness',
  );
  const received = bob.awareness.getStates().get(ada.doc.clientID);
  assert.deepEqual(parseAwarenessState(received)?.selection, selection);

  // The candidate replacement for those offsets: the same selection as a CRDT-relative
  // position, computed while it is still the text the caret was made on.
  const relative = Y.createRelativePositionFromTypeIndex(ada.text, selection.anchor);

  // Bob pastes 100 characters at the top of the file — nothing unusual.
  const paste = `${'// '.repeat(50)}pasted\n`;
  bob.doc.transact(() => {
    bob.text.insert(0, paste);
  }, 'spike:local');
  sync(bob, ada);
  assert.equal(ada.text.toString(), paste + SEED);

  // The absolute offsets now point somewhere else entirely: they slid by the paste.
  const drifted = ada.text.toString().slice(selection.anchor, selection.head);
  console.log(
    `[spike 1] absolute offsets, ${paste.length}-character insert at 0: ` +
      `anchor ${selection.anchor} now selects ${JSON.stringify(drifted)} ` +
      `(expected ${JSON.stringify(SELECTED)}); drift = ${paste.length} = the insert length`,
  );
  assert.notEqual(drifted, SELECTED, 'an absolute offset is not a position in a CRDT');

  // The same selection as a CRDT-relative position follows the text it was made on.
  const absolute = Y.createAbsolutePositionFromRelativePosition(relative, ada.doc);
  assert.ok(absolute !== null);
  console.log(
    `[spike 1] the same selection as a relative position lands on ` +
      `${JSON.stringify(ada.text.toString().slice(absolute.index, absolute.index + SELECTED.length))} ` +
      `at index ${absolute.index} (the absolute offset would have said ${selection.anchor})`,
  );
  assert.equal(
    ada.text.toString().slice(absolute.index, absolute.index + SELECTED.length),
    SELECTED,
  );

  // It survives the trip to the other replica, as JSON, because it is just a state (§8.1).
  const shipped = Y.relativePositionToJSON(relative);
  const restored = Y.createAbsolutePositionFromRelativePosition(
    Y.createRelativePositionFromJSON(JSON.parse(JSON.stringify(shipped))),
    bob.doc,
  );
  assert.ok(restored !== null);
  assert.equal(
    bob.text.toString().slice(restored.index, restored.index + SELECTED.length),
    SELECTED,
  );
});

test('spike 1: offsets are UTF-16 code units, not code points and not bytes', () => {
  const doc = new Y.Doc();
  const text = doc.getText('src/main.rs');
  text.insert(0, '😀x');

  const rendered = text.toString();
  console.log(
    `[spike 1] "😀x": Y.Text length ${text.length}, string length ${rendered.length}, ` +
      `code points ${[...rendered].length}, ` +
      `UTF-16 code units ${rendered.length}, ` +
      `UTF-8 bytes ${new TextEncoder().encode(rendered).length}`,
  );
  assert.equal(text.length, 3, 'two UTF-16 code units for the emoji, one for x');
  assert.equal([...rendered].length, 2);
  assert.equal(new TextEncoder().encode(rendered).length, 5, '4 bytes for the emoji, 1 for x');

  // Index 1 is inside the surrogate pair; a code-point offset would put "x" at 1 and a byte
  // offset at 4. Only UTF-16 makes Y.Text, VS Code's `offsetAt` and the Rust client's default
  // `OffsetKind::Utf16` agree on where "x" is.
  assert.equal(rendered[0], '\ud83d', 'index 0 is the high surrogate');
  assert.equal(rendered[1], '\ude00', 'index 1 is the low surrogate, not x');
  assert.equal(rendered[2], 'x', 'index 2 is x');

  // A selection made in the middle of a surrogate pair is a state a peer has to tolerate.
  const half = Y.createAbsolutePositionFromRelativePosition(
    Y.createRelativePositionFromTypeIndex(text, 1),
    doc,
  );
  assert.equal(half?.index, 1);
});
