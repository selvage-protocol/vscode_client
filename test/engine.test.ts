/**
 * Engine tests over a fake `selvaged` (`test/helpers/fake-server.ts`), so they run
 * without a Rust build. The real server is exercised in `test/selvaged.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SelvageEngine } from '../src/engine/engine.ts';
import { ProtocolError, isProtocolError } from '../src/engine/errors.ts';
import { caret } from '../src/engine/presence.ts';
import { FakeServer } from './helpers/fake-server.ts';
import { ControlledSocket } from './helpers/controlled-socket.ts';
import { fakeSession, options } from './helpers/session.ts';
import {
  converge,
  record,
  waitFor,
  waitForPeer,
  waitForPresence,
} from './helpers/wait.ts';

const PATH = 'src/main.rs';

test('a host mints a room and gets an invite URL it can be joined through', async (t) => {
  const session = await fakeSession();
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });

  const hostSession = session.host.session();
  assert.equal(hostSession.role, 'host');
  assert.match(hostSession.roomId, /^r-[0-9a-f]+$/);
  assert.equal(typeof hostSession.token, 'string');
  assert.deepEqual(hostSession.peers, []);
  assert.ok(hostSession.capabilities.includes('y-protocols/1'));
  assert.equal(hostSession.keepalive.awareness_renew_ms, 15_000);

  // The invite URL *is* the connection URL (spec §5.1).
  assert.equal(
    session.invite,
    `${session.server.wsBase}/session?room=${hostSession.roomId}&token=${hostSession.token}`,
  );
  assert.equal(session.guest.session().role, 'guest');
  assert.equal(session.guest.inviteUrl(), undefined);
  assert.equal(session.guest.session().roomId, hostSession.roomId);

  // Both sides learn the other, with the awareness client id that attributes a cursor.
  const bob = await waitForPeer(session.host, 'Bob');
  const ada = await waitForPeer(session.guest, 'Ada');
  assert.equal(bob.role, 'guest');
  assert.equal(ada.role, 'host');
  assert.equal(bob.awareness_client_id, session.guest.session().peer.awareness_client_id);
  assert.equal(ada.awareness_client_id, session.host.session().peer.awareness_client_id);
});

test('a refusal is reported with its session error code', async (t) => {
  const server = await FakeServer.start();
  const host = await SelvageEngine.host(server.wsBase, 'Ada', { meta: 'skip' });
  t.after(async () => {
    await host.disconnect();
    await server.stop();
  });
  const room = host.session().roomId;

  // A wrong token is refused before seating, with the code the spec names (§11).
  await assert.rejects(
    SelvageEngine.join(
      `${server.wsBase}/session?room=${room}&token=wrong`,
      'Eve',
      options({ baseUrl: server.wsBase, displayName: 'Eve' }),
    ),
    (error: unknown) =>
      isProtocolError(error, 'token_invalid') &&
      error.message.includes('token'),
  );

  // A room that was never minted is refused the same way, and differently.
  await assert.rejects(
    SelvageEngine.join(
      `${server.wsBase}/session?room=r-deadbeef0000&token=x`,
      'Eve',
      options({ baseUrl: server.wsBase, displayName: 'Eve' }),
    ),
    (error: unknown) => isProtocolError(error, 'room_unknown'),
  );

  // Exactly one host connection at a time (§9).
  await assert.rejects(
    SelvageEngine.connect(
      options({
        baseUrl: server.wsBase,
        displayName: 'Eve',
        room,
        token: host.session().token ?? '',
        role: 'host',
      }),
    ),
    (error: unknown) => isProtocolError(error, 'host_present'),
  );

  // An invite URL that is not a session URL is refused without a connection attempt.
  await assert.rejects(
    SelvageEngine.join('https://example.test/join?room=r', 'Eve', options({
      baseUrl: server.wsBase,
      displayName: 'Eve',
    })),
    (error: unknown) => isProtocolError(error, 'bad_params'),
  );
});

test('a handshake refused with close 4000 keeps the code the server named', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  // §11: bad_params, bad_message and hello_required all close with 4000, so the close
  // code alone names none of them. The session.error before it is what names the fault.
  await assert.rejects(
    SelvageEngine.host(server.wsBase, '', { meta: 'skip' }),
    (error: unknown) => isProtocolError(error, 'bad_params'),
  );
});

test('a close with no recorded reason is read from its close code', async () => {
  const protocolError = new ControlledSocket();
  const refused = SelvageEngine.host('ws://controlled.test', 'Ada', {
    meta: 'skip',
    reconnect: false,
    webSocketFactory: () => protocolError,
  });
  await waitFor('the engine to attach its handlers', () => protocolError.onopen !== null);
  protocolError.open();
  // 4000 is protocol_error; with no session.error before it, §11 calls it bad_message.
  protocolError.fromPeer(4000, 'protocol_error');
  await assert.rejects(refused, (error: unknown) =>
    isProtocolError(error, 'bad_message'),
  );

  const wentAway = new ControlledSocket();
  const abandoned = SelvageEngine.host('ws://controlled.test', 'Ada', {
    meta: 'skip',
    reconnect: false,
    webSocketFactory: () => wentAway,
  });
  await waitFor('the engine to attach its handlers', () => wentAway.onopen !== null);
  wentAway.open();
  // A clean close reports no fault: what happened is that the handshake never completed.
  wentAway.fromPeer(1000, '');
  await assert.rejects(abandoned, (error: unknown) =>
    isProtocolError(error, 'hello_required'),
  );
});

test('/meta is read before connecting: unreachable is advisory, incompatible is a refusal', async (t) => {
  // `/meta` that names only a version this client cannot speak: refused, no socket opened.
  const incompatible = await FakeServer.start({ metaWireVersions: ['selvage/2'] });
  t.after(async () => {
    await incompatible.stop();
  });
  await assert.rejects(
    SelvageEngine.host(incompatible.wsBase, 'Ada', {}),
    (error: unknown) =>
      isProtocolError(error, 'unsupported_version') &&
      error.message.includes('selvage/2'),
  );
  assert.equal(incompatible.connectionCount, 0, 'no socket was opened');

  // A handshake that works while `/meta` does not: the endpoint is a convenience.
  const degraded = await FakeServer.start({ metaStatus: 404 });
  t.after(async () => {
    await degraded.stop();
  });
  const host = await SelvageEngine.host(degraded.wsBase, 'Ada', {});
  t.after(async () => {
    await host.disconnect();
  });
  assert.equal(host.session().role, 'host');
});

test('the open-document set belongs to the room, and a hold belongs to a connection', async (t) => {
  const session = await fakeSession();
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  const { host, guest } = session;
  const events = record(guest);

  await host.open(PATH);
  assert.deepEqual(host.documents(), [PATH]);
  await guest.open(PATH);
  assert.deepEqual(guest.documents(), [PATH], 'both holds are one path in the set');

  await guest.open('docs/notes.md');
  assert.deepEqual(guest.documents(), [PATH, 'docs/notes.md']);
  await waitFor("the host to see the room's set", () =>
    host.documents().includes('docs/notes.md'),
  );

  // Closing releases only this connection's hold: the host still holds the path (§5).
  await guest.close(PATH);
  assert.deepEqual(guest.documents(), [PATH, 'docs/notes.md']);
  await host.close(PATH);
  assert.deepEqual(host.documents(), ['docs/notes.md']);

  // The event carries the set after the change, to every peer including the sender.
  const closed = await events.waitForEvent(
    "the guest to be told the path left the room's set",
    (event) => event.type === 'documentsChanged' && !event.documents.includes(PATH),
  );
  assert.deepEqual(closed, { type: 'documentsChanged', documents: ['docs/notes.md'] });
});

test('a request is answered by its id, and a refusal rejects that request', async (t) => {
  const session = await fakeSession();
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  const { host, guest } = session;
  await host.open(PATH);
  await guest.open(PATH);
  await host.insert(PATH, 0, 'fn main() {}\n');
  await waitFor('the guest to receive the seeded document', () =>
    guest.text(PATH) === 'fn main() {}\n',
  );

  // Two replies that arrive on one connection are matched by id, not by order.
  const [a, b] = await Promise.all([guest.open('a.txt'), guest.open('b.txt')]);
  assert.equal(a, undefined);
  assert.equal(b, undefined);
  assert.deepEqual(guest.openDocuments().sort(), [PATH, 'a.txt', 'b.txt'].sort());

  // The server's own refusal (an empty path) rejects the request that carried the id.
  await assert.rejects(guest.open('  '), (error: unknown) =>
    isProtocolError(error, 'bad_params'),
  );

  // An unknown method is an error and the connection stays usable (§4.2).
  assert.equal(guest.isOpen, true);
  await guest.open('c.txt');
  assert.ok(guest.openDocuments().includes('c.txt'));
});

test('a request in flight when the socket drops fails rather than hanging', async (t) => {
  const session = await fakeSession();
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  // Paused outbound, so the request never reaches the server before the drop.
  session.guest.pauseOutbound(true);
  const asked = session.guest.open(PATH);
  session.server.drop('Bob');
  await assert.rejects(asked, (error: unknown) =>
    error instanceof Error && error.name === 'EngineClosedError',
  );
});

test('text converges between two engines, and the paths that changed are named', async (t) => {
  const session = await fakeSession();
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  const { host, guest } = session;
  await host.open(PATH);
  await guest.open(PATH);
  await host.open('docs/notes.md');
  await guest.open('docs/notes.md');

  const events = record(guest);
  host.insert(PATH, 0, 'fn main() {}\n');
  const changed = await events.waitForEvent(
    'the guest to report the changed document',
    (event) => event.type === 'documentChanged' && event.path === PATH,
  );
  assert.ok(changed.type === 'documentChanged');
  assert.deepEqual(
    events.events.filter((event) => event.type === 'documentChanged'),
    [{ type: 'documentChanged', path: PATH }],
    'only the document that changed is reported',
  );

  // A cursor move is awareness, not text: no adapter should re-reconcile a buffer for it.
  const before = events.events.length;
  host.setSelection(PATH, { anchor: 0, head: 2 });
  await events.waitForEvent(
    'the guest to see the host\'s cursor',
    (event) => event.type === 'presenceChanged',
  );
  assert.equal(
    events.events
      .slice(before)
      .filter((event) => event.type === 'documentChanged').length,
    0,
    'an awareness frame is not a document change',
  );

  // Concurrent edits, made concurrent by holding outbound frames on both sides.
  host.pauseOutbound(true);
  guest.pauseOutbound(true);
  host.insert(PATH, 0, 'AAA ');
  guest.insert(PATH, 0, 'BBB ');
  assert.equal(host.text(PATH), 'AAA fn main() {}\n');
  assert.equal(guest.text(PATH), 'BBB fn main() {}\n');
  host.pauseOutbound(false);
  guest.pauseOutbound(false);

  const merged = await converge(host, guest, PATH);
  assert.ok(merged.includes('AAA') && merged.includes('BBB'), merged);
  assert.ok(
    merged.startsWith('AAA BBB ') || merged.startsWith('BBB AAA '),
    `concurrent inserts stay contiguous: ${merged}`,
  );
  await waitFor('the state vectors to agree', () => {
    const left = JSON.stringify(host.stateVector());
    const right = JSON.stringify(guest.stateVector());
    return left === right ? left : false;
  });
});

test('presence is attributed to a peer, and dropped when that peer leaves', async (t) => {
  const session = await fakeSession();
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  const { host, guest } = session;
  await host.open(PATH);
  await guest.open(PATH);

  const ada = await waitForPeer(guest, 'Ada');
  const bob = await waitForPeer(host, 'Bob');
  host.setSelection(PATH, { anchor: 0, head: 2 });
  guest.setSelection(PATH, caret(11));

  // A state arrives as a sequence: the empty one published at seating, then the cursor.
  const bobOnHost = await waitFor("Bob's cursor to reach the host", () =>
    host
      .presence()
      .find(
        (presence) =>
          presence.peer?.display_name === 'Bob' &&
          presence.state?.selection?.anchor === 11,
      ) ?? false,
  );
  assert.equal(bobOnHost.clientId, bob.awareness_client_id);
  assert.deepEqual(bobOnHost.state, {
    path: PATH,
    selection: { anchor: 11, head: 11 },
  });

  const adaOnGuest = await waitFor("Ada's cursor to reach the guest", () =>
    guest
      .presence()
      .find(
        (presence) =>
          presence.peer?.display_name === 'Ada' &&
          presence.state?.selection?.anchor === 0,
      ) ?? false,
  );
  assert.equal(adaOnGuest.clientId, ada.awareness_client_id);
  assert.deepEqual(adaOnGuest.state, {
    path: PATH,
    selection: { anchor: 0, head: 2 },
  });

  const events = record(host);
  await guest.disconnect();
  await events.waitForEvent(
    'the host to be told the guest left',
    (event) => event.type === 'peersChanged' && event.peers.length === 0,
  );
  assert.equal(
    host.presence().some((presence) => presence.clientId === bob.awareness_client_id),
    false,
    'a departed peer keeps no cursor',
  );
});

test('a remote state that stops renewing is forgotten on the server-advertised clock', async (t) => {
  // The reader runs a compressed clock; the silent peer runs a long one, so it publishes
  // once and never renews. §8.2: expiry is the reader's, at the advertised scale.
  const session = await fakeSession();
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  const { host, guest } = session;
  host.setAwareness({ path: PATH, selection: caret(0) });

  const bob = guest.session().peer.awareness_client_id;
  assert.equal(typeof bob, 'number');
  await waitForPresence(host, 'Bob');

  // The host now runs the compressed clock the server advertises for the session.
  const reader = await SelvageEngine.join(session.invite, 'Cleo', options({
    baseUrl: session.server.wsBase,
    displayName: 'Cleo',
    keepalive: { renewMs: 20, expireMs: 80 },
  }));
  t.after(async () => {
    await reader.disconnect();
  });
  await waitForPresence(reader, 'Ada');

  // The guest's clock is long enough that it does not renew inside the reader's window.
  guest.setAwareness({ path: PATH, selection: caret(0) });
  await waitForPresence(reader, 'Bob');
  await waitFor(
    "the reader to forget a state that stopped renewing",
    () => reader.presence().every((presence) => presence.peer?.display_name !== 'Bob'),
    { timeoutMs: 3000, describe: () => reader.presence() },
  );
});

test('the room lifecycle reaches the adapter: host detached, room gone, disconnected', async (t) => {
  const session = await fakeSession({ roomGraceMs: 40 });
  t.after(async () => {
    await session.host.disconnect();
    await session.server.stop();
  });
  const { host, guest } = session;
  await host.open(PATH);
  await guest.open(PATH);
  await host.insert(PATH, 0, 'shared\n');
  await converge(host, guest, PATH);

  const events = record(guest);
  await host.disconnect();
  const detached = await events.waitForEvent(
    'the guest to be told the host detached',
    (event) => event.type === 'hostDetached',
  );
  assert.ok(detached.type === 'hostDetached');
  assert.equal(detached.graceMs, 40);

  const gone = await events.waitForEvent(
    'the guest to be told the room is gone',
    (event) => event.type === 'roomGone',
  );
  assert.ok(gone.type === 'roomGone');
  await events.waitForEvent(
    'the guest to be told the session ended',
    (event) => event.type === 'disconnected',
  );
  assert.equal(guest.isOpen, false, 'a destroyed room is not retried');
  assert.equal(guest.session().roomId, session.host.session().roomId);

  // §9.1: `room_unknown` means the room is gone for good, on any URL.
  await assert.rejects(
    SelvageEngine.join(session.invite, 'Dan', options({
      baseUrl: session.server.wsBase,
      displayName: 'Dan',
    })),
    (error: unknown) => isProtocolError(error, 'room_unknown'),
  );
});

test('frames this client does not understand are ignored, not fatal', async (t) => {
  const session = await fakeSession();
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  const { host, guest } = session;
  const events = record(guest);

  // An unknown event, an `x.` event, a frame that is not JSON, and a binary frame with a
  // message type that does not exist in y-protocols.
  session.server.sendToClient('Bob', JSON.stringify({
    v: 'selvage/1',
    event: 'x.private',
    params: { anything: true },
  }));
  session.server.sendToClient('Bob', 'this is not a session envelope');
  session.server.sendToClient('Bob', JSON.stringify({ v: 'selvage/1', event: 'future.event' }));
  session.server.sendBinaryToClient('Bob', new Uint8Array([200, 1, 2, 3]));

  // The session is untouched by all of it.
  await host.open(PATH);
  await guest.open(PATH);
  host.insert(PATH, 0, 'still here\n');
  assert.equal(await converge(host, guest, PATH), 'still here\n');
  assert.equal(
    events.events.some((event) => event.type === 'disconnected'),
    false,
  );
});

test('a fault the server cannot attach to a request reaches the adapter', async (t) => {
  const session = await fakeSession();
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  const events = record(session.guest);
  // `session.error` is for faults with no request to attach them to (spec §6, §11).
  session.server.sendToClient('Bob', JSON.stringify({
    v: 'selvage/1',
    event: 'session.error',
    params: { code: 'bad_message', message: 'a request needs an id' },
  }));

  const reported = await events.waitForEvent(
    'the guest to be told about the fault',
    (event) => event.type === 'sessionError',
  );
  assert.deepEqual(reported, {
    type: 'sessionError',
    code: 'bad_message',
    message: 'a request needs an id',
  });
  // The fault is not terminal by itself, so the session is still usable.
  await session.host.open(PATH);
  await session.guest.open(PATH);
  assert.equal(session.guest.openDocuments().includes(PATH), true);
});

test('closing a path this connection never held releases nothing, and a bad path is refused', async (t) => {
  const session = await fakeSession();
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  await session.host.open('never-opened-by-the-guest.txt');
  await session.guest.close('never-opened-by-the-guest.txt');
  assert.deepEqual(session.guest.openDocuments(), []);
  // A path the server refuses rejects the request rather than leaving it outstanding.
  const error = await session.host.open('').catch((reason: unknown) => reason);
  assert.ok(error instanceof ProtocolError);
  assert.equal(error.code, 'bad_params');
});
