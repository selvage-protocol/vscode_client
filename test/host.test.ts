/**
 * `PROTOCOL.md` §7.1's producer half: what a host publishes, what it carries, and when it goes.
 *
 * Every clock here is a number the test passes in and every frame is built from constants, so
 * these are §7.1's rules under test rather than a machine's timing. The corpus
 * (`test/peer-corpus.test.ts`) drives the same rules through the decision vectors' host half.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { nodeCrypto } from '../src/node/crypto.ts';
import { HOST_MUTATIONS, MAX_PATH_BYTES } from '../src/engine/index.ts';
import { PeerSession } from '../src/engine/peer.ts';
import type { PeerOptions } from '../src/engine/peer.ts';
import type { HostStore, PersistedHost } from '../src/engine/host.ts';
import {
  Reader,
  canonicalJson,
  encodeKey,
  frameKey,
  mintSessionKey,
  opens,
  parseEnvelope,
  seal,
} from '../src/engine/sealed.ts';
import type { RoomState, SessionKeypair } from '../src/engine/sealed.ts';
import { encodeUpdate } from '../src/engine/sync.ts';
import * as Y from 'yjs';

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

/** Every session a test opened, released when the file's tests are done. */
const sessions: PeerSession[] = [];

after(() => {
  for (const peer of sessions) {
    peer.destroy();
  }
});

/** A store that keeps one record in memory, which is all a test needs of §7.1's persistence. */
class MemoryStore implements HostStore {
  saved: PersistedHost | undefined;

  load(): PersistedHost | undefined {
    return this.saved;
  }

  save(persisted: PersistedHost): void {
    this.saved = {
      hostSeed: Uint8Array.from(persisted.hostSeed),
      issued: persisted.issued,
      ...(persisted.frames === undefined ? {} : { frames: persisted.frames }),
    };
  }
}

interface HostFixture {
  peer: PeerSession;
  store: MemoryStore;
  listing: string[];
}

/** A host session: the fixture's host key, our own session key, and a caller's listing. */
async function hostHosting(
  listing: string[],
  extra: Partial<PeerOptions> = {},
  store = new MemoryStore(),
): Promise<HostFixture> {
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
    seat: 'p-host',
    sessionSeed: now.ours.seed,
    host: { hostSeed: now.host.seed, listing: () => listing, store },
    ...extra,
  });
  assert.ok(peer !== undefined, 'a host session is opened');
  sessions.push(peer);
  return { peer, store, listing };
}

/** A session-key announcement, `kind = 4`, signed by the very key it names (§7.1). */
async function announce(
  signer: SessionKeypair,
  counter: number,
  role?: string,
): Promise<Uint8Array> {
  const now = await room();
  const members: Record<string, unknown> = { key: encodeKey(signer.public) };
  if (role !== undefined) {
    members['role'] = role;
  }
  const bytes = await seal(
    nodeCrypto,
    {
      roomId: ROOM,
      frameKey: now.frameKey,
      kind: 4,
      epoch: 0,
      counter,
      nonce: new Uint8Array(12).fill(counter),
      signer,
    },
    canonicalJson(members),
  );
  assert.ok(bytes !== undefined);
  return bytes;
}

/** A room state, as a peer would re-send one (§7.1). */
async function state(
  signer: SessionKeypair,
  issued: number,
  entries: Array<[SessionKeypair, string, string]>,
  listing: string[] = ['README.md'],
  counter = 1,
): Promise<Uint8Array> {
  const now = await room();
  const peers: Record<string, unknown> = {};
  for (const [key, role, seat] of entries) {
    peers[encodeKey(key.public)] = { peer_id: seat, role };
  }
  const bytes = await seal(
    nodeCrypto,
    {
      roomId: ROOM,
      frameKey: now.frameKey,
      kind: 1,
      epoch: 0,
      counter,
      nonce: new Uint8Array(12).fill(counter),
      signer,
    },
    canonicalJson({ issued, listing, peers }),
  );
  assert.ok(bytes !== undefined);
  return bytes;
}

/** What a published frame carried, and the plaintext it carried it as. */
async function opened(
  bytes: Uint8Array,
): Promise<{ kind: number; text: string; payload: unknown; envelope: NonNullable<ReturnType<typeof parseEnvelope>> }> {
  const now = await room();
  const envelope = parseEnvelope(bytes);
  assert.ok(envelope !== undefined, 'a published frame is an envelope');
  const plaintext = await opens(nodeCrypto, now.frameKey, ROOM, envelope);
  assert.ok(plaintext !== undefined, 'a published frame opens under the frame key');
  const text = new TextDecoder().decode(plaintext);
  return { kind: envelope.kind, text, payload: JSON.parse(text) as unknown, envelope };
}

/** The states a host published, as `{issued, listing, peers, fresh}`. */
function published(session: PeerSession): Array<{
  issued: number;
  listing: string[];
  peers: Record<string, { peer_id: string; role: string }>;
  fresh: boolean;
}> {
  return session.hostStates().map((publication) => {
    const state: RoomState | undefined = publication.state;
    return {
      issued: publication.issued,
      listing: [...(state?.listing ?? [])],
      peers: Object.fromEntries(
        [...(state?.peers ?? new Map())].map(([spelling, entry]) => [
          spelling,
          { peer_id: entry.peer_id, role: entry.role },
        ]),
      ),
      fresh: publication.fresh,
    };
  });
}

// --- at mint ---------------------------------------------------------------------

test('a host publishes a state at mint: its listing, one host entry, and issued 1', async () => {
  const now = await room();
  const { peer } = await hostHosting(['src/main.rs', 'README.md']);

  const out = peer.takeOutbound();
  assert.equal(out.length, 2, '§7.1: a state at mint, then §13.1 step 6\u2019s SyncStep1');
  const frame = await opened(out[0] as Uint8Array);
  assert.equal(frame.kind, 1);
  assert.deepEqual(frame.payload, {
    issued: 1,
    listing: ['README.md', 'src/main.rs'],
    peers: {
      [encodeKey(now.ours.public)]: { peer_id: 'p-host', role: 'host' },
    },
  });
  assert.equal(peer.publishedCount, 1);
  // §7.1: exactly one key has role `host`, and it is this connection's session key.
  assert.equal(peer.stateHeld(), true, 'the state the host wrote is the state it holds');
  assert.deepEqual(peer.listing, ['README.md', 'src/main.rs']);
  assert.equal(peer.issued, 1);
});

test('the state is signed by the host key, and a reader holding the fragment applies it', async () => {
  const now = await room();
  const { peer } = await hostHosting(['README.md']);
  const bytes = peer.takeOutbound()[0] as Uint8Array;
  const frame = await opened(bytes);
  // The key id is the host key's, which is what makes the frame a state rather than a peer's.
  const fromHost = await nodeCrypto.sha256(now.host.public);
  assert.deepEqual([...frame.envelope.keyId], [...fromHost.slice(0, 8)]);
  // A reader that holds the invite's fragment applies it, which is the whole of the join path.
  const other = await reader();
  const verdict = await other.read(bytes);
  assert.equal(verdict.ok, true);
  assert.deepEqual(other.listing, ['README.md']);
  assert.equal(other.issued, 1);
  assert.equal(other.roleOfKey(now.ours.public), 'host');
});

/** A receiver holding only the fragment's two keys, which is every joiner before a state. */
async function reader(): Promise<Reader> {
  const now = await room();
  const made = await Reader.create({
    roomId: ROOM,
    roomKey: now.roomKey,
    hostKey: now.host.public,
    crypto: nodeCrypto,
  });
  assert.ok(made !== undefined);
  return made;
}

test('the canonical bytes of a state are §2.1 order, whatever order the members are built in', async () => {
  const now = await room();
  const { peer } = await hostHosting(['README.md']);
  peer.seatJoined(0, 'p-alice');
  await peer.tick(0);
  await peer.deliver(0, await announce(now.peer, 1, 'guest'));
  await peer.tick(0);
  const frames = peer.takeOutbound();
  const last = frames[frames.length - 1] as Uint8Array;
  const { text } = await opened(last);
  // The two keys' spellings are fixed by the seeds above, so the whole plaintext is pinnable.
  // §2.1 orders members by Unicode code point, which puts `Z` (U+005A) before `b` (U+0062).
  assert.equal(encodeKey(now.ours.public), 'bnoc3Smwt4_ROvTFWY_v9O8qlxZuPKby5Pv8zYBQW_E');
  assert.equal(
    text,
    '{"issued":2,"listing":["README.md"],"peers":{' +
      '"Zr5-Myx6RTMyvZ0Kf32wVfXF7xoGraZtmLOftoEMRzo":{"peer_id":"p-alice","role":"guest"},' +
      '"bnoc3Smwt4_ROvTFWY_v9O8qlxZuPKby5Pv8zYBQW_E":{"peer_id":"p-host","role":"host"}}}',
    'members ascending by name, no whitespace, `peer_id` before `role`',
  );
});

test('a path §5 refuses, and one over the bound, are dropped rather than written', async () => {
  const listing = ['b/ok.md', '', 'a\u0000b', 'b/ok.md', 'x'.repeat(MAX_PATH_BYTES + 1)];
  const { peer } = await hostHosting(listing);
  const frame = await opened(peer.takeOutbound()[0] as Uint8Array);
  assert.deepEqual((frame.payload as { listing: string[] }).listing, ['b/ok.md']);
  assert.deepEqual(peer.listing, ['b/ok.md'], '§13.3 drops the path and applies the rest');
});

// --- CANONICAL.md §6.1, the frame budget ------------------------------------------

test('a host that reaches the frame budget publishes its closing and ends', async () => {
  const now = await room();
  const { peer } = await hostHosting(['README.md'], { frameBudget: 3 });
  assert.equal(peer.takeOutbound().length, 2, 'the mint state and its handshake are counted');
  await peer.deliver(1, await announce(now.peer, 1, 'guest'));
  await peer.tick(2);
  const out = peer.takeOutbound();
  assert.equal(out.length, 1, 'one frame past the budget, and it is the closing');
  const frame = await opened(out[0] as Uint8Array);
  assert.equal(frame.envelope.kind, 2);
  assert.equal(peer.end, 'frame-budget');
});

test('a host continues the frame count it saved, and ends at the budget from there', async () => {
  const now = await room();
  const store = new MemoryStore();
  store.saved = { hostSeed: Uint8Array.from(now.host.seed), issued: 5, frames: 10 };
  // CANONICAL.md §6.1: the host's count is the room's, so a reload continues it rather than
  // starting at 0. The mint state and its handshake take it to the budget of 12.
  const { peer } = await hostHosting(['README.md'], { frameBudget: 12 }, store);
  assert.equal(peer.takeOutbound().length, 2);
  await peer.tick(1);
  assert.equal(peer.end, 'frame-budget', 'from the saved count, not from zero');
});

test('a host writes its moving frame count at least once a renewal interval', async () => {
  const now = await room();
  const store = new MemoryStore();
  const { peer } = await hostHosting(['README.md'], {}, store);
  peer.takeOutbound();
  // The mint state's own write opened the window at 0, so the count it could not yet carry — the
  // state and its handshake — is written on the first tick a window later.
  await peer.tick(RENEW_MS);
  assert.equal(store.saved?.frames, 2, 'the mint state and its handshake, written on the tick');
  await peer.deliver(RENEW_MS + 1, await announce(now.peer, 1, 'guest'));
  await peer.tick(3 * RENEW_MS);
  assert.ok((store.saved?.frames ?? 0) >= 3, 'the delivered announcement is in the saved count');
  assert.equal(store.saved?.issued, peer.issued, 'written beside `issued`');
});

test('a state published after a flush counts as a write for the renewal window', async () => {
  const store = new MemoryStore();
  let saves = 0;
  const save = store.save.bind(store);
  store.save = (persisted: PersistedHost): void => {
    saves += 1;
    save(persisted);
  };
  const now = await room();
  const { peer } = await hostHosting(['README.md'], {}, store);
  peer.takeOutbound();
  await peer.tick(RENEW_MS);
  // An announcement commits a key, so the host publishes a fresh state, and that write carries
  // the count at its own clock: a frame that moves the count right after it waits for the next
  // window rather than being written on the next tick.
  await peer.seatJoined(2 * RENEW_MS, 'p-alice');
  await peer.deliver(2 * RENEW_MS, await announce(now.peer, 1, 'guest'));
  const afterState = saves;
  await peer.deliver(2 * RENEW_MS + 1, new Uint8Array([1, 2, 3]));
  await peer.tick(2 * RENEW_MS + 2);
  assert.equal(saves, afterState, 'no frame-only write inside the window the state opened');
  await peer.tick(3 * RENEW_MS);
  assert.equal(saves, afterState + 1, 'and one once it has passed');
});

test('a host that closes its room saves the count with the closing in it', async () => {
  const store = new MemoryStore();
  const { peer } = await hostHosting(['README.md'], {}, store);
  peer.takeOutbound();
  assert.equal(await peer.closeRoom(), true);
  // The mint state, its handshake and the closing: a reload continues from the frame that ended
  // the room, with no tick left to write it on.
  assert.equal(store.saved?.frames, 3);
});

test('a host that reaches the frame budget saves the count with its closing in it', async () => {
  const store = new MemoryStore();
  const { peer } = await hostHosting(['README.md'], { frameBudget: 2 }, store);
  peer.takeOutbound();
  await peer.tick(1);
  assert.equal(peer.end, 'frame-budget');
  assert.equal(store.saved?.frames, 3, 'the budget, and the closing sealed at it');
});

test('a host store written before the frame count existed still loads', async () => {
  const now = await room();
  const store = new MemoryStore();
  store.saved = { hostSeed: Uint8Array.from(now.host.seed), issued: 3 };
  const { peer } = await hostHosting(['README.md'], {}, store);
  assert.equal(peer.issued, 4, 'the `issued` series continues');
  await peer.tick(RENEW_MS);
  assert.equal(store.saved?.frames, 2, 'and the count starts where a mint would');
});

// --- the roster -------------------------------------------------------------------

test('a peer.joined and a peer.left each publish, and a departed seat leaves the statement', async () => {
  const now = await room();
  const { peer } = await hostHosting(['README.md']);
  peer.takeOutbound();

  await peer.seatJoined(10, 'p-alice');
  assert.equal(peer.publishedCount, 2, '§7.1: a state on every peer.joined');

  await peer.deliver(20, await announce(now.peer, 1, 'guest'));
  await peer.tick(20);
  const before = published(peer).at(-1);
  assert.deepEqual(before?.peers[encodeKey(now.peer.public)], {
    peer_id: 'p-alice',
    role: 'guest',
  });

  await peer.seatLeft(30, 'p-alice');
  const after = published(peer).at(-1);
  assert.equal(
    after?.peers[encodeKey(now.peer.public)],
    undefined,
    '§7.1: a key whose entry labels a seat the roster no longer has is dropped',
  );
  assert.ok(after?.fresh, 'and that is a new edition rather than a re-send');
});

// --- the announcements ------------------------------------------------------------

test('an accepted announcement is committed with the role it declared and a seat the roster names', async () => {
  const now = await room();
  const { peer } = await hostHosting(['README.md']);
  peer.takeOutbound();
  await peer.seatJoined(10, 'p-alice');

  await peer.deliver(20, await announce(now.peer, 1, 'viewer'));
  await peer.tick(20);
  const last = published(peer).at(-1);
  assert.deepEqual(
    last?.peers[encodeKey(now.peer.public)],
    { peer_id: 'p-alice', role: 'viewer' },
    '§7.1: a declaration is honoured when the key is first committed',
  );
});

test('a commitment is never withheld for want of a label', async () => {
  const now = await room();
  const { peer } = await hostHosting(['README.md']);
  peer.takeOutbound();

  // No `peer.joined` has named a seat for this key at all: §7.1 still requires the commitment,
  // and the label it believes is the only free seat the roster has — the host's own.
  await peer.deliver(20, await announce(now.peer, 1));
  await peer.tick(20);
  const last = published(peer).at(-1);
  assert.deepEqual(last?.peers[encodeKey(now.peer.public)], {
    peer_id: 'p-host',
    role: 'guest',
  });
});

test('two keys that both arrive before any seat does are both committed', async () => {
  const now = await room();
  const { peer } = await hostHosting(['README.md']);
  peer.takeOutbound();

  // The roster names no seat for either key, so §7.1's label falls back to the host's own for
  // both. The commitment is what a peer cannot do without, so neither one may evict the other:
  // the label gives way and the two keys share a seat, which is the conflict `label()` records.
  const second = (await mintSessionKey(nodeCrypto, new Uint8Array(32).fill(23))) as SessionKeypair;
  await peer.deliver(10, await announce(now.peer, 1, 'guest'));
  await peer.tick(10);
  await peer.deliver(400, await announce(second, 1, 'guest'));
  await peer.tick(400);
  const last = published(peer).at(-1);
  assert.deepEqual(last?.peers[encodeKey(now.peer.public)], {
    peer_id: 'p-host',
    role: 'guest',
  });
  assert.deepEqual(last?.peers[encodeKey(second.public)], {
    peer_id: 'p-host',
    role: 'guest',
  });
});

test('a declaration changes nothing for a key the state already commits', async () => {
  const now = await room();
  const { peer } = await hostHosting(['README.md']);
  peer.takeOutbound();
  await peer.seatJoined(10, 'p-alice');

  await peer.deliver(20, await announce(now.peer, 1, 'guest'));
  await peer.tick(20);
  await peer.deliver(400, await announce(now.peer, 2, 'viewer'));
  await peer.tick(400);
  const last = published(peer).at(-1);
  assert.deepEqual(
    last?.peers[encodeKey(now.peer.public)],
    { peer_id: 'p-alice', role: 'guest' },
    '§7.1: the role in the state is the room’s, and a later declaration does not re-role it',
  );
});

/** How many entries of a published state's `peers` label one seat. */
function seatedUnder(peers: Record<string, { peer_id: string; role: string }>, seat: string): number {
  return Object.values(peers).filter((entry) => entry.peer_id === seat).length;
}

test('a second key for a seat replaces the key it held there', async () => {
  const now = await room();
  const { peer } = await hostHosting(['README.md']);
  peer.takeOutbound();
  await peer.seatJoined(10, 'p-alice');
  await peer.deliver(20, await announce(now.peer, 1, 'guest'));
  await peer.tick(20);
  const before = published(peer).at(-1);
  assert.equal(seatedUnder(before?.peers ?? {}, 'p-alice'), 1);

  // Every seat the roster names already carries a key, so §7.1's *at most one key per seat*
  // forces the replacement: the new key takes the seat the host has held longest.
  const second = (await mintSessionKey(nodeCrypto, new Uint8Array(32).fill(31))) as SessionKeypair;
  await peer.deliver(400, await announce(second, 1, 'guest'));
  await peer.tick(400);
  const after = published(peer).at(-1);
  assert.equal(seatedUnder(after?.peers ?? {}, 'p-alice'), 1, '§7.1: at most one key per seat');
  assert.deepEqual(after?.peers[encodeKey(second.public)], {
    peer_id: 'p-alice',
    role: 'guest',
  });
  assert.equal(
    after?.peers[encodeKey(now.peer.public)],
    undefined,
    'the replaced key is dropped from the state',
  );

  // §13.3: a state that replaces a key revokes what the earlier one granted, so the replaced
  // key's content is refused from that state on.
  const stale = await contentFrame(now.peer, 9, 'README.md', 'gone');
  assert.equal((await peer.deliver(500, stale)).status, 'dropped');
  assert.equal(peer.droppedFrames.at(-1)?.reason, 'uncommitted_key');
});

test('`duplicate-seat` is what makes one key per seat a rule rather than a description', async () => {
  const now = await room();
  const { peer } = await hostHosting(['README.md']);
  peer.mutate('duplicate-seat');
  peer.takeOutbound();
  await peer.seatJoined(10, 'p-alice');
  await peer.deliver(20, await announce(now.peer, 1, 'guest'));
  await peer.tick(20);
  const second = (await mintSessionKey(nodeCrypto, new Uint8Array(32).fill(31))) as SessionKeypair;
  await peer.deliver(400, await announce(second, 1, 'guest'));
  await peer.tick(400);
  const last = published(peer).at(-1);
  assert.equal(
    seatedUnder(last?.peers ?? {}, 'p-alice'),
    2,
    'mutated: two keys are committed under one seat, which §7.1 forbids',
  );
});

test('an announcement for a key the state already commits publishes no new edition', async () => {
  const now = await room();
  const { peer } = await hostHosting(['README.md']);
  peer.takeOutbound();
  await peer.seatJoined(10, 'p-alice');
  await peer.deliver(20, await announce(now.peer, 1, 'guest'));
  await peer.tick(20);
  const first = published(peer).at(-1);
  const out = peer.takeOutbound();
  const firstBytes = out[out.length - 1] as Uint8Array;

  // The same key announces again — the reading a re-announcement has is that its sender has
  // not applied the state that commits its key, and §7.1 has the host answer with that state.
  await peer.deliver(400, await announce(now.peer, 2));
  await peer.tick(400);
  const resent = peer.takeOutbound();
  assert.equal(resent.length, 1, '§7.1: the host answers it');
  assert.deepEqual([...(resent[0] as Uint8Array)], [...firstBytes], 're-sent unchanged');
  const last = published(peer).at(-1);
  assert.equal(last?.fresh, false);
  assert.equal(last?.issued, first?.issued, 'and it publishes nothing new');
});

test('a peer minting keys without bound obliges one state a window, not one a frame', async () => {
  const { peer } = await hostHosting(['README.md']);
  peer.takeOutbound();
  for (const seat of ['p-a', 'p-b', 'p-c']) {
    await peer.seatJoined(0, seat);
  }
  peer.takeOutbound();

  const keys: SessionKeypair[] = [];
  for (const fill of [21, 22, 23]) {
    keys.push((await mintSessionKey(nodeCrypto, new Uint8Array(32).fill(fill))) as SessionKeypair);
  }
  // The first announcement of the window is answered at once — §7.1 lets a host answer a later
  // announcement immediately rather than folding it — and the rest are owed, not answered.
  await peer.deliver(0, await announce(keys[0] as SessionKeypair, 1));
  assert.equal(peer.takeOutbound().length, 1, 'the first is answered at once');
  await peer.deliver(10, await announce(keys[1] as SessionKeypair, 1));
  await peer.deliver(20, await announce(keys[2] as SessionKeypair, 1));
  assert.equal(peer.takeOutbound().length, 0, 'the rest wait for the window');

  // One state at the window's end carries every key committed by then (§7.1).
  await peer.tick(RENEW_MS);
  const out = peer.takeOutbound();
  assert.equal(out.length, 1, 'one state, not one a frame');
  const state = published(peer).at(-1);
  for (const key of keys) {
    assert.ok(state?.peers[encodeKey(key.public)] !== undefined, 'and it carries all three');
  }
  await peer.tick(RENEW_MS + 1);
  assert.equal(peer.takeOutbound().length, 0, 'and the room is quiet again');
});

// --- issued, and what survives a reload -------------------------------------------

test('the issued series continues from the store, and a foreign key starts at 1', async () => {
  const now = await room();
  const store = new MemoryStore();
  const first = await hostHosting(['README.md'], {}, store);
  first.peer.takeOutbound();
  await first.peer.seatJoined(10, 'p-alice');
  await first.peer.deliver(20, await announce(now.peer, 1));
  await first.peer.tick(20);
  assert.equal(store.saved?.issued, 2, 'the `issued` is kept beside the key (§7.1)');

  const second = await hostHosting(['README.md'], {}, store);
  const state = published(second.peer).at(-1);
  assert.equal(state?.issued, 3, '§7.1: a host that persists the key continues the series');

  const other = new MemoryStore();
  other.save({ hostSeed: new Uint8Array(32).fill(99), issued: 41 });
  const third = await hostHosting(['README.md'], {}, other);
  assert.equal(
    published(third.peer).at(-1)?.issued,
    1,
    'a series that belongs to another key is not this host’s to continue',
  );
});

test('a returning host publishes its own new key and replaces the entry it held before', async () => {
  const store = new MemoryStore();
  const before = await hostHosting(['README.md'], {}, store);
  const minted = published(before.peer).at(-1);
  assert.equal(Object.values(minted?.peers ?? {})[0]?.role, 'host');

  // §9.1: a rejoin is a new peer, so the state a returning host publishes carries the new
  // connection's key in its own entry — the whole of what a resume is in this version.
  const returning = (await mintSessionKey(nodeCrypto, new Uint8Array(32).fill(17))) as SessionKeypair;
  const after = await hostHosting(['README.md'], { sessionSeed: returning.seed }, store);
  const state = published(after.peer).at(-1);
  assert.deepEqual(
    Object.keys(state?.peers ?? {}),
    [encodeKey(returning.public)],
    'the returning connection’s new key is the room’s only one',
  );
  assert.equal(state?.peers[encodeKey(returning.public)]?.role, 'host');
  assert.ok(
    (state?.issued ?? 0) > (minted?.issued ?? 0),
    '§7.1: its state is above every state it has published',
  );
});

test('a host that verifies a state above its own writes above that one instead', async () => {
  const now = await room();
  const { peer } = await hostHosting(['README.md']);
  peer.takeOutbound();
  // §9.1: a returning host that lost its series learns the room's edition from a re-sent state.
  await peer.deliver(10, await state(now.host, 5, [[now.peer, 'guest', 'p-alice']]));
  await peer.tick(10);
  assert.equal(peer.issued, 5, 'the re-sent state is what the host now holds');
  assert.equal(published(peer).at(-1)?.issued, 1, 'and nothing goes out until something changes');

  // §7.1: what it writes next is above the edition it verified. The state it published itself is
  // not re-sent over that edition — a frame at 1 is one every peer refuses `stale_issued`, and
  // the fresh state above it is what a joiner needs from a host.
  await peer.seatJoined(20, 'p-bob');
  assert.equal(published(peer).at(-1)?.issued, 6, 'above the edition it verified');
  assert.ok(published(peer).at(-1)?.fresh, 'and a new edition rather than a re-send');

  await peer.deliver(20, await announce(now.peer, 1, 'guest'));
  assert.equal(
    published(peer).at(-1)?.issued,
    7,
    '§7.1: and every state after it is above that one again',
  );
});

// --- the closing ------------------------------------------------------------------

test('a closing is above every state, and the host publishes nothing after it', async () => {
  const { peer } = await hostHosting(['README.md']);
  peer.takeOutbound();
  await peer.seatJoined(10, 'p-alice');
  peer.takeOutbound();

  assert.equal(await peer.closeRoom(), true);
  const frame = await opened(peer.takeOutbound()[0] as Uint8Array);
  assert.equal(frame.kind, 2);
  assert.deepEqual(frame.payload, { closing: true, issued: 2 });
  assert.deepEqual([...peer.hostClosings()], [2]);
  assert.equal(peer.end, 'closing', '§13.10: the room is over for the session that ended it');

  // §7.1: a host that has left publishes nothing, and one that has closed a room stays closed
  // through a rejoin of its own seat — the state that follows would be an edition above the
  // closing, and §13.10's ordering has nothing to put it back in front of.
  await peer.seatJoined(15, 'p-host');
  assert.equal(peer.takeOutbound().length, 0, 'not even for its own seat');
  await peer.seatJoined(20, 'p-bob');
  assert.equal(peer.takeOutbound().length, 0);
  await peer.listingChanged(30);
  assert.equal(peer.takeOutbound().length, 0);
  await peer.insert('README.md', 0, 'text after the closing');
  assert.equal(peer.takeOutbound().length, 0, 'and no content either');
});

// --- the host as a peer -----------------------------------------------------------

test('a host applies the content of a key it has committed, and refused it before that', async () => {
  const now = await room();
  const { peer } = await hostHosting(['README.md']);
  peer.takeOutbound();

  const content = await contentFrame(now.peer, 2, 'README.md', 'hello');
  assert.equal(
    (await peer.deliver(5, content)).status,
    'dropped',
    '§13.3: no applied state commits this key, so its content is uncommitted',
  );

  await peer.deliver(10, await announce(now.peer, 1, 'guest'));
  await peer.tick(10);
  peer.takeOutbound();
  assert.equal((await peer.deliver(20, content)).status, 'applied');
  assert.equal(peer.text('README.md'), 'hello');
});

test('a host with no seat is refused where it is built, because its own entry needs one', async () => {
  const now = await room();
  const made = await PeerSession.create({
    roomId: ROOM,
    roomKey: now.roomKey,
    hostKey: now.host.public,
    keepalive: {
      ping_interval_ms: 30_000,
      awareness_renew_ms: RENEW_MS,
      awareness_expire_ms: EXPIRE_MS,
    },
    crypto: nodeCrypto,
    sessionSeed: now.ours.seed,
    host: { hostSeed: now.host.seed, listing: () => ['README.md'] },
  });
  assert.equal(made, undefined);
});
test('a host whose mint state cannot be sealed is not handed back', async () => {
  const now = await room();
  const blind = {
    ...nodeCrypto,
    randomBytes: (): Uint8Array => {
      throw new Error('no entropy');
    },
  };
  const made = await PeerSession.create({
    roomId: ROOM,
    roomKey: now.roomKey,
    hostKey: now.host.public,
    keepalive: {
      ping_interval_ms: 30_000,
      awareness_renew_ms: RENEW_MS,
      awareness_expire_ms: EXPIRE_MS,
    },
    crypto: blind,
    seat: 'p-host',
    sessionSeed: now.ours.seed,
    host: { hostSeed: now.host.seed, listing: () => ['README.md'] },
  });
  // §7.1's first state is what brings the room's listing into existence and commits this
  // connection's key. A host that could not seal one has nothing a peer can verify against,
  // and a session nobody can see is not a session to hand back.
  assert.equal(made, undefined);
});

test('a host is seated in the roster it was handed, so its own state does not end it', async () => {
  // The roster `room.joined` carries need not name the host itself, and the state this host
  // publishes names its own seat either way: §13.8's clock must not arm on it for that reason.
  const { peer } = await hostHosting(['README.md'], { roster: ['p-guest'] });
  peer.takeOutbound();
  await peer.tick(EXPIRE_MS);
  assert.equal(peer.end, undefined, 'the host’s own `host` entry labels a seat the room has');
  assert.equal(peer.failure, undefined);
});

test('a listing change publishes the whole tree, and a shorter one is a smaller room', async () => {
  const { peer, listing } = await hostHosting(['README.md', 'src/main.rs']);
  peer.takeOutbound();
  listing.push('src/lib.rs');
  await peer.listingChanged(10);
  assert.deepEqual(peer.listing, ['README.md', 'src/lib.rs', 'src/main.rs']);
  listing.splice(0, 2);
  await peer.listingChanged(20);
  assert.deepEqual(peer.listing, ['src/lib.rs'], '§13.3: replaced wholesale, never merged');
  assert.equal(peer.publishedCount, 3);
});

// --- the guards a corpus mutation removes -----------------------------------------

test('every host rule a mutation names is one this producer removes', async () => {
  const { peer } = await hostHosting(['README.md']);
  for (const name of HOST_MUTATIONS) {
    peer.mutate(name);
    assert.equal(peer.mutationName, name, `the subject can remove ${name}`);
  }
  assert.throws(() => {
    peer.mutate('no-such-rule');
  });
});

test('the two sharpest rules are what the clean behaviour rests on', async () => {
  const now = await room();
  // `frozen-issued`: §7.1's series does not advance, so the second state reuses the first
  // edition and every peer refuses it `stale_issued`.
  const frozen = await hostHosting(['README.md']);
  frozen.peer.mutate('frozen-issued');
  frozen.peer.takeOutbound();
  await frozen.peer.seatJoined(10, 'p-alice');
  assert.equal(published(frozen.peer).at(-1)?.issued, 1, 'mutated: the edition does not advance');

  // `withhold-commitment`: the announcement is accepted and nothing is written for it.
  const withholding = await hostHosting(['README.md']);
  withholding.peer.mutate('withhold-commitment');
  withholding.peer.takeOutbound();
  await withholding.peer.deliver(10, await announce(now.peer, 1));
  await withholding.peer.tick(10);
  const state = published(withholding.peer).at(-1);
  assert.equal(
    state?.peers[encodeKey(now.peer.public)],
    undefined,
    'mutated: the key is not committed, and §13.1 leaves its holder unable to publish',
  );
});

/** A `kind = 0` frame carrying a real update, which is document content. */
async function contentFrame(
  signer: SessionKeypair,
  counter: number,
  path: string,
  text: string,
): Promise<Uint8Array> {
  const now = await room();
  const scratch = new Y.Doc();
  scratch.getText(path).insert(0, text);
  const bytes = await seal(
    nodeCrypto,
    {
      roomId: ROOM,
      frameKey: now.frameKey,
      kind: 0,
      epoch: 0,
      counter,
      nonce: new Uint8Array(12).fill(counter),
      signer,
    },
    encodeUpdate(Y.encodeStateAsUpdate(scratch)),
  );
  assert.ok(bytes !== undefined);
  return bytes;
}
