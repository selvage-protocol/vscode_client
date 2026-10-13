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
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import { PeerSession, parseInvite } from '../src/engine/peer.ts';
import { authentic, decodeKey, frameKey, opens, parseEnvelope } from '../src/engine/sealed.ts';
import { nodeCrypto } from '../src/node/crypto.ts';

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

  // And the guest can edit again, which is the whole point of surviving the blip. The edit is
  // made once; the wait below polls the room, never the editor.
  assert.equal(await guest.insert(PATH, 0, 'guest: '), true);
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

/**
 * The transport seam, armed to lose exactly one frame: a wrapper around a real socket that reports
 * every property an `OpenSocket` reads and drops only the authenticated Update whose
 * decoded insertion is `off ` instead of sending it. The socket still reports open, which is what a lost frame on a
 * closing socket looks like from above — no error, no close, just a frame that never arrived.
 */
test('selvage/2: a real server loses one outbound update and the reconnect recovers it', async (t) => {
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

  const parsed = parseInvite(invite);
  assert.ok(parsed.ok);
  const key = await frameKey(nodeCrypto, parsed.invite.room, parsed.invite.roomKey);
  assert.ok(key !== undefined);
  const raw: WebSocket[] = [];
  let armed = false;
  let dropped: Uint8Array | undefined;
  let dependent: Uint8Array | undefined;
  let sender: Uint8Array | undefined;
  let sendQueue = Promise.resolve();
  let sendFailure: unknown;
  let acceptedDependent = false;
  let lastSyncTraffic = Date.now();
  const updates = new Map<Uint8Array, Y.Item>();
  const originalDeliver = PeerSession.prototype.deliver;
  PeerSession.prototype.deliver = async function (clock, bytes) {
    const result = await originalDeliver.call(this, clock, bytes);
    if (result.status === 'applied') {
      const envelope = parseEnvelope(bytes);
      if (envelope?.kind === 0) {
        const plaintext = await opens(nodeCrypto, key, parsed.invite.room, envelope);
        if (plaintext?.[0] === 0 && (plaintext[1] === 0 || plaintext[1] === 1)) lastSyncTraffic = Date.now();
      }
    }
    if (dependent !== undefined && Buffer.from(bytes).equals(Buffer.from(dependent))) {
      assert.equal(result.status, 'applied', 'dependent frame must authenticate and apply before close');
      acceptedDependent = true;
    }
    return result;
  };
  t.after(() => { PeerSession.prototype.deliver = originalDeliver; });
  const identifyUpdate = async (bytes: Uint8Array): Promise<string | undefined> => {
    const envelope = parseEnvelope(bytes);
    assert.ok(envelope !== undefined);
    const plaintext = await opens(nodeCrypto, key, parsed.invite.room, envelope);
    assert.ok(plaintext !== undefined);
    if (envelope.kind === 4) {
      const announcement = JSON.parse(new TextDecoder().decode(plaintext)) as { key: string };
      sender = decodeKey(announcement.key);
      assert.ok(sender !== undefined);
    }
    if (envelope.kind !== 0) return undefined;
    const decoder = decoding.createDecoder(plaintext);
    if (decoding.readVarUint(decoder) !== 0 || decoding.readVarUint(decoder) !== 2) return undefined;
    assert.ok(sender !== undefined);
    assert.ok(await authentic(nodeCrypto, parsed.invite.room, envelope, sender), 'Update signature');
    const update = Y.decodeUpdate(decoding.readVarUint8Array(decoder));
    assert.equal(decoding.hasContent(decoder), false, 'expected one Update');
    assert.equal(update.structs.length, 1, 'intended delta contains one insertion');
    const item = update.structs[0];
    assert.ok(item instanceof Y.Item && item.content instanceof Y.ContentString);
    assert.equal(update.ds.clients.size, 0, 'intended insertion carries no deletion');
    updates.set(bytes, item);
    return item.content.str;
  };
  const guest = await RelaySession.join({
    invite,
    displayName: 'Bob',
    keepalive: KEEPALIVE,
    reconnect: FAST,
    webSocketFactory: (url) => {
      const socket = new WebSocket(url);
      raw.push(socket);
      const wrapper: WebSocketLike = {
        get readyState(): number {
          return socket.readyState;
        },
        get binaryType(): string {
          return socket.binaryType;
        },
        set binaryType(value: string) {
          socket.binaryType = value as typeof socket.binaryType;
        },
        send(data: string | Uint8Array): void {
          sendQueue = sendQueue.then(async () => {
            if (typeof data !== 'string') {
              const text = await identifyUpdate(data);
              if (armed && text === 'off ') {
                armed = false;
                dropped = data;
                return;
              }
              if (dropped !== undefined && text === 'on ') dependent = data;
            }
            socket.send(data as never);
          }).catch((error: unknown) => { sendFailure = error; });
        },
        close(code?: number, reason?: string): void {
          socket.close(code, reason);
        },
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      };
      socket.onopen = () => wrapper.onopen?.();
      socket.onmessage = (event) => wrapper.onmessage?.({ data: event.data });
      socket.onclose = (event) => wrapper.onclose?.(event as never);
      socket.onerror = (event) => wrapper.onerror?.(event);
      return wrapper;
    },
  });
  t.after(() => {
    guest.disconnect();
  });
  await waitFor("the guest to apply the host's state", () => guest.listing().length > 0);

  assert.equal(await host.insert(PATH, 0, 'abc'), true);
  await waitFor("the guest to see the host's text", () =>
    guest.text(PATH) === 'abc' ? true : false,
  );
  assert.ok(
    Buffer.from(host.stateVector()).equals(Buffer.from(guest.stateVector())),
    'the two replicas start converged',
  );

  await waitFor('bootstrap requests and answers to quiesce across three renewal windows', () => Date.now() - lastSyncTraffic >= KEEPALIVE.awareness_renew_ms * 3);

  // B inserts `off ` and the frame is lost on the wire while the socket reports open. Then B
  // inserts `on `, which depends on the missing struct and is delivered.
  const firstSeat = guest.sessionInfo().seat;
  armed = true;
  assert.equal(await guest.insert(PATH, 0, 'off '), true);
  await waitFor('the authenticated off Update to be dropped', () => {
    if (sendFailure !== undefined) throw sendFailure;
    return dropped !== undefined;
  });
  assert.equal(await identifyUpdate(dropped as Uint8Array), 'off ');
  assert.equal(await guest.insert(PATH, 0, 'on '), true);
  await waitFor('the host to accept the authenticated dependent Update before close', () => {
    if (sendFailure !== undefined) throw sendFailure;
    return acceptedDependent;
  });
  const lostItem = updates.get(dropped as Uint8Array);
  const nextItem = updates.get(dependent as Uint8Array);
  assert.ok(lostItem !== undefined && nextItem !== undefined);
  assert.deepEqual(nextItem.rightOrigin, lostItem.id, 'dependent insertion references the dropped struct');
  assert.equal(nextItem.id.client, lostItem.id.client);
  assert.equal(nextItem.id.clock, lostItem.id.clock + 4);
  assert.equal(host.text(PATH), 'abc', 'accepted dependent Update remains pending');

  // The socket is cut: the reconnect is a fresh seat, a fresh key and the same retained replica.
  const seen: RelayEvent[] = [];
  guest.on((event) => {
    seen.push(event);
  });
  raw[raw.length - 1]?.terminate();
  await waitFor('the reconnecting report', () =>
    seen.some((event) => event.type === 'reconnecting') ? true : false,
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
  await waitFor(
    "the host to commit the guest's new key",
    () => (guest.appliedRole() === 'guest' ? true : false),
    { timeoutMs: 15_000, describe: () => guest.appliedRole() },
  );

  // No further edit: the reciprocal request is what carries the lost struct back.
  const recovered = await waitFor(
    'the host to recover the lost update',
    () => (host.text(PATH) === 'on off abc' ? host.text(PATH) : false),
    { timeoutMs: 15_000, describe: () => host.text(PATH) },
  );
  assert.equal(recovered, 'on off abc');
  assert.equal(guest.text(PATH), 'on off abc');
  assert.ok(
    Buffer.from(host.stateVector()).equals(Buffer.from(guest.stateVector())),
    'texts and state vectors converged',
  );
});
