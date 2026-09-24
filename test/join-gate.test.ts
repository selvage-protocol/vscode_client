/**
 * The one check that precedes a join's socket (`PROTOCOL.md` §2): `/meta`, which is advisory. A
 * `/meta` that cannot be read is no answer rather than a refusal, so the join is attempted and the
 * handshake is what reports the truth.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RelaySession } from '../src/engine/relay.ts';
import { FakeServer } from './helpers/fake-server.ts';

const KEEPALIVE = { awareness_renew_ms: 50, awareness_expire_ms: 5000 };

/** A host on `server`, and the invite it hands on. */
async function hosted(t: { after: (fn: () => void) => void }, server: FakeServer): Promise<string> {
  const host = await RelaySession.host({
    baseUrl: server.wsBase,
    displayName: 'Ada',
    listing: () => ['notes.txt'],
    keepalive: KEEPALIVE,
  });
  t.after(() => {
    host.disconnect();
  });
  const invite = host.invite();
  assert.ok(invite !== undefined, 'the host is handed a link to send');
  return invite;
}

test('a join whose /meta cannot be read is attempted, and the handshake decides', async (t) => {
  const server = await FakeServer.start({ metaStatus: 404 });
  t.after(async () => {
    await server.stop();
  });
  const invite = await hosted(t, server);
  const guest = await RelaySession.join({ invite, displayName: 'Bob', keepalive: KEEPALIVE });
  t.after(() => {
    guest.disconnect();
  });
  assert.ok(guest.sessionInfo().roomId.length > 0, 'the guest was not seated');
});
