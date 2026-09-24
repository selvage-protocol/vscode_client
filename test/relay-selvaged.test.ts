/**
 * The `selvage/2` relay against a real `selvaged` on its defaults, which seat both versions: two
 * relays, one room, a host and a guest, exchanging an edit through a server that never sees a file
 * name or a byte of either replica. This is the proof the version's two halves (`§7.1` and `§13`)
 * can be handed a socket and a room and come out the other side agreeing, which is the wiring the
 * engine was written without.
 *
 * It needs a built sibling `selvaged` (see `test/helpers/selvaged.ts`), so it is not part of the
 * server-free suite. Run it with `npm run test:relay-selvaged`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { SessionBridge } from '../src/bridge/bridge.ts';
import { PeerEngine } from '../src/bridge/peer-engine.ts';
import { parseInvite } from '../src/engine/peer.ts';
import { RelaySession } from '../src/engine/relay.ts';
import type { RelayEvent } from '../src/engine/relay.ts';

import { FakeEditor } from './helpers/fake-editor.ts';
import { RealServer } from './helpers/selvaged.ts';
import { waitFor } from './helpers/wait.ts';

const PATH = 'notes.txt';
const OTHER = 'src/main.rs';
const SEED = 'a room two relays share\n';
const DISK = 'the working copy the host reads for it\n';

/** A host and a guest, and the invite between them, seated over the real server. */
async function pair(server: RealServer): Promise<{ host: RelaySession; guest: RelaySession }> {
  // A shorter renewal interval than the server advertises, so the session's own clocks run
  // during a test: §13.7's holds are published on the tick that changes them.
  const keepalive = { awareness_renew_ms: 50, awareness_expire_ms: 5000 };
  const host = await RelaySession.host({
    baseUrl: server.wsBase,
    displayName: 'Ada',
    listing: () => [PATH],
    keepalive,
  });
  const invite = host.invite();
  assert.ok(invite !== undefined, 'the host is handed a link to send');
  const guest = await RelaySession.join({ invite, displayName: 'Bob', keepalive });
  return { host, guest };
}

test('selvage/2: a host mints, a guest joins, and the listing arrives', async (t) => {
  const server = await RealServer.start();
  t.after(async () => {
    await server.stop();
  });
  const host = await RelaySession.host({
    baseUrl: server.wsBase,
    displayName: 'Ada',
    listing: () => [PATH, 'src/main.rs'],
  });
  t.after(() => {
    host.disconnect();
  });
  // The host's own state is applied to its receiver at mint, so the listing it published is the
  // listing it holds.
  assert.deepEqual([...host.listing()], [PATH, 'src/main.rs']);

  const invite = host.invite();
  assert.ok(invite !== undefined);
  // The fragment is §5.1's, in its order, and the connection URL has none.
  assert.match(invite, /#k=[A-Za-z0-9_-]{43}&h=[A-Za-z0-9_-]{43}$/);
  const read = parseInvite(invite);
  assert.equal(read.ok, true);
  assert.ok(read.ok && !read.invite.socketUrl.includes('#'));

  const guest = await RelaySession.join({ invite, displayName: 'Bob' });
  t.after(() => {
    guest.disconnect();
  });
  const listed = await waitFor('the guest to apply the host\'s state', () => {
    const listing = [...guest.listing()];
    return listing.length > 0 ? listing : false;
  });
  assert.deepEqual(listed, [PATH, 'src/main.rs']);
  // §13.4: the guest's seat reaches the host as a `peer.joined`, and the role it is drawn with
  // is the one the applied state gives that seat rather than anything the event claimed.
  const seen = await waitFor('the host to see the guest in the room', () => {
    const peer = host.peerInfos().find((entry) => entry.peer_id === guest.sessionInfo().seat);
    return peer === undefined ? false : peer;
  });
  assert.equal(seen.display_name, 'Bob');
  assert.equal(seen.awareness_client_id, guest.awarenessClientId());
  assert.equal(guest.isHost, false);
  assert.equal(host.isHost, true);
  assert.equal(host.sessionInfo().roomId, guest.sessionInfo().roomId);
});

test("selvage/2: a peer's hold is reported as the room's open set", async (t) => {
  const server = await RealServer.start();
  t.after(async () => {
    await server.stop();
  });
  const { host, guest } = await pair(server);
  t.after(() => {
    host.disconnect();
    guest.disconnect();
  });
  const events: RelayEvent[] = [];
  host.on((event) => {
    events.push(event);
  });
  // §13.1's step 4: nothing the guest holds counts until a state commits its key.
  await waitFor("the host's state to commit the guest's key", () => guest.appliedRole() ?? false, {
    timeoutMs: 15_000,
    describe: () => guest.sessionInfo().peers,
  });
  guest.open(PATH);
  assert.deepEqual(guest.heldPaths(), [PATH], 'the hold was not taken');

  // The host's replica holds no text for the path — a hold is the only thing that names it —
  // so this is the change the room's open set has to be reported from, and what a host reads
  // its own working copy for. §13.7's holds replace version 1's `doc.opened` set.
  const reported = await waitFor(
    "the host's relay to report the room's open set",
    () => {
      for (const event of events) {
        if (event.type === 'content' && event.documents.includes(PATH)) {
          return event.documents;
        }
      }
      return false;
    },
    { describe: () => events.map((event) => event.type) },
  );
  assert.deepEqual(reported, [PATH]);
  assert.deepEqual(host.documents(), [], 'the replica holds no text for the path');
});

test('selvage/2: an edit crosses a real server in both directions', async (t) => {
  const server = await RealServer.start();
  t.after(async () => {
    await server.stop();
  });
  const { host, guest } = await pair(server);
  t.after(() => {
    host.disconnect();
    guest.disconnect();
  });
  host.open(PATH);
  guest.open(PATH);

  // §13.7: the hold a joiner takes is the room's, and the host sees the guest held to the path.
  const holds = await waitFor('the guest\'s hold to reach the host', () => {
    for (const paths of host.peerHolds().values()) {
      if (paths.includes(PATH)) {
        return paths;
      }
    }
    return false;
  });
  assert.ok(holds.includes(PATH));

  const seeded = await host.insert(PATH, 0, SEED);
  assert.equal(seeded, true, 'the host publishes its own edit');
  const arrived = await waitFor('the seeded text to reach the guest', () => {
    const text = guest.text(PATH);
    return text === SEED ? text : false;
  });
  assert.equal(arrived, SEED);

  // The guest only publishes once a state commits its key, which the host's answer to its
  // announcement is. The insert returning `true` is the room having accepted it.
  const guestEdit = await waitFor('the guest to be able to publish', async () => {
    const published = await guest.insert(PATH, 0, 'guest: ');
    return published ? true : false;
  });
  assert.equal(guestEdit, true);
  const backAtHost = await waitFor('the guest\'s edit to reach the host', () => {
    const text = host.text(PATH);
    return text === `guest: ${SEED}` ? text : false;
  });
  assert.equal(backAtHost, `guest: ${SEED}`);
});

test('selvage/2: the host\'s closing ends the guest, in §13.10\'s words', async (t) => {
  const server = await RealServer.start();
  t.after(async () => {
    await server.stop();
  });
  const { host, guest } = await pair(server);
  t.after(() => {
    host.disconnect();
    guest.disconnect();
  });
  // The guest holds a verified state, so the closing applies rather than being ignored.
  await waitFor('the guest to hold the listing', () => guest.listing().length > 0);
  assert.equal(await host.closeRoom(), true);
  const ended = await waitFor('the guest to hear the closing', () => guest.end);
  assert.equal(ended, 'closing');
  assert.equal(guest.endingSentence(), 'the room closed');
});

test('selvage/2: the host key and its issued series are saved on every state', async (t) => {
  const server = await RealServer.start();
  t.after(async () => {
    await server.stop();
  });
  // §7.1's store: the host key and the highest `issued` it published, which is what a reload
  // continues from. The adapter's is VS Code's state; here it is a box that records the writes.
  let saved: { hostSeed: Uint8Array; issued: number } | undefined;
  const store = {
    load: () => saved,
    save: (persisted: { hostSeed: Uint8Array; issued: number }) => {
      saved = persisted;
    },
  };
  const paths = [PATH];
  const host = await RelaySession.host({
    baseUrl: server.wsBase,
    displayName: 'Ada',
    listing: () => paths,
    store,
  });
  t.after(() => {
    host.disconnect();
  });
  assert.ok(saved !== undefined, 'the mint state is saved with the key that signed it');
  const minted = saved.issued;
  assert.ok(minted >= 1, `issued starts at 1, and the mint saved ${minted}`);
  paths.push('second.txt');
  await host.listingChanged();
  assert.ok(saved.issued > minted, 'a new edition moves the saved series');
  assert.equal(saved.hostSeed.length, 32);
});

test('selvage/2: the page-link form joins the same room', async (t) => {
  const server = await RealServer.start();
  t.after(async () => {
    await server.stop();
  });
  const host = await RelaySession.host({
    baseUrl: server.wsBase,
    displayName: 'Ada',
    listing: () => [PATH],
  });
  t.after(() => {
    host.disconnect();
  });
  const wire = host.invite();
  assert.ok(wire !== undefined);
  // §5.1's second form: the same room, token and fragment over the scheme a browser speaks. The
  // fragment must survive the round trip to the connection URL the relay dials.
  const page = wire.replace('ws://', 'http://').replace('/session?', '/?');
  const guest = await RelaySession.join({ invite: page, displayName: 'Bob' });
  t.after(() => {
    guest.disconnect();
  });
  const listed = await waitFor('the guest joining by page link to apply the state', () => {
    const listing = [...guest.listing()];
    return listing.length > 0 ? listing : false;
  });
  assert.deepEqual(listed, [PATH]);
});

test('selvage/2: the engine facade hosts, joins, grants and exchanges an edit', async (t) => {
  const server = await RealServer.start();
  t.after(async () => {
    await server.stop();
  });
  // The listing an adapter owns: a state is sealed from it, so replacing it and publishing are
  // one step and the room cannot hear the tree it used to be.
  const tree = [PATH];
  const listing = {
    current: () => tree,
    replace: (paths: readonly string[]) => {
      tree.length = 0;
      tree.push(...paths);
    },
  };
  const keepalive = { awareness_renew_ms: 50, awareness_expire_ms: 5000 };
  const host = await PeerEngine.host({
    baseUrl: server.wsBase,
    displayName: 'Ada',
    listing,
    keepalive,
  });
  t.after(() => {
    host.disconnect();
  });
  assert.deepEqual(host.session().documents.sort(), [], 'nothing is open yet');
  assert.equal(host.session().role, 'host');

  const invite = host.inviteUrl();
  assert.ok(invite !== undefined && invite.includes('#k='));
  const guest = await PeerEngine.join({ invite, displayName: 'Bob', keepalive });
  t.after(() => {
    guest.disconnect();
  });
  const listed = await waitFor('the guest to apply the host\'s listing', () => {
    const paths = [...guest.grantedPaths()];
    return paths.length > 0 ? paths : false;
  });
  assert.deepEqual(listed, [PATH]);
  assert.equal(guest.session().role, 'guest');

  // The open set is §13.7's: a path someone holds, which is what the adapter's words are about.
  await guest.open(PATH);
  const open = await waitFor('the guest\'s hold to reach the room', () => {
    const documents = host.session().documents;
    return documents.includes(PATH) ? documents : false;
  });
  assert.ok(open.includes(PATH));

  const seeded = host.insert(PATH, 0, SEED);
  assert.equal(seeded, undefined, 'a local edit is applied and published without being awaited');
  const arrived = await waitFor('the seeded text to reach the guest', () => {
    const text = guest.text(PATH);
    return text === SEED ? text : false;
  });
  assert.equal(arrived, SEED);

  // A new edition of the listing: the facade's grant is the room's whole tree.
  await host.grant([PATH, OTHER]);
  const regranted = await waitFor('the guest to hold the new listing', () => {
    const paths = [...guest.grantedPaths()];
    return paths.length === 2 ? paths : false;
  });
  assert.deepEqual(regranted, [PATH, OTHER].sort());

  // §8: a caret is published and read back, and the two ids agree because the handshake said so.
  guest.setSelection(PATH, { anchor: 0, head: 3 });
  const seen = await waitFor('the host to see the guest\'s caret', () => {
    const record = host.presence().find((entry) => entry.peer?.peer_id === guest.session().peer.peer_id);
    return record?.state?.selection !== undefined ? record : false;
  });
  assert.equal(seen.clientId, seen.peer?.awareness_client_id);
});

/**
 * Read-on-hold through a window that was already open: the shape the browser client's in-room
 * driver met, and the one path in this suite where the *host* owes a state rather than a guest.
 *
 * §7.1 folds an announcement accepted inside a window a state already went out for: the host
 * commits the key and answers at the end of that window. §13.1's step 4 lets a client send nothing
 * but its announcement until a state commits its key, so the folded guest's holds (§13.7) wait on
 * that state — and a window whose end the host's own timer misses by a whole window leaves the
 * guest unable to publish for two, which is a path the room never hears about and a file the host
 * never reads.
 *
 * The two guests differ in their renewal clock on purpose: the second one's own re-announcement is
 * ten windows away, so the state that commits its key can only be the host discharging the fold.
 * The window is compressed the way the conformance suite compresses it.
 */
test('selvage/2: a guest folded into the host\'s window is committed inside it', async (t) => {
  const WINDOW = 600;
  const server = await RealServer.start();
  t.after(async () => {
    await server.stop();
  });
  let listing: readonly string[] = [PATH, OTHER];
  const host = await PeerEngine.host({
    baseUrl: server.wsBase,
    displayName: 'Ada',
    listing: {
      current: () => listing,
      replace: (paths) => {
        listing = [...paths];
      },
    },
    keepalive: { awareness_renew_ms: WINDOW, awareness_expire_ms: 60_000 },
  });
  const editor = new FakeEditor();
  editor.disk.set(OTHER, DISK);
  const bridge = new SessionBridge({ engine: host, host: editor, autoSave: false });
  editor.attach(bridge);
  t.after(async () => {
    bridge.dispose();
    host.disconnect();
  });
  const invite = host.inviteUrl();
  assert.ok(invite !== undefined);

  // A guest whose renewal clock is far longer than the host's window: nothing it sends on its own
  // clock can commit its key, so the deadline under test is the host's alone.
  const slow = { awareness_renew_ms: WINDOW * 10, awareness_expire_ms: WINDOW * 100 };
  const first = await PeerEngine.join({ invite, displayName: 'Bob', keepalive: slow });
  t.after(() => {
    first.disconnect();
  });
  // The answered announcement that opens the window.
  await waitFor('the first guest to be committed', () => first.appliedRole() ?? false, {
    describe: () => ({ documents: first.session().documents }),
  });
  const opened = Date.now();
  await delay(Math.round(WINDOW / 4));

  const folded = await PeerEngine.join({ invite, displayName: 'Cy', keepalive: slow });
  t.after(() => {
    folded.disconnect();
  });
  await folded.open(OTHER);
  await waitFor('the folded guest to be committed', () => folded.appliedRole() ?? false, {
    timeoutMs: WINDOW * 4,
    describe: () => ({ documents: folded.session().documents, held: folded.session().documents }),
  });
  const took = Date.now() - opened;
  assert.ok(
    took <= WINDOW + Math.round(WINDOW / 2),
    `the folded guest was committed ${took}ms after the window opened, more than one ${WINDOW}ms window`,
  );

  // And the hold it could only publish once committed is what makes the host read its own copy.
  await waitFor('the host to read its working copy', () => editor.reads.includes(OTHER) || false, {
    describe: () => ({ reads: [...editor.reads], documents: host.session().documents }),
  });
  const arrived = await waitFor('the host\'s copy to reach the guest', () => {
    const text = folded.text(OTHER);
    return text === DISK ? text : false;
  });
  assert.equal(arrived, DISK);
});
