/**
 * The version gate a `selvage/2` join passes before it opens a socket (`PROTOCOL.md` §2, §10;
 * `specification/vectors/peer/158`): a reachable `/meta` that names no version at major 2 is
 * refused locally, naming the version the invite needs, and is never fallen back from; a `/meta`
 * that could not be read is no answer, and the join is attempted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { joinRefusal } from '../src/engine/meta.ts';
import { ProtocolError } from '../src/engine/errors.ts';
import { RelaySession } from '../src/engine/relay.ts';
import { FakeServer } from './helpers/fake-server.ts';

const KEEPALIVE = { awareness_renew_ms: 50, awareness_expire_ms: 5000 };

test('joinRefusal refuses only a reachable list with nothing at major 2', () => {
  assert.equal(joinRefusal(undefined), undefined, 'an unreadable /meta is no answer');
  assert.equal(joinRefusal({}), undefined, 'a body that names no versions said nothing');
  assert.equal(joinRefusal({ wire_versions: [] }), undefined);
  assert.equal(joinRefusal({ wire_versions: ['selvage/2'] }), undefined);
  assert.equal(joinRefusal({ wire_versions: ['selvage/1', 'selvage/2.3'] }), undefined);
  const refused = joinRefusal({ wire_versions: ['selvage/1'] }, 'ws://example.test');
  assert.ok(refused !== undefined);
  assert.match(refused, /selvage\/2/, 'the refusal names the version the invite needs');
  assert.match(refused, /ws:\/\/example\.test/, 'the refusal names the server');
});

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

test('a join whose /meta seats no selvage/2 is refused before any socket, not fallen back from', async (t) => {
  // The server still seats both versions; only its advertisement narrows, which is the case a
  // client is held to: it acts on what a reachable `/meta` says.
  const server = await FakeServer.start({ metaWireVersions: ['selvage/1'] });
  t.after(async () => {
    await server.stop();
  });
  const invite = await hosted(t, server);
  const before = server.acceptedConnections;
  await assert.rejects(
    () => RelaySession.join({ invite, displayName: 'Bob', keepalive: KEEPALIVE }),
    (error: unknown) =>
      error instanceof ProtocolError &&
      error.code === 'unsupported_version' &&
      /selvage\/2/.test(error.message),
  );
  assert.equal(server.acceptedConnections, before, 'the refused join opened a socket');
});

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
