/**
 * What one inbound binary frame may cost this client in answers.
 *
 * A y-protocols frame is a stream of top-level messages with no count and no terminator, so
 * a frame of one byte per message is well-formed, and two message types in it are *answered*:
 * `SyncStep1` draws a catch-up carrying the replica, and the awareness query used to draw the
 * whole awareness set. Answering the query cost one frame per byte of the query — 256000 bytes
 * of `0x03` measured 256000 replies and 8 MB from a single legal 256 KB frame — and the
 * engine's own 16 MiB inbound bound allowed roughly half a gigabyte of generated replies.
 * `selvage/1` never sends that message, so it is read and dropped; a frame may also be
 * answered at most once, which is all a conforming peer's frame asks for.
 *
 * The named test below fails without either guard: the reply count is the assertion, and the
 * frame's own honesty is what makes the count legitimate rather than a decoder artefact.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

import { SelvageEngine } from '../src/engine/engine.ts';
import {
  MESSAGE_QUERY_AWARENESS,
  MESSAGE_SYNC,
  applyFrame,
  encodeSyncStep1,
  encodeUpdate,
} from '../src/engine/sync.ts';
import { ControlledSocket } from './helpers/controlled-socket.ts';
import { waitFor } from './helpers/wait.ts';

const PATH = 'src/main.rs';

/** A frame of query messages: one byte each, the run a peer can pack into one frame. */
const QUERY_RUN_BYTES = 256 * 1024;

const KEEPALIVE = {
  ping_interval_ms: 30_000,
  awareness_renew_ms: 15_000,
  awareness_expire_ms: 30_000,
};

/** How many bytes a set of replies holds, and how many replies it is. */
function measured(replies: Uint8Array[]): { count: number; bytes: number } {
  return {
    count: replies.length,
    bytes: replies.reduce((total, reply) => total + reply.length, 0),
  };
}

/** A pair of replicas and a live awareness set for each, destroyed with the test. */
function replica(t: TestContext, text: string): { doc: Y.Doc; awareness: Awareness } {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  t.after(() => {
    awareness.destroy();
    doc.destroy();
  });
  if (text !== '') {
    doc.getText(PATH).insert(0, text);
  }
  return { doc, awareness };
}

test('a frame of awareness queries is answered with nothing at all', (t) => {
  const room = replica(t, 'the room’s text\n');
  // A live state makes the answer a real frame rather than an empty one: the measurement is
  // of what the client would have written, so the replica has to be worth writing out.
  room.awareness.setLocalState({ path: PATH });

  const frame = new Uint8Array(QUERY_RUN_BYTES).fill(MESSAGE_QUERY_AWARENESS);
  const effect = applyFrame(frame, room.doc, room.awareness, 'peer');
  const { count, bytes } = measured(effect.replies);

  assert.equal(count, 0, `${count} answers to a frame no conforming peer asks in`);
  assert.equal(bytes, 0, `${bytes} bytes of answers to a ${QUERY_RUN_BYTES}-byte frame`);
  // The replica is untouched by the run: a query asks a question, it does not carry one.
  assert.equal(room.doc.getText(PATH).toString(), 'the room’s text\n');
});

/** `messages` copies of the smallest SyncStep1: sync, step 1, a one-byte empty state vector. */
function syncQueries(messages: number): Uint8Array {
  const step = Uint8Array.of(MESSAGE_SYNC, 0, 1, 0);
  const frame = new Uint8Array(messages * step.length);
  for (let index = 0; index < messages; index += 1) {
    frame.set(step, index * step.length);
  }
  return frame;
}

test('a frame of sync queries draws one answer and stays aligned behind it', (t) => {
  const room = replica(t, 'the room’s text\n');
  // 4096 SyncStep1 messages, four bytes each: `0x00` for the sync type, `0x00` for step 1,
  // `0x01` for a one-byte state vector and `0x00` for that vector — the shape that costs a
  // whole replica-sized diff apiece, and the smallest message that is one. Past the cap the
  // diff is never computed and the state vector is read off the frame and dropped, so an
  // update after the run is still found and still applied: the frame stayed aligned.
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(room.doc));
  const text = peer.getText(PATH);
  text.insert(text.length, 'from the peer\n');
  const update = encodeUpdate(Y.encodeStateAsUpdate(peer));
  peer.destroy();

  const queries = syncQueries(4096);
  const frame = new Uint8Array(queries.length + update.length);
  frame.set(queries, 0);
  frame.set(update, queries.length);

  const effect = applyFrame(frame, room.doc, room.awareness, 'peer');
  const { count } = measured(effect.replies);
  assert.equal(count, 1, `${count} answers to a frame of 4096 queries`);
  assert.equal(
    room.doc.getText(PATH).toString(),
    'the room’s text\nfrom the peer\n',
    'the frame did not stay aligned behind the dropped state vectors',
  );
});

test('a sync sub-type y-protocols does not define is still a frame this client drops', (t) => {
  const room = replica(t, 'the room’s text\n');
  // The dispatch reads the sub-type itself, so it has to keep refusing a message that
  // `y-protocols/sync`'s own `readSyncMessage` refuses.
  assert.throws(
    () => applyFrame(Uint8Array.of(MESSAGE_SYNC, 7), room.doc, room.awareness, 'peer'),
    /unknown y-protocols sync message type 7/,
  );
});

test('a legitimate frame is still applied and still answered', (t) => {
  const room = replica(t, 'the room’s text\n');
  const peer = replica(t, '');

  // The catch-up handshake: one SyncStep1 is answered with one SyncStep2, and applying the
  // answer is what gives the asker the room's text.
  const asked = applyFrame(encodeSyncStep1(peer.doc), room.doc, room.awareness, 'peer');
  assert.equal(asked.replies.length, 1, 'a SyncStep1 was not answered');
  applyFrame(asked.replies[0] as Uint8Array, peer.doc, peer.awareness, 'answer');
  assert.equal(peer.doc.getText(PATH).toString(), 'the room’s text\n');

  // An update in a frame still lands, and a query beside it changes neither the reply count
  // nor what the frame carried.
  const update = new Y.Doc();
  Y.applyUpdate(update, Y.encodeStateAsUpdate(room.doc));
  const text = update.getText(PATH);
  text.insert(text.length, 'from the peer\n');
  const carried = encodeUpdate(Y.encodeStateAsUpdate(update));
  const mixed = new Uint8Array(1 + carried.length);
  mixed[0] = MESSAGE_QUERY_AWARENESS;
  mixed.set(carried, 1);
  const effect = applyFrame(mixed, room.doc, room.awareness, 'peer');
  assert.equal(effect.replies.length, 0, 'a query with an update beside it was answered');
  assert.equal(room.doc.getText(PATH).toString(), 'the room’s text\nfrom the peer\n');
  update.destroy();
});

/** An engine seated on a socket the test drives, so a frame can be delivered exactly. */
async function seated(t: TestContext): Promise<{
  engine: SelvageEngine;
  socket: ControlledSocket;
}> {
  const socket = new ControlledSocket();
  const attempted = SelvageEngine.host('ws://controlled.test', 'Ada', {
    meta: 'skip',
    reconnect: false,
    webSocketFactory: () => socket,
  });
  let engine: SelvageEngine | undefined;
  let failure: unknown;
  void attempted.then(
    (seatedEngine) => {
      engine = seatedEngine;
    },
    (error: unknown) => {
      failure = error;
    },
  );
  t.after(async () => {
    await engine?.disconnect();
  });
  await waitFor('the engine to attach its handlers', () => socket.onopen !== null);
  socket.open();
  await waitFor('the engine to send session.hello', () => socket.sent.length > 0);
  socket.deliver(
    JSON.stringify({
      v: 'selvage/1',
      event: 'room.created',
      params: {
        room_id: 'r-cap1',
        token: 'tok',
        self: { peer_id: 'p-host', display_name: 'Ada', role: 'host' },
        peers: [],
        documents: [],
        capabilities: [],
        keepalive: KEEPALIVE,
      },
    }),
  );
  return {
    engine: await waitFor('the handshake to complete', () => engine ?? false, {
      describe: () => ({ failure }),
    }),
    socket,
  };
}

test('the engine writes nothing back for a hostile frame, and goes on', async (t) => {
  const { engine, socket } = await seated(t);
  const before = socket.sentBinary.length;

  socket.deliverBinary(new Uint8Array(QUERY_RUN_BYTES).fill(MESSAGE_QUERY_AWARENESS));
  assert.equal(
    socket.sentBinary.length,
    before,
    `${socket.sentBinary.length - before} frames written for a hostile frame`,
  );

  // The session goes on: the next legitimate frame is applied as usual.
  const update = new Y.Doc();
  update.getText(PATH).insert(0, 'after\n');
  socket.deliverBinary(encodeUpdate(Y.encodeStateAsUpdate(update)));
  assert.equal(engine.text(PATH), 'after\n');
  update.destroy();
});
