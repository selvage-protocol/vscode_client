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
  reconnect: false | typeof FAST = FAST,
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
