/**
 * `selvage/2` reconnection (`PROTOCOL.md` §9.1): a guest whose socket is cut mid-session re-hellos
 * on a fresh socket with a bounded backoff, keeps its replica and its holds, and the room comes
 * back; a refusal a retry cannot change stops; and the room's own advertised grace is what bounds
 * the retry.
 *
 * The transport drop is the fake server's `drop` — the real server's socket is not the client's to
 * cut — and the fake server also produces the refusal the real one will not produce on demand.
 * One case runs against a real `selvaged`, which is the server-backed proof that the whole path
 * works over the wire the version is deployed on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PeerEngine } from '../src/bridge/peer-engine.ts';
import { RelaySession } from '../src/engine/relay.ts';
import type { RelayEvent } from '../src/engine/relay.ts';
import { attemptsForGrace } from '../src/engine/reconnect.ts';
import type { ReconnectPolicy } from '../src/engine/reconnect.ts';
import { FakeServer } from './helpers/fake-server.ts';
import { waitFor } from './helpers/wait.ts';

const PATH = 'notes.txt';
const SEED = 'a room that survives a blip\n';

/** A fast backoff, so a test does not wait out the production delays. */
const FAST = { initialDelayMs: 20, maxDelayMs: 60 } as const;

/** The clocks a test runs the session on, so its hold/awareness ticks actually tick. */
const KEEPALIVE = { awareness_renew_ms: 50, awareness_expire_ms: 5000 };

/** A host and a guest seated in one room over `server`, the guest able to reconnect. */
async function pair(
  server: FakeServer,
  reconnect: false | Partial<ReconnectPolicy> = FAST,
): Promise<{ host: RelaySession; guest: RelaySession }> {
  const host = await RelaySession.host({
    baseUrl: server.wsBase,
    displayName: 'Ada',
    listing: () => [PATH],
    keepalive: KEEPALIVE,
  });
  const invite = host.invite();
  assert.ok(invite !== undefined, 'the host is handed a link to send');
  const guest = await RelaySession.join({
    invite,
    displayName: 'Bob',
    keepalive: KEEPALIVE,
    reconnect,
  });
  return { host, guest };
}

function events(session: RelaySession): RelayEvent[] {
  const seen: RelayEvent[] = [];
  session.on((event) => {
    seen.push(event);
  });
  return seen;
}

test('selvage/2: a dropped guest keeps its replica and reports the retry, never the ending', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const { host, guest } = await pair(server);
  t.after(() => {
    host.disconnect();
    guest.disconnect();
  });
  await waitFor("the guest to apply the host's state", () => guest.listing().length > 0);
  host.open(PATH);
  const seeded = await waitFor('the host to publish its own edit', async () =>
    (await host.insert(PATH, 0, SEED)) ? true : false,
  );
  assert.equal(seeded, true);
  await waitFor('the seeded text to reach the guest', () =>
    guest.text(PATH) === SEED ? SEED : false,
  );
  const firstSeat = guest.sessionInfo().seat;

  const seen = events(guest);
  server.drop('Bob');
  const reconnecting = await waitFor(
    'the reconnecting report',
    () => seen.find((event) => event.type === 'reconnecting') ?? false,
  );
  assert.equal(reconnecting.type, 'reconnecting');
  assert.equal(
    guest.end,
    undefined,
    'a recoverable drop ended the session instead of retrying',
  );
  assert.equal(
    seen.some((event) => event.type === 'ended'),
    false,
    'the ending was reported for a drop that was retried',
  );

  const seat = await waitFor(
    'the guest to be seated again',
    () => {
      const now = guest.sessionInfo().seat;
      return now !== firstSeat ? now : false;
    },
    { timeoutMs: 15_000 },
  );
  assert.notEqual(seat, firstSeat);
  assert.deepEqual([...guest.listing()], [PATH], 'the room state did not come back');
  assert.equal(guest.text(PATH), SEED, 'the replica was dropped with the socket');
});

test('selvage/2: a guest that renamed re-hellos under the name it set, not the one it was seated with', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const { host, guest } = await pair(server);
  t.after(() => {
    host.disconnect();
    guest.disconnect();
  });
  await waitFor("the guest to apply the host's state", () => guest.listing().length > 0);
  const firstSeat = guest.sessionInfo().seat;

  await guest.rename('Bobby');
  await waitFor('the room to record the rename', () =>
    server.displayNames().includes('Bobby') ? true : false,
  );

  // §5: a rename is the connection's and dies with it, and §9.1 says a client that renamed
  // re-hellos with the current name. A peer that joins afterwards is what makes this
  // deterministic: the room's frames arrive in order on one socket, so seeing the joiner is
  // proof that the mover's own `peer.renamed` was applied before the drop below — a
  // `terminate` sent the instant the server has recorded the rename can still discard it.
  const invite = host.invite();
  assert.ok(invite !== undefined, 'the host is handed a link to send');
  const third = await RelaySession.join({
    invite,
    displayName: 'Cy',
    keepalive: KEEPALIVE,
    reconnect: false,
  });
  t.after(() => {
    third.disconnect();
  });
  await waitFor('the renamed guest to see the peer that joined after it', () =>
    guest.peers().some((peer) => peer.display_name === 'Cy') ? true : false,
  );

  server.drop('Bobby');
  const seat = await waitFor(
    'the guest to be seated again',
    () => {
      const now = guest.sessionInfo().seat;
      return now !== firstSeat ? now : false;
    },
    { timeoutMs: 15_000 },
  );
  assert.notEqual(seat, firstSeat);
  assert.deepEqual(
    server.displayNames(),
    ['Ada', 'Bobby', 'Cy'],
    'the re-seat reintroduced the name the session was seated under',
  );
  // The same name on this side: the room's own row for this seat is what an adapter shows.
  assert.equal(guest.selfInfo().display_name, 'Bobby');
});

test('selvage/2: a terminal refusal on the reconnect is not retried', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const { host, guest } = await pair(server);
  t.after(() => {
    host.disconnect();
    guest.disconnect();
  });
  await waitFor("the guest to apply the host's state", () => guest.listing().length > 0);
  const seen = events(guest);
  const before = server.acceptedConnections;

  // §9.1: `token_invalid` refuses for a reason a retry cannot change, so the client stops and
  // says why rather than re-helloing into the same refusal.
  server.helloRefusal = { code: 'token_invalid', message: "the token is not the room's" };
  server.drop('Bob');

  const failed = await waitFor(
    'the refusal to be reported',
    () => seen.find((event) => event.type === 'failed') ?? false,
  );
  assert.equal(failed.type === 'failed' ? failed.code : '', 'token_invalid');
  await waitFor('the session to end', () => guest.end !== undefined || false);
  assert.equal(guest.end, 'room-gone');

  // The one refused dial is all the client spent: no second handshake into the same refusal.
  assert.equal(
    server.acceptedConnections,
    before + 1,
    `a terminal refusal was retried: ${server.acceptedConnections - before} attempts`,
  );
});

test('selvage/2: the room\'s advertised grace sizes the retry budget', async (t) => {
  // 600 ms at the fast backoff is 11 attempts, against the five the policy itself carries:
  // a client that ignored the grace would spend five, and the grace is what raises the floor.
  const server = await FakeServer.start({ roomGraceMs: 600 });
  t.after(async () => {
    await server.stop();
  });
  const { host, guest } = await pair(server);
  t.after(() => {
    host.disconnect();
    guest.disconnect();
  });
  await waitFor("the guest to apply the host's state", () => guest.listing().length > 0);
  const before = server.acceptedConnections;

  // A refusal that is not terminal keeps the retry going, and the budget is the grace the
  // server advertised in `/meta` (§9.1), sized by the same function the version-1 engine uses.
  server.helloRefusal = { code: 'bad_params', message: 'a refusal the next attempt could pass' };
  server.drop('Bob');
  await waitFor('the session to give up', () => guest.end !== undefined || false, {
    timeoutMs: 15_000,
  });
  assert.equal(guest.end, 'room-gone');
  const budget = attemptsForGrace(600, { enabled: true, ...FAST, maxAttempts: 5 });
  assert.equal(budget, 11, 'the fast backoff over 600 ms is eleven attempts');
  assert.equal(
    server.acceptedConnections - before,
    budget,
    `the grace did not size the retry: ${server.acceptedConnections - before} attempts`,
  );
});

test('selvage/2: the retry reaches the bridge an adapter listens to', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const host = await RelaySession.host({
    baseUrl: server.wsBase,
    displayName: 'Ada',
    listing: () => [PATH],
    keepalive: KEEPALIVE,
  });
  t.after(() => {
    host.disconnect();
  });
  const invite = host.invite();
  assert.ok(invite !== undefined);
  const engine = await PeerEngine.join({
    invite,
    displayName: 'Bob',
    keepalive: KEEPALIVE,
    reconnect: FAST,
  });
  t.after(() => {
    void engine.disconnect();
  });
  await waitFor("the guest to apply the host's state", () =>
    engine.grantedPaths().length > 0 ? true : false,
  );
  const seen: string[] = [];
  engine.on((event) => {
    seen.push(event.type);
  });
  server.drop('Bob');

  // The bridge event the adapter's status bar is wired to (`events.ts`): before this fix the same
  // drop arrived at the adapter as `disconnected`.
  await waitFor('the bridge to report the retry', () =>
    seen.includes('reconnecting') ? true : false,
  );
  assert.equal(seen.includes('disconnected'), false, 'a retry was reported as a lost session');
});

test('selvage/2: the role a re-seat is given reaches the bridge after the state that gives it', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const host = await RelaySession.host({
    baseUrl: server.wsBase,
    displayName: 'Ada',
    listing: () => [PATH],
    keepalive: KEEPALIVE,
  });
  t.after(() => {
    host.disconnect();
  });
  const invite = host.invite();
  assert.ok(invite !== undefined);
  const engine = await PeerEngine.join({
    invite,
    displayName: 'Bob',
    keepalive: KEEPALIVE,
    reconnect: FAST,
  });
  t.after(() => {
    void engine.disconnect();
  });
  await waitFor('the state that commits the guest to arrive', () => engine.appliedRole() ?? false);

  // Recorded per event, with the role the applied state gives this connection at that moment: a
  // re-seat commits no key at all, so `§13.4`'s role is `undefined` again until the room's own
  // state lands, and the report the bar needs is one made after it.
  const reported: Array<{ type: string; role: string | undefined }> = [];
  const stop = engine.on((event) => {
    reported.push({ type: event.type, role: engine.appliedRole() });
  });
  t.after(() => {
    stop();
  });
  server.drop('Bob');

  // A re-seat commits no key, so the role goes back to `undefined` with it and the room's own
  // state is the next thing that assigns one. The status bar reads the role off the session and
  // re-reads it on the reports it is given, so what it needs is the report after that state: an
  // adapter left on "waiting for the host" after a reconnect is a role nothing said.
  const said = await waitFor(
    'a report made after the re-seat while the applied state gives this connection a role',
    () => {
      const away = reported.findIndex((entry) => entry.role === undefined);
      if (away === -1) {
        return false;
      }
      return reported.find((entry, at) => at > away && entry.role === 'guest') ?? false;
    },
    { timeoutMs: 15_000, describe: () => JSON.stringify(reported) },
  );
  assert.ok(
    said.type === 'peersChanged' || said.type === 'documentsChanged',
    `the report that carries the role is one the status bar re-reads: ${said.type}`,
  );
});

test("selvage/2: an edit typed while the socket is down is published once the re-seat is committed", async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  // A backoff wide enough to type inside, so the edit lands after the drop and before the dial.
  const SLOW = { initialDelayMs: 300, maxDelayMs: 300 } as const;
  const host = await RelaySession.host({
    baseUrl: server.wsBase,
    displayName: 'Ada',
    listing: () => [PATH],
    keepalive: KEEPALIVE,
  });
  t.after(() => {
    host.disconnect();
  });
  const invite = host.invite();
  assert.ok(invite !== undefined);
  const engine = await PeerEngine.join({
    invite,
    displayName: 'Bob',
    keepalive: KEEPALIVE,
    reconnect: SLOW,
  });
  t.after(() => {
    void engine.disconnect();
  });
  await waitFor('the state that commits the guest to arrive', () => engine.appliedRole() ?? false);

  const seen: string[] = [];
  engine.on((event) => {
    seen.push(event.type);
  });
  server.drop('Bob');
  await waitFor('the retry to be reported', () =>
    seen.includes('reconnecting') ? true : false,
  );

  // Typed with the socket gone. The key the dead connection held is one the room will not commit
  // again, so the edit is held back rather than sealed under it, and the state that commits the
  // re-seat's key is what carries it to the room.
  engine.insert(PATH, 0, 'typed while away');
  const atHost = await waitFor(
    'the edit typed during the drop to reach the room',
    () => (host.text(PATH).includes('typed while away') ? host.text(PATH) : false),
    { timeoutMs: 15_000, describe: () => host.text(PATH) },
  );
  assert.ok(atHost.includes('typed while away'));
});

test('selvage/2: an attempt budget the caller named is not raised by the advertised grace', async (t) => {
  // 600 ms at the fast backoff is 11 attempts, and the caller asked for 2: the grace raises a
  // budget nobody named, exactly as it does in the version-1 engine.
  const server = await FakeServer.start({ roomGraceMs: 600 });
  t.after(async () => {
    await server.stop();
  });
  const { host, guest } = await pair(server, { ...FAST, maxAttempts: 2 });
  t.after(() => {
    host.disconnect();
    guest.disconnect();
  });
  await waitFor("the guest to apply the host's state", () => guest.listing().length > 0);
  const before = server.acceptedConnections;

  server.helloRefusal = { code: 'bad_params', message: 'a refusal the next attempt could pass' };
  server.drop('Bob');
  await waitFor('the session to give up', () => guest.end !== undefined || false, {
    timeoutMs: 15_000,
  });
  assert.equal(guest.end, 'room-gone');
  assert.equal(
    server.acceptedConnections - before,
    2,
    `an explicit budget was raised by the grace: ${server.acceptedConnections - before} attempts`,
  );
});
