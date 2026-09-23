/**
 * The `selvage/2` relay's local half: the invite is read before a socket is built, the page form
 * resolves to the wire form with its fragment carried across, and a fragment-less link is refused
 * where `PROTOCOL.md` §5.1 says the refusal happens. None of this opens a connection, which is the
 * point — the corpus and the engine's own tests already pin the frame bytes, and what is added here
 * is the one reading `PeerSession` was never handed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MISSING_FRAGMENT, parseInvite } from '../src/engine/peer.ts';
import { encodeKey } from '../src/engine/sealed.ts';
import { RelaySession, wireInvite } from '../src/node/relay.ts';

const ROOM_KEY = encodeKey(new Uint8Array(32).fill(7));
const HOST_KEY = encodeKey(new Uint8Array(32).fill(9));
const FRAGMENT = `#k=${ROOM_KEY}&h=${HOST_KEY}`;
const WIRE = `ws://127.0.0.1:9999/session?room=room-1&token=tok-1${FRAGMENT}`;
const PAGE = `http://127.0.0.1:9999/?room=room-1&token=tok-1${FRAGMENT}`;

test('wireInvite leaves the endpoint form alone, fragment and all', () => {
  assert.equal(wireInvite(WIRE), WIRE);
});

test('wireInvite resolves a page link to the connection URL, keeping its fragment', () => {
  const read = parseInvite(wireInvite(PAGE));
  assert.equal(read.ok, true);
  if (!read.ok) {
    return;
  }
  assert.equal(read.invite.socketUrl, 'ws://127.0.0.1:9999/session?room=room-1&token=tok-1');
  assert.equal(read.invite.room, 'room-1');
  assert.equal(read.invite.token, 'tok-1');
  assert.deepEqual([...read.invite.roomKey], [...new Uint8Array(32).fill(7)]);
  assert.deepEqual([...read.invite.hostKey], [...new Uint8Array(32).fill(9)]);
});

test('wireInvite turns a page link from https to wss', () => {
  const read = parseInvite(wireInvite(`https://example.test/?room=r&token=t${FRAGMENT}`));
  assert.equal(read.ok, true);
  if (read.ok) {
    assert.equal(read.invite.socketUrl, 'wss://example.test/session?room=r&token=t');
  }
});

test('wireInvite leaves a link it cannot read as it stands', () => {
  assert.equal(wireInvite('not a url'), 'not a url');
  // A page link with no room or token names nothing to join; the refusal is parseInvite's.
  const nameless = `http://127.0.0.1:9999/${FRAGMENT}`;
  assert.equal(wireInvite(nameless), nameless);
});

test('a page link joins the same room a wire link does', () => {
  const fromPage = parseInvite(wireInvite(PAGE));
  const fromWire = parseInvite(WIRE);
  assert.equal(fromPage.ok, true);
  assert.equal(fromWire.ok, true);
  if (fromPage.ok && fromWire.ok) {
    assert.deepEqual(fromPage.invite, fromWire.invite);
  }
});

test('joining without a fragment is refused locally, before any socket', async () => {
  await assert.rejects(
    RelaySession.join({ invite: 'ws://127.0.0.1:9999/session?room=r&token=t', displayName: 'Bo' }),
    (error: unknown) =>
      error instanceof Error && error.message === MISSING_FRAGMENT,
  );
});

test('joining without a room key is refused locally', async () => {
  await assert.rejects(
    RelaySession.join({
      invite: `ws://127.0.0.1:9999/session?room=r&token=t#h=${HOST_KEY}`,
      displayName: 'Bo',
    }),
    /no room key/,
  );
});

test('a handover with the wrong key lengths is refused before any socket', async () => {
  await assert.rejects(
    RelaySession.join({
      invite: '',
      displayName: 'Bo',
      handover: {
        socketUrl: 'ws://127.0.0.1:9999/session',
        room: 'r',
        token: 't',
        roomKey: new Uint8Array(4),
        hostKey: new Uint8Array(32),
      },
    }),
    /handover carries no 32-byte/,
  );
});
