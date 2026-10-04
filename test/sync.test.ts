/**
 * Where one message of a y-protocols frame ends (`PROTOCOL.md` §7). A frame is a stream of
 * messages with no count, so a receiver that reads one message's body to the wrong length
 * misreads every message after it. The auth message is the one whose body is not a single
 * `varUint8Array`: a `varUint(status)`, then a `varString(reason)` for status 0 alone. These
 * cases put one in front of the messages a frame exists to carry, built by y-protocols' own
 * writer where it has one, and read both the applier and the content walk §13.5 refuses a
 * `viewer`'s edits by, which have to agree on where the auth message ends.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import { Awareness } from 'y-protocols/awareness';
import * as auth from 'y-protocols/auth';

import { isContent } from '../src/engine/sealed.ts';
import {
  MESSAGE_AUTH,
  applyFrame,
  encodeAwareness,
  encodeSyncStep1,
  encodeUpdate,
} from '../src/engine/sync.ts';

const PATH = 'notes.txt';

/** A denial as y-protocols writes one: status 0 and its reason. */
function denial(reason: string): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AUTH);
  auth.writePermissionDenied(encoder, reason);
  return encoding.toUint8Array(encoder);
}

/** An auth message with a status other than 0, which carries nothing after it. */
function authStatus(status: number): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AUTH);
  encoding.writeVarUint(encoder, status);
  return encoding.toUint8Array(encoder);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A replica and its awareness set, destroyed with the test. */
function replica(t: TestContext): { doc: Y.Doc; awareness: Awareness } {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  t.after(() => {
    awareness.destroy();
    doc.destroy();
  });
  return { doc, awareness };
}

/** An update that writes `text` into a fresh document at {@link PATH}. */
function updateWriting(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText(PATH).insert(0, text);
  const update = encodeUpdate(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  return update;
}

/**
 * A peer's awareness state and the client id it is under. The id is the one y-protocols minted,
 * whose clock 0 its constructor spent, so the state goes out above 0 and a receiver applies it.
 */
function peerAwareness(t: TestContext): { client: number; message: Uint8Array } {
  const peer = replica(t);
  peer.awareness.setLocalState({ path: PATH });
  const client = peer.awareness.clientID;
  return { client, message: encodeAwareness(peer.awareness, [client]) };
}

test('the messages behind an auth denial in one frame are each read and applied', (t) => {
  const room = replica(t);
  const state = peerAwareness(t);
  const frame = concat(denial('no entry'), updateWriting('after the denial\n'), state.message);

  applyFrame(frame, room.doc, room.awareness, 'peer');

  assert.equal(room.doc.getText(PATH).toString(), 'after the denial\n', 'the update was misread');
  assert.deepEqual(
    room.awareness.getStates().get(state.client),
    { path: PATH },
    'the awareness state was misread',
  );
});

test('an auth message of any other status carries no reason, and the frame stays aligned', (t) => {
  for (const status of [1, 2, 200]) {
    const room = replica(t);
    const peer = replica(t);
    peer.doc.getText(PATH).insert(0, 'the peer’s text\n');
    const frame = concat(authStatus(status), encodeSyncStep1(room.doc), updateWriting('mine\n'));

    const effect = applyFrame(frame, peer.doc, peer.awareness, 'peer');

    assert.equal(effect.replies.length, 1, `status ${status}: the SyncStep1 behind it went unanswered`);
    assert.equal(
      peer.doc.getText(PATH).length,
      'the peer’s text\n'.length + 'mine\n'.length,
      `status ${status}: the update behind it was misread`,
    );
  }
});

test('document content behind an auth message is content, whatever the status', () => {
  const update = updateWriting('a viewer’s edit\n');
  assert.equal(isContent(concat(denial('no entry'), update)), true, 'behind a denial');
  assert.equal(isContent(concat(authStatus(3), update)), true, 'behind status 3');
  assert.equal(isContent(denial('no entry')), false, 'an auth message alone is not content');
});

/**
 * A frame whose last readable message is followed by one §7's table does not define, then by
 * bytes that would be content if anything read them.
 */
function endedBy(undefinedMessage: Uint8Array, room: { doc: Y.Doc }, state: Uint8Array): Uint8Array {
  return concat(
    encodeSyncStep1(room.doc),
    updateWriting('before the stop\n'),
    state,
    undefinedMessage,
    updateWriting('past the stop\n'),
  );
}

test('a message type §7 does not define ends the reading, and the messages before it stand', (t) => {
  for (const messageType of [4, 127, 300]) {
    const room = replica(t);
    const peer = replica(t);
    const state = peerAwareness(t);
    const head = encoding.createEncoder();
    encoding.writeVarUint(head, messageType);

    const effect = applyFrame(
      endedBy(encoding.toUint8Array(head), peer, state.message),
      room.doc,
      room.awareness,
      'peer',
    );

    assert.equal(effect.replies.length, 1, `type ${messageType}: the SyncStep1 before it went unanswered`);
    assert.equal(
      room.doc.getText(PATH).toString(),
      'before the stop\n',
      `type ${messageType}: the update before it was lost, or the bytes after it were read`,
    );
    assert.deepEqual(
      room.awareness.getStates().get(state.client),
      { path: PATH },
      `type ${messageType}: the awareness state before it was lost`,
    );
  }
});

test('a sync sub-type §7 does not define ends the reading, and the messages before it stand', (t) => {
  for (const syncType of [3, 7, 200]) {
    const room = replica(t);
    const peer = replica(t);
    const state = peerAwareness(t);
    const head = encoding.createEncoder();
    encoding.writeVarUint(head, 0);
    encoding.writeVarUint(head, syncType);

    const effect = applyFrame(
      endedBy(encoding.toUint8Array(head), peer, state.message),
      room.doc,
      room.awareness,
      'peer',
    );

    assert.equal(effect.replies.length, 1, `sub-type ${syncType}: the SyncStep1 before it went unanswered`);
    assert.equal(
      room.doc.getText(PATH).toString(),
      'before the stop\n',
      `sub-type ${syncType}: the update before it was lost, or the bytes after it were read`,
    );
    assert.deepEqual(
      room.awareness.getStates().get(state.client),
      { path: PATH },
      `sub-type ${syncType}: the awareness state before it was lost`,
    );
  }
});

test('the content walk stops where the applier stops, at a sync sub-type §7 does not define', () => {
  const update = updateWriting('past the stop\n');
  // An empty `varUint8Array` behind the sub-type: a walk that read one there would go on to the
  // update and call the frame content the applier never applies.
  assert.equal(isContent(concat(Uint8Array.of(0, 3, 0), update)), false, 'read past sub-type 3');
  assert.equal(isContent(concat(update, Uint8Array.of(0, 3, 0))), true, 'lost the update before it');
});
