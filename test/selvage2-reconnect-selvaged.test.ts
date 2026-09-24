/**
 * `selvage/2` reconnection against a real `selvaged` (`PROTOCOL.md` §9.1): a guest whose socket is
 * cut mid-session re-hellos on a fresh socket, keeps its replica and its holds, and edits on. The
 * socket is cut by the test through the transport seam — the client's own `terminate` is the 1006
 * a proxy or a sleeping laptop produces — so this is the server-backed proof of the whole path.
 *
 * It needs a built sibling `selvaged` (see `test/helpers/selvaged.ts`), so it is not part of the
 * server-free suite. The fake-server cases are `test/selvage2-reconnect.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import WebSocket from 'ws';

import { RelaySession } from '../src/engine/relay.ts';
import type { RelayEvent } from '../src/engine/relay.ts';
import type { WebSocketLike } from '../src/engine/transport.ts';
import { RealServer } from './helpers/selvaged.ts';
import { waitFor } from './helpers/wait.ts';

const PATH = 'notes.txt';

/** A fast backoff, so a test does not wait out the production delays. */
const FAST = { initialDelayMs: 20, maxDelayMs: 60 } as const;

/** The clocks a test runs the session on, so its hold/awareness ticks actually tick. */
const KEEPALIVE = { awareness_renew_ms: 50, awareness_expire_ms: 5000 };

test('selvage/2: a guest a real server drops reconnects and keeps editing', async (t) => {
  const server = await RealServer.start();
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

  // The socket is cut by closing the guest's own transport underneath it, which is what a
  // proxy 1006 or a sleeping laptop does to a real session.
  const raw: WebSocket[] = [];
  const guest = await RelaySession.join({
    invite,
    displayName: 'Bob',
    keepalive: KEEPALIVE,
    reconnect: FAST,
    webSocketFactory: (url) => {
      const socket = new WebSocket(url);
      raw.push(socket);
      return socket as unknown as WebSocketLike;
    },
  });
  t.after(() => {
    guest.disconnect();
  });
  await waitFor("the guest to apply the host's state", () => guest.listing().length > 0);
  guest.open(PATH);
  assert.deepEqual(guest.heldPaths(), [PATH], 'the hold was taken before the drop');
  const firstSeat = guest.sessionInfo().seat;

  const seen: RelayEvent[] = [];
  guest.on((event) => {
    seen.push(event);
  });
  const dialsBefore = raw.length;
  raw[raw.length - 1]?.terminate();

  await waitFor('the reconnecting report', () =>
    seen.some((event) => event.type === 'reconnecting') ? true : false,
  );
  assert.equal(
    seen.some((event) => event.type === 'ended'),
    false,
    'a recoverable drop was reported as the session ending',
  );

  const seat = await waitFor(
    'the guest to be seated again',
    () => {
      const now = guest.sessionInfo().seat;
      return now !== firstSeat ? now : false;
    },
    { timeoutMs: 15_000 },
  );
  assert.notEqual(seat, firstSeat, 'the reconnect is a new peer (§9.1)');
  assert.equal(guest.sessionInfo().roomId, host.sessionInfo().roomId);
  assert.ok(raw.length > dialsBefore, 'the reconnect opened a new socket');
  assert.deepEqual(guest.heldPaths(), [PATH], 'the reconnect abandoned the space it held open');

  // §13.1's steps 4 and 6 replay, and the host answers with a state that commits the new key.
  await waitFor(
    "the host to commit the guest's new key",
    () => (guest.appliedRole() === 'guest' ? true : false),
    { timeoutMs: 15_000, describe: () => guest.appliedRole() },
  );

  // And the guest can edit again, which is the whole point of surviving the blip.
  const published = await waitFor(
    'the guest to publish again',
    async () => ((await guest.insert(PATH, 0, 'guest: ')) ? true : false),
    { timeoutMs: 15_000 },
  );
  assert.equal(published, true);
  const atHost = await waitFor(
    "the guest's edit to reach the host",
    () => (host.text(PATH).includes('guest: ') ? host.text(PATH) : false),
    { timeoutMs: 15_000 },
  );
  assert.ok(atHost.includes('guest: '));
});

test('selvage/2: a guest that renamed re-hellos to a real server under the name it set', async (t) => {
  const server = await RealServer.start();
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

  const raw: WebSocket[] = [];
  const guest = await RelaySession.join({
    invite,
    displayName: 'Bob',
    keepalive: KEEPALIVE,
    reconnect: FAST,
    webSocketFactory: (url) => {
      const socket = new WebSocket(url);
      raw.push(socket);
      return socket as unknown as WebSocketLike;
    },
  });
  t.after(() => {
    guest.disconnect();
  });
  await waitFor("the guest to apply the host's state", () => guest.listing().length > 0);
  const firstSeat = guest.sessionInfo().seat;

  await guest.rename('Bobby');
  await waitFor('the host to see the rename', () =>
    host.peers().some((peer) => peer.peer_id === firstSeat && peer.display_name === 'Bobby')
      ? true
      : false,
  );
  // A peer that joins after the rename is what makes this deterministic: the room's frames
  // arrive in order on the guest's socket, so seeing the joiner is proof the mover's own
  // `peer.renamed` was applied before the socket is cut below.
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

  const dialsBefore = raw.length;
  raw[raw.length - 1]?.terminate();
  const seat = await waitFor(
    'the guest to be seated again',
    () => {
      const now = guest.sessionInfo().seat;
      return now !== firstSeat ? now : false;
    },
    { timeoutMs: 15_000 },
  );
  assert.notEqual(seat, firstSeat, 'the reconnect is a new peer (§9.1)');
  assert.ok(raw.length > dialsBefore, 'the reconnect opened a new socket');

  // What the re-hello carried, as the room itself recorded it (`PROTOCOL.md` §5, §9.1).
  const atHost = await waitFor(
    'the host to see the re-seated guest',
    () => host.peers().find((peer) => peer.peer_id === seat) ?? false,
    { timeoutMs: 15_000, describe: () => host.peers() },
  );
  assert.equal(
    atHost.display_name,
    'Bobby',
    'the re-seat reintroduced the name the session was seated under',
  );
});
