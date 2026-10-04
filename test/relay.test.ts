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

import { encodeKey, frameKey, mintSessionKey, seal } from '../src/engine/sealed.ts';
import type { SessionKeypair } from '../src/engine/sealed.ts';
import { MESSAGE_AWARENESS } from '../src/engine/sync.ts';
import { MAX_INBOX_FRAMES, RelaySession, wireInvite } from '../src/engine/relay.ts';
import type { RelayEvent } from '../src/engine/relay.ts';
import { isProtocolError } from '../src/engine/errors.ts';
import { isTerminalCode } from '../src/engine/envelope.ts';
import { PeerEngine } from '../src/bridge/peer-engine.ts';
import { nodeCrypto } from '../src/node/crypto.ts';
import { ControlledSocket } from './helpers/controlled-socket.ts';
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

/** A relay whose socket the test drives, opened and handed a host's reading of `session.hello`. */
async function handDriven(t: TestContext): Promise<{
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
        keepalive: KEEPALIVE,
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
    crypto: nodeCrypto,
    webSocketFactory: () => socket,
    keepalive: KEEPALIVE,
    handshakeTimeoutMs: 5_000,
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
  const state = { issued: 1, listing: ['README.md'], peers: entries };
  socket.deliverBinary(await sealed(host, 1, new TextEncoder().encode(JSON.stringify(state))));
  await waitFor("the host's state to be applied", () => relay.listing().length > 0);

  return {
    socket,
    relay,
    ownAwareness,
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
