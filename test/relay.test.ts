/**
 * The `selvage/2` relay's local half: the invite is read before a socket is built, the page form
 * resolves to the wire form with its fragment carried across, a fragment-less link is refused
 * where `PROTOCOL.md` §5.1 says the refusal happens, and the fault the server reports is read
 * from the field the server writes it in. The first cases open no connection — the corpus and the
 * engine's own tests already pin the frame bytes, and what is added there is the one reading
 * `PeerSession` was never handed — and the rest drive a socket by hand: a refusal is a frame and
 * nothing else in the suite delivers one, and §8.4's `peer.left` turns on the awareness ids the
 * roster claims, which a test names here rather than taking the ones a real client mints.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import { MISSING_FRAGMENT, parseInvite } from '../src/engine/peer.ts';
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';

import { encodeKey, frameKey, mintSessionKey, seal } from '../src/engine/sealed.ts';
import type { SessionKeypair } from '../src/engine/sealed.ts';
import { MESSAGE_AWARENESS, encodeSyncStep1, encodeUpdate } from '../src/engine/sync.ts';
import { MAX_INBOX_FRAMES, RelaySession, wireInvite } from '../src/engine/relay.ts';
import type { RelayEvent } from '../src/engine/relay.ts';
import { isProtocolError } from '../src/engine/errors.ts';
import { isTerminalCode } from '../src/engine/envelope.ts';
import { PeerEngine } from '../src/bridge/peer-engine.ts';
import { nodeCrypto } from '../src/node/crypto.ts';
import type { FrameCrypto } from '../src/engine/crypto.ts';
import { ControlledSocket } from './helpers/controlled-socket.ts';
import { FakeServer } from './helpers/fake-server.ts';
import { FakeTimers } from './helpers/fake-timers.ts';
import { waitFor } from './helpers/wait.ts';
import type { WebSocketFactory } from '../src/engine/transport.ts';

const ROOM_KEY = encodeKey(new Uint8Array(32).fill(7));
const HOST_KEY = encodeKey(new Uint8Array(32).fill(9));
const FRAGMENT = `#k=${ROOM_KEY}&h=${HOST_KEY}`;
const WIRE = `ws://127.0.0.1:9999/session?room=room-1&token=tok-1${FRAGMENT}`;
const PAGE = `http://127.0.0.1:9999/?room=room-1&token=tok-1${FRAGMENT}`;

test('wireInvite leaves the endpoint form alone, fragment and all', () => {
  assert.equal(wireInvite(WIRE), WIRE);
});

test('wireInvite resolves a page link to the connection URL, keeping its fragment', () => {
  const read = parseInvite(wireInvite(PAGE));
  assert.equal(read.ok, true);
  if (!read.ok) {
    return;
  }
  assert.equal(read.invite.socketUrl, 'ws://127.0.0.1:9999/session?room=room-1&token=tok-1');
  assert.equal(read.invite.room, 'room-1');
  assert.equal(read.invite.token, 'tok-1');
  assert.deepEqual([...read.invite.roomKey], [...new Uint8Array(32).fill(7)]);
  assert.deepEqual([...read.invite.hostKey], [...new Uint8Array(32).fill(9)]);
});

test('wireInvite turns a page link from https to wss', () => {
  const read = parseInvite(wireInvite(`https://example.test/?room=r&token=t${FRAGMENT}`));
  assert.equal(read.ok, true);
  if (read.ok) {
    assert.equal(read.invite.socketUrl, 'wss://example.test/session?room=r&token=t');
  }
});

test('a page link that repeats the room is refused through the rewrite, not collapsed', () => {
  const read = parseInvite(wireInvite(`https://example.org/?room=r-1&room=r-2&token=t${FRAGMENT}`));
  assert.ok(!read.ok);
  assert.equal(read.reason, 'the invite names `room` twice');
});

test('a page link that repeats the token is refused through the rewrite, not collapsed', () => {
  const read = parseInvite(wireInvite(`https://example.org/?room=r-1&token=t-1&token=t-2${FRAGMENT}`));
  assert.ok(!read.ok);
  assert.equal(read.reason, 'the invite names `token` twice');
});

test('a page link that repeats a fragment key is refused through the rewrite', () => {
  const read = parseInvite(
    wireInvite(`https://example.org/?room=r-1&token=t#k=${ROOM_KEY}&k=${ROOM_KEY}&h=${HOST_KEY}`),
  );
  assert.ok(!read.ok);
  assert.equal(read.reason, 'the invite names `k` twice');
});

test('a page link with one room and token still rewrites and joins, an unknown parameter ignored', () => {
  const read = parseInvite(wireInvite(`https://example.org/?room=r-1&token=t&who=you${FRAGMENT}`));
  assert.equal(read.ok, true);
  if (read.ok) {
    // §5.1: a receiver ignores a query parameter it does not know, so the rewrite carries the
    // query rather than read the two names it knows out of it.
    assert.equal(read.invite.socketUrl, 'wss://example.org/session?room=r-1&token=t&who=you');
    assert.equal(read.invite.room, 'r-1');
    assert.equal(read.invite.token, 't');
  }
});

test('joining a page link that repeats the room is refused by name, before any socket', async () => {
  const dialled: string[] = [];
  const factory: WebSocketFactory = (url: string) => {
    dialled.push(url);
    throw new Error('a socket this case did not expect');
  };
  await assert.rejects(
    RelaySession.join({
      invite: `https://example.org/?room=r-1&room=r-2&token=t${FRAGMENT}`,
      displayName: 'Bo',
      webSocketFactory: factory,
    }),
    (error: unknown) =>
      error instanceof Error && error.message === 'the invite names `room` twice',
  );
  assert.deepEqual(dialled, [], 'the refusal dialled a server anyway');
});

test('wireInvite leaves a link it cannot read as it stands', () => {
  assert.equal(wireInvite('not a url'), 'not a url');
  // A page link with no room or token names nothing to join; the refusal is parseInvite's.
  const nameless = `http://127.0.0.1:9999/${FRAGMENT}`;
  assert.equal(wireInvite(nameless), nameless);
});

test('a page link joins the same room a wire link does', () => {
  const fromPage = parseInvite(wireInvite(PAGE));
  const fromWire = parseInvite(WIRE);
  assert.equal(fromPage.ok, true);
  assert.equal(fromWire.ok, true);
  if (fromPage.ok && fromWire.ok) {
    assert.deepEqual(fromPage.invite, fromWire.invite);
  }
});

test('joining without a fragment is refused locally, before any socket', async () => {
  await assert.rejects(
    RelaySession.join({ invite: 'ws://127.0.0.1:9999/session?room=r&token=t', displayName: 'Bo' }),
    (error: unknown) =>
      error instanceof Error && error.message === MISSING_FRAGMENT,
  );
});

test('joining without a room key is refused locally', async () => {
  await assert.rejects(
    RelaySession.join({
      invite: `ws://127.0.0.1:9999/session?room=r&token=t#h=${HOST_KEY}`,
      displayName: 'Bo',
    }),
    /no room key/,
  );
});

test('a handover with the wrong key lengths is refused before any socket', async () => {
  await assert.rejects(
    RelaySession.join({
      invite: '',
      displayName: 'Bo',
      handover: {
        socketUrl: 'ws://127.0.0.1:9999/session',
        room: 'r',
        token: 't',
        roomKey: new Uint8Array(4),
        hostKey: new Uint8Array(32),
      },
    }),
    /handover carries no 32-byte/,
  );
});

// --- what a `session.error` event is read as -----------------------------------------

const KEEPALIVE = {
  ping_interval_ms: 30_000,
  awareness_renew_ms: 300,
  awareness_expire_ms: 900,
};

/** The server's own frame for a fault, as `selvaged` writes one: code and words in `params`. */
function fault(code: string, message: string): string {
  return JSON.stringify({ v: 'selvage/2', event: 'session.error', params: { code, message } });
}

/**
 * A relay whose socket the test drives, opened and handed a host's reading of `session.hello`.
 * `keepalive` is the session's own renewal window, which a case that reads the timers armed
 * beside a request sets long so the two cannot be confused.
 */
async function handDriven(
  t: TestContext,
  keepalive: typeof KEEPALIVE = KEEPALIVE,
): Promise<{
  socket: ControlledSocket;
  join(): Promise<RelaySession>;
}> {
  const socket = new ControlledSocket();
  t.after(() => {
    socket.close();
  });
  const factory: WebSocketFactory = () => socket;
  return {
    socket,
    join: () =>
      RelaySession.join({
        invite: WIRE,
        displayName: 'Bo',
        crypto: nodeCrypto,
        webSocketFactory: factory,
        keepalive,
        handshakeTimeoutMs: 5_000,
      }),
  };
}

/** Opens the socket, once the relay is listening, and waits for its `session.hello`. */
async function attach(socket: ControlledSocket): Promise<void> {
  await waitFor('the relay to attach its handlers', () => socket.onmessage !== null);
  socket.open();
  await waitFor('the relay to say session.hello', () => socket.sent.length > 0);
}

/** The server's answer to a `selvage/2` hello that seats the connection. */
function seatReply(): string {
  return JSON.stringify({
    v: 'selvage/2',
    id: 1,
    event: 'room.joined',
    params: {
      room_id: 'r-fault',
      self: { peer_id: 'p-guest', display_name: 'Bo' },
      peers: [],
      capabilities: [],
      keepalive: KEEPALIVE,
    },
  });
}

// --- a request promise: the reply's `id`, not the send --------------------------------------

/**
 * The keepalive a rename round trip is read under: long, so the relay's ordinary grid puts no
 * timer inside the one the request itself is bound by.
 */
const STILL_KEEPALIVE = {
  ping_interval_ms: 30_000,
  awareness_renew_ms: 30_000,
  awareness_expire_ms: 90_000,
};

/** The relay's own bound on a request with no reply, which its timeout message names. */
const REQUEST_BOUND_MS = 10_000;

/** The seat, with {@link STILL_KEEPALIVE} in force. */
function stillReply(keepalive: typeof KEEPALIVE = STILL_KEEPALIVE): string {
  return JSON.stringify({
    v: 'selvage/2',
    id: 1,
    event: 'room.joined',
    params: {
      room_id: 'r-corr',
      self: { peer_id: 'p-guest', display_name: 'Bo' },
      peers: [],
      capabilities: [],
      keepalive,
    },
  });
}

test('a rename resolves on the reply its id names, a refusal by its code', async (t) => {
  const { socket, join } = await handDriven(t);
  const seated = join();
  await attach(socket);
  socket.deliver(stillReply());
  const relay = await seated;
  t.after(() => {
    relay.disconnect();
  });

  const answered = relay.rename('Robert');
  const frame = JSON.parse(socket.sent[socket.sent.length - 1]) as {
    id: number;
    method: string;
  };
  assert.equal(frame.method, 'session.rename', 'the rename was not sent as its method');
  assert.equal(frame.id, 2, 'the rename did not send under the request id after the hello');
  socket.deliver(JSON.stringify({ v: 'selvage/2', id: 2, result: {} }));
  await answered;

  const refused = relay.rename('Robert').then(
    () => 'resolved' as const,
    (error: unknown) => error,
  );
  socket.deliver(
    JSON.stringify({
      v: 'selvage/2',
      id: 3,
      error: { code: 'bad_params', message: 'the display_name is blank or over the bound' },
    }),
  );
  const error = await refused;
  assert.ok(isProtocolError(error, 'bad_params'), `the refusal was not the server's code: ${String(error)}`);
  assert.equal(
    error instanceof Error && error.message,
    'the display_name is blank or over the bound',
    'the refusal lost the sentence the server sent',
  );
});

test('an unanswered rename gives up on its own bound and frees the request', async (t) => {
  const timers = new FakeTimers();
  timers.install();
  t.after(() => {
    timers.restore();
  });
  const { socket, join } = await handDriven(t);
  const seated = join();
  await attach(socket);
  socket.deliver(stillReply());
  const relay = await seated;
  t.after(() => {
    relay.disconnect();
  });

  let settled: string | false = false;
  const renamed = relay.rename('Robert').then(
    () => {
      settled = 'resolved';
    },
    (error: unknown) => {
      settled = `rejected: ${error instanceof Error ? error.message : String(error)}`;
    },
  );
  await timers.advance(9_999);
  assert.equal(settled, false, 'the rename promised something before its bound was out');
  await timers.advance(1, {
    settled: () => settled !== false,
    label: 'the rename to give up on its bound',
  });
  assert.equal(
    settled,
    'rejected: the server did not answer the rename within 10000 ms',
    'the rename gave up with no word of why',
  );
  void renamed;

  // The freed request is gone: a reply that arrives for its id settles nothing, and the next
  // rename sends under the next id and answers on its own.
  socket.deliver(JSON.stringify({ v: 'selvage/2', id: 2, result: {} }));
  await new Promise<void>((fluent) => setImmediate(fluent));
  assert.equal(settled, 'rejected: the server did not answer the rename within 10000 ms');
  const again = relay.rename('Roberta').then(
    () => 'resolved' as const,
    (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
  );
  const frame = JSON.parse(socket.sent[socket.sent.length - 1]) as { id: number };
  assert.equal(frame.id, 3, 'the next rename did not take the next request id');
  socket.deliver(JSON.stringify({ v: 'selvage/2', id: 3, result: {} }));
  assert.equal(await again, 'resolved', 'the rename after the timeout did not answer on its own id');
});

test('a rename still out when the socket drops fails on the drop', async (t) => {
  const { socket, join } = await handDriven(t);
  const seated = join();
  await attach(socket);
  socket.deliver(stillReply());
  const relay = await seated;
  t.after(() => {
    relay.disconnect();
  });

  let settled: string | false = false;
  void relay.rename('Robert').then(
    () => {
      settled = 'resolved';
    },
    (error: unknown) => {
      settled = `rejected: ${error instanceof Error ? error.message : String(error)}`;
    },
  );
  socket.fromPeer(1006, 'the server went away');
  await waitFor('the drop to tell the rename', () => settled !== false, {
    describe: () => settled,
  });
  assert.equal(settled, 'rejected: the connection ended (1006 the server went away)');
});

test("a rename still out when the session's own end is observed fails on it", async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  // The reply is withheld this time: the request sits until the session ends it, which is the
  // path where the ending arrives with the room's own word (`§13.10`) rather than a socket's.
  server.holdRenames = true;
  const host = await RelaySession.host({
    baseUrl: server.wsBase,
    displayName: 'Ada',
    listing: () => [],
  });
  t.after(() => {
    host.disconnect();
  });

  let settled: string | false = false;
  void host.rename('Robert').then(
    () => {
      settled = 'resolved';
    },
    (error: unknown) => {
      settled = `rejected: ${error instanceof Error ? error.message : String(error)}`;
    },
  );
  assert.equal(settled, false, 'the rename settled with no end and no reply in sight');

  // §7.1's closing: the host publishes it, the session stamps its own end, and the report that
  // reads that state fails the request still out instead of leaving it to its bound.
  assert.ok(await host.closeRoom(), 'the host could not publish its closing');
  await host.tick();
  assert.equal(settled !== false, true, 'the rename was not told');
  assert.equal(settled, 'rejected: the session ended (closing)');
});

test('a rename whose send throws is refused with that error and frees its request', async (t) => {
  const timers = new FakeTimers();
  timers.install();
  t.after(() => {
    timers.restore();
  });
  const { socket, join } = await handDriven(t, STILL_KEEPALIVE);
  const seated = join();
  await attach(socket);
  socket.deliver(stillReply(STILL_KEEPALIVE));
  const relay = await seated;
  t.after(() => {
    relay.disconnect();
  });
  // Read before the send, so what is armed after it is the send's own doing. The earliest delay
  // cannot answer this: the session's own renewal is sooner than a request's bound, so a request
  // left armed hides behind it.
  const scheduledBefore = timers.scheduled;

  // The socket this relay writes through is open, so the connected check passes, and the write
  // itself is what fails — the one path where the request is registered and then has no frame
  // out, which no reply and no close would ever settle.
  const failure = new Error('the socket is not open');
  socket.throwOnSend = failure;
  let settled: string | false = false;
  await relay.rename('Robert').then(
    () => {
      settled = 'resolved';
    },
    (error: unknown) => {
      settled = `rejected: ${error instanceof Error ? error.message : String(error)}`;
    },
  );
  assert.equal(settled, 'rejected: the socket is not open', 'the caller did not see the send fail');
  assert.equal(
    socket.sent.filter((frame) => frame.includes('session.rename')).length,
    0,
    'the refused write was recorded as a frame that went out',
  );
  // The request's clock went with the request. A timer still armed for it would be due at its
  // bound, ahead of the session's own renewal, which is the leak the settle has to close.
  assert.equal(
    timers.scheduled,
    scheduledBefore,
    'the failed send left its request clock armed, so the request was not freed',
  );

  // The request is gone rather than merely rejected: its clock was cleared, so the bound it would
  // have given up on never fires a second settle, and the next rename sends under the next id and
  // answers on its own.
  socket.throwOnSend = undefined;
  await timers.advance(REQUEST_BOUND_MS + 1);
  assert.equal(settled, 'rejected: the socket is not open');
  const again = relay.rename('Roberta').then(
    () => 'resolved' as const,
    (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
  );
  const frame = JSON.parse(socket.sent[socket.sent.length - 1] as string) as { id: number };
  assert.equal(frame.id, 3, 'the next rename did not take the next request id');
  socket.deliver(JSON.stringify({ v: 'selvage/2', id: 3, result: {} }));
  assert.equal(await again, 'resolved', 'the rename after the failed send did not answer on its own id');
});

test('a rename asked for during a reconnect handshake is refused, not sent', async (t) => {
  // A factory the test owns, one socket per dial: the first seats the guest, and the retry's is
  // the one the handshake is held open on. No `/meta` is reachable from this address, which the
  // relay treats as no word about the room's grace and nothing more.
  const sockets: ControlledSocket[] = [];
  const factory: WebSocketFactory = () => {
    const socket = new ControlledSocket();
    sockets.push(socket);
    return socket;
  };
  const joining = RelaySession.join({
    invite: WIRE,
    displayName: 'Bo',
    crypto: nodeCrypto,
    webSocketFactory: factory,
    keepalive: STILL_KEEPALIVE,
    handshakeTimeoutMs: 5_000,
    reconnect: { initialDelayMs: 10, maxDelayMs: 20 },
  });
  await waitFor('the relay to attach its handlers', () => sockets[0]?.onmessage != null);
  const first = sockets[0];
  assert.ok(first !== undefined);
  t.after(() => {
    first.close();
  });
  await attach(first);
  first.deliver(stillReply());
  const relay = await joining;
  t.after(() => {
    relay.disconnect();
  });
  const seatedAgain = new Promise<void>((resolve) => {
    relay.on((event) => {
      if (event.type === 'seated') {
        resolve();
      }
    });
  });

  // The drop starts the retry, which dials a second socket. Until the room answers the
  // `session.hello` that socket carries, this relay is handshaking: the socket is open, and the
  // session being renamed is the one the handshake has yet to re-seat.
  first.fromPeer(1006, 'the server went away');
  await waitFor('the retry to dial', () => sockets[1] ?? false);
  const second = sockets[1];
  assert.ok(second !== undefined);
  t.after(() => {
    second.close();
  });
  await attach(second);

  const refused = relay.rename('Bobby').then(
    () => 'resolved' as const,
    (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
  );
  assert.equal(
    await refused,
    'rejected: the session is not connected',
    'a rename in the reconnect handshake was accepted by a socket that cannot answer it',
  );
  assert.equal(
    second.sent.filter((frame) => frame.includes('session.rename')).length,
    0,
    'a rename went out on a socket the handshake had not yet been seated on',
  );

  // The refusal is the handshake's, not the session's: once the re-seat lands a rename goes out
  // and answers as it always did.
  second.deliver(stillReply());
  await seatedAgain;
  const renamed = relay.rename('Bobby');
  const frame = JSON.parse(second.sent[second.sent.length - 1] as string) as { id: number };
  second.deliver(JSON.stringify({ v: 'selvage/2', id: frame.id, result: {} }));
  assert.equal(await renamed, undefined, 'the rename after the re-seat did not answer');
});

test('a refused handshake keeps the server’s code, terminal or not', async (t) => {
  for (const [code, terminal] of [
    // A refusal in the reserved namespace is terminal whatever it names: that is the whole of
    // what the namespace is for (§10.1, §9.1).
    ['x.room_full', true],
    ['bad_params', false],
  ] as const) {
    const { socket, join } = await handDriven(t);
    const attempt = join();
    await attach(socket);
    socket.deliver(fault(code, `refused with ${code}`));
    const error: unknown = await attempt.then(
      () => undefined,
      (failure: unknown) => failure,
    );
    if (!isProtocolError(error)) {
      assert.fail(`the refusal was not a protocol refusal: ${String(error)}`);
    }
    assert.equal(error.code, code, 'the refusal lost the code the server sent');
    assert.equal(error.message, `refused with ${code}`, 'the refusal lost the sentence');
    assert.equal(isTerminalCode(error.code), terminal, `${code} read as the wrong kind of refusal`);
  }
});

test('a fault on a seated session reaches a listener with its code', async (t) => {
  const { socket, join } = await handDriven(t);
  const seated = join();
  await attach(socket);
  socket.deliver(seatReply());
  const relay = await seated;
  t.after(() => {
    relay.disconnect();
  });
  const events: RelayEvent[] = [];
  relay.on((event) => {
    events.push(event);
  });

  socket.deliver(fault('x.room_full', 'the room is full'));
  const failed = await waitFor(
    'the relay to report the fault',
    () => events.find((event) => event.type === 'failed') ?? false,
    { describe: () => events },
  );
  assert.equal(failed.code, 'x.room_full', 'the fault lost the code the server sent');
  assert.equal(failed.reason, 'the room is full');
  assert.equal(relay.failure, 'the room is full');
  assert.equal(isTerminalCode(failed.code), true, "a code in §11's reserved namespace is terminal");
});

/**
 * The inbox is this client's own memory (§2.1): a server that delivers faster than the session
 * verifies fills it, and past `MAX_INBOX_FRAMES` the connection is dropped as a transport bound
 * drops it — the queue goes, and a guest reports the drop and re-seats (§9.1).
 */
test('a flood past the inbox bound drops the connection rather than queueing it', async (t) => {
  const { socket, join } = await handDriven(t);
  const seated = join();
  await attach(socket);
  socket.deliver(seatReply());
  const relay = await seated;
  t.after(() => {
    relay.disconnect();
  });
  const events: RelayEvent[] = [];
  relay.on((event) => {
    events.push(event);
  });

  const closesBefore = socket.closes;
  // Delivered in one synchronous burst, so the session verifies none of them in between. The
  // first is taken off the queue at once to be verified, so the bound is crossed one later.
  for (let index = 0; index <= MAX_INBOX_FRAMES + 1; index += 1) {
    socket.deliverBinary(Uint8Array.from([1, 2, 3]));
  }
  assert.equal(socket.closes, closesBefore + 1, 'the flood did not drop the connection');
  await waitFor('the relay to report the drop', () =>
    events.some((event) => event.type === 'reconnecting'),
    { describe: () => events },
  );
});

test('the fault’s code arrives in the bridge’s own event', async (t) => {
  const socket = new ControlledSocket();
  t.after(() => {
    socket.close();
  });
  const attempt = PeerEngine.join({
    invite: WIRE,
    displayName: 'Bo',
    crypto: nodeCrypto,
    webSocketFactory: () => socket,
    keepalive: KEEPALIVE,
    handshakeTimeoutMs: 5_000,
  });
  await attach(socket);
  socket.deliver(seatReply());
  const engine = await attempt;
  t.after(() => {
    void engine.disconnect();
  });
  const reported: Array<{ code: string; message: string }> = [];
  engine.on((event) => {
    if (event.type === 'sessionError') {
      reported.push({ code: event.code, message: event.message });
    }
  });

  socket.deliver(fault('x.room_full', 'the room is full'));
  await waitFor('the engine to report the fault', () => reported[0] ?? false, {
    describe: () => reported,
  });
  assert.deepEqual(reported, [{ code: 'x.room_full', message: 'the room is full' }]);
});

// --- §8.4: a departed peer's awareness state --------------------------------------------

/** A room whose host and peers are real keys, so the frames a test delivers verify. */
interface SealedRoom {
  socket: ControlledSocket;
  relay: RelaySession;
  /** The awareness client id this connection announced in its `session.hello`. */
  ownAwareness: number;
  /** The host keypair the room's states are signed with. */
  host: SessionKeypair;
  /** Seals one frame under the room's frame key, as a server would relay it. */
  seal(signer: SessionKeypair, kind: number, plaintext: Uint8Array): Promise<Uint8Array>;
  /** Delivers a `kind = 0` frame from `signer` carrying one awareness message. */
  awareness(signer: SessionKeypair, entries: Array<[number, number, unknown]>): Promise<void>;
}

const SEALED_ROOM = 'room-1';

/**
 * Joins a room by hand: the handshake seats this connection among `peers`, whose awareness ids are
 * the ones a test names, and the host's state commits `committed` so their frames are applied.
 * `peers` may name this connection's own awareness id, read from the hello it sent.
 */
async function sealedRoom(
  t: TestContext,
  committed: Array<[SessionKeypair, string]>,
  peers: (ownAwareness: number) => Array<{ peer_id: string; awareness_client_id: number }>,
  options: { crypto?: FrameCrypto; ownRole?: string } = {},
): Promise<SealedRoom> {
  const roomKey = new Uint8Array(32).fill(7);
  const host = (await mintSessionKey(nodeCrypto, new Uint8Array(32).fill(3))) as SessionKeypair;
  const key = await frameKey(nodeCrypto, SEALED_ROOM, roomKey);
  assert.ok(key !== undefined);
  const counters = new Map<SessionKeypair, number>();
  const sealed = async (signer: SessionKeypair, kind: number, plaintext: Uint8Array) => {
    const counter = (counters.get(signer) ?? 0) + 1;
    counters.set(signer, counter);
    const bytes = await seal(
      nodeCrypto,
      { roomId: SEALED_ROOM, frameKey: key, kind, epoch: 0, counter, nonce: new Uint8Array(12).fill(4), signer },
      plaintext,
    );
    assert.ok(bytes !== undefined);
    return bytes;
  };

  const socket = new ControlledSocket();
  t.after(() => {
    socket.close();
  });
  const invite =
    `ws://127.0.0.1:9999/session?room=${SEALED_ROOM}&token=tok-1` +
    `#k=${encodeKey(roomKey)}&h=${encodeKey(host.public)}`;
  const seated = RelaySession.join({
    invite,
    displayName: 'Bo',
    crypto: options.crypto ?? nodeCrypto,
    webSocketFactory: () => socket,
    keepalive: KEEPALIVE,
    handshakeTimeoutMs: 5_000,
    // No `/meta` fetch: the socket is the test's own, and a real fetch leaves undici's own
    // timers behind, which a test driving the relay's timers cannot tell from the relay's.
    reconnect: false,
  });
  await attach(socket);
  const hello = JSON.parse(socket.sent[0] as string) as { params: { awareness_client_id: number } };
  const ownAwareness = hello.params.awareness_client_id;
  socket.deliver(
    JSON.stringify({
      v: 'selvage/2',
      id: 1,
      event: 'room.joined',
      params: {
        room_id: SEALED_ROOM,
        self: { peer_id: 'p-self', display_name: 'Bo', awareness_client_id: ownAwareness },
        peers: peers(ownAwareness).map((peer) => ({ ...peer, display_name: peer.peer_id })),
        capabilities: [],
        keepalive: KEEPALIVE,
      },
    }),
  );
  const relay = await seated;
  t.after(() => {
    relay.disconnect();
  });

  const entries: Record<string, unknown> = {};
  for (const [peer, seat] of committed) {
    entries[encodeKey(peer.public)] = { peer_id: seat, role: 'guest' };
  }
  // The relay mints its own session key, so a state that commits it can only be built after the
  // seat. A committed writer is what §13.1's step 6 handshake and §13.6's repair request need.
  if (options.ownRole !== undefined) {
    entries[encodeKey(relay.sessionKey())] = { peer_id: 'p-self', role: options.ownRole };
  }
  const state = { issued: 1, listing: ['README.md'], peers: entries };
  socket.deliverBinary(await sealed(host, 1, new TextEncoder().encode(JSON.stringify(state))));
  await waitFor("the host's state to be applied", () => relay.listing().length > 0);

  return {
    socket,
    relay,
    ownAwareness,
    host,
    seal: (signer, kind, plaintext) => sealed(signer, kind, plaintext),
    async awareness(signer, states) {
      const update = encoding.createEncoder();
      encoding.writeVarUint(update, states.length);
      for (const [client, clock, value] of states) {
        encoding.writeVarUint(update, client);
        encoding.writeVarUint(update, clock);
        encoding.writeVarString(update, JSON.stringify(value));
      }
      const message = encoding.createEncoder();
      encoding.writeVarUint(message, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(message, encoding.toUint8Array(update));
      socket.deliverBinary(await sealed(signer, 0, encoding.toUint8Array(message)));
    },
  };
}

/** Delivers `peer.left` for `seat` and waits until the relay's roster no longer names it. */
async function leave(room: SealedRoom, seat: string): Promise<void> {
  room.socket.deliver(JSON.stringify({ v: 'selvage/2', event: 'peer.left', params: { peer_id: seat } }));
  await waitFor(`the relay to drop ${seat} from its roster`, () =>
    room.relay.peerInfos().every((peer) => peer.peer_id !== seat),
  );
}

function clientsIn(relay: RelaySession): number[] {
  return relay.presence().map((entry) => entry.clientId);
}

test("peer.left drops the state under the id the departed peer claimed, and no other", async (t) => {
  const ann = (await mintSessionKey(nodeCrypto, new Uint8Array(32).fill(21))) as SessionKeypair;
  const room = await sealedRoom(t, [[ann, 'p-ann']], () => [{ peer_id: 'p-ann', awareness_client_id: 200 }]);
  // 150 is a state the same key published under an id nobody claims, which §8.4 does not drop.
  await room.awareness(ann, [
    [200, 1, { path: 'README.md' }],
    [150, 1, { path: 'README.md' }],
  ]);
  await waitFor('both states to be held', () => {
    const clients = clientsIn(room.relay);
    return clients.includes(200) && clients.includes(150);
  });

  await leave(room, 'p-ann');
  const clients = clientsIn(room.relay);
  assert.equal(clients.includes(200), false, `the departed peer's state is still reported: ${clients}`);
  assert.equal(clients.includes(150), true, 'a state under an id the peer did not claim was dropped');

  // The id's clock is kept, so the same state arriving late is not applied again. 151 rides in
  // the same frame, so its arrival is the frame having been read.
  await room.awareness(ann, [
    [200, 1, { path: 'README.md' }],
    [151, 1, { path: 'README.md' }],
  ]);
  await waitFor('the late frame to be read', () => clientsIn(room.relay).includes(151));
  assert.equal(clientsIn(room.relay).includes(200), false, 'a stale state brought the departed peer back');
});

test('peer.left keeps a state while a seated peer still claims its id, this connection included', async (t) => {
  const ann = (await mintSessionKey(nodeCrypto, new Uint8Array(32).fill(21))) as SessionKeypair;
  const bea = (await mintSessionKey(nodeCrypto, new Uint8Array(32).fill(22))) as SessionKeypair;
  const room = await sealedRoom(t, [[ann, 'p-ann'], [bea, 'p-bea']], (own) => [
    { peer_id: 'p-ann', awareness_client_id: 200 },
    { peer_id: 'p-bea', awareness_client_id: 200 },
    { peer_id: 'p-cid', awareness_client_id: own },
  ]);
  await room.awareness(ann, [[200, 1, { path: 'README.md' }]]);
  room.relay.setAwareness({ path: 'README.md' });
  await waitFor('both states to be held', () => {
    const clients = clientsIn(room.relay);
    return clients.includes(200) && clients.includes(room.ownAwareness);
  });

  await leave(room, 'p-ann');
  const kept = room.relay.presence().find((entry) => entry.clientId === 200);
  assert.ok(kept !== undefined, 'a state another seated peer claims was dropped');
  assert.equal(kept.peer?.peer_id, 'p-bea', 'and it is attributed to the peer that still claims it');

  await leave(room, 'p-cid');
  assert.equal(
    clientsIn(room.relay).includes(room.ownAwareness),
    true,
    "this connection's own state was dropped for a peer that claimed its id",
  );

  await leave(room, 'p-bea');
  assert.equal(clientsIn(room.relay).includes(200), false, 'the last claimant left and the state stayed');
});

// --- the automatic repair timer, on the test's own clock --------------------------------

/** A frame crypto whose seals fail on demand, counting each attempt at a nonce. */
function failingSeals(): { crypto: FrameCrypto; fail(): void; attempts(): number } {
  let failing = false;
  let attempts = 0;
  const crypto: FrameCrypto = {
    ...nodeCrypto,
    randomBytes(length: number): Uint8Array {
      if (failing && length === 12) {
        attempts += 1;
        throw new Error('the platform CSPRNG is unavailable');
      }
      return nodeCrypto.randomBytes(length);
    },
  };
  return {
    crypto,
    fail: () => {
      failing = true;
    },
    attempts: () => attempts,
  };
}

test('a persistent seal failure draws one automatic request a window, not a millisecond chain', async (t) => {
  const timers = new FakeTimers();
  timers.install();
  t.after(() => {
    timers.restore();
  });
  const seals = failingSeals();
  const other = (await mintSessionKey(nodeCrypto, new Uint8Array(32).fill(31))) as SessionKeypair;
  const room = await sealedRoom(t, [[other, 'p-other']], () => [], {
    crypto: seals.crypto,
    ownRole: 'guest',
  });
  // A committed writer's own request arms §13.1's step 6 reciprocal obligation.
  const empty = new Y.Doc();
  room.socket.deliverBinary(await room.seal(other, 0, encodeSyncStep1(empty)));
  empty.destroy();
  // The frame is delivered asynchronously; its own answer is what shows the cause was recorded.
  const answered = room.socket.sentBinary.length;
  await waitFor('the remote request to be answered', () => room.socket.sentBinary.length > answered, {
    describe: () => room.socket.sentBinary.length,
  });
  assert.equal(timers.nextDelay(), KEEPALIVE.awareness_renew_ms, 'the repair was not armed on the request clock');

  seals.fail();
  await timers.advance(KEEPALIVE.awareness_renew_ms, {
    settled: () => seals.attempts() >= 1 && timers.nextDelay() !== undefined,
    label: 'the first automatic request and the delay it armed',
  });
  assert.equal(seals.attempts(), 1, 'the first automatic request did not run');
  // The attempt completed now, so the next one is a whole window away and not a millisecond.
  assert.ok(
    (timers.nextDelay() ?? 0) >= KEEPALIVE.awareness_renew_ms,
    `the failed attempt left a ${timers.nextDelay()}ms retry, so the timer self-chains`,
  );

  for (let attempt = 2; attempt <= 3; attempt += 1) {
    await timers.advance(KEEPALIVE.awareness_renew_ms, {
      settled: () => seals.attempts() >= attempt && timers.nextDelay() !== undefined,
      label: `the automatic request at attempt ${attempt} and the delay it armed`,
    });
  }
  assert.equal(seals.attempts(), 3, `three windows drew ${seals.attempts()} automatic attempts`);
  assert.equal(room.relay.end, undefined, 'a persistent seal failure ended the session');
  assert.match(room.relay.failure ?? '', /could not be sealed/);
});

test('an ordinary grid deadline does not drive a paced repair early', async (t) => {
  const timers = new FakeTimers();
  timers.install();
  t.after(() => {
    timers.restore();
  });
  const seals = failingSeals();
  const room = await sealedRoom(t, [], () => [], { crypto: seals.crypto });
  // The first state commits no local key, so the handshake waits for the second one.
  await timers.advance(100);
  seals.fail();
  const peers = { [encodeKey(room.relay.sessionKey())]: { peer_id: 'p-self', role: 'guest' } };
  const state = new TextEncoder().encode(JSON.stringify({ issued: 2, listing: ['README.md'], peers }));
  room.socket.deliverBinary(await room.seal(room.host, 1, state));
  await waitFor('the committing state to drive its one failed handshake', () => seals.attempts() === 1, {
    describe: () => seals.attempts(),
  });
  const failedHandshake = seals.attempts();
  assert.equal(failedHandshake, 1, 'the committing state did not drive its one failed handshake');

  // The grid tick is due at 300 and the failure completed at 100, so its window opens at 400.
  await timers.advance(200, {
    settled: () => timers.nextDelay() !== undefined,
    label: 'the ordinary grid tick at 300 to return and re-arm',
  });
  assert.equal(timers.now, 300, 'the grid tick is due at 300');
  assert.equal(seals.attempts(), failedHandshake, 'the ordinary grid deadline drove a paced repair early');
  await timers.advance(100, {
    settled: () => seals.attempts() > failedHandshake,
    label: 'the paced repair at 400',
  });
  assert.equal(seals.attempts(), failedHandshake + 1, 'the paced deadline did not draw its one attempt');
});

test('a repair attempt that completes a window late paces from its completion, not its start', async (t) => {
  const timers = new FakeTimers();
  timers.install();
  t.after(() => {
    timers.restore();
  });
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let slow = false;
  let attempts = 0;
  const crypto: FrameCrypto = {
    ...nodeCrypto,
    async aesGcmSeal(...args): Promise<Uint8Array | undefined> {
      if (slow) {
        attempts += 1;
        await barrier;
        return undefined;
      }
      return nodeCrypto.aesGcmSeal(...args);
    },
  };
  const other = (await mintSessionKey(nodeCrypto, new Uint8Array(32).fill(31))) as SessionKeypair;
  const room = await sealedRoom(t, [[other, 'p-other']], () => [], { crypto, ownRole: 'guest' });
  const empty = new Y.Doc();
  room.socket.deliverBinary(await room.seal(other, 0, encodeSyncStep1(empty)));
  empty.destroy();
  // The frame is delivered asynchronously; its own answer is what shows the cause was recorded.
  const answered = room.socket.sentBinary.length;
  await waitFor('the remote request to be answered', () => room.socket.sentBinary.length > answered, {
    describe: () => room.socket.sentBinary.length,
  });

  slow = true;
  await timers.advance(KEEPALIVE.awareness_renew_ms, {
    settled: () => attempts === 1,
    label: 'the automatic attempt at its deadline to start',
  });
  assert.equal(attempts, 1, 'the automatic attempt did not start at its deadline');
  // The seal outlives the window it started in, so the attempt completes two windows later.
  await timers.advance(KEEPALIVE.awareness_renew_ms * 2);
  release();
  await waitFor(
    'the late completion to pace the next attempt from its completion',
    () => (timers.nextDelay() ?? 0) >= KEEPALIVE.awareness_renew_ms,
    { describe: () => ({ attempts, delay: timers.nextDelay() }) },
  );
  assert.ok(
    (timers.nextDelay() ?? 0) >= KEEPALIVE.awareness_renew_ms,
    `a late completion left a ${timers.nextDelay()}ms retry, so the stale start clock paced it`,
  );
});

test('sessionKey answers a copy of the key the announcement names', async (t) => {
  const room = await sealedRoom(t, [], () => []);
  const announced = Uint8Array.from(room.relay.sessionKey());
  assert.ok(announced.length > 0, 'the relay minted no session key to read');
  const returned = room.relay.sessionKey();
  returned.fill(0);
  assert.deepEqual(
    [...room.relay.sessionKey()],
    [...announced],
    'the diagnostic answer is the session’s live public key',
  );
});

/**
 * A delivery failure that has completed but that its owning relay has not stamped yet must not be
 * retried by a tick already queued behind it. The relay stamps a delivery failure only after its
 * whole inbox drains, and a binary frame sits behind the queued tick in the session's serial
 * chain — so the tick can reach `resync` with the failure complete and unstamped.
 */
for (const host of ['no host is identified', 'a named host is present'] as const) {
  test(`a queued automatic tick does not retry an unstamped delivery failure (${host})`, async (t) => {
    const timers = new FakeTimers();
    timers.install();
    t.after(() => {
      timers.restore();
    });

    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let hold = false;
    let attempts = 0;
    let completions = 0;
    const isStep1 = (plaintext: Uint8Array): boolean => plaintext[0] === 0 && plaintext[1] === 0;
    const crypto: FrameCrypto = {
      ...nodeCrypto,
      async aesGcmSeal(key, nonce, plaintext, aad): Promise<Uint8Array | undefined> {
        if (!isStep1(plaintext)) {
          return nodeCrypto.aesGcmSeal(key, nonce, plaintext, aad);
        }
        attempts += 1;
        if (hold) {
          hold = false;
          entered();
          await barrier;
          completions += 1;
          return undefined;
        }
        return nodeCrypto.aesGcmSeal(key, nonce, plaintext, aad);
      },
    };

    const other = (await mintSessionKey(nodeCrypto, new Uint8Array(32).fill(31))) as SessionKeypair;
    const namedHost = host === 'a named host is present';
    const room = await sealedRoom(
      t,
      [[other, 'p-other']],
      () => [
        { peer_id: 'p-other', awareness_client_id: 201 },
        ...(namedHost ? [{ peer_id: 'p-host', awareness_client_id: 202 }] : []),
      ],
      { crypto },
    );
    await timers.advance(100);

    // A signed state commits this connection's key: §13.1's immediate step 6 handshake enters a
    // seal that will resolve `undefined`.
    hold = true;
    const peers: Record<string, unknown> = {
      [encodeKey(room.relay.sessionKey())]: { peer_id: 'p-self', role: 'guest' },
      [encodeKey(other.public)]: { peer_id: 'p-other', role: 'guest' },
    };
    if (namedHost) {
      peers[encodeKey(room.host.public)] = { peer_id: 'p-host', role: 'host' };
    }
    const committing = new TextEncoder().encode(JSON.stringify({ issued: 2, listing: ['README.md'], peers }));
    room.socket.deliverBinary(await room.seal(room.host, 1, committing));
    await started;

    // The grid timer is due at 300 and fires while that seal is open: its pump queues the
    // automatic tick behind the committing state's own serial task.
    await timers.advance(200);
    assert.equal(timers.now, 300, 'the grid tick is due at 300');

    // A binary tail behind the state: an authenticated Update from a writer the state commits.
    const remote = new Y.Doc();
    remote.getText('README.md').insert(0, 'tail');
    const update = encodeUpdate(Y.encodeStateAsUpdate(remote));
    remote.destroy();
    room.socket.deliverBinary(await room.seal(other, 0, update));

    // The seal fails at 600, with the automatic tick still ahead of the tail.
    await timers.advance(300);
    assert.equal(timers.now, 600, 'the queued automatic tick runs at 600');
    release();

    // The tail is delivered behind the automatic tick in the session's serial chain, so the state
    // it lands in is proof that the tick has already run.
    await waitFor(
      'the tail frame to be applied after the queued automatic tick',
      () => room.relay.text('README.md') === 'tail',
      { describe: () => ({ attempts, completions, delay: timers.nextDelay() }) },
    );
    assert.equal(completions, 1, 'the committing state’s handshake had not completed');
    assert.equal(attempts, 1, 'the queued automatic tick retried a failure its relay had not stamped');

    // The completion paces the next automatic attempt a window from the completion, not the tick.
    await waitFor(
      'the relay to pace the next attempt from the completion',
      () => (timers.nextDelay() ?? 0) >= KEEPALIVE.awareness_renew_ms,
      { describe: () => ({ attempts, delay: timers.nextDelay() }) },
    );
    await timers.advance(KEEPALIVE.awareness_renew_ms - 1, {
      settled: () => timers.nextDelay() !== undefined,
      label: 'whatever the ordinary grid tick inside the window does',
    });
    assert.equal(attempts, 1, 'an automatic attempt ran inside the completion window');
    await timers.advance(1, {
      settled: () => attempts > 1,
      label: 'the automatic attempt at the paced deadline',
    });
    assert.equal(attempts, 2, 'the paced deadline did not draw its one attempt');
    assert.equal(room.relay.end, undefined, 'a fixture window ended the session');
  });
}
