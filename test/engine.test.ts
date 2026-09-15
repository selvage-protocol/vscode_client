/**
 * Engine tests over a fake `selvaged` (`test/helpers/fake-server.ts`), so they run
 * without a Rust build. The real server is exercised in `test/selvaged.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import { SelvageEngine } from '../src/engine/engine.ts';
import type { ConnectOptions } from '../src/engine/engine.ts';
import { EngineClosedError, ProtocolError, isProtocolError } from '../src/engine/errors.ts';
import * as Y from 'yjs';

import { caret } from '../src/engine/presence.ts';
import type { Anchor, AwarenessState } from '../src/engine/presence.ts';
import { FakeServer } from './helpers/fake-server.ts';
import { ControlledSocket } from './helpers/controlled-socket.ts';
import { counting } from './helpers/counting-socket.ts';
import type { Counting } from './helpers/counting-socket.ts';
import { fakeSession, options } from './helpers/session.ts';
import {
  converge,
  record,
  waitFor,
  waitForPeer,
  waitForPresence,
  waitForSelection,
} from './helpers/wait.ts';

const PATH = 'src/main.rs';

/** `anchorAt` for a document the test has already put a text behind. */
function anchored(engine: SelvageEngine, path: string, index: number): Anchor {
  const anchor = engine.anchorAt(path, index);
  assert.ok(anchor !== undefined, `no text for ${path}: the replica received nothing`);
  return anchor;
}

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

test('a connection that never comes up is abandoned by its deadline', async () => {
  // A transport that upgrades in the OS sense but never fires open, error or close — a
  // blackholed connect, or a stalled proxy. The handshake deadline covers the upgrade
  // too, or the caller waits for the operating system to give up instead.
  const blackhole = new ControlledSocket();
  let outcome: string | undefined;
  void SelvageEngine.host('ws://controlled.test', 'Ada', {
    meta: 'skip',
    reconnect: false,
    handshakeTimeoutMs: 50,
    webSocketFactory: () => blackhole,
  }).then(
    () => {
      outcome = 'seated';
    },
    (error: unknown) => {
      outcome = isProtocolError(error)
        ? `${error.name}:${error.code}`
        : String(error);
    },
  );
  await waitFor('the attempt to give up', () => outcome, { timeoutMs: 3000 });
  assert.equal(outcome, 'ProtocolError:hello_required');
  assert.ok(blackhole.closes > 0, 'the abandoned socket was closed');
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

test('a request the server never answers fails the caller by its deadline', async (t) => {
  const session = await fakeSession();
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  const reader = await SelvageEngine.join(
    session.invite,
    'Cleo',
    options({
      baseUrl: session.server.wsBase,
      displayName: 'Cleo',
      requestTimeoutMs: 100,
    }),
  );
  t.after(async () => {
    await reader.disconnect();
  });

  // The server takes the request and never answers it: a wedged peer, not a slow one.
  session.server.unansweredOpens.add('wedged.txt');
  let failure: unknown;
  void reader.open('wedged.txt').then(
    () => {
      failure = 'resolved';
    },
    (error: unknown) => {
      failure = error;
    },
  );
  await waitFor('the request to be failed by its deadline', () => failure, {
    timeoutMs: 3000,
  });
  assert.ok(
    failure instanceof EngineClosedError,
    `expected EngineClosedError, got ${String(failure)}`,
  );

  // The connection is not what failed, and the outcome is not guessed: whether the
  // server applied the request is unknowable (spec §5), so the hold is not recorded.
  assert.equal(reader.isOpen, true);
  assert.equal(reader.openDocuments().includes('wedged.txt'), false);
  await reader.open('after.txt');
  assert.ok(reader.openDocuments().includes('after.txt'));
});

test('a session reply with no room id is refused, not seated in a room named ""', async (t) => {
  const socket = new ControlledSocket();
  let seated: SelvageEngine | undefined;
  const attempted = SelvageEngine.host('ws://controlled.test', 'Ada', {
    meta: 'skip',
    reconnect: false,
    webSocketFactory: () => socket,
  }).then((engine: SelvageEngine) => {
    seated = engine;
    return engine;
  });
  t.after(async () => {
    await seated?.disconnect();
  });

  await waitFor('the engine to attach its handlers', () => socket.onopen !== null);
  socket.open();
  await waitFor('the engine to send session.hello', () => socket.sent.length > 0);
  // The room id is what a later reconnect carries; without it the next hello would mint
  // a second room instead of rejoining this one.
  socket.deliver(
    JSON.stringify({
      v: 'selvage/1',
      event: 'room.joined',
      params: {
        self: { peer_id: 'p-1', display_name: 'Ada', role: 'host' },
        peers: [],
        documents: [],
        capabilities: [],
        keepalive: {
          ping_interval_ms: 30_000,
          awareness_renew_ms: 15_000,
          awareness_expire_ms: 30_000,
        },
      },
    }),
  );
  await assert.rejects(attempted, (error: unknown) =>
    isProtocolError(error, 'bad_message'),
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

  // The grammar is the schema's (`^selvage/(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*))?$`), so a
  // leading zero is not a version at all: an advertisement that names only one names
  // nothing the client can speak, exactly as one naming another major does (§10,
  // CANONICAL.md §2.5).
  const malformed = await FakeServer.start({ metaWireVersions: ['selvage/01'] });
  t.after(async () => {
    await malformed.stop();
  });
  await assert.rejects(
    SelvageEngine.host(malformed.wsBase, 'Ada', {}),
    (error: unknown) => isProtocolError(error, 'unsupported_version'),
  );
  assert.equal(malformed.connectionCount, 0, 'no socket was opened');

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

  // A reply is matched by the id it carries, not by arrival order: one for an id nobody
  // is waiting on answers nobody rather than the first outstanding request.
  const events = record(guest);
  guest.pauseOutbound(true);
  const asked = guest.open('a.txt');
  session.server.sendToClient('Bob', JSON.stringify({
    v: 'selvage/1',
    id: 987_654,
    result: { documents: ['bogus.txt'] },
  }));
  // A frame that follows it, so the assertions cannot outrun the socket.
  session.server.sendToClient('Bob', JSON.stringify({
    v: 'selvage/1',
    event: 'host.detached',
    params: { grace_ms: 1 },
  }));
  await events.waitForEvent(
    'the frame sent after the stray reply to arrive',
    (event) => event.type === 'hostDetached',
  );
  assert.deepEqual(guest.documents(), [PATH], 'a stray reply changed nothing');
  assert.equal(guest.openDocuments().includes('a.txt'), false);
  guest.pauseOutbound(false);
  await asked;
  assert.ok(guest.openDocuments().includes('a.txt'));

  // Two requests in flight together are each answered by their own id.
  await Promise.all([guest.open('b.txt'), guest.open('c.txt')]);
  assert.deepEqual(
    guest.openDocuments().sort(),
    [PATH, 'a.txt', 'b.txt', 'c.txt'].sort(),
  );

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
  // An anchor names an element, so both replicas need the text before either takes one.
  host.insert(PATH, 0, 'fn main() {}\n');
  await converge(host, guest, PATH);
  host.setSelection(PATH, { anchor: 0, head: 2 });
  guest.setSelection(PATH, { anchor: 11, head: 11 });

  // A state arrives as a sequence: the empty one published at seating, then the cursor.
  const bobOnHost = await waitForSelection(
    host,
    'Bob',
    PATH,
    (selection) => selection.anchor === 11,
  );
  assert.equal(bobOnHost.presence.clientId, bob.awareness_client_id);
  assert.equal(bobOnHost.presence.state?.path, PATH);
  assert.deepEqual(bobOnHost.selection, { anchor: 11, head: 11 });

  const adaOnGuest = await waitForSelection(
    guest,
    'Ada',
    PATH,
    (selection) => selection.anchor === 0,
  );
  assert.equal(adaOnGuest.presence.clientId, ada.awareness_client_id);
  assert.deepEqual(adaOnGuest.selection, { anchor: 0, head: 2 });

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

test('setAwareness(null) clears presence rather than publishing an empty state', async (t) => {
  const session = await fakeSession();
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  const { host, guest } = session;
  await waitForPeer(host, 'Bob');

  // The document is here and genuinely empty — written and then deleted away, so both
  // replicas have the text and neither has a character. This is what §8.1's scope-only
  // form encodes; a document that never arrived is a different thing.
  await host.open(PATH);
  await guest.open(PATH);
  host.insert(PATH, 0, 'x');
  await converge(host, guest, PATH);
  host.delete(PATH, 0, 1);
  await converge(host, guest, PATH);

  guest.setAwareness({ path: PATH, selection: caret(anchored(guest, PATH, 0)) });
  const shown = await waitForSelection(host, 'Bob', PATH);
  assert.equal(shown.presence.state?.path, PATH);
  assert.deepEqual(shown.selection, { anchor: 0, head: 0 });
  assert.deepEqual(shown.presence.state?.selection, {
    anchor: { tname: PATH, assoc: 0 },
    head: { tname: PATH, assoc: 0 },
  });

  // `null` means the cursor is gone (spec §8.2), not that it is at nowhere in particular.
  guest.setAwareness(null);
  await waitFor(
    "Bob's presence to be gone",
    () =>
      host.presence().some((presence) => presence.peer?.display_name === 'Bob') ===
      false,
    { describe: () => host.presence() },
  );
});

/**
 * A host and a guest whose outbound frames are counted, so a test can name what the guest
 * published. A peer's own view cannot: an unchanged state is deliberately invisible to it.
 */
async function countedGuest(
  t: TestContext,
  connect: Partial<ConnectOptions> = {},
): Promise<{ host: SelvageEngine; guest: SelvageEngine; tap: Counting }> {
  const tap = counting();
  const server = await FakeServer.start();
  const host = await SelvageEngine.host(
    server.wsBase,
    'Ada',
    options({ baseUrl: server.wsBase, displayName: 'Ada', reconnect: false }),
  );
  const invite = host.inviteUrl();
  assert.ok(invite !== undefined, 'the host was given no invite URL');
  const guest = await SelvageEngine.join(
    invite,
    'Bob',
    options({
      baseUrl: server.wsBase,
      displayName: 'Bob',
      reconnect: false,
      webSocketFactory: tap.factory,
      ...connect,
    }),
  );
  t.after(async () => {
    await guest.disconnect();
    await host.disconnect();
    await server.stop();
  });
  await host.open(PATH);
  await guest.open(PATH);
  host.insert(PATH, 0, 'fn main() {}\n');
  await converge(host, guest, PATH);
  return { host, guest, tap };
}

test('an identical selection is not published a second time', async (t) => {
  const { host, guest, tap } = await countedGuest(t);
  guest.setSelection(PATH, { anchor: 1, head: 1 });
  await waitForSelection(host, 'Bob', PATH, (selection) => selection.anchor === 1);

  // Nothing else is in flight between the reset and the changed position, so the frames the
  // tally holds are the ones these two calls produced: a repeat of the state Bob already
  // holds, then a state he does not.
  tap.reset();
  guest.setSelection(PATH, { anchor: 1, head: 1 });
  guest.setSelection(PATH, { anchor: 2, head: 2 });
  const seen = await waitForSelection(host, 'Bob', PATH, (selection) => selection.anchor === 2);
  assert.deepEqual(seen.selection, { anchor: 2, head: 2 });
  assert.equal(tap.tally.sent.awareness, 1, 'the unchanged state was published again');
});

test('a renewal republishes the same state with a newer clock', async (t) => {
  const { host, guest, tap } = await countedGuest(t, {
    keepalive: { renewMs: 40, expireMs: 8000 },
  });
  guest.setSelection(PATH, { anchor: 1, head: 1 });
  await waitForSelection(host, 'Bob', PATH, (selection) => selection.anchor === 1);

  // A renewal is deliberately the state the room already has (§8.2), so it is the one
  // publication the comparison must not swallow.
  tap.reset();
  await waitFor(
    'the renewal tick to republish',
    () => tap.tally.sent.awareness > 0,
    { timeoutMs: 2000 },
  );
  await waitForSelection(host, 'Bob', PATH, (selection) => selection.anchor === 1);
});

test('clearing an already-clear presence publishes nothing', async (t) => {
  const { host, guest, tap } = await countedGuest(t);
  guest.setAwareness(null);
  await waitFor(
    "Bob's presence to be gone",
    () =>
      host.presence().some((presence) => presence.peer?.display_name === 'Bob') ===
      false,
    { describe: () => host.presence() },
  );

  tap.reset();
  guest.setAwareness(null);
  guest.setAwareness({ path: PATH, selection: caret(anchored(guest, PATH, 1)) });
  const seen = await waitForSelection(host, 'Bob', PATH, (selection) => selection.anchor === 1);
  assert.deepEqual(seen.selection, { anchor: 1, head: 1 });
  assert.equal(tap.tally.sent.awareness, 1, 'the second clear was published');
});

test('a changed state is published', async (t) => {
  const { host, guest, tap } = await countedGuest(t);
  guest.setSelection(PATH, { anchor: 1, head: 1 });
  await waitForSelection(host, 'Bob', PATH, (selection) => selection.anchor === 1);

  tap.reset();
  guest.setSelection(PATH, { anchor: 2, head: 4 });
  const seen = await waitForSelection(
    host,
    'Bob',
    PATH,
    (selection) => selection.head === 4,
  );
  assert.deepEqual(seen.selection, { anchor: 2, head: 4 });
  assert.equal(tap.tally.sent.awareness, 1);
});

test('a sender publishes no selection it cannot anchor', async (t) => {
  const session = await fakeSession();
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  const { host, guest } = session;
  const other = 'src/other.rs';
  /** Ada's state as Bob sees it: the wire, not this engine's own view. */
  const asSeenByBob = (): AwarenessState | undefined =>
    guest.presence().find((presence) => presence.peer?.display_name === 'Ada')?.state;

  // Opened, and nobody has written to it: this replica holds no `Y.Text`, so an offset in
  // it names nothing. §8.1: the path travels, the selection does not — the alternative is
  // "the caret is at the end of the text", which no peer can tell from the real thing.
  await host.open(other);
  host.setSelection(other, { anchor: 0, head: 0 });
  const unwritten = await waitFor(
    "Ada's state for a document she has not received",
    () => {
      const state = asSeenByBob();
      return state?.path === other ? state : false;
    },
    { describe: () => guest.presence() },
  );
  assert.equal(
    unwritten.selection,
    undefined,
    'no text in the replica, so no position in it',
  );

  // An offset past the end of a text this replica does hold is not one either.
  await host.open(PATH);
  host.insert(PATH, 0, 'abc');
  host.setSelection(PATH, { anchor: 99, head: 99 });
  const past = await waitFor(
    "Ada's state for a document she holds",
    () => {
      const state = asSeenByBob();
      return state?.path === PATH ? state : false;
    },
    { describe: () => guest.presence() },
  );
  assert.equal(past.selection, undefined, 'there is no element at offset 99');

  // The contrast: a position that does exist is published, as an anchor.
  host.setSelection(PATH, { anchor: 1, head: 1 });
  const held = await waitForSelection(
    guest,
    'Ada',
    PATH,
    (selection) => selection.anchor === 1,
  );
  assert.deepEqual(held.selection, { anchor: 1, head: 1 });
});

test('reading a path this replica has not received does not make it anchorable', async (t) => {
  const session = await fakeSession();
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  const { host, guest } = session;
  const other = 'src/other.rs';
  /** Ada's state as Bob sees it: the wire, not this engine's own view. */
  const asSeenByBob = (): AwarenessState | undefined =>
    guest.presence().find((presence) => presence.peer?.display_name === 'Ada')?.state;

  // In the room's open set, and received by nobody: no replica has a text for it.
  await host.open(other);

  // The two reads an adapter makes while rendering — a peer's cursor, and an anchor for a
  // state assembled by hand. Each of them used to hand back a freshly created empty text,
  // which is a document arriving by the act of reading it.
  const resolved = host.resolveSelection(other, caret({ tname: other, assoc: 0 }));
  const anchor = host.anchorAt(other, 0);

  // §8.1: the path travels and the selection does not, exactly as if nothing were read.
  host.setSelection(other, { anchor: 0, head: 0 });
  const unwritten = await waitFor(
    "Ada's state for a document she has not received",
    () => {
      const state = asSeenByBob();
      return state?.path === other ? state : false;
    },
    { describe: () => guest.presence() },
  );
  assert.equal(unwritten.selection, undefined, 'a read is not a local edit');

  // And each read reports the absence rather than inventing a position to resolve to.
  assert.equal(resolved, undefined, 'nothing has arrived, so nothing resolves');
  assert.equal(anchor, undefined, 'nothing has arrived, so no anchor points into it');
});

test("a peer's scope-only anchor for a document that has not arrived resolves to nothing", async (t) => {
  const session = await fakeSession();
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  const { host, guest } = session;
  const other = 'src/other.rs';
  await host.open(other);

  // What the wire carries for a caret in an empty text: the scope alone, published through
  // `setAwareness`, which ships a state verbatim. Ada has received nothing for the path, and
  // the receiver's rule matches the sender's — there is no position to resolve rather than
  // one at 0 in a document she has never seen.
  guest.setAwareness({ path: other, selection: caret({ tname: other, assoc: 0 }) });
  const held = await waitFor(
    "Ada to hold Bob's scope-only anchor",
    () =>
      host
        .presence()
        .find(
          (candidate) =>
            candidate.peer?.display_name === 'Bob' &&
            candidate.state?.path === other &&
            candidate.state.selection !== undefined,
        ) ?? false,
    { describe: () => host.presence() },
  );
  const selection = held.state?.selection;
  assert.ok(selection !== undefined, 'the state carries the scope alone');
  assert.equal(
    host.resolveSelection(other, selection),
    undefined,
    'an unarrived document is not a document at offset 0',
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
  // A path and nothing else: this test is about the clock, and no document exists here
  // for a selection to point into.
  host.setAwareness({ path: PATH });

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
  guest.setAwareness({ path: PATH });
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

const DRIFT_SEED = 'const answer = 42;\nlet total = 0;\n';

test('an insert before a peer\'s caret moves its offset and leaves its anchor alone', async (t) => {
  const session = await fakeSession();
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  const { host, guest } = session;
  await host.open(PATH);
  await guest.open(PATH);
  host.insert(PATH, 0, DRIFT_SEED);
  await converge(host, guest, PATH);

  const at = DRIFT_SEED.indexOf('let');
  guest.setSelection(PATH, { anchor: at, head: at + 2 });
  const before = await waitForSelection(
    host,
    'Bob',
    PATH,
    (selection) => selection.anchor === at,
  );
  assert.equal(
    host.text(PATH).slice(before.selection.anchor, before.selection.head),
    'le',
  );

  // The paste §8.1 exists to survive: 157 characters above the caret.
  const paste = `${'// '.repeat(50)}pasted\n`;
  host.insert(PATH, 0, paste);
  const after = await waitForSelection(
    host,
    'Bob',
    PATH,
    (selection) => selection.anchor === at + paste.length,
  );
  assert.deepEqual(
    after.presence.state?.selection,
    before.presence.state?.selection,
    'the anchor on the wire never moved; only the offset it resolves to did',
  );
  assert.equal(
    host.text(PATH).slice(after.selection.anchor, after.selection.head),
    'le',
    'the caret still holds the characters it was put on',
  );
});

test('a caret at the end of a document travels as tname and follows an append', async (t) => {
  const session = await fakeSession();
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  const { host, guest } = session;
  await host.open(PATH);
  await guest.open(PATH);
  host.insert(PATH, 0, 'fn main() {}\n');
  await converge(host, guest, PATH);

  // The end of a text has no element to name, so tname is the only encoding for it.
  const end = guest.text(PATH).length;
  guest.setSelection(PATH, { anchor: end, head: end });
  const seen = await waitForSelection(
    host,
    'Bob',
    PATH,
    (selection) => selection.anchor === end,
  );
  assert.deepEqual(seen.presence.state?.selection?.anchor, { tname: PATH, assoc: 0 });

  // tname with assoc 0 is the end of the text, so it follows an append forever (§8.1).
  host.insert(PATH, host.text(PATH).length, 'trailing\n');
  const appended = await waitForSelection(
    host,
    'Bob',
    PATH,
    (selection) => selection.anchor === host.text(PATH).length,
  );
  assert.equal(appended.selection.head, host.text(PATH).length);
});

test('offsets either side of a non-BMP character are UTF-16 code units', async (t) => {
  const session = await fakeSession();
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  const { host, guest } = session;
  await host.open(PATH);
  await guest.open(PATH);
  // The emoji is a surrogate pair: it holds indices 0 and 1, so "x" is at index 2.
  host.insert(PATH, 0, '😀x = 1;\n');
  await converge(host, guest, PATH);

  guest.setSelection(PATH, { anchor: 2, head: 3 });
  const seen = await waitForSelection(
    host,
    'Bob',
    PATH,
    (selection) => selection.anchor === 2,
  );
  assert.deepEqual(seen.selection, { anchor: 2, head: 3 });
  assert.equal(host.text(PATH).slice(2, 3), 'x', 'a code-point unit would say index 1');

  // A caret inside the surrogate pair is a state a peer tolerates rather than rejects.
  guest.setSelection(PATH, { anchor: 1, head: 1 });
  const half = await waitForSelection(
    host,
    'Bob',
    PATH,
    (selection) => selection.anchor === 1,
  );
  assert.equal(half.selection.head, 1);
});

test('half a character does not cross the wire, so only this replica can hold one', async (t) => {
  const session = await fakeSession();
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  const { host, guest } = session;
  await host.open(PATH);
  await guest.open(PATH);
  host.insert(PATH, 0, 'ab\n');
  await converge(host, guest, PATH);

  // yjs writes a text update with the UTF-8 encoder, which has no encoding for half a
  // character: the writer keeps its lone surrogate and every peer's replica holds U+FFFD in
  // its place. Nothing a peer sends can put half a character in this replica, so a change
  // that holds one can only come from this client's own text — which is what makes the
  // diff's output the place to keep it out of (`test/editing.test.ts`, `test/bridge.test.ts`).
  guest.insert(PATH, 1, '\ud83d');
  await waitFor('the replacement character to arrive', () => host.text(PATH) === 'a\ufffdb\n');
  assert.equal(guest.text(PATH), 'a\ud83db\n');
});

test('an endpoint that does not resolve is no selection, and the state is kept', async (t) => {
  const session = await fakeSession();
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  const { host, guest } = session;
  await host.open(PATH);
  await guest.open(PATH);
  host.insert(PATH, 0, 'fn main() {}\n');
  await converge(host, guest, PATH);

  /** Bob's state once the anchor it carries is the one this phase published. */
  const held = async (label: string, matches: (anchor: unknown) => boolean) =>
    waitFor(
      label,
      () =>
        host
          .presence()
          .find(
            (presence) =>
              presence.peer?.display_name === 'Bob' &&
              presence.state?.selection !== undefined &&
              matches(presence.state.selection.anchor),
          ) ?? false,
      { describe: () => host.presence() },
    );

  // An element no replica has ever seen: unresolvable, and not an exception.
  guest.setAwareness({
    path: PATH,
    selection: caret({ item: { client: 987_654_321, clock: 42 }, tname: PATH, assoc: 0 }),
  });
  const unknown = await held(
    "the host to hold Bob's anchor into an unknown client",
    (anchor) => (anchor as { item?: { client: number } }).item?.client === 987_654_321,
  );
  assert.ok(unknown.state?.selection !== undefined);
  assert.equal(
    host.resolveSelection(PATH, unknown.state.selection),
    undefined,
    'no selection, no clamp, and no throw',
  );
  assert.equal(
    unknown.state.path,
    PATH,
    'the state is retained for a later attempt: resolution is deferred (§8.1)',
  );

  // A tname naming another document is a scope mismatch, however well-formed it is.
  guest.setAwareness({
    path: PATH,
    selection: caret({ tname: 'docs/notes.md', assoc: 0 }),
  });
  const mismatched = await held(
    "the host to hold Bob's mismatched tname",
    (anchor) => (anchor as { tname?: string }).tname === 'docs/notes.md',
  );
  assert.ok(mismatched.state?.selection !== undefined);
  assert.equal(
    host.resolveSelection(PATH, mismatched.state.selection),
    undefined,
    'tname must equal the path it is resolved against',
  );

  // And the contrast: unknown keys on a sound anchor still resolve (§8.1).
  const anchor = anchored(guest, PATH, 4);
  guest.setAwareness({
    path: PATH,
    selection: { anchor: { ...anchor, mystery: 'ignored' }, head: anchor },
  } as never);
  const tolerated = await waitForSelection(
    host,
    'Bob',
    PATH,
    (selection) => selection.anchor === 4,
  );
  assert.deepEqual(tolerated.selection, { anchor: 4, head: 4 });
});

test('an element is a position only in the text its state names', async (t) => {
  const session = await fakeSession();
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  const { host, guest } = session;
  const other = 'src/other.rs';
  await host.open(PATH);
  await guest.open(PATH);
  await host.open(other);
  host.insert(PATH, 0, 'abc');
  host.insert(other, 0, 'xy');
  await converge(host, guest, other);

  // The element exists and resolves — in the other text. `item` is the element, `path` is
  // where the state puts it, and the branch check is the only thing that catches the two
  // disagreeing: a `yrs` anchor carries no `tname` for the scope test to reject.
  const elsewhere = anchored(host, other, 0);
  assert.ok(elsewhere.item !== undefined);
  const itemOnly: Anchor = { item: elsewhere.item, assoc: 0 };
  guest.setAwareness({ path: PATH, selection: caret(itemOnly) });
  const held = await waitFor(
    "Bob's element-only anchor for the other document",
    () => {
      const presence = host
        .presence()
        .find(
          (candidate) =>
            candidate.peer?.display_name === 'Bob' &&
            candidate.state?.selection?.anchor.item?.clock === elsewhere.item?.clock,
        );
      return presence ?? false;
    },
    { describe: () => host.presence() },
  );
  assert.ok(held.state?.selection !== undefined);
  assert.equal(
    host.resolveSelection(PATH, held.state.selection),
    undefined,
    'an element in another text is not a position in this one',
  );
});

test('an element that is gone resolves to the boundary, not to nothing', async (t) => {
  const session = await fakeSession();
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  const { host, guest } = session;
  await host.open(PATH);
  await guest.open(PATH);
  host.insert(PATH, 0, 'abcdef');
  await converge(host, guest, PATH);

  // A caret on `d`, published as an anchor naming it.
  guest.setSelection(PATH, { anchor: 3, head: 3 });
  const published = await waitForSelection(
    host,
    'Bob',
    PATH,
    (selection) => selection.anchor === 3,
  );
  const anchors = published.presence.state?.selection;
  assert.ok(anchors !== undefined);

  // The element it names is deleted. §8.1 calls the surviving boundary a success, so the
  // caret does not blink out because someone removed the character it was sitting on.
  host.delete(PATH, 3, 2);
  assert.equal(host.text(PATH), 'abcf');
  assert.deepEqual(
    host.resolveSelection(PATH, anchors),
    { anchor: 3, head: 3 },
    'the deleted element resolves where it was',
  );
});

test('a selection endpoint published with assoc 0 extends when an insert lands on it', async (t) => {
  const session = await fakeSession();
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  const { host, guest } = session;
  await host.open(PATH);
  await guest.open(PATH);
  host.insert(PATH, 0, 'abcdef');
  await converge(host, guest, PATH);

  guest.setSelection(PATH, { anchor: 2, head: 5 });
  const before = await waitForSelection(
    host,
    'Bob',
    PATH,
    (selection) => selection.head === 5,
  );
  assert.equal(
    before.presence.state?.selection?.head.assoc,
    0,
    "the head endpoint is published with `assoc: 0` (§12.4)",
  );

  // Exactly on the head endpoint, which is the only place `0` and `-1` differ.
  host.insert(PATH, 5, 'ZZ');
  const extended = await waitForSelection(
    host,
    'Bob',
    PATH,
    (selection) => selection.head === 7,
  );
  assert.equal(host.text(PATH), 'abcdeZZf');
  assert.deepEqual(extended.selection, { anchor: 2, head: 7 }, 'the selection extends');
  assert.deepEqual(
    extended.presence.state?.selection,
    before.presence.state?.selection,
    'nothing was republished: the same endpoint resolved further along',
  );
});

test('a yjs-native anchor, scope and element together, resolves as published', async (t) => {
  const session = await fakeSession();
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  const { host, guest } = session;
  await host.open(PATH);
  await guest.open(PATH);
  host.insert(PATH, 0, 'fn main() {}\n');
  await converge(host, guest, PATH);

  // Exactly what the library emits, shipped unedited: `tname` is the scope and `item` the
  // element inside it. Built through yjs so this keeps tracking the library's own shape.
  const native = Y.relativePositionToJSON(
    Y.createRelativePositionFromTypeIndex(guest.getText(PATH), 4),
  ) as Record<string, unknown>;
  assert.equal(native.tname, PATH, 'the scope is the document path');
  assert.equal(typeof native.item, 'object', 'and the element travels with it');

  const shipped = JSON.parse(JSON.stringify(native)) as Anchor;
  guest.setAwareness({ path: PATH, selection: { anchor: shipped, head: shipped } });
  const seen = await waitForSelection(
    host,
    'Bob',
    PATH,
    (selection) => selection.anchor === 4,
  );
  assert.deepEqual(seen.selection, { anchor: 4, head: 4 });
  assert.equal(seen.presence.state?.selection?.anchor.tname, PATH);

  // The scope is a check on the element: a tname naming another document fails even
  // though the item it carries is perfectly sound.
  const wrongScope: Anchor = { ...shipped, tname: 'docs/notes.md' };
  assert.equal(
    host.resolveSelection(PATH, { anchor: wrongScope, head: wrongScope }),
    undefined,
    'tname must equal the path the selection is resolved against',
  );
});
