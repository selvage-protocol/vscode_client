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

test('a dropped guest re-hellos under a fresh awareness client id', async (t) => {
  const session = await fakeSession({}, { reconnect: FAST_RECONNECT });
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  const { guest } = session;
  await guest.open(PATH);
  const firstPeerId = guest.session().peer.peer_id;
  const firstAwarenessId = guest.session().peer.awareness_client_id;

  session.server.drop('Bob');
  await waitFor('the guest to be seated again', () => {
    const peerId = guest.session().peer.peer_id;
    return peerId !== firstPeerId ? peerId : false;
  });

  // Spec §9.1: a reconnect is a new peer, so its awareness client id must not be the one
  // the previous connection used — reusing it is silently dropped by a peer that already
  // tombstoned the old id.
  const secondAwarenessId = guest.session().peer.awareness_client_id;
  assert.notEqual(secondAwarenessId, firstAwarenessId);
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

test('a request the connection dies under is failed, and its frame is not replayed', async (t) => {
  const session = await fakeSession({}, { reconnect: FAST_RECONNECT });
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  const { host, guest } = session;
  await host.open(PATH);
  await guest.open(PATH);
  const firstPeerId = guest.session().peer.peer_id;

  // Held outbound, so this request never reaches the server before the socket dies.
  guest.pauseOutbound(true);
  let queuedOutcome: string | undefined;
  void guest.open('stale.txt').then(
    () => {
      queuedOutcome = 'resolved';
    },
    (error: Error) => {
      queuedOutcome = error.name;
    },
  );
  session.server.drop('Bob');
  await waitFor('the queued request to be failed by the drop', () => queuedOutcome, {
    timeoutMs: 2000,
  });
  assert.equal(queuedOutcome, 'EngineClosedError');

  // A request issued while there is no connection to carry it is not left outstanding:
  // replaying it on the next connection would recycle its id onto a fresh peer (§9.1).
  let downOutcome: string | undefined;
  void guest.open('late.txt').then(
    () => {
      downOutcome = 'resolved';
    },
    (error: Error) => {
      downOutcome = error.name;
    },
  );
  await waitFor('the request issued while down to settle', () => downOutcome, {
    timeoutMs: 2000,
  });
  assert.equal(downOutcome, 'EngineClosedError');

  guest.pauseOutbound(false);
  await waitFor(
    'the guest to be seated again',
    () => guest.session().peer.peer_id !== firstPeerId,
  );
  await guest.open('new.txt');
  assert.deepEqual(guest.openDocuments().sort(), [PATH, 'new.txt'].sort());
  await waitFor("the room to carry the new hold", () =>
    host.documents().includes('new.txt'),
  );
  assert.deepEqual(
    host.documents().filter((path) => path !== PATH),
    ['new.txt'],
    'a request no connection carried opened nothing for the room',
  );
});

test('a reconnect restores the engine’s own holds before it tells the adapter', async (t) => {
  const session = await fakeSession({}, { reconnect: FAST_RECONNECT });
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  const { host, guest } = session;
  await host.open(PATH);
  await guest.open(PATH);
  const firstPeerId = guest.session().peer.peer_id;

  // An adapter that re-opens a document the moment it is told the session is back.
  const reopened: Array<Promise<void>> = [];
  const stop = guest.on((event) => {
    if (
      event.type === 'documentsChanged' &&
      reopened.length === 0 &&
      guest.session().peer.peer_id !== firstPeerId
    ) {
      reopened.push(guest.open('adapter.txt'));
    }
  });
  t.after(stop);

  const since = session.server.requests.length;
  session.server.drop('Bob');
  await waitFor('the adapter to react to the reconnect', () => reopened.length > 0, {
    timeoutMs: 3000,
  });
  await Promise.all(reopened);
  const order = session.server.requests
    .slice(since)
    .filter((request) => request.client === 'Bob')
    .map((request) => request.path);
  assert.deepEqual(
    order,
    [PATH, 'adapter.txt'],
    'the engine re-opens its own holds before the events reach the adapter',
  );
});

test('a re-open the server refuses is reported, not swallowed', async (t) => {
  const session = await fakeSession({}, { reconnect: FAST_RECONNECT });
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  const { host, guest } = session;
  await host.open(PATH);
  await guest.open(PATH);
  const firstPeerId = guest.session().peer.peer_id;
  const events = record(guest);

  // From here the server refuses this path. A refusal is an error response on a
  // connection that stays up, so nothing else would report that it was not re-opened.
  session.server.refusedOpens.add(PATH);
  session.server.drop('Bob');
  const reported = await events.waitForEvent(
    'the refused re-open to be reported',
    (event) => event.type === 'sessionError' && event.code === 'bad_params',
    { timeoutMs: 3000 },
  );
  assert.ok(reported.type === 'sessionError');
  assert.equal(reported.message, 'this path is refused');
  assert.notEqual(guest.session().peer.peer_id, firstPeerId);
  assert.equal(guest.isOpen, true, 'the connection is not what failed');
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

test('a handshake that is never answered is abandoned, closed and retried', async (t) => {
  // The connection is seated, then every later one takes the upgrade and goes quiet, so the
  // reconnection's handshakes time out. This is the path that used to leave the abandoned
  // socket open and read its later close as the session ending.
  const server = await FakeServer.start({ silentAfter: 1 });
  t.after(async () => {
    await server.stop();
  });
  const host = await SelvageEngine.host(server.wsBase, 'Ada', {
    meta: 'skip',
    handshakeTimeoutMs: 80,
    reconnect: { initialDelayMs: 10, maxDelayMs: 20, maxAttempts: 2 },
  });
  t.after(async () => {
    await host.disconnect();
  });
  const events = record(host);
  await host.open(PATH);
  server.drop('Ada');

  await events.waitForEvent(
    'the host to give up after its attempts',
    (event) => event.type === 'disconnected',
    { timeoutMs: 3000 },
  );
  assert.equal(host.isOpen, false);
  assert.equal(
    server.acceptedConnections,
    3,
    'the seated connection and two retries',
  );
  // The two abandoned attempts were closed rather than left open. Waited for, not asserted
  // instantly: the server learns of a close a tick after the client sends it, so sampling the
  // count the moment the last retry gives up is a race — it failed roughly one run in five.
  await waitFor('the abandoned connections to be closed', () =>
    server.connectionCount === 0,
  );
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

test('a reconnect re-learns the room\'s grant, and a drop drops the listing', async (t) => {
  const session = await fakeSession({}, { reconnect: FAST_RECONNECT });
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  const { host, guest } = session;
  await host.grant(['README.md', 'src/main.rs']);
  await waitFor('the guest to learn the grant', () =>
    guest.grantedPaths().length > 0 ? guest.grantedPaths() : false,
  );
  const firstPeerId = guest.session().peer.peer_id;
  const events = record(guest);

  session.server.drop('Bob');

  // The listing is this replica's view of the room and the room restates it after the join,
  // so the drop takes it away before the reconnect brings it back.
  const cleared = await events.waitForEvent(
    'the grant to be dropped with the connection',
    (event) => event.type === 'grantChanged' && event.paths.length === 0,
  );
  assert.deepEqual(cleared.type === 'grantChanged' ? cleared.paths : undefined, []);

  await waitFor('the guest to be seated again', () => {
    const peerId = guest.session().peer.peer_id;
    return peerId !== firstPeerId ? peerId : false;
  });
  const relearned = await waitFor('the grant to come back', () =>
    guest.grantedPaths().length > 0 ? guest.grantedPaths() : false,
  );
  assert.deepEqual(relearned, ['README.md', 'src/main.rs']);
});

test('a reconnect into a room that now grants nothing shows nothing', async (t) => {
  const session = await fakeSession({}, { reconnect: FAST_RECONNECT });
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  const { host, guest } = session;
  await host.grant(['README.md']);
  await waitFor('the guest to learn the grant', () =>
    guest.grantedPaths().length > 0 ? guest.grantedPaths() : false,
  );

  // The host empties the grant while the guest's socket is down, so the guest misses the
  // event and its stale listing is all it has to go on. A server sends no `doc.granted` for an
  // empty grant, which is why the drop has to be what took the listing away.
  const firstPeerId = guest.session().peer.peer_id;
  session.server.drop('Bob');
  await host.grant([]);

  await waitFor('the guest to be seated again', () => {
    const peerId = guest.session().peer.peer_id;
    return peerId !== firstPeerId ? peerId : false;
  });
  assert.deepEqual(
    guest.grantedPaths(),
    [],
    'the listing the drop took away came back on the reconnect',
  );
});
