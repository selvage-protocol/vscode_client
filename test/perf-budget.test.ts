/**
 * What one action costs the wire, in frames and bytes, counted at the socket.
 *
 * There is no wall-clock in this file, which is what makes it worth having: a fixed sequence
 * of calls produces a fixed number of frames of a fixed size, so a run either matches the
 * budget or the client is sending something else. A policy that regroups frames, a caller
 * that publishes a state twice, or a keystroke that becomes two messages all show up here as
 * a number that moved, on any machine, loaded or not.
 *
 * The budgets are counted on the sender against the fake `selvaged` (`test/helpers/fake-server.ts`),
 * whose relay rule is the reference server's: every frame reaches every other peer once.
 * CPU is not budgeted here — a millisecond bound is a function of the runner, and the
 * measurement that goes with these numbers is in the study, not in a gate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import { SelvageEngine } from '../src/engine/engine.ts';
import { FakeServer } from './helpers/fake-server.ts';
import { counting } from './helpers/counting-socket.ts';
import type { Counting } from './helpers/counting-socket.ts';
import { options } from './helpers/session.ts';
import { record, waitFor, waitForPresence } from './helpers/wait.ts';

const PATH = 'src/main.rs';
const OTHER = 'src/other.rs';

interface Room {
  server: FakeServer;
  host: SelvageEngine;
  /** The tally of everything the host wrote to its socket, from the moment it seated. */
  hostFrames: Counting;
}

/**
 * A fixed client id, set before the replica holds anything.
 *
 * Every struct's id is written on the wire as the client id's varint followed by the clock,
 * so a random id — which is what a session has — moves the byte budgets by the width of that
 * varint. The value below is one a random id almost always is (four fifths of the space needs
 * five bytes), and pinning it is what makes the numbers numbers rather than ranges.
 */
const CLIENT_ID = 0xa3c1_5f00;

/** A host alone in its room, counting its own frames. */
async function hostRoom(t: TestContext, path = PATH): Promise<Room> {
  const server = await FakeServer.start();
  const hostFrames = counting();
  const host = await SelvageEngine.host(
    server.wsBase,
    'Ada',
    options({
      baseUrl: server.wsBase,
      displayName: 'Ada',
      webSocketFactory: hostFrames.factory,
    }),
  );
  host.doc.clientID = CLIENT_ID;
  t.after(async () => {
    await host.disconnect();
    await server.stop();
  });
  await host.open(path);
  // Counted from here: the handshake, the hold and the awareness published at seat are the
  // session's own cost, and each budget below is about one action on top of it.
  hostFrames.reset();
  return { server, host, hostFrames };
}

test('a keystroke is one sync frame carrying only that keystroke', async (t) => {
  const { host, hostFrames } = await hostRoom(t);
  host.insert(PATH, 0, 'fn main() {}\n');
  hostFrames.reset();

  for (let index = 0; index < 100; index += 1) {
    host.insert(PATH, 6 + index, 'x');
  }

  const sent = hostFrames.tally.sent;
  // One transaction, one delta, one frame: the engine flushes each update as it happens.
  assert.equal(sent.sync, 100, '100 keystrokes must be 100 sync frames');
  assert.equal(sent.awareness, 0, 'typing publishes no presence');
  assert.equal(sent.text, 0, 'the JSON envelope is not on the keystroke path');
  // What a one-character delta costs on the wire: the y-protocols header, the struct's id
  // and origin, and the character. A byte count rather than a range on purpose — this is the
  // budget, and a change to it is a change to what the client sends.
  assert.equal(sent.bytes, 2700, 'a keystroke costs 27 bytes of payload');
});

test('a caret is one awareness frame, and a caret that has not moved is none', async (t) => {
  const { host, hostFrames } = await hostRoom(t);
  host.insert(PATH, 0, 'fn main() {}\n');
  hostFrames.reset();

  host.setSelection(PATH, { anchor: 4, head: 4 });
  assert.equal(hostFrames.tally.sent.awareness, 1, 'one caret move is one frame');
  assert.equal(hostFrames.tally.sent.awarenessSelection, 1, 'and it carries a caret');
  assert.ok(
    hostFrames.tally.sent.awarenessBytes <= 300,
    `a caret frame must stay under 300 bytes, saw ${hostFrames.tally.sent.awarenessBytes}`,
  );

  hostFrames.reset();
  for (let index = 0; index < 50; index += 1) {
    host.setSelection(PATH, { anchor: 9, head: 9 });
  }
  assert.equal(hostFrames.tally.sent.awareness, 1, '50 identical selections must be one frame');

  hostFrames.reset();
  for (let index = 0; index < 50; index += 1) {
    host.setAwareness(null);
  }
  assert.equal(hostFrames.tally.sent.awareness, 1, 'clear-and-clear-again is one frame');
  assert.ok(
    hostFrames.tally.sent.awarenessBytes <= 40,
    `a clear must be a removal and not a state, saw ${hostFrames.tally.sent.awarenessBytes} bytes`,
  );
});

test('a turn of typing publishes one caret frame whatever the caret did in it', async (t) => {
  const { host, hostFrames } = await hostRoom(t);
  host.insert(PATH, 0, 'fn main() {}\n');
  hostFrames.reset();

  // What the adapter's 100 ms coalescer hands the engine when a person types: a text change
  // and a caret event per keystroke, with the caret at a different offset every time. The
  // frames are the engine's own; the adapter's side of the same budget is
  // `test/adapter-presence.test.ts`, where the coalescer is driven through the real
  // extension host.
  for (let index = 0; index < 100; index += 1) {
    host.insert(PATH, 6 + index, 'x');
    host.setSelection(PATH, { anchor: 7 + index, head: 7 + index });
  }

  const sent = hostFrames.tally.sent;
  assert.equal(sent.sync, 100, 'each keystroke is its own frame');
  assert.equal(sent.awareness, 1, 'the caret frames of one turn are one frame');
});

test('joining a room is one frame of each kind out, and one announcement in', async (t) => {
  const server = await FakeServer.start();
  const hostFrames = counting();
  const guestFrames = counting();
  t.after(async () => {
    await host.disconnect();
    await guest.disconnect();
    await server.stop();
  });
  const host = await SelvageEngine.host(
    server.wsBase,
    'Ada',
    options({
      baseUrl: server.wsBase,
      displayName: 'Ada',
      webSocketFactory: hostFrames.factory,
    }),
  );
  const invite = host.inviteUrl();
  assert.ok(invite !== undefined);
  hostFrames.reset();

  const guest = await SelvageEngine.join(
    invite,
    'Bob',
    options({
      baseUrl: server.wsBase,
      displayName: 'Bob',
      webSocketFactory: guestFrames.factory,
    }),
  );
  await waitForPresence(host, 'Bob');

  const sent = guestFrames.tally.sent;
  // The handshake, the state vector that is the whole of the sync handshake, and the
  // awareness that puts this client's caret on the room's map: three frames, no content.
  assert.equal(sent.text, 1, 'the handshake is one text frame');
  assert.equal(sent.sync, 1, 'a join sends one sync frame, not the document');
  assert.equal(sent.awareness, 1, 'a join publishes its presence once');
  assert.ok(sent.bytes < 400, `a join must stay small, saw ${sent.bytes} bytes`);
  // The room is told the peer arrived, once.
  assert.equal(hostFrames.tally.received.text, 1, 'the host hears peer.joined once');
});

test('a document set is announced once for one open, not once per direction', async (t) => {
  const server = await FakeServer.start();
  const guestFrames = counting();
  t.after(async () => {
    await host.disconnect();
    await guest.disconnect();
    await server.stop();
  });
  const host = await SelvageEngine.host(
    server.wsBase,
    'Ada',
    options({ baseUrl: server.wsBase, displayName: 'Ada' }),
  );
  const invite = host.inviteUrl();
  assert.ok(invite !== undefined);
  const guest = await SelvageEngine.join(
    invite,
    'Bob',
    options({
      baseUrl: server.wsBase,
      displayName: 'Bob',
      webSocketFactory: guestFrames.factory,
    }),
  );
  await host.open(PATH);
  await waitFor('the guest to learn the room\'s set', () => guest.documents().includes(PATH));

  const events = record(guest);
  const hostEvents = record(host);
  guestFrames.reset();
  await guest.open(OTHER);

  // The mover hears its own event as well as the answer that made it, and the answer has
  // already been applied: the frames are the server's, and the refresh is the client's.
  await waitFor(
    'the mover to have been answered and told',
    () => (guestFrames.tally.received.text >= 2 ? true : false),
  );
  assert.equal(
    events.types().filter((type) => type === 'documentsChanged').length,
    1,
    'one open must refresh the mover once',
  );
  await waitFor(
    'the room to hear the open',
    () => hostEvents.types().filter((type) => type === 'documentsChanged').length >= 1,
    { describe: () => hostEvents.types() },
  );
  assert.equal(
    hostEvents.types().filter((type) => type === 'documentsChanged').length,
    1,
    'one open must refresh the room once',
  );
});
