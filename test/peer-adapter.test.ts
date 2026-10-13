/**
 * The surface a `selvage/2` session has to present to an editor adapter: the local deletion of
 * §13.5, the awareness of §8 as both a publisher and a reader, the role the applied state gives
 * this connection's own key (§13.4), §13.7's holds per path, and §13.8's host-away clock.
 *
 * Two real sessions, wired to each other by hand and driven by a clock the test passes in: this
 * is `crates/client`'s and the clients' adapter seam, and it is about the rules rather than
 * about a socket. The corpus's decision vectors drive the same session through
 * `test/peer-corpus.test.ts`; `test/relay-selvaged.test.ts` is the whole of it over a real
 * `selvaged`.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { nodeCrypto } from '../src/node/crypto.ts';
import { PeerSession } from '../src/engine/peer.ts';
import type { PeerOptions } from '../src/engine/peer.ts';
import { encodeKey, frameKey, mintSessionKey, opens, parseEnvelope, seal } from '../src/engine/sealed.ts';
import type { SessionKeypair } from '../src/engine/sealed.ts';
import type { PeerInfo } from '../src/engine/envelope.ts';

const ROOM = 'Ra1b2c3d4';
const RENEW_MS = 300;
const EXPIRE_MS = 900;
const PATH = 'notes.txt';
const OTHER = 'src/main.rs';

interface Keys {
  roomKey: Uint8Array;
  hostKey: Uint8Array;
  hostSeed: Uint8Array;
}

let cached: Promise<Keys> | undefined;

function keys(): Promise<Keys> {
  cached ??= (async () => {
    const hostSeed = new Uint8Array(32).fill(3);
    const host = (await mintSessionKey(nodeCrypto, hostSeed)) as SessionKeypair;
    return { roomKey: new Uint8Array(32).fill(7), hostSeed, hostKey: host.public };
  })();
  return cached;
}

/** Every session a test opened, released when the file's tests are done. */
const sessions: PeerSession[] = [];

after(() => {
  for (const peer of sessions) {
    peer.destroy();
  }
});

const KEEPALIVE = { ping_interval_ms: 30_000, awareness_renew_ms: RENEW_MS, awareness_expire_ms: EXPIRE_MS };

async function hostOf(listing: string[]): Promise<PeerSession> {
  const now = await keys();
  const host = await PeerSession.create({
    roomId: ROOM,
    roomKey: now.roomKey,
    hostKey: now.hostKey,
    keepalive: KEEPALIVE,
    crypto: nodeCrypto,
    seat: 'p-host',
    awarenessClientId: 1001,
    host: { hostSeed: now.hostSeed, listing: () => listing },
  });
  assert.ok(host !== undefined, 'the host session is opened');
  sessions.push(host);
  return host;
}

async function guestOf(extra: Partial<PeerOptions> = {}): Promise<PeerSession> {
  const now = await keys();
  const guest = await PeerSession.create({
    roomId: ROOM,
    roomKey: now.roomKey,
    hostKey: now.hostKey,
    keepalive: KEEPALIVE,
    crypto: nodeCrypto,
    seat: 'p-guest',
    awarenessClientId: 2002,
    roster: ['p-host', 'p-guest'],
    ...extra,
  });
  assert.ok(guest !== undefined, 'the guest session is opened');
  sessions.push(guest);
  return guest;
}

/** A clock the test moves, so no rule here waits on a machine. */
class Clock {
  private value = 0;

  now(): number {
    return this.value;
  }

  advance(by: number): number {
    this.value += by;
    return this.value;
  }
}

/**
 * What the session published, handed to the other one, until neither has anything left to say.
 *
 * Bounded rather than open: a pair that keeps publishing is a bug, and the count is what says
 * which side would not settle. Each round waits on both sessions' own queues first, because a
 * state handed in is a frame a moment later — the crypto seam is asynchronous — and a drain that
 * does not wait for one reads an empty outbound list while a caret is still being sealed.
 */
async function settle(left: PeerSession, right: PeerSession, clock: Clock): Promise<void> {
  for (let round = 0; round < 40; round += 1) {
    await left.whenIdle();
    await right.whenIdle();
    const leftFrames = left.takeOutbound();
    const rightFrames = right.takeOutbound();
    if (leftFrames.length === 0 && rightFrames.length === 0) {
      return;
    }
    for (const frame of leftFrames) {
      await right.deliver(clock.now(), frame);
    }
    for (const frame of rightFrames) {
      await left.deliver(clock.now(), frame);
    }
    await left.tick(clock.advance(10));
    await right.tick(clock.advance(10));
  }
  assert.fail('the two sessions never settled');
}

/**
 * Moves both sessions across at least a renewal window, delivering every frame.
 *
 * A reciprocal request is coalesced on the request clock and is not due until a window after the
 * last locally generated `SyncStep1`, so a test that only settles until both are quiet would
 * never reach it. This drives the clock past the window and keeps delivering.
 */
async function drive(
  left: PeerSession,
  right: PeerSession,
  clock: Clock,
  rounds = 60,
): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await left.whenIdle();
    await right.whenIdle();
    for (const frame of left.takeOutbound()) {
      await right.deliver(clock.now(), frame);
    }
    for (const frame of right.takeOutbound()) {
      await left.deliver(clock.now(), frame);
    }
    await left.tick(clock.advance(10));
    await right.tick(clock.advance(10));
  }
}

/** A host and a guest that hold one verified state each. */
async function pair(
  listing: string[] = [PATH, OTHER],
  extra: Partial<PeerOptions> = {},
): Promise<{ host: PeerSession; guest: PeerSession; clock: Clock }> {
  const clock = new Clock();
  const host = await hostOf(listing);
  const guest = await guestOf(extra);
  // What the relay does with `peer.joined`: the host's roster is the server's, and §7.1's seat
  // label comes from it — a host that never heard of the guest labels its key with a fallback.
  await host.seatJoined(clock.now(), 'p-guest');
  await settle(host, guest, clock);
  assert.equal(guest.listing.length, listing.length, 'the guest holds the room\'s state');
  return { host, guest, clock };
}

const HOST_AS_A_PEER: PeerInfo = { peer_id: 'p-host', display_name: 'Ada', role: 'host' };

test('a local deletion is published and lands in the other replica', async () => {
  const { host, guest, clock } = await pair();
  host.open(PATH);
  guest.open(PATH);
  assert.equal(await host.insert(PATH, 0, 'hello world'), true);
  await settle(host, guest, clock);
  assert.equal(guest.text(PATH), 'hello world');

  assert.equal(await guest.remove(PATH, 5, 6), true, 'a deletion is published');
  await settle(host, guest, clock);
  assert.equal(host.text(PATH), 'hello');
  assert.equal(guest.text(PATH), 'hello');

  // The whole document, which is what a second replica back from the first agrees on.
  assert.equal(await host.remove(PATH, 0, 5), true);
  await settle(host, guest, clock);
  assert.equal(guest.text(PATH), '');
});

test('a local edit is in the replica before its publication is awaited', async () => {
  const { host } = await pair();
  host.open(PATH);
  const publishing = host.insert(PATH, 0, 'now');
  // The read the bridge does between two keystrokes: an edit that waited for a seal would be
  // diffed twice, and the second diff would publish it again.
  assert.equal(host.text(PATH), 'now');
  assert.equal(await publishing, true);
  const removing = host.remove(PATH, 0, 3);
  assert.equal(host.text(PATH), '');
  assert.equal(await removing, true);
});

test('a selection is published as anchors and reads back as offsets', async () => {
  const { host, guest, clock } = await pair();
  host.open(PATH);
  guest.open(PATH);
  await host.insert(PATH, 0, 'a line of text');
  await settle(host, guest, clock);

  guest.setSelection(PATH, { anchor: 2, head: 9 });
  await settle(host, guest, clock);

  const presence = host.presence([HOST_AS_A_PEER, GUEST_AS_A_PEER], HOST_AS_A_PEER);
  const mine = presence.find((record) => record.clientId === 2002);
  assert.ok(mine !== undefined, 'the guest\'s awareness state is held');
  assert.equal(mine.peer?.peer_id, 'p-guest');
  assert.equal(mine.state?.path, PATH);
  assert.ok(mine.state?.selection !== undefined);

  // §8.1: the wire carries anchors, and a reader resolves them against its own replica.
  const resolved = host.resolveSelection(PATH, mine.state.selection);
  assert.deepEqual(resolved, { anchor: 2, head: 9 });

  // A selection this replica cannot anchor carries the path and no selection.
  guest.setSelection(OTHER, { anchor: 0, head: 4 });
  await settle(host, guest, clock);
  const moved = host
    .presence([HOST_AS_A_PEER, GUEST_AS_A_PEER], HOST_AS_A_PEER)
    .find((record) => record.clientId === 2002);
  assert.equal(moved?.state?.path, OTHER);
  assert.equal(moved?.state?.selection, undefined);

  // And clearing it publishes a removal rather than an empty state.
  guest.setAwareness(null);
  await settle(host, guest, clock);
  const cleared = host.presence([HOST_AS_A_PEER], HOST_AS_A_PEER);
  assert.equal(cleared.find((record) => record.clientId === 2002), undefined);
});

const GUEST_AS_A_PEER: PeerInfo = {
  peer_id: 'p-guest',
  display_name: 'Bob',
  role: 'guest',
  awareness_client_id: 2002,
};

test('the role an applied state gives this connection is what it reads', async () => {
  const { host, guest, clock } = await pair([PATH], { declaredRole: 'viewer' });
  assert.equal(guest.ownRole(), 'viewer', 'the state commits the declared role');
  assert.equal(host.ownRole(), 'host');
  assert.deepEqual(
    [...host.rolesBySeat()].sort(),
    [
      ['p-guest', 'viewer'],
      ['p-host', 'host'],
    ],
  );

  // §13.9: a viewer keeps its edit and sends none of it, and the awareness of the same frame
  // is still its own to publish.
  host.open(PATH);
  guest.open(PATH);
  assert.equal(await host.insert(PATH, 0, 'the room\'s text'), true);
  await settle(host, guest, clock);
  assert.equal(await guest.insert(PATH, 0, 'mine'), false);
  guest.setSelection(PATH, { anchor: 0, head: 0 });
  await settle(host, guest, clock);
  assert.equal(host.text(PATH), 'the room\'s text');

  const listed = await guest.heldPaths();
  assert.deepEqual(listed, [PATH], 'a viewer holds what it opens');  await settle(host, guest, clock);
  const holds = [...host.peerHolds().values()];
  assert.deepEqual(holds, [[PATH]]);
});

test('a hold is released one path at a time and the room hears the whole set', async () => {
  const { host, guest, clock } = await pair();
  host.open(PATH);
  host.open(OTHER);
  await settle(host, guest, clock);
  assert.deepEqual([...host.heldPaths()].sort(), [OTHER, PATH].sort());

  guest.release(PATH);
  assert.deepEqual(guest.heldPaths(), []);
  await settle(host, guest, clock);
  assert.deepEqual(guest.heldPaths(), []);

  // §13.7 asks for the empty set rather than for silence, and the lease alone would keep the
  // host holding the guest to a path the guest has released.
  const remaining = [...host.peerHolds().values()].flat();
  assert.deepEqual(remaining, []);
});

test('the host-away window is readable while it runs, and names the host seat', async () => {
  const { host, guest, clock } = await pair();
  assert.equal(guest.namedHostSeat(), 'p-host');

  // A roster without the host's seat: §13.8's clock arms on the state that names it.
  const orphan = await PeerSession.create({
    roomId: ROOM,
    roomKey: (await keys()).roomKey,
    hostKey: (await keys()).hostKey,
    keepalive: KEEPALIVE,
    crypto: nodeCrypto,
    seat: 'p-lone',
    awarenessClientId: 3003,
    roster: ['p-lone'],
  });
  assert.ok(orphan !== undefined);
  sessions.push(orphan);
  // §7.1: a seat that joins is what obliges the host to publish a state, which is how the
  // orphan learns the room's listing and the seat its roster does not have.
  await host.seatJoined(clock.now(), 'p-lone');
  await settle(host, orphan, clock);
  assert.equal(orphan.stateHeld(), true, 'the joiner holds the state it was published');

  const grace = orphan.hostAwayGraceMs(clock.now());
  assert.ok(grace !== undefined, 'the window is running');
  assert.ok(grace > 0 && grace <= EXPIRE_MS, `what is left of it is inside the window: ${grace}`);
  assert.equal(orphan.end, undefined, 'the window is a report and not yet an ending');
  // The window is a countdown and not a constant: §13.8's clock runs from the state that named
  // a host seat the roster does not have.
  await orphan.tick(clock.advance(100));
  const later = orphan.hostAwayGraceMs(clock.now());
  assert.ok(later !== undefined && later < grace, `${later} is less than ${grace}`);
  assert.equal(guest.hostAwayGraceMs(clock.now()), undefined, 'a roster with the host has none');
});

test('a session that has ended reports its ending and publishes nothing more', async () => {
  const { host, guest, clock } = await pair();
  await settle(host, guest, clock);
  assert.equal(await host.closeRoom(), true);
  await settle(host, guest, clock);
  assert.equal(guest.end, 'closing');
  assert.equal(await guest.insert(PATH, 0, 'after the end'), false);
  assert.equal(guest.text(PATH), 'after the end', 'the viewer keeps what it typed to itself');
});

test('an awareness client id handed in is the one this connection publishes under', async () => {
  const { host, guest, clock } = await pair();
  host.open(PATH);
  guest.open(PATH);
  guest.setAwareness({ path: PATH });
  await settle(host, guest, clock);
  const recorded = host
    .presence([HOST_AS_A_PEER, GUEST_AS_A_PEER], HOST_AS_A_PEER)
    .map((record) => record.clientId);
  assert.deepEqual(recorded, [2002], 'the id the handshake announced, and not a minted one');
  assert.equal(encodeKey(new Uint8Array(32)).length, 43);
});

// --- §13.1's step 6, made reciprocal: a lost outbound update is recovered -------------

/**
 * The subtype of a published `kind = 0` frame's first sync message: 0 is a `SyncStep1`, 1 a
 * `SyncStep2`, 2 an `Update`. `undefined` for any other kind.
 */
async function syncSubtype(bytes: Uint8Array): Promise<number | undefined> {
  const now = await keys();
  const derived = await frameKey(nodeCrypto, ROOM, now.roomKey);
  assert.ok(derived !== undefined);
  const envelope = parseEnvelope(bytes);
  assert.ok(envelope !== undefined, 'a published frame is an envelope');
  const plaintext = await opens(nodeCrypto, derived, ROOM, envelope);
  assert.ok(plaintext !== undefined);
  return envelope.kind === 0 ? plaintext[1] : undefined;
}

/** Whether two replicas hold the same history and not merely the same text. */
function converged(left: PeerSession, right: PeerSession): boolean {
  return (
    left.text(PATH) === right.text(PATH) &&
    Buffer.from(left.stateVector()).equals(Buffer.from(right.stateVector()))
  );
}

test('a lost outbound update is recovered by the reciprocal request after a re-seat', async () => {
  const { host, guest, clock } = await pair();
  host.open(PATH);
  guest.open(PATH);
  assert.equal(await host.insert(PATH, 0, 'abc'), true);
  await settle(host, guest, clock);
  assert.equal(guest.text(PATH), 'abc');
  assert.ok(converged(host, guest), 'the two replicas start converged');

  // B inserts `off ` and the frame is lost on the closing socket: drained, never delivered, and
  // never marked unsent. Its struct is in B's replica and nowhere else.
  assert.equal(await guest.insert(PATH, 0, 'off '), true);
  const lost = guest.takeOutbound();
  assert.equal(lost.length, 1, 'the update is the frame that goes missing');
  assert.equal(await syncSubtype(lost[0] as Uint8Array), 2, 'and it is an Update');

  // B's next edit depends on the missing struct. A accepts it (it is validly signed and its
  // counter is fresh) and holds it as a pending struct; A's text does not change yet.
  assert.equal(await guest.insert(PATH, 0, 'on '), true);
  const dependent = guest.takeOutbound();
  assert.equal(dependent.length, 1);
  await host.deliver(clock.now(), dependent[0] as Uint8Array);
  assert.equal(guest.text(PATH), 'on off abc');
  assert.equal(host.text(PATH), 'abc', 'the dependency is not yet here');
  assert.equal(host.droppedFrames.length, 0, 'a dependent update is accepted, not refused');

  // B re-seats: a new seat, a new session key, the same retained replica (§9.1).
  guest.detach();
  await guest.reseat('p-guest-2', ['p-host', 'p-guest-2'], 2003);
  await host.seatJoined(clock.now(), 'p-guest-2');
  await drive(host, guest, clock);

  assert.equal(host.text(PATH), 'on off abc', 'the reciprocal exchange recovered the lost update');
  assert.equal(guest.text(PATH), 'on off abc');
  assert.ok(converged(host, guest), 'texts and state vectors agree');

  // A later edit proves the dependency is genuinely recovered and editing continues.
  assert.equal(await guest.insert(PATH, 0, 'later: '), true);
  await settle(host, guest, clock);
  assert.equal(host.text(PATH), 'later: on off abc');
  assert.ok(converged(host, guest));
});

test('a lost deletion is recovered the same way', async () => {
  const { host, guest, clock } = await pair();
  host.open(PATH);
  guest.open(PATH);
  assert.equal(await host.insert(PATH, 0, 'abcdef'), true);
  await settle(host, guest, clock);

  // B deletes, and the deletion is lost. A later B edit is delivered, so A's text is not the
  // room's — the deletion set never arrived and the recovered history has to carry it.
  assert.equal(await guest.remove(PATH, 0, 2), true);
  guest.takeOutbound();
  assert.equal(await guest.insert(PATH, 0, 'Z'), true);
  const dependent = guest.takeOutbound();
  await host.deliver(clock.now(), dependent[0] as Uint8Array);
  // The insert is anchored to the item after the deleted text, so A places it after `ab`: the
  // deletion set the frame never carried is what still differs.
  assert.equal(host.text(PATH), 'abZcdef', 'the lost deletion set is not here yet');

  guest.detach();
  await guest.reseat('p-guest-2', ['p-host', 'p-guest-2'], 2003);
  await host.seatJoined(clock.now(), 'p-guest-2');
  await drive(host, guest, clock);

  assert.equal(host.text(PATH), 'Zcdef');
  assert.equal(guest.text(PATH), 'Zcdef');
  assert.ok(converged(host, guest), 'the deletion set converged, not just the text');
});

test('a document the room does not currently hold or list converges too', async () => {
  const { host, guest, clock } = await pair([PATH]);
  assert.ok(!host.heldPaths().includes(OTHER) && !guest.heldPaths().includes(OTHER));
  // The path is not in the listing: the room carries it as content and history alone.
  assert.equal(await guest.insert(OTHER, 0, 'hidden '), true);
  guest.takeOutbound();
  assert.equal(await guest.insert(OTHER, 0, 'more '), true);
  await host.deliver(clock.now(), guest.takeOutbound()[0] as Uint8Array);

  guest.detach();
  await guest.reseat('p-guest-2', ['p-host', 'p-guest-2'], 2003);
  await host.seatJoined(clock.now(), 'p-guest-2');
  await drive(host, guest, clock);

  assert.equal(host.text(OTHER), 'more hidden ');
  assert.ok(converged(host, guest));
});

/**
 * Delivers every frame among a set of sessions and ticks them, round after round, returning how
 * many `SyncStep1` frames each session published. The subtype is read off the wire, because
 * `handshakeCount` counts every sync frame — a `SyncStep2` answer included.
 */
async function driveAll(sessions: PeerSession[], clock: Clock, rounds = 60): Promise<{ step1: number[]; step2: number[] }> {
  const step1 = sessions.map(() => 0);
  const step2 = sessions.map(() => 0);
  for (let round = 0; round < rounds; round += 1) {
    for (const session of sessions) {
      await session.whenIdle();
    }
    const frames = sessions.map((session) => session.takeOutbound());
    for (let from = 0; from < sessions.length; from += 1) {
      for (const frame of frames[from] as Uint8Array[]) {
        const subtype = await syncSubtype(frame);
        if (subtype === 0) step1[from] = (step1[from] ?? 0) + 1;
        if (subtype === 1) step2[from] = (step2[from] ?? 0) + 1;
        for (let to = 0; to < sessions.length; to += 1) {
          if (to !== from) {
            await (sessions[to] as PeerSession).deliver(clock.now(), frame);
          }
        }
      }
    }
    for (const session of sessions) {
      await session.tick(clock.advance(10));
    }
  }
  return { step1, step2 };
}

test('a three-peer room converges and the reciprocal request does not echo', async () => {
  const clock = new Clock();
  const host = await hostOf([PATH]);
  const one = await guestOf({ seat: 'p-one', awarenessClientId: 3001, roster: ['p-host', 'p-one', 'p-two'] });
  const two = await guestOf({ seat: 'p-two', awarenessClientId: 3002, roster: ['p-host', 'p-one', 'p-two'] });
  await host.seatJoined(clock.now(), 'p-one');
  await host.seatJoined(clock.now(), 'p-two');

  host.open(PATH);
  one.open(PATH);
  two.open(PATH);
  assert.equal(await host.insert(PATH, 0, 'abc'), true);

  const requests = await driveAll([host, one, two], clock, 60);
  assert.equal(one.text(PATH), 'abc');
  assert.equal(two.text(PATH), 'abc');

  // One local `SyncStep1` per peer is the initial handshake; the reciprocal exchange adds a
  // bounded, finite number — one per eligible key, coalesced on the request clock. What must not
  // happen is an echo: a peer that keeps asking window after window.
  assert.ok(
    requests.step1.every((count) => count <= 3),
    `a peer kept requesting: ${JSON.stringify(requests)}`,
  );
  assert.ok(
    Buffer.from(host.stateVector()).equals(Buffer.from(one.stateVector())) &&
      Buffer.from(host.stateVector()).equals(Buffer.from(two.stateVector())),
    'all three histories converged',
  );
});

test('UNKNOWN rollback reconciles facade cache and open editor including removed roots', async (t) => {
  const { WebSocket } = await import('ws');
  const { FakeServer } = await import('./helpers/fake-server.ts');
  const { waitFor } = await import('./helpers/wait.ts');
  const { RelaySession } = await import('../src/engine/relay.ts');
  const { PeerEngine } = await import('../src/bridge/peer-engine.ts');
  const { SessionBridge } = await import('../src/bridge/bridge.ts');
  const { FakeEditor } = await import('./helpers/fake-editor.ts');
  const server = await FakeServer.start();
  t.after(() => server.stop());
  const host = await RelaySession.host({ baseUrl: server.wsBase, displayName: 'host', listing: () => [PATH], keepalive: { awareness_renew_ms: 30000, awareness_expire_ms: 90000 } });
  t.after(() => host.disconnect());
  const pending: Uint8Array[] = [];
  let deliver: (bytes: Uint8Array) => void = () => { throw new Error('socket not opened'); };
  const guest = await RelaySession.join({
    invite: host.invite() as string, displayName: 'viewer', declaredRole: 'viewer', reconnect: false,
    keepalive: { awareness_renew_ms: 30000, awareness_expire_ms: 90000 },
    webSocketFactory: (url) => {
      const socket = new WebSocket(url);
      const wrapper: import('../src/engine/transport.ts').WebSocketLike = {
        get readyState() { return socket.readyState; },
        send: (data) => socket.send(data), close: (code, reason) => socket.close(code, reason),
        onopen: null, onmessage: null, onclose: null, onerror: null,
      };
      deliver = (bytes) => wrapper.onmessage?.({ data: bytes });
      socket.on('open', () => wrapper.onopen?.());
      socket.on('message', (data, binary) => {
        if (binary) pending.push(new Uint8Array(data as Buffer));
        else wrapper.onmessage?.({ data: data.toString() });
      });
      socket.on('close', (code, reason) => wrapper.onclose?.({ code, reason }));
      socket.on('error', (error) => wrapper.onerror?.(error));
      return wrapper;
    },
  });
  t.after(() => guest.disconnect());
  await waitFor('uncommitted and committing states queued', () => pending.filter((b) => parseEnvelope(b)?.kind === 1).length >= 2);
  const firstState = pending.findIndex((b) => parseEnvelope(b)?.kind === 1);
  deliver(pending.splice(firstState, 1)[0] as Uint8Array);
  await waitFor('initial state applied without local commitment', () => guest.listing().includes(PATH));
  assert.equal(guest.appliedRole(), undefined);
  const engine = new PeerEngine({ relay: guest, displayName: 'viewer' });
  t.after(() => engine.dispose());
  const editor = new FakeEditor();
  const bridge = new SessionBridge({ engine, host: editor, reconcileSettleMs: 30000 });
  editor.attach(bridge);
  t.after(() => bridge.dispose());
  editor.open(PATH, ''); editor.open(OTHER, '');
  bridge.documentOpened(PATH); bridge.documentOpened(OTHER);
  editor.type(PATH, 'spec'); editor.type(OTHER, 'removed');
  await waitFor('synchronous speculation in both open documents', () => guest.text(PATH) === 'spec' && guest.text(OTHER) === 'removed');
  guest.setSelection(OTHER, { anchor: 3, head: 3 });
  await host.insert(PATH, 0, 'remote');
  await host.setAwareness({ path: PATH });
  await waitFor('remote content queued', () => pending.some((b) => parseEnvelope(b)?.kind === 0));
  for (const bytes of pending.filter((b) => parseEnvelope(b)?.kind === 0)) deliver(bytes);
  await waitFor('remote history accepted while UNKNOWN', () => guest.text(PATH).includes('remote'));
  const changed: string[] = [];
  engine.on((event) => { if (event.type === 'documentChanged') changed.push(event.path); });
  // The content scan above cached the speculative documents before the reset.
  for (const bytes of pending.filter((b) => parseEnvelope(b)?.kind === 1)) deliver(bytes);
  await waitFor('viewer role applied', () => guest.appliedRole() === 'viewer');
  assert.equal(guest.text(PATH), 'remote');
  assert.equal(guest.text(OTHER), '');
  await waitFor('facade reports cached and removed roots on the state event', () => changed.includes(PATH) && changed.includes(OTHER));
  await waitFor('editor and its saved cache reconcile', () => editor.text(PATH) === 'remote' && editor.text(OTHER) === '');
  assert.deepEqual(guest.heldPaths(), [PATH, OTHER].sort());
  const local = guest.presence().find((p) => p.state?.path === OTHER);
  assert.equal(local?.state?.selection, undefined, 'speculative selection must not retain dead anchors');
});


test('three-peer lost retained Update repairs unheld unlisted history with exact counts and frozen windows', async () => {
  const clock = new Clock();
  const host = await hostOf([PATH]);
  const one = await guestOf({ seat: 'p-one', awarenessClientId: 3001, roster: ['p-host', 'p-one', 'p-two'] });
  const two = await guestOf({ seat: 'p-two', awarenessClientId: 3002, roster: ['p-host', 'p-one', 'p-two'] });
  await host.seatJoined(clock.now(), 'p-one'); await host.seatJoined(clock.now(), 'p-two');
  await driveAll([host, one, two], clock);
  await one.insert(OTHER, 0, 'lost ');
  const lost = one.takeOutbound();
  assert.equal(lost.length, 1); assert.equal(await syncSubtype(lost[0] as Uint8Array), 2);
  await one.insert(OTHER, 0, 'dependent ');
  const dependent = one.takeOutbound()[0] as Uint8Array;
  for (const receiver of [host, two]) {
    assert.equal((await receiver.deliver(clock.now(), dependent)).status, 'applied');
    assert.equal(receiver.text(OTHER), '');
  }
  one.detach();
  await one.reseat('p-return', ['p-host', 'p-return', 'p-two'], 3003);
  await host.seatJoined(clock.now(), 'p-return');
  const counts = await driveAll([host, one, two], clock);
  // Returning peer: initial + reciprocal request. Each stable peer: one reciprocal request.
  // Every request is answered once by each of the other two writers.
  assert.deepEqual(counts, { step1: [1, 2, 1], step2: [3, 2, 3] });
  for (const peer of [host, one, two]) {
    assert.equal(peer.text(OTHER), 'dependent lost ');
    assert.deepEqual(peer.stateVector(), one.stateVector());
    assert.ok(!peer.heldPaths().includes(OTHER));
    assert.ok(!peer.listing.includes(OTHER));
    assert.ok([...peer.peerHolds().values()].every((paths) => !paths.includes(OTHER)));
  }
  const frozen = await driveAll([host, one, two], clock, 90);
  assert.deepEqual(frozen, { step1: [0, 0, 0], step2: [0, 0, 0] });
});

async function signedPairState(left: PeerSession, right: PeerSession, issued: number, includeRight: boolean): Promise<Uint8Array> {
  const now = await keys();
  const signer = await mintSessionKey(nodeCrypto, now.hostSeed);
  const derived = await frameKey(nodeCrypto, ROOM, now.roomKey);
  assert.ok(signer !== undefined && derived !== undefined);
  const peers: Record<string, unknown> = { [encodeKey(left.sessionKey)]: { peer_id: 'p-host', role: 'host' } };
  if (includeRight) peers[encodeKey(right.sessionKey)] = { peer_id: 'p-guest', role: 'guest' };
  const bytes = await seal(nodeCrypto, { roomId: ROOM, frameKey: derived, signer, kind: 1, epoch: 0, counter: issued, nonce: new Uint8Array(12).fill(issued) },
    new TextEncoder().encode(JSON.stringify({ issued, listing: [PATH], peers })));
  assert.ok(bytes !== undefined);
  return bytes;
}

async function exchangeCounts(peers: PeerSession[], clock: Clock): Promise<{ step1: number[]; step2: number[] }> {
  const step1 = peers.map(() => 0);
  const step2 = peers.map(() => 0);
  for (let round = 0; round < 40; round += 1) {
    for (const peer of peers) await peer.whenIdle();
    const frames = peers.map((peer) => peer.takeOutbound());
    if (frames.every((batch) => batch.length === 0)) return { step1, step2 };
    for (const [from, batch] of frames.entries()) {
      for (const bytes of batch) {
        const subtype = await syncSubtype(bytes);
        if (subtype === 0) step1[from] = (step1[from] ?? 0) + 1;
        if (subtype === 1) step2[from] = (step2[from] ?? 0) + 1;
        for (const [to, peer] of peers.entries()) {
          if (to !== from) assert.equal((await peer.deliver(clock.now(), bytes)).status, 'applied');
        }
      }
    }
  }
  assert.fail('sync exchange did not quiesce');
}

for (const loss of ['insertion', 'deletion']) {
  test(`same-key writer omission and recommitment repairs a published lost ${loss}`, async () => {
    const clock = new Clock();
    const host = await guestOf({ seat: 'p-host', awarenessClientId: 1001 });
    const guest = await guestOf();
    const peers = [host, guest];
    const initial = await signedPairState(host, guest, 1, true);
    for (const peer of peers) assert.equal((await peer.deliver(clock.now(), initial)).status, 'applied');
    assert.deepEqual(await exchangeCounts(peers, clock), { step1: [1, 1], step2: [1, 1] });
    clock.advance(RENEW_MS);
    for (const peer of peers) await peer.tick(clock.now());
    assert.deepEqual(await exchangeCounts(peers, clock), { step1: [1, 1], step2: [1, 1] });
    assert.equal(await host.insert(PATH, 0, 'abcdef'), true);
    await exchangeCounts(peers, clock);
    assert.ok(converged(host, guest));

    assert.equal(loss === 'insertion' ? await guest.insert(PATH, 0, 'off ') : await guest.remove(PATH, 0, 2), true);
    const lost = guest.takeOutbound();
    assert.equal(lost.length, 1, 'U was queued and drained, not held as unsent');
    assert.equal(await syncSubtype(lost[0] as Uint8Array), 2);
    if (loss === 'deletion') assert.deepEqual(host.stateVector(), guest.stateVector(), 'a lost deletion does not change the vector');
    assert.equal(await guest.insert(PATH, 0, 'on '), true);
    const dependent = guest.takeOutbound();
    assert.equal(dependent.length, 1);
    assert.equal(await syncSubtype(dependent[0] as Uint8Array), 2);
    const beforeDependent = host.stateVector();
    assert.equal((await host.deliver(clock.now(), dependent[0] as Uint8Array)).status, 'applied');
    assert.equal(host.text(PATH), loss === 'insertion' ? 'abcdef' : 'abon cdef');
    if (loss === 'insertion') assert.deepEqual(host.stateVector(), beforeDependent, 'V is accepted pending, not integrated without U');
    assert.equal(guest.text(PATH), loss === 'insertion' ? 'on off abcdef' : 'on cdef');
    if (loss === 'deletion') assert.deepEqual(host.stateVector(), guest.stateVector(), 'equal vectors still hide missing deletion content');
    assert.equal(host.droppedFrames.length, 0);

    const unchangedKey = guest.sessionKey.slice();
    const omitted = await signedPairState(host, guest, 2, false);
    clock.advance(1);
    for (const peer of peers) assert.equal((await peer.deliver(clock.now(), omitted)).status, 'applied');
    assert.deepEqual(await exchangeCounts(peers, clock), { step1: [0, 0], step2: [0, 0] });
    const recommitted = await signedPairState(host, guest, 3, true);
    clock.advance(1);
    for (const peer of peers) assert.equal((await peer.deliver(clock.now(), recommitted)).status, 'applied');
    assert.deepEqual(guest.sessionKey, unchangedKey);
    assert.deepEqual(await exchangeCounts(peers, clock), { step1: [0, 0], step2: [0, 0] }, 'state-only transitions do not send a redundant immediate handshake');
    clock.advance(RENEW_MS - 3);
    for (const peer of peers) await peer.tick(clock.now());
    assert.deepEqual(await exchangeCounts(peers, clock), { step1: [0, 0], step2: [0, 0] }, 'renew-1');
    clock.advance(1);
    for (const peer of peers) await peer.tick(clock.now());
    assert.deepEqual(await exchangeCounts(peers, clock), { step1: [0, 1], step2: [1, 0] }, 'renew: renewed local readiness');
    clock.advance(1);
    for (const peer of peers) await peer.tick(clock.now());
    assert.deepEqual(await exchangeCounts(peers, clock), { step1: [1, 0], step2: [0, 1] }, 'renew+1: host reciprocates once');
    assert.equal(host.text(PATH), loss === 'insertion' ? 'on off abcdef' : 'on cdef');
    assert.ok(converged(host, guest));
    for (const peer of peers) assert.equal(peer.droppedFrames.length, 0, 'repair must not depend on a refusal');
    assert.equal(await guest.insert(PATH, 0, 'later: '), true);
    await exchangeCounts(peers, clock);
    assert.equal(host.text(PATH), loss === 'insertion' ? 'later: on off abcdef' : 'later: on cdef');
    assert.ok(converged(host, guest));
    assert.deepEqual(await driveAll(peers, clock, 90), { step1: [0, 0], step2: [0, 0] });
  });
}
