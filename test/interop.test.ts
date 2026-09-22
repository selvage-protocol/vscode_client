/**
 * Interop: the real TypeScript engine and the real Rust client in one room, over one real
 * `selvaged`.
 *
 * Each suite around this one verifies a single implementation against the server —
 * `test/selvaged.test.ts` puts two TypeScript engines in a room, and `reference_server`'s
 * harness puts two Rust clients in one — which says each speaks `selvage/1` and says
 * nothing about the two agreeing with each other. Here the host is the engine, the guest
 * is `selvage-client` built from the sibling `reference_server` checkout, and the
 * assertions are made on what both sides say about the same room.
 *
 * It needs that sibling checkout and a built `interop_peer`, so it is not in CI and not in
 * `test:fast`: `npm run test:interop` runs it, and so does `npm test`. `scripts/ci-local.sh`
 * records why. What it does not cover: the editor adapters (no VS Code, no Neovim), any
 * reconnect, the room's grant, awareness renewal or expiry, and more than one document.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SelvageEngine } from '../src/engine/engine.ts';
import { RustPeer, waitForReport } from './helpers/interop_peer.ts';
import type { PeerReport } from './helpers/interop_peer.ts';
import { RealServer } from './helpers/selvaged.ts';
import { waitForPeer, waitForSelection } from './helpers/wait.ts';

const PATH = 'src/main.rs';

/**
 * The seed carries an astral character on purpose: an implementation that counted bytes or
 * code points where the editor counts UTF-16 code units would place an anchor elsewhere,
 * and the anchor assertions below would resolve to different offsets on the two sides.
 */
const SEED = 'fn main() {\n    println!("héllo 🧵");\n}\n';

/** Just past the surrogate pair, so the offsets below are a UTF-16 claim and not an ASCII one. */
const AFTER_EMOJI = SEED.indexOf('🧵') + '🧵'.length;

function vectorKey(entries: Array<[number, number]>): string {
  return JSON.stringify([...entries].sort((left, right) => left[0] - right[0]));
}

function names(
  records: { display_name: string | null; role: string | null }[],
): string[] {
  return records
    .map((record) => `${record.display_name}:${record.role}`)
    .sort();
}

function sameOffsets(
  left: { anchor: number; head: number } | null | undefined,
  right: { anchor: number; head: number },
): boolean {
  return (
    left != null && left.anchor === right.anchor && left.head === right.head
  );
}

function ada(report: PeerReport) {
  return report.presence.find((record) => record.display_name === 'Ada');
}

test('interop: the TypeScript engine and the Rust client converge in one room', async (t) => {
  const server = await RealServer.start();
  t.after(async () => {
    await server.stop();
  });

  const host = await SelvageEngine.host(server.wsBase, 'Ada', {
    client: 'selvage-vscode-test/0.1.0',
  });
  t.after(async () => {
    await host.disconnect();
  });
  const invite = host.inviteUrl();
  assert.ok(invite !== undefined, 'the host is given the token to share');

  await host.open(PATH);
  host.insert(PATH, 0, SEED);

  // The guest joins through the shared link, so the invite URL the engine minted is what
  // the other implementation reads.
  const peer = await RustPeer.start({ invite, path: PATH, name: 'Bob' });
  t.after(async () => {
    await peer.stop();
  });

  // --- the handshake, from both sides ---------------------------------------
  const joined = await peer.report();
  assert.equal(
    joined.session.room,
    host.session().roomId,
    'the Rust client joined the room the engine minted',
  );
  assert.equal(joined.session.role, 'guest');
  assert.deepEqual(
    joined.session.documents,
    [PATH],
    "the handshake reply carried the room's document set",
  );

  // --- the seed crossed implementations -------------------------------------
  // Read from the Rust replica, not from the server: the engine's insert had to arrive as
  // an encoded update and be merged there.
  const seeded = await waitForReport(
    peer,
    'the Rust replica to hold the engine’s seed',
    (report) => report.text === SEED,
  );
  assert.equal(seeded.text, SEED);

  // --- membership and the room's set, each side asked itself ----------------
  const bobOnEngine = await waitForPeer(host, 'Bob');
  assert.equal(bobOnEngine.role, 'guest');
  assert.equal(
    bobOnEngine.peer_id,
    joined.session.peer_id,
    'the server-minted peer id is the same one on both sides',
  );
  assert.equal(typeof bobOnEngine.awareness_client_id, 'number');

  const seen = await waitForReport(
    peer,
    'the Rust client to see Ada in the room',
    (report) => names(report.peers).join() === 'Ada:host',
  );
  assert.deepEqual(
    seen.peers.map((record) => record.awareness_client_id),
    [host.session().peer.awareness_client_id],
    'both sides map Ada to the same awareness client id',
  );
  assert.deepEqual(
    [...seen.documents].sort(),
    [...host.documents()].sort(),
    "both sides report the room's open-document set",
  );
  assert.deepEqual(seen.documents, [PATH]);

  // --- an anchor authored by one implementation, resolved by the other ------
  // Both directions, and the router in the middle only relays (§8.1), so an offset that
  // matches on the far side came from the anchor this side published.
  const caret = { anchor: AFTER_EMOJI, head: AFTER_EMOJI + 3 };
  host.setSelection(PATH, caret);

  const resolved = await waitForReport(
    peer,
    'the engine’s selection to resolve in the Rust replica',
    (report) => sameOffsets(ada(report)?.resolved, caret),
  );
  const onPeer = ada(resolved);
  assert.ok(onPeer !== undefined, 'the Rust client holds a record for Ada');
  assert.deepEqual(onPeer.resolved, caret);
  assert.equal(
    typeof onPeer.anchors?.anchor,
    'object',
    'the wire carried an anchor object, not an index',
  );

  await peer.select({ anchor: 0, head: 4 });
  const onEngine = await waitForSelection(
    host,
    'Bob',
    PATH,
    (selection) => selection.anchor === 0 && selection.head === 4,
  );
  assert.deepEqual(onEngine.selection, { anchor: 0, head: 4 });
  assert.equal(
    typeof onEngine.presence.state?.selection?.anchor,
    'object',
    'the wire carried an anchor object, not an index',
  );

  // --- one document, both sides editing, the edits held concurrent ----------
  // The engine holds its frames while the Rust client edits and converges on the seed
  // alone, so neither insert is in the other's causal history: what follows is a real
  // CRDT merge across two implementations, not a replay of a linear history.
  host.pauseOutbound(true);
  host.insert(PATH, 0, 'AAA ');
  const whileHeld = await peer.insert(0, 'BBB ');
  assert.ok(
    whileHeld.includes('BBB '),
    `the Rust client applied its own insert: ${JSON.stringify(whileHeld)}`,
  );
  assert.ok(
    !whileHeld.includes('AAA '),
    `the Rust edit was authored without seeing the engine's: ${JSON.stringify(whileHeld)}`,
  );
  host.pauseOutbound(false);

  const merged = await waitForReport(
    peer,
    'the two replicas to agree on the merged text',
    (report) =>
      report.text === host.text(PATH) &&
      report.text.includes('AAA ') &&
      report.text.includes('BBB '),
  );
  assert.ok(
    merged.text.startsWith('AAA BBB ') || merged.text.startsWith('BBB AAA '),
    `concurrent inserts stay contiguous: ${merged.text}`,
  );
  assert.equal(merged.text.length, SEED.length + 8);
  assert.ok(
    merged.text.includes('héllo 🧵'),
    'the merge kept the seed, astral character and all',
  );

  // Text equality alone is not convergence: the histories have to agree too (§7), and the
  // state vector is the one claim no single-implementation suite can make.
  const history = await waitForReport(
    peer,
    'the two state vectors to agree',
    (report) => vectorKey(report.state_vector) === vectorKey(host.stateVector()),
  );
  assert.equal(history.state_vector.length, 2, 'one entry per editing client');

  t.diagnostic(
    JSON.stringify({
      room: host.session().roomId,
      engine_peer_id: host.session().peer.peer_id,
      rust_peer_id: joined.session.peer_id,
      ada_awareness_client_id: seen.peers[0]?.awareness_client_id,
      seeded: seeded.text,
      merged: merged.text,
      state_vector: history.state_vector,
      documents: history.documents,
    }),
  );
});
