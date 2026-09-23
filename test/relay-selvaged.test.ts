/**
 * The `selvage/2` relay against the real `selvaged`, run with `--serve-version-2`: two relays,
 * one room, a host and a guest, exchanging an edit through a server that never sees a file name
 * or a byte of either replica. This is the proof the version's two halves (`§7.1` and `§13`) can
 * be handed a socket and a room and come out the other side agreeing, which is the wiring the
 * engine was written without.
 *
 * It needs a built sibling `selvaged` (see `test/helpers/selvaged.ts`), so it is not part of the
 * server-free suite. Run it with `npm run test:relay-selvaged`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseInvite } from '../src/engine/peer.ts';
import { RelaySession } from '../src/engine/relay.ts';
import { RealServer } from './helpers/selvaged.ts';
import { waitFor } from './helpers/wait.ts';

const PATH = 'notes.txt';
const SEED = 'a room two relays share\n';

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
  const server = await RealServer.start({ serveVersion2: true });
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
  assert.equal(guest.isHost, false);
  assert.equal(host.isHost, true);
  assert.equal(host.sessionInfo().roomId, guest.sessionInfo().roomId);
});

test('selvage/2: an edit crosses a real server in both directions', async (t) => {
  const server = await RealServer.start({ serveVersion2: true });
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
  const server = await RealServer.start({ serveVersion2: true });
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
  const server = await RealServer.start({ serveVersion2: true });
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
  const server = await RealServer.start({ serveVersion2: true });
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

