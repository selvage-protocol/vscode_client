/**
 * Reconnection (spec §9.1): a dropped socket is a new connection, a new peer identity,
 * the same room — and the documents this client still holds are re-opened.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SelvageEngine } from '../src/engine/engine.ts';
import { isProtocolError } from '../src/engine/errors.ts';
import { FakeServer } from './helpers/fake-server.ts';
import { fakeSession, options } from './helpers/session.ts';
import { converge, record, waitFor, waitForPeer } from './helpers/wait.ts';

const PATH = 'src/main.rs';

/** A fast backoff, so a test does not wait out the production delays. */
const FAST_RECONNECT = {
  initialDelayMs: 20,
  maxDelayMs: 60,
  maxAttempts: 5,
};

test('a dropped guest re-hellos, re-opens its documents and reconverges', async (t) => {
  const session = await fakeSession({}, { reconnect: FAST_RECONNECT });
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  const { host, guest } = session;
  await host.open(PATH);
  await guest.open(PATH);
  host.insert(PATH, 0, 'before the drop\n');
  await converge(host, guest, PATH);
  const firstPeerId = guest.session().peer.peer_id;
  await waitForPeer(host, 'Bob');

  const events = record(guest);
  session.server.drop('Bob');

  // The reconnection is a new peer: new peer id, same room, and the host is told.
  const rejoined = await waitFor('the guest to be seated again', () => {
    const peerId = guest.session().peer.peer_id;
    return peerId !== firstPeerId ? peerId : false;
  });
  assert.notEqual(rejoined, firstPeerId);
  assert.equal(guest.session().role, 'guest');
  assert.equal(guest.session().roomId, host.session().roomId);
  assert.equal(guest.openDocuments().includes(PATH), true);
  assert.deepEqual(
    events.types().filter((type) => type === 'disconnected'),
    [],
    'a reconnectable drop is not a lost session',
  );
  assert.deepEqual(
    events.types().filter((type) => type === 'sessionError'),
    [],
    'a plain drop is not a server fault',
  );

  // The host learns the new peer id under the same display name.
  const bobAgain = await waitFor('the host to see the rejoined guest', () =>
    host.peers().find((peer) => peer.peer_id === rejoined) ?? false,
  );
  assert.equal(bobAgain.display_name, 'Bob');
  assert.equal(host.peers().length, 1, 'the departed connection is gone, not duplicated');

  // Content is not replayed by the server: it flows again because both sides sync.
  host.insert(PATH, 0, 'after the drop\n');
  const merged = await converge(host, guest, PATH);
  assert.ok(merged.includes('before the drop'), merged);
  assert.ok(merged.includes('after the drop'), merged);
});

test('a host that dropped reclaims its room rather than minting a second one', async (t) => {
  const session = await fakeSession({}, { reconnect: FAST_RECONNECT });
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  const { host, guest } = session;
  await host.open(PATH);
  await guest.open(PATH);
  host.insert(PATH, 0, 'before the drop\n');
  await converge(host, guest, PATH);
  const roomId = host.session().roomId;
  const firstHostPeerId = host.session().peer.peer_id;

  const events = record(guest);
  session.server.drop('Ada');

  // The room is the same one, and the peer is new: a reclaim, not a fresh room (§9.1).
  const reclaimed = await waitFor('the host to be seated again', () => {
    const peerId = host.session().peer.peer_id;
    return peerId !== firstHostPeerId ? peerId : false;
  });
  assert.equal(host.session().roomId, roomId);
  assert.equal(host.session().role, 'host');
  assert.equal(host.session().token, session.host.session().token);
  assert.equal(guest.session().roomId, roomId);
  assert.deepEqual(
    events.types().filter((type) => type === 'roomGone'),
    [],
    'the room never died',
  );

  const attached = await events.waitForEvent(
    'the guest to be told the host attached',
    (event) => event.type === 'hostAttached',
  );
  assert.ok(attached.type === 'hostAttached');
  assert.equal(attached.peer.peer_id, reclaimed);

  // The reclaimed host still holds its document and reconverges with the guest.
  assert.deepEqual(host.openDocuments(), [PATH]);
  guest.insert(PATH, 0, 'after the drop\n');
  const merged = await converge(host, guest, PATH);
  assert.ok(merged.includes('before the drop'), merged);
  assert.ok(merged.includes('after the drop'), merged);
});

test('a room destroyed under a client ends the session, and nothing retries it', async (t) => {
  const server = await FakeServer.start({ roomGraceMs: 200 });
  t.after(async () => {
    await server.stop();
  });
  const host = await SelvageEngine.host(server.wsBase, 'Ada', {
    meta: 'skip',
    reconnect: false,
  });
  const invite = host.inviteUrl() ?? '';
  const guest = await SelvageEngine.join(
    invite,
    'Bob',
    options({
      baseUrl: server.wsBase,
      displayName: 'Bob',
      reconnect: FAST_RECONNECT,
    }),
  );
  t.after(async () => {
    await host.disconnect();
    await guest.disconnect();
  });
  const events = record(guest);
  const roomId = host.session().roomId;
  await host.open(PATH);
  await guest.open(PATH);

  // The host does not come back, so the grace period expires while the guest is seated
  // in the room again: the reaper's `room.gone` arrives on a live connection.
  server.drop('Ada');
  await events.waitForEvent(
    'the guest to be told the host detached',
    (event) => event.type === 'hostDetached',
  );
  server.drop('Bob');

  await events.waitForEvent(
    'the guest to be told the room is gone',
    (event) => event.type === 'roomGone',
  );
  await events.waitForEvent(
    'the guest to be told the session ended',
    (event) => event.type === 'disconnected',
  );
  assert.equal(guest.isOpen, false);
  assert.equal(guest.session().roomId, roomId);
  await waitFor('the close that ends the session', () =>
    server.connectionCount === 0,
  );
  // §9.1: a destroyed room is gone for good, on any URL.
  await assert.rejects(
    SelvageEngine.join(invite, 'Dan', options({
      baseUrl: server.wsBase,
      displayName: 'Dan',
    })),
    (error: unknown) => isProtocolError(error, 'room_unknown'),
  );

  // Nothing retries a room that is gone for good: the only connection that appears is
  // this test's own, and it is refused and closed like the others.
  await waitFor('the refused join to close', () => server.connectionCount === 0);
  assert.equal(guest.isOpen, false);
  assert.deepEqual(guest.session().roomId, roomId);
});

test('a reconnect that is refused as host_present does not become a second host', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const host = await SelvageEngine.host(server.wsBase, 'Ada', {
    meta: 'skip',
    reconnect: FAST_RECONNECT,
  });
  t.after(async () => {
    await host.disconnect();
  });
  // A second connection claiming the host role while the host is present is refused, and
  // the refusal is terminal rather than a retry loop.
  const token = host.session().token ?? '';
  await assert.rejects(
    SelvageEngine.connect(
      options({
        baseUrl: server.wsBase,
        displayName: 'Ada again',
        room: host.session().roomId,
        token,
        role: 'host',
        reconnect: FAST_RECONNECT,
      }),
    ),
    (error: unknown) => isProtocolError(error, 'host_present'),
  );
  assert.equal(host.isOpen, true, 'the seated host is untouched');
  await waitFor('the refused connection to close', () =>
    server.connectionCount === 1,
  );
});
