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
import { encodeKey, mintSessionKey } from '../src/engine/sealed.ts';
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
