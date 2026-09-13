/**
 * The conformance gate, run against the real `selvaged` built from the sibling
 * `reference_server` checkout: two engines, one room, concurrent edits, convergence and
 * presence. This is the test `DESIGN.md` §7 asks for and the one that says the TypeScript
 * engine speaks `selvage/1` rather than merely agreeing with itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SelvageEngine } from '../src/engine/engine.ts';
import { fetchMeta } from '../src/engine/meta.ts';
import {
  catchUp,
  converge,
  waitFor,
  waitForPeer,
  waitForSelection,
} from './helpers/wait.ts';
import { RealServer } from './helpers/selvaged.ts';

const PATH = 'src/main.rs';
const SEED = 'fn main() {\n    println!("hello");\n}\n';

/** Host with the real server, and its invite URL. */
async function mint(server: RealServer): Promise<{
  host: SelvageEngine;
  invite: string;
}> {
  const host = await SelvageEngine.host(server.wsBase, 'Ada', {
    client: 'selvage-vscode-test/0.1.0',
  });
  const invite = host.inviteUrl();
  assert.ok(invite !== undefined, 'the host is given the token to share');
  return { host, invite };
}

test('selvaged: /meta advertises the wire version and the session clock', async (t) => {
  const server = await RealServer.start();
  t.after(async () => {
    await server.stop();
  });
  const meta = await fetchMeta(server.wsBase);
  assert.ok(meta.wire_versions?.includes('selvage/1'), JSON.stringify(meta));
  assert.equal(meta.capabilities?.includes('y-protocols/1'), true);
  assert.deepEqual(meta.roles, ['host', 'guest']);
  assert.deepEqual(meta.keepalive, {
    ping_interval_ms: 30_000,
    awareness_renew_ms: 15_000,
    awareness_expire_ms: 30_000,
  });
});

test('selvaged: two engines converge on concurrent edits and see each other', async (t) => {
  const server = await RealServer.start();
  t.after(async () => {
    await server.stop();
  });
  const { host, invite } = await mint(server);
  t.after(async () => {
    await host.disconnect();
  });
  // The invite URL is the share, so the guest joins through the link itself (§5.1).
  const guest = await SelvageEngine.join(invite, 'Bob', {
    client: 'selvage-vscode-test/0.1.0',
  });
  t.after(async () => {
    await guest.disconnect();
  });

  // --- session layer -------------------------------------------------------
  assert.equal(host.session().role, 'host');
  assert.equal(guest.session().role, 'guest');
  assert.equal(host.session().roomId, guest.session().roomId);
  assert.equal(guest.session().token, undefined, 'a token is never echoed (§6.1)');

  // --- one document, seeded by the host ------------------------------------
  await host.open(PATH);
  await guest.open(PATH);
  host.insert(PATH, 0, SEED);

  const seeded = await waitFor('the guest to receive the seeded document', () => {
    const text = guest.text(PATH);
    return text === SEED ? text : false;
  });
  assert.equal(seeded, SEED);

  // --- membership and presence ---------------------------------------------
  const bob = await waitForPeer(host, 'Bob');
  const ada = await waitForPeer(guest, 'Ada');
  assert.equal(bob.role, 'guest');
  assert.equal(ada.role, 'host');
  assert.equal(typeof ada.awareness_client_id, 'number');
  assert.equal(typeof bob.awareness_client_id, 'number');

  host.setSelection(PATH, { anchor: 0, head: 2 });
  guest.setSelection(PATH, { anchor: 11, head: 13 });

  // The wire carries anchors and each receiver resolves them against its own replica
  // (§8.1), so this also says the real server relays a state it does not interpret.
  const bobOnHost = await waitForSelection(
    host,
    'Bob',
    PATH,
    (selection) => selection.anchor === 11 && selection.head === 13,
  );
  assert.equal(bobOnHost.presence.clientId, bob.awareness_client_id);
  assert.equal(bobOnHost.presence.state?.path, PATH);
  assert.equal(
    typeof bobOnHost.presence.state?.selection?.anchor,
    'object',
    'no index reaches the wire',
  );

  const adaOnGuest = await waitForSelection(
    guest,
    'Ada',
    PATH,
    (selection) => selection.anchor === 0 && selection.head === 2,
  );
  assert.equal(adaOnGuest.presence.clientId, ada.awareness_client_id);

  // --- concurrent edits ----------------------------------------------------
  // Held outbound frames on both sides, so neither edit can be in the other's history.
  host.pauseOutbound(true);
  guest.pauseOutbound(true);
  host.insert(PATH, 0, 'AAA ');
  guest.insert(PATH, 0, 'BBB ');
  assert.equal(host.text(PATH), `AAA ${SEED}`);
  assert.equal(guest.text(PATH), `BBB ${SEED}`);
  host.pauseOutbound(false);
  guest.pauseOutbound(false);

  const merged = await converge(host, guest, PATH);
  assert.ok(merged.includes('AAA'), `the merge kept the host's edit: ${merged}`);
  assert.ok(merged.includes('BBB'), `the merge kept the guest's edit: ${merged}`);
  assert.ok(merged.includes('hello'), `the merge kept the seed: ${merged}`);
  assert.ok(
    merged.startsWith('AAA BBB ') || merged.startsWith('BBB AAA '),
    `concurrent inserts stay contiguous: ${merged}`,
  );
  assert.equal(merged.length, SEED.length + 8);

  // Convergence is not just text equality: the replicas hold the same history (§7).
  const vectors = await waitFor('the state vectors to agree', () => {
    const left = JSON.stringify(host.stateVector());
    const right = JSON.stringify(guest.stateVector());
    return left === right ? left : false;
  });
  assert.equal(JSON.parse(vectors).length, 2, 'one entry per editing client');

  const documents = await waitFor('the room to hold the document', () =>
    host.documents().includes(PATH) && guest.documents().includes(PATH),
  );
  assert.equal(documents, true);

  // --- a late joiner is brought up to the merged state ----------------------
  const late = await SelvageEngine.join(invite, 'Cleo');
  t.after(async () => {
    await late.disconnect();
  });
  await late.open(PATH);
  const onLate = await waitFor(
    'the late joiner to receive the merged document',
    () => {
      const text = late.text(PATH);
      return text === merged ? text : false;
    },
  );
  assert.equal(onLate, merged);
  const cleo = await waitForPeer(host, 'Cleo');
  assert.equal(typeof cleo.awareness_client_id, 'number');
});

test('selvaged: a rejoining guest inherits the room, and the set survives it', async (t) => {
  const server = await RealServer.start();
  t.after(async () => {
    await server.stop();
  });
  const { host, invite } = await mint(server);
  const guest = await SelvageEngine.join(invite, 'Bob');
  t.after(async () => {
    await guest.disconnect();
    await host.disconnect();
  });
  await host.open(PATH);
  await guest.open(PATH);
  host.insert(PATH, 0, 'content\n');
  await converge(host, guest, PATH);

  const firstPeerId = guest.session().peer.peer_id;
  await guest.disconnect();
  // A device that releases its hold does not take the path out of the room's set (§5).
  await waitFor('the host to see the guest leave', () =>
    host.peers().length === 0,
  );
  assert.ok(host.documents().includes(PATH));

  // §9.1: reconnecting is `session.hello` again on a new socket; the room's set is the
  // truth, and content comes back from the peers rather than from the server.
  const rejoined = await SelvageEngine.join(invite, 'Bob');
  t.after(async () => {
    await rejoined.disconnect();
  });
  assert.equal(rejoined.session().role, 'guest');
  assert.deepEqual(rejoined.session().documents, [PATH]);
  assert.notEqual(rejoined.session().peer.peer_id, firstPeerId);
  await rejoined.open(PATH);
  const text = await waitFor('the rejoin to catch up', () => {
    const caught = rejoined.text(PATH);
    return caught === 'content\n' ? caught : false;
  });
  assert.equal(text, 'content\n');
  await catchUp(host, rejoined, PATH);
});

test('selvaged: the open-document set is held by connections, not by paths', async (t) => {
  const server = await RealServer.start();
  t.after(async () => {
    await server.stop();
  });
  const { host, invite } = await mint(server);
  t.after(async () => {
    await host.disconnect();
  });
  const guest = await SelvageEngine.join(invite, 'Bob');
  t.after(async () => {
    await guest.disconnect();
  });

  await host.open(PATH);
  await guest.open(PATH);
  await guest.close(PATH);
  // The host still holds it, so the room's set is unchanged, and both are told so.
  const afterGuestClose = await waitFor(
    'the guest to be told the set still holds the path',
    () => guest.documents().includes(PATH),
  );
  assert.equal(afterGuestClose, true);
  assert.deepEqual(guest.openDocuments(), []);
  await waitFor('the host to be told the guest released it', () =>
    host.documents().includes(PATH),
  );

  await host.close(PATH);
  await waitFor('the path to leave the room once nobody holds it', () =>
    host.documents().length === 0 && guest.documents().length === 0,
  );
  // Closing does not delete content: the Y.Text is still there for a later open (§5).
  assert.equal(host.text(PATH), '');
  await host.open(PATH);
  assert.deepEqual(host.documents(), [PATH]);
});
