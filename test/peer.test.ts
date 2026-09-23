/**
 * `PROTOCOL.md` §13: the order of operations at a join, what a client may publish and when, the
 * roles the applied state gives, the holds and their lease, the two windows that end a session,
 * and the invite §13.1's first step reads.
 *
 * Every clock here is a number the test passes in, and every frame is built from constants, so
 * these are rules under test and not a machine's timing. The corpus
 * (`test/peer-corpus.test.ts`) is what drives the same rules through the decision vectors.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import * as Y from 'yjs';

import { nodeCrypto } from '../src/node/crypto.ts';
import {
  MISSING_FRAGMENT,
  PEER_MUTATIONS,
  PeerSession,
  endingReason,
  parseInvite,
} from '../src/engine/peer.ts';
import type { PeerOptions } from '../src/engine/peer.ts';
import {
  decodeKey,
  encodeKey,
  encodeEnvelope,
  frameKey,
  hex,
  mintSessionKey,
  opens,
  parseEnvelope,
  readVaruint,
  seal,
} from '../src/engine/sealed.ts';
import type { SessionKeypair } from '../src/engine/sealed.ts';
import { encodeSyncStep1, encodeUpdate } from '../src/engine/sync.ts';

const ROOM = 'R7f3a2c19';
const RENEW_MS = 300;
const EXPIRE_MS = 900;

interface Room {
  frameKey: Uint8Array;
  roomKey: Uint8Array;
  host: SessionKeypair;
  ours: SessionKeypair;
  peer: SessionKeypair;
}

let cached: Promise<Room> | undefined;

function room(): Promise<Room> {
  cached ??= (async () => {
    const roomKey = new Uint8Array(32).fill(7);
    const derive = await frameKey(nodeCrypto, ROOM, roomKey);
    assert.ok(derive !== undefined);
    return {
      roomKey,
      frameKey: derive,
      host: (await mintSessionKey(nodeCrypto, new Uint8Array(32).fill(3))) as SessionKeypair,
      ours: (await mintSessionKey(nodeCrypto, new Uint8Array(32).fill(5))) as SessionKeypair,
      peer: (await mintSessionKey(nodeCrypto, new Uint8Array(32).fill(11))) as SessionKeypair,
    };
  })();
  return cached;
}

const utf8 = (value: unknown): Uint8Array =>
  new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));

async function frame(
  signer: SessionKeypair,
  kind: number,
  counter: number,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const now = await room();
  const bytes = await seal(
    nodeCrypto,
    { roomId: ROOM, frameKey: now.frameKey, kind, epoch: 0, counter, nonce: new Uint8Array(12).fill(4), signer },
    plaintext,
  );
  assert.ok(bytes !== undefined);
  return bytes;
}

function peers(entries: Array<[SessionKeypair, string, string]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, role, seat] of entries) {
    out[encodeKey(key.public)] = { peer_id: seat, role };
  }
  return out;
}

function state(
  signer: SessionKeypair,
  issued: number,
  entries: Array<[SessionKeypair, string, string]>,
  listing: string[] = ['README.md'],
  counter = 1,
): Promise<Uint8Array> {
  return frame(signer, 1, counter, utf8({ issued, listing, peers: peers(entries) }));
}

function holds(
  signer: SessionKeypair,
  counter: number,
  paths: string[],
): Promise<Uint8Array> {
  return frame(signer, 3, counter, utf8({ holds: paths }));
}

function closing(signer: SessionKeypair, issued: number): Promise<Uint8Array> {
  return frame(signer, 2, 1, utf8({ closing: true, issued }));
}

/** A `kind = 0` frame carrying a real update, which is document content. */
async function content(
  signer: SessionKeypair,
  counter: number,
  path: string,
  text: string,
): Promise<Uint8Array> {
  const scratch = new Y.Doc();
  scratch.getText(path).insert(0, text);
  const update = Y.encodeStateAsUpdate(scratch);
  return frame(signer, 0, counter, encodeUpdate(update));
}

/** Every session a test opened, released when the file's tests are done. */
const opened: PeerSession[] = [];

after(() => {
  for (const peer of opened) {
    peer.destroy();
  }
});

async function session(options: Partial<PeerOptions> = {}): Promise<PeerSession> {
  const now = await room();
  const peer = await PeerSession.create({
    roomId: ROOM,
    roomKey: now.roomKey,
    hostKey: now.host.public,
    keepalive: {
      ping_interval_ms: 30_000,
      awareness_renew_ms: RENEW_MS,
      awareness_expire_ms: EXPIRE_MS,
    },
    crypto: nodeCrypto,
    seat: 'p-self',
    sessionSeed: now.ours.seed,
    ...options,
  });
  assert.ok(peer !== undefined, 'a session is opened');
  opened.push(peer);
  return peer;
}

/** What one published frame carried, and what kind it is. */
async function publishedFrame(
  bytes: Uint8Array,
): Promise<{ kind: number; payload: unknown }> {
  const now = await room();
  const envelope = parseEnvelope(bytes);
  assert.ok(envelope !== undefined, 'a published frame is an envelope');
  const plaintext = await opens(nodeCrypto, now.frameKey, ROOM, envelope);
  assert.ok(plaintext !== undefined, 'a published frame opens under the frame key');
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    payload = [...plaintext];
  }
  return { kind: envelope.kind, payload };
}

// --- §13.1, the order of operations at a join -----------------------------------

test('the announcement goes out first and nothing else before a state', async () => {
  const peer = await session();
  await peer.tick(0);
  const out = peer.takeOutbound();
  assert.equal(out.length, 1, "§13.1's step 4 is the first binary frame");
  assert.equal(peer.publishedCount, 1);
  assert.equal(peer.handshakeCount, 0);
  const { kind, payload } = await publishedFrame(out[0] as Uint8Array);
  assert.equal(kind, 4);
  assert.deepEqual(payload, { key: encodeKey(peer.sessionKey) });
});

test('an uncommitted key is re-announced on the renewal clock and stops once committed', async () => {
  const now = await room();
  const peer = await session();
  await peer.tick(0);
  peer.takeOutbound();

  // A state that commits another peer and not this connection: §13.1's step 4 announces again at
  // once, because the renewal clock alone would wait a whole window.
  const other = await state(now.host, 1, [[now.peer, 'guest', 'p-other']]);
  assert.deepEqual(await peer.deliver(1, other), { status: 'applied', kind: 1 });
  peer.takeOutbound();
  assert.equal(peer.publishedCount, 2);

  await peer.tick(1 + RENEW_MS - 1);
  assert.equal(peer.takeOutbound().length, 0, 'the clock has not passed');
  await peer.tick(1 + RENEW_MS);
  assert.equal(peer.takeOutbound().length, 1, "§13.1's renewal clock");
  assert.equal(peer.publishedCount, 3);

  const committing = await state(now.host, 2, [[now.ours, 'guest', 'p-self']]);
  assert.deepEqual(await peer.deliver(1 + RENEW_MS + 1, committing), {
    status: 'applied',
    kind: 1,
  });
  peer.takeOutbound();
  await peer.tick(2_000);
  assert.equal(peer.takeOutbound().length, 0, 'a committed key stops being announced');
  assert.equal(peer.publishedCount, 3);
});

test('a committing state answers with the handshake, once, and moves no publication', async () => {
  const now = await room();
  const peer = await session();
  await peer.tick(0);
  peer.takeOutbound();

  assert.deepEqual(
    await peer.deliver(1, await state(now.host, 1, [[now.ours, 'guest', 'p-self']])),
    { status: 'applied', kind: 1 },
  );
  const after = peer.takeOutbound();
  assert.equal(after.length, 1, "§13.1's step 6, once");
  assert.equal(peer.handshakeCount, 1);
  assert.equal(peer.publishedCount, 1, 'a handshake frame is not a publication');
  const { kind, payload } = await publishedFrame(after[0] as Uint8Array);
  assert.equal(kind, 0);
  assert.deepEqual(payload, [...encodeSyncStep1(new Y.Doc())]);
  assert.equal((payload as number[])[0], 0, 'message type 0: sync');
  assert.equal(readVaruint(Uint8Array.from(payload as number[]), 1)?.[0], 0, 'SyncStep1');
  assert.deepEqual(peer.listing, ['README.md']);
  assert.equal(peer.stateHeld(), true);
});

test('a second state that commits our key sends no second handshake', async () => {
  const now = await room();
  const peer = await session();
  await peer.tick(0);
  assert.deepEqual(
    await peer.deliver(1, await state(now.host, 1, [[now.ours, 'guest', 'p-self']])),
    { status: 'applied', kind: 1 },
  );
  peer.takeOutbound();
  assert.equal(peer.handshakeCount, 1);

  assert.deepEqual(
    await peer.deliver(2, await state(now.host, 2, [[now.ours, 'guest', 'p-self']])),
    { status: 'applied', kind: 1 },
  );
  await peer.tick(2 + RENEW_MS + 1);
  assert.equal(peer.takeOutbound().length, 0, 'one handshake per connection');
  assert.equal(peer.handshakeCount, 1);
});

test('an edit past the end of the text is refused, and a guest publishes its delta', async () => {
  const now = await room();
  const peer = await session();
  await peer.tick(0);
  await peer.deliver(1, await state(now.host, 1, [[now.ours, 'guest', 'p-self']]));
  peer.takeOutbound();

  assert.equal(await peer.insert('README.md', 0, 'hello'), true);
  assert.equal(peer.length('README.md'), 5);
  const out = peer.takeOutbound();
  assert.equal(out.length, 1);
  assert.equal(peer.publishedCount, 2);
  assert.equal((await publishedFrame(out[0] as Uint8Array)).kind, 0);

  await assert.rejects(peer.insert('README.md', 7, '!'), /no offset 7/);
  assert.equal(peer.length('README.md'), 5, 'and nothing was applied');
});

test("a committed viewer's content is refused, its holds are applied, and its own edit is not published", async () => {
  const now = await room();
  const peer = await session();
  await peer.tick(0);
  const both = await state(now.host, 1, [
    [now.ours, 'guest', 'p-self'],
    [now.peer, 'viewer', 'p-viewer'],
  ]);
  assert.deepEqual(await peer.deliver(1, both), { status: 'applied', kind: 1 });
  peer.takeOutbound();

  assert.deepEqual(await peer.deliver(2, await content(now.peer, 1, 'README.md', 'hello')), {
    status: 'dropped',
    reason: 'unauthorised_content',
  });
  assert.equal(peer.publishedCount, 1, 'nothing was published in answer');
  assert.equal(peer.text('README.md'), '', 'and nothing was applied');

  assert.deepEqual(await peer.deliver(3, await holds(now.peer, 2, ['README.md'])), {
    status: 'applied',
    kind: 3,
  });
  assert.deepEqual(peer.peerHolds().get(encodeKey(now.peer.public)), ['README.md']);

  // §13.6: the refusal opens an interval, and the client re-syncs in it once per renewal, and no
  // more than once however many content frames it refused.
  await peer.tick(3 + RENEW_MS);
  const resync = peer.takeOutbound();
  assert.equal(resync.length, 1, "§13.6's re-sync");
  assert.equal(peer.handshakeCount, 2, "§13.1's step 6, then §13.6's");
  assert.equal(peer.publishedCount, 1, 'a handshake frame is not a publication');
  assert.equal((await publishedFrame(resync[0] as Uint8Array)).kind, 0);
  await peer.tick(3 + RENEW_MS + 1);
  await peer.deliver(3 + RENEW_MS + 2, await content(now.peer, 3, 'README.md', 'again'));
  await peer.tick(3 + RENEW_MS + 3);
  assert.equal(peer.takeOutbound().length, 0, 'once per interval');
});

test('a viewer keeps its own edit, sends nothing, and still publishes its holds', async () => {
  const now = await room();
  const peer = await session();
  await peer.tick(0);
  assert.deepEqual(
    await peer.deliver(1, await state(now.host, 1, [[now.ours, 'viewer', 'p-self']])),
    { status: 'applied', kind: 1 },
  );
  peer.takeOutbound();

  assert.equal(await peer.insert('README.md', 0, 'hello'), false);
  assert.equal(peer.text('README.md'), 'hello', 'its own replica holds it');
  assert.equal(peer.publishedCount, 1, 'and the room never hears it');

  peer.open('README.md');
  await peer.tick(2);
  const out = peer.takeOutbound();
  assert.equal(out.length, 1, '§13.9: a viewer publishes its holds');
  assert.equal((await publishedFrame(out[0] as Uint8Array)).kind, 3);
});

test('a closing handed to a state-less client is ignored and the state below it still applies', async () => {
  const now = await room();
  const peer = await session();
  await peer.tick(0);
  peer.takeOutbound();

  assert.deepEqual(await peer.deliver(1, await closing(now.host, 2)), {
    status: 'ignored',
    kind: 2,
  });
  assert.equal(peer.appliedFrames.length, 0);
  assert.equal(peer.droppedFrames.length, 0);
  assert.deepEqual(peer.ignoredFrames, [0]);
  assert.equal(peer.end, undefined);

  assert.deepEqual(
    await peer.deliver(2, await state(now.host, 1, [[now.ours, 'guest', 'p-self']])),
    { status: 'applied', kind: 1 },
  );
  assert.deepEqual(await peer.deliver(3, await closing(now.host, 2)), {
    status: 'applied',
    kind: 2,
  });
  assert.equal(peer.end, 'closing');
  assert.equal(endingReason('closing'), 'the room closed');
});

// --- §13.7, the holds and their lease -------------------------------------------

test('a lease lapses a window after the last message and drops no frame', async () => {
  const now = await room();
  const peer = await session();
  await peer.tick(0);
  await peer.deliver(1, await state(now.host, 1, [[now.peer, 'guest', 'p-other']]));
  assert.deepEqual(await peer.deliver(2, await holds(now.peer, 1, ['README.md'])), {
    status: 'applied',
    kind: 3,
  });
  assert.deepEqual(peer.peerHolds().get(encodeKey(now.peer.public)), ['README.md']);

  await peer.tick(2 + EXPIRE_MS - 1);
  assert.equal(peer.peerHolds().size, 1, 'the lease has not lapsed');
  await peer.tick(2 + EXPIRE_MS);
  assert.equal(peer.peerHolds().size, 0);
  assert.equal(peer.droppedFrames.length, 0, 'an expiry is not a refusal');
  assert.equal(peer.end, undefined, 'and it is not a departure');
});

test('a hold set is announced wholesale, and an empty one is a release', async () => {
  const now = await room();
  const peer = await session();
  await peer.tick(0);
  await peer.deliver(1, await state(now.host, 1, [[now.ours, 'guest', 'p-self']]));
  peer.takeOutbound();

  peer.open('src/main.rs');
  peer.open('README.md');
  await peer.tick(2);
  const out = peer.takeOutbound();
  assert.equal(out.length, 1, 'a changed set goes out at once');
  assert.deepEqual((await publishedFrame(out[0] as Uint8Array)).payload, {
    holds: ['README.md', 'src/main.rs'],
  });

  peer.release();
  await peer.tick(3);
  const released = peer.takeOutbound();
  assert.equal(released.length, 1);
  assert.deepEqual((await publishedFrame(released[0] as Uint8Array)).payload, { holds: [] });
});

test('an idle holder keeps renewing its holds on its own clock', async () => {
  const now = await room();
  const peer = await session();
  await peer.tick(0);
  await peer.deliver(1, await state(now.host, 1, [[now.ours, 'guest', 'p-self']]));
  peer.open('README.md');
  await peer.tick(2);
  peer.takeOutbound();

  await peer.tick(2 + RENEW_MS - 1);
  assert.equal(peer.takeOutbound().length, 0, 'not before the clock');
  await peer.tick(2 + RENEW_MS);
  const renewed = peer.takeOutbound();
  assert.equal(renewed.length, 1, '§13.7: renewal is unconditional and timer-driven');
  assert.deepEqual((await publishedFrame(renewed[0] as Uint8Array)).payload, {
    holds: ['README.md'],
  });
});

test('a holds message from a key no state commits is refused, and the session goes on', async () => {
  const now = await room();
  const peer = await session();
  await peer.tick(0);
  await peer.deliver(1, await state(now.host, 1, [[now.ours, 'guest', 'p-self']]));
  peer.takeOutbound();
  assert.deepEqual(await peer.deliver(2, await holds(now.peer, 1, ['README.md'])), {
    status: 'dropped',
    reason: 'uncommitted_key',
  });
  assert.equal(peer.peerHolds().size, 0);
  assert.equal(peer.end, undefined, 'a refused frame never ends a session');
});

test('a seat joining makes the held set due again, and one leaving loses its holds', async () => {
  const now = await room();
  const peer = await session();
  await peer.tick(0);
  await peer.deliver(1, await state(now.host, 1, [[now.ours, 'guest', 'p-self']]));
  peer.open('README.md');
  await peer.tick(2);
  peer.takeOutbound();

  // §13.7: a holder MUST re-announce when it sees a `peer.joined`, so that a joiner learns the
  // holds without asking — and not only when the renewal clock comes round.
  peer.seatJoined('p-new');
  await peer.tick(2 + 1);
  const out = peer.takeOutbound();
  assert.equal(out.length, 1, 'the set is announced at once, not at the end of the window');
  assert.deepEqual((await publishedFrame(out[0] as Uint8Array)).payload, { holds: ['README.md'] });
});

test('a peer that leaves loses its holds at once, and a seat the roster never knew does not', async () => {
  const now = await room();
  const peer = await session({ roster: ['p-other'] });
  await peer.tick(0);
  await peer.deliver(1, await state(now.host, 1, [[now.peer, 'guest', 'p-other']]));
  await peer.deliver(2, await holds(now.peer, 1, ['README.md']));
  assert.equal(peer.peerHolds().size, 1);

  peer.seatLeft(3, 'p-nobody');
  assert.equal(peer.peerHolds().size, 1, 'a seat the roster never knew is left to its lease');
  peer.seatLeft(4, 'p-other');
  assert.equal(peer.peerHolds().size, 0, 'the roster is the authority on who is present');
});

// --- §13.8 and §13.3, the two windows -------------------------------------------

test('a seated client with no state ends at the no-state window, and not before', async () => {
  const peer = await session();
  await peer.tick(EXPIRE_MS - 1);
  assert.equal(peer.end, undefined, 'not before the window');
  await peer.tick(EXPIRE_MS);
  assert.equal(peer.end, 'no-state');
  assert.equal(endingReason('no-state'), 'no state arrived within the no-state window');
});

test('a state whose host entry is unseated ends the session a window later', async () => {
  const now = await room();
  const peer = await session();
  await peer.tick(0);
  assert.deepEqual(await peer.deliver(1, await state(now.host, 1, [[now.peer, 'host', 'p-absent']])), {
    status: 'applied',
    kind: 1,
  });
  await peer.tick(EXPIRE_MS);
  assert.equal(peer.end, undefined, 'one millisecond short of the window');
  await peer.tick(EXPIRE_MS + 1);
  assert.equal(peer.end, 'host-away');
  assert.equal(endingReason('host-away'), 'the host has been away past its window');
});

test('a peer.left for the seat the host entry labels arms the clock', async () => {
  const now = await room();
  const peer = await session({ roster: ['p-host'] });
  await peer.tick(0);
  await peer.deliver(1, await state(now.host, 1, [[now.peer, 'host', 'p-host']]));
  await peer.tick(500);
  assert.equal(peer.end, undefined, 'the host is seated');

  peer.seatLeft(600, 'p-host');
  await peer.tick(600 + EXPIRE_MS - 1);
  assert.equal(peer.end, undefined);
  await peer.tick(600 + EXPIRE_MS);
  assert.equal(peer.end, 'host-away');
});

test('a state that names no host arms nothing, and the two windows run in sequence', async () => {
  const now = await room();
  const peer = await session();
  await peer.tick(0);
  await peer.deliver(1, await state(now.host, 1, [[now.peer, 'guest', 'p-other']]));
  await peer.tick(5_000);
  assert.equal(peer.end, undefined, 'a client MUST NOT guess which connection is the host\'s');

  // The other order: seated with no state for part of the window, then a state whose host entry
  // is unseated. Both windows are owed, so the second is not shortened by the first.
  const later = await session();
  await later.tick(EXPIRE_MS - 100);
  assert.equal(later.end, undefined);
  await later.deliver(EXPIRE_MS - 100, await state(now.host, 1, [[now.peer, 'host', 'p-absent']]));
  await later.tick(2 * EXPIRE_MS - 101);
  assert.equal(later.end, undefined, 'the host-away window started where the state was applied');
  await later.tick(2 * EXPIRE_MS - 100);
  assert.equal(later.end, 'host-away');
});

// --- the invite -----------------------------------------------------------------

test('the invite carries the room, the token and both keys, and the fragment is stripped', async () => {
  const now = await room();
  const link = `/session?room=${ROOM}&token=t-1#k=${encodeKey(now.roomKey)}&h=${encodeKey(now.host.public)}`;
  const read = parseInvite(link);
  assert.ok(read.ok, read.ok ? '' : read.reason);
  assert.equal(read.invite.room, ROOM);
  assert.equal(read.invite.token, 't-1');
  assert.deepEqual(read.invite.roomKey, now.roomKey);
  assert.deepEqual(read.invite.hostKey, now.host.public);
  assert.equal(read.invite.socketUrl.includes('#'), false);
  assert.equal(read.invite.socketUrl, `/session?room=${ROOM}&token=t-1`);

  // An absolute link keeps its address, and an unknown parameter is ignored.
  const absolute = parseInvite(
    `ws://127.0.0.1:8080/session?room=${ROOM}&token=t-1&who=you#k=${encodeKey(now.roomKey)}&h=${encodeKey(now.host.public)}`,
  );
  assert.ok(absolute.ok);
  assert.equal(absolute.invite.socketUrl, `ws://127.0.0.1:8080/session?room=${ROOM}&token=t-1&who=you`);
});

test('an invite with no fragment, or a value that is not a key, is refused locally', async () => {
  const now = await room();
  const key = encodeKey(now.roomKey);
  const host = encodeKey(now.host.public);
  const at = `?room=${ROOM}&token=t-1`;

  const missing = parseInvite(`/session${at}`);
  assert.ok(!missing.ok);
  assert.match(missing.reason, /fragment/);
  assert.equal(missing.reason, MISSING_FRAGMENT);
  assert.match(MISSING_FRAGMENT, /ask for the whole link/);

  for (const [fragment, wanted] of [
    [`k=${encodeKey(now.roomKey).slice(0, 42)}B&h=${host}`, /`k`/],
    [`k=AAAA&h=${host}`, /`k`/],
    [`k=${key}&k=${key}&h=${host}`, /twice/],
    [`k=${key}`, /`h`/],
    [`h=${host}`, /`k`/],
    [`#`, /`k`/],
  ] as Array<[string, RegExp]>) {
    const read = parseInvite(`/session${at}#${fragment}`);
    assert.ok(!read.ok, `${fragment} is refused`);
    assert.match(read.reason, wanted, fragment);
  }

  // §5.1: a query that repeats one of the two values is malformed.
  const repeated = parseInvite(`/session?room=${ROOM}&room=${ROOM}&token=t-1#k=${key}&h=${host}`);
  assert.ok(!repeated.ok);
  assert.match(repeated.reason, /`room` twice/);

  const noRoom = parseInvite(`/session?token=t-1#k=${key}&h=${host}`);
  assert.ok(!noRoom.ok);
  assert.match(noRoom.reason, /no room/);

  const notTheEndpoint = parseInvite(`/other?room=${ROOM}&token=t-1#k=${key}&h=${host}`);
  assert.ok(!notTheEndpoint.ok);
  assert.match(notTheEndpoint.reason, /session endpoint/);

  // A key that is not the canonical encoding is not a key: the final character of a 32-byte
  // value carries two zero pad bits, and a spelling whose last character is any other spells none.
  assert.equal(decodeKey(`${key.slice(0, 42)}B`), undefined);
  assert.equal(hex(now.roomKey), hex(now.roomKey));
});

// --- §13.11's census ------------------------------------------------------------

test('each mutation removes the rule it names, and an unknown one is refused', async () => {
  const now = await room();
  const committed = await state(now.host, 1, [
    [now.ours, 'guest', 'p-self'],
    [now.peer, 'viewer', 'p-viewer'],
  ]);

  // `ignore-roles`: a committed viewer's content is applied.
  const roles = await session();
  await roles.tick(0);
  await roles.deliver(1, committed);
  roles.takeOutbound();
  roles.mutate('ignore-roles');
  assert.deepEqual(await roles.deliver(2, await content(now.peer, 1, 'README.md', 'hello')), {
    status: 'applied',
    kind: 0,
  });
  assert.equal(roles.text('README.md'), 'hello');

  // `announce-once`: no re-announcement on the renewal clock.
  const once = await session();
  await once.tick(0);
  once.mutate('announce-once');
  await once.tick(10 * RENEW_MS);
  assert.equal(once.publishedCount, 1);

  // `no-lease`: a peer's holds are kept for ever.
  const leased = await session();
  await leased.tick(0);
  await leased.deliver(1, await state(now.host, 1, [[now.peer, 'guest', 'p-other']]));
  await leased.deliver(2, await holds(now.peer, 1, ['README.md']));
  leased.mutate('no-lease');
  await leased.tick(10_000);
  assert.equal(leased.peerHolds().size, 1);

  // `wait-for-ever`: a client with no state stays seated.
  const seeded = await session();
  seeded.mutate('wait-for-ever');
  await seeded.tick(60_000);
  assert.equal(seeded.end, undefined);

  // `any-closing`: a closing ends a client that holds no state.
  const closing_ = await session();
  await closing_.tick(0);
  closing_.mutate('any-closing');
  assert.deepEqual(await closing_.deliver(1, await closing(now.host, 2)), {
    status: 'applied',
    kind: 2,
  });
  assert.equal(closing_.end, 'closing');

  // `ignore-issued`: a state at the mark is applied.
  const issued = await session();
  await issued.tick(0);
  await issued.deliver(1, await state(now.host, 2, [[now.peer, 'guest', 'p-other']]));
  issued.mutate('ignore-issued');
  assert.deepEqual(await issued.deliver(2, await state(now.host, 2, [[now.peer, 'guest', 'p-other']], ['old.md'], 2)), {
    status: 'applied',
    kind: 1,
  });
  assert.deepEqual(issued.listing, ['old.md']);

  const unknown = await session();
  assert.throws(() => unknown.mutate('make-it-up'), /no mutation is named/);
  assert.deepEqual([...PEER_MUTATIONS], [
    'ignore-roles',
    'ignore-issued',
    'announce-once',
    'no-lease',
    'any-closing',
    'wait-for-ever',
  ]);
  assert.equal(unknown.mutationName, undefined);
});

test('a frame that is not an envelope is refused without ending the session', async () => {
  const peer = await session();
  await peer.tick(0);
  assert.deepEqual(await peer.deliver(1, Uint8Array.from([1, 2, 3])), {
    status: 'dropped',
    reason: 'bad_envelope',
  });
  assert.equal(peer.end, undefined);
  assert.deepEqual(peer.droppedFrames, [{ frame: 0, reason: 'bad_envelope' }]);
  assert.deepEqual(
    parseEnvelope(encodeEnvelope({ keyId: new Uint8Array(8), kind: 0, epoch: 0, counter: 1, nonce: new Uint8Array(12), ciphertext: new Uint8Array(0), signature: new Uint8Array(64) }))?.kind,
    0,
  );
});
