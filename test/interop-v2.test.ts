/**
 * Interop over the new wire: the real TypeScript engine hosts a `selvage/2` room and the real
 * Rust client joins it through the host's own invite — fragment and all — over one real
 * `selvaged` on its defaults, which seat both versions and advertise both.
 *
 * `interop.test.ts` beside this one drives `selvage/1` and keeps every claim it made there: one
 * room, the same text, the same state vectors, and presence and selections in both directions.
 * Here the wire is the zero-knowledge one. The server is a payload-opaque relay; the room's
 * listing and the roles live in a state the host signs and seals; and which role a connection
 * holds is a fact the peers verify rather than a value the server asserts (`PROTOCOL.md` §7.1,
 * §13.4). The two implementations are the ones that were written against that design — the
 * engine's `src/engine/relay.ts`, `src/engine/peer.ts` and `src/bridge/peer-engine.ts`, and
 * `reference_server`'s `selvage-client` — so what this file proves is that they agree on it.
 *
 * It needs the sibling `reference_server` checkout and an `interop_peer` built from a branch
 * that teaches that example `selvage/2` (`SELVAGE_INTEROP_PEER` names one), so it is not in CI
 * and not in `test:fast`: `npm run test:interop` runs it, and so does `npm test`.
 *
 * **What cannot be asserted on this wire, and is not asserted here.**
 *
 * - **Presence and awareness expiry.** The Rust side's `selvage/2` session applies no awareness
 *   and publishes none yet, so `interop_peer` answers `select` with `unsupported` and reports
 *   `presence: []` always. The caret assertions `interop.test.ts` makes have no counterpart
 *   here; that leg keeps making them.
 * - **The server-owned grant.** `selvage/2`'s server keeps membership only. The room's
 *   open-document set is §13.7's union of the live holds, which is what both sides are asked
 *   for below — a different fact from `selvage/1`'s `doc.granted`, and the only one there is.
 * - **A state vector on the engine's side.** The `selvage/2` relay exposes none, so history
 *   agreement is read from the Rust report alone. The version-1 leg still compares both.
 * - **Whether a state commits a given key yet.** A seat's role is the applied state's word
 *   (§13.4), but the way that state draws a key it does not name is `guest` too, and the
 *   `interop_peer` example declares no role, so neither replica can be asked the question. The
 *   reply is what says so: `insert`'s `published` is `true` only once a state commits the key.
 *
 * None of that weakens the version-1 leg: it asserts all of it, unchanged.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { PeerEngine } from '../src/bridge/peer-engine.ts';
import { SelvageEngine } from '../src/engine/engine.ts';
import { isProtocolError } from '../src/engine/errors.ts';
import { RustPeer, START_MS, waitForReport } from './helpers/interop_peer.ts';
import { RealServer } from './helpers/selvaged.ts';
import { WAIT_MS, waitFor } from './helpers/wait.ts';

const PATH = 'notes.txt';
const OTHER = 'src/main.rs';

/**
 * The seed carries an astral character on purpose: an implementation that counted bytes or code
 * points where the editor counts UTF-16 code units would place the Rust client's insert below
 * elsewhere, and the exact text asserted afterwards would differ on the two sides.
 */
const SEED = 'fn main() {\n    println!("héllo 🧵");\n}\n';

/** Just past the surrogate pair, so the Rust insert below is a UTF-16 offset and not an ASCII one. */
const AFTER_EMOJI = SEED.indexOf('🧵') + '🧵'.length;

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, at) => value === right[at]);
}

/** The engine's own view of a peer, from the roles the applied state assigns. */
async function waitForPeerOn(engine: PeerEngine, displayName: string) {
  return waitFor(
    `the engine to seat ${displayName}`,
    () =>
      engine
        .session()
        .peers.find((candidate) => candidate.display_name === displayName) ?? false,
    { describe: () => engine.session().peers },
  );
}

/**
 * Runs `work` and answers the refusal it raised. A call that succeeds is the failure: this is the
 * shape every anti-downgrade assertion below takes, because the defect it guards against is a
 * connection that comes up rather than one that raises. The refusal itself and not only its
 * sentence, because `ProtocolError.code` is the half a caller branches on and the half a refusal
 * has to carry to be told apart from any other fault.
 */
async function refusalOf(work: () => Promise<unknown>): Promise<Error> {
  try {
    await work();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('the call was expected to be refused, and it succeeded');
}

test('interop over selvage/2: the engine hosts, the Rust client joins with the sealed invite, and the two converge', async (t) => {
  const server = await RealServer.start();
  t.after(async () => {
    await server.stop();
  });

  // The listing a host publishes is sealed; the engine reads it through this source (§7.1).
  const tree = [PATH, OTHER];
  const host = await PeerEngine.host({
    baseUrl: server.wsBase,
    displayName: 'Ada',
    listing: {
      current: () => tree,
      replace: (paths: readonly string[]) => {
        tree.length = 0;
        tree.push(...paths);
      },
    },
    client: 'selvage-vscode-test/0.1.0',
  });
  t.after(() => {
    host.disconnect();
  });

  const invite = host.inviteUrl();
  assert.ok(invite !== undefined, 'the host is given the link to share');
  // §5.1: the room key and the host key are the fragment's, and nothing else's. A user agent
  // never sends the fragment, which is the whole of why the server cannot read the room.
  assert.match(invite, /#k=[A-Za-z0-9_-]{43}&h=[A-Za-z0-9_-]{43}$/);
  assert.ok(
    !invite.split('#')[0].includes('k=') && !invite.split('#')[0].includes('h='),
    'no key reaches the request line',
  );

  await host.open(PATH);
  host.insert(PATH, 0, SEED);

  // The guest joins through the link the engine minted, so what the second implementation reads
  // — fragment included — is what the engine wrote. No `--version` is passed on purpose: the
  // fragment is the selection, and a client that dropped or ignored it would dial `selvage/1`
  // and be refused by a room pinned to the other version. The explicit flag is exercised in the
  // held-back test below.
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
  // §13.4: this is the role the applied state gives this connection's own key. The Rust client
  // announces no role here, so nothing on the wire but the state could have said it. (`guest`
  // is also the fallback for a key no state names yet, which is why the seat list below is what
  // pins the state's arrival: `host` is a role no fallback produces.)
  assert.equal(joined.session.role, 'guest');
  assert.ok(joined.session.peer_id.length > 0, 'the handshake named this connection a seat');

  // --- the engine's sealed state reached the Rust client --------------------
  // `interop_peer`'s report carries no listing, so the state's arrival is read where it is
  // unambiguous: `host` is a role no fallback produces, so a Rust replica that names Ada as one
  // has applied the state the host sealed, roles and listing together.
  const seats = await waitForReport(
    peer,
    'the Rust replica to apply the sealed state',
    (report) =>
      report.peers.some(
        (record) => record.display_name === 'Ada' && record.role === 'host',
      ),
  );
  assert.deepEqual(
    seats.peers.map((record) => `${record.display_name}:${record.role}`),
    ['Ada:host'],
  );
  assert.deepEqual(seats.session.peers, seats.peers);

  const bobOnEngine = await waitForPeerOn(host, 'Bob');
  assert.equal(bobOnEngine.role, 'guest');
  assert.equal(
    bobOnEngine.peer_id,
    joined.session.peer_id,
    'the server-minted seat is the same one on both sides',
  );

  // --- §13.7: the open set, which is not the listing ------------------------
  const held = await waitForReport(
    peer,
    'both sides to name the same open-document set',
    (report) =>
      sameStrings(report.session.documents, host.session().documents),
  );
  assert.deepEqual(held.session.documents, [PATH]);
  assert.deepEqual(host.session().documents, [PATH]);
  assert.deepEqual(
    [...host.grantedPaths()].sort(),
    [PATH, OTHER].sort(),
    'the sealed listing names a path nobody holds, so the two sets are read apart',
  );

  // --- the seed crossed implementations -------------------------------------
  // Read from the Rust replica, not from the server: the engine's insert had to be sealed,
  // relayed byte for byte and applied there.
  const seeded = await waitForReport(
    peer,
    'the Rust replica to hold the engine’s seed',
    (report) => report.text === SEED,
  );
  assert.equal(seeded.text, SEED);

  // --- an edit from the Rust side, at an offset past the astral character ---
  const expected = `${SEED.slice(0, AFTER_EMOJI)}X${SEED.slice(AFTER_EMOJI)}`;
  const fromRust = await peer.insert(AFTER_EMOJI, 'X');
  assert.equal(fromRust, expected, 'the Rust client edited its own replica at a UTF-16 offset');
  const atEngine = await waitFor(
    'the engine to hold the Rust client’s edit',
    () => {
      const text = host.text(PATH);
      return text === expected ? text : false;
    },
    { describe: () => host.text(PATH) },
  );
  assert.equal(atEngine, expected);

  // --- and an edit from the engine reaches the Rust side --------------------
  const full = `AAA ${expected}`;
  host.insert(PATH, 0, 'AAA ');
  const backAtRust = await waitForReport(
    peer,
    'the Rust replica to hold the engine’s edit',
    (report) => report.text === full,
  );
  assert.equal(backAtRust.text, full);
  assert.equal(host.text(PATH), full, 'the two replicas hold the same text');

  // Both clients' edits are in one history. The engine's `selvage/2` relay exposes no state
  // vector, so this is the Rust side's own report: one clock per editing client.
  assert.equal(
    backAtRust.state_vector.length,
    2,
    `one entry per editing client: ${JSON.stringify(backAtRust.state_vector)}`,
  );

  t.diagnostic(
    JSON.stringify({
      room: host.session().roomId,
      engine_peer_id: host.session().peer.peer_id,
      rust_peer_id: joined.session.peer_id,
      seed: seeded.text,
      after_rust_edit: fromRust,
      converged: backAtRust.text,
      state_vector: backAtRust.state_vector,
      documents: held.session.documents,
      granted: [...host.grantedPaths()].sort(),
    }),
  );
});

test('interop over selvage/2: an edit made before a committing state is held, then published', async (t) => {
  const server = await RealServer.start();
  t.after(async () => {
    await server.stop();
  });

  // §7.1's publish-rate bound is what makes this deterministic, and the window below is derived
  // from the bound rather than guessed at. A host MAY treat one state as answering every
  // session-key announcement it accepts inside the next `awareness_renew_ms`, and it answers
  // none inside that window: so an announcement accepted in the window leaves the key
  // uncommitted until the window ends. The window is twice the harness's own bound on the
  // guest's startup — `START_MS`, the deadline `RustPeer.start` allows the first report, plus
  // `WAIT_MS`, the deadline the insert's reply gets — so on any run that reaches the assertion
  // below the fold cannot have ended first, whatever the machine is doing: a startup slower
  // than that budget fails `RustPeer.start`, loudly and with the step that stalled, rather than
  // reaching the assertion as a `published: true`. §8.2's expiry is four windows, which is more
  // than enough for a renewal to fall inside the expiry it renews.
  const publishWindowMs = 2 * (START_MS + WAIT_MS);
  const keepalive = {
    awareness_renew_ms: publishWindowMs,
    awareness_expire_ms: 4 * publishWindowMs,
  };
  const tree = [PATH];
  const host = await PeerEngine.host({
    baseUrl: server.wsBase,
    displayName: 'Ada',
    listing: {
      current: () => tree,
      replace: (paths: readonly string[]) => {
        tree.length = 0;
        tree.push(...paths);
      },
    },
    keepalive,
  });
  t.after(() => {
    host.disconnect();
  });
  const invite = host.inviteUrl();
  assert.ok(invite !== undefined);
  await host.open(PATH);
  host.insert(PATH, 0, SEED);

  // A warmer: a second guest whose announcement is the state that opens that window, because
  // §7.1 opens it on an answer and not on the clock. It declares `viewer`, which is what makes
  // the wait below the proof of the premise rather than a guess at it: a seat's role is the
  // applied state's word, and `guest` — the way every peer a state does not name is drawn — is
  // the one answer that cannot be `viewer`. So a state answering the warmer is published, and
  // the window is open, before the guest below is spawned; the wait cannot be satisfied by a
  // roster that merely seats it (`PROTOCOL.md` §13.4).
  const warmer = await PeerEngine.join({
    invite,
    displayName: 'Cy',
    declaredRole: 'viewer',
    keepalive,
  });
  t.after(() => {
    warmer.disconnect();
  });
  const warmerSeat = warmer.session().peer.peer_id;
  await waitFor(
    "the host’s state to commit the warmer’s key, which opens the publish window",
    () =>
      host.session().peers.find((record) => record.peer_id === warmerSeat)?.role ===
      'viewer',
    { describe: () => host.session().peers },
  );

  // Spawned inside that window. Nothing else the host publishes in the meantime commits this
  // guest's key: the room announces `peer.joined` before it relays a word of the joining
  // connection's own, so the roster state that join obliges is published without the key, and
  // §7.1's window is what folds the announcement that follows it.
  const peer = await RustPeer.start({ invite, path: PATH, name: 'Bob', version: 2 });
  t.after(async () => {
    await peer.stop();
  });

  // §13.1's step 4: the edit is applied here and published by nobody, and the reply says
  // `published: false` rather than refusing. How much of the seed the guest holds by now is not
  // read: content is applied while no state commits this key, so its replica may be empty or may
  // hold the seed when the edit lands, and where the merge then puts the text is the CRDT's
  // business. That the edit and the seed both arrive is what is asserted. A `true` here would
  // mean the host had already published a state committing this key, which is the premise the
  // window above exists for and not a refusal; the reply is printed so the two read apart.
  const held = await peer.insertReply(0, 'guest: ');
  assert.equal(
    held.published,
    false,
    `the first edit is held, not refused: ${JSON.stringify(held)}`,
  );
  assert.ok(
    held.text.includes('guest: '),
    `the edit is in the Rust replica meanwhile: ${JSON.stringify(held)}`,
  );

  // §13.1's step 4 releases the frame on the first state that commits this connection's key, and
  // §7.1 obliges a state whenever the host's listing changes — a state that carries every key
  // committed by then, the guest's among them as soon as the host has accepted its announcement.
  // Whether it has yet is not something this side can read: §7.1 folds an announcement inside the
  // window above rather than answering it, the announcement is written by a second process whose
  // own first report may be printed before it, and the guest's role says nothing (a key no state
  // names is drawn `guest` as well). So the test asks for one listing state per attempt until the
  // edit lands: an attempt that lands before the announcement is accepted publishes a state
  // without the key — one §7.1 owes on the change anyway — and the next one carries it. A host
  // answering the folded announcement at the window's own end is `test/host.test.ts`'s subject;
  // waiting for that here would cost this test the window the premise above needs, not the tenths
  // of a second it costs this way. `WAIT_MS` bounds the attempts, so a release that never comes
  // is reported with the number of states the host published for it rather than waited out.
  const releaseDeadline = Date.now() + WAIT_MS;
  let statesAsked = 0;
  let atEngine = host.text(PATH);
  while (!atEngine.includes('guest: ') && Date.now() < releaseDeadline) {
    statesAsked += 1;
    // The listing is replaced wholesale by every state, so the attempts alternate the tree the
    // host shares: a state that only repeated the last one would be §7.1's re-send and carry no
    // key the state before it did not.
    await host.grant(statesAsked % 2 === 1 ? [PATH, OTHER] : [PATH]);
    await delay(25);
    atEngine = host.text(PATH);
  }
  assert.ok(
    atEngine.includes('guest: '),
    `the held edit is still unpublished after ${statesAsked} listing states and ${WAIT_MS}ms, and the engine holds ${JSON.stringify(atEngine)}`,
  );
  assert.ok(atEngine.includes(SEED), 'the seed and the held edit are both there');

  const bobOnEngine = await waitForPeerOn(host, 'Bob');
  assert.equal(bobOnEngine.role, 'guest', 'the committing state names the guest’s seat');

  const converged = await waitForReport(
    peer,
    'the two replicas to agree on the merged text',
    (report) => report.text === host.text(PATH),
  );
  assert.equal(converged.text, atEngine);

  // And the edit that follows is published: the state that commits a key is what §13.1's step 4
  // was waiting for, and this is the flip a driver reads instead of a refusal.
  const published = await peer.insertReply(0, 'more: ');
  assert.equal(
    published.published,
    true,
    `the next edit goes out: ${JSON.stringify(published)}`,
  );
  assert.ok(published.text.startsWith('more: '));

  t.diagnostic(
    JSON.stringify({
      room: host.session().roomId,
      held: held.text,
      published_after_commit: published.text,
      merged: converged.text,
      documents: host.session().documents,
    }),
  );
});

test('interop over selvage/2: a sealed invite is refused by a server that does not seat the version', async (t) => {
  // The one failure mode a confidentiality feature cannot have is the silent downgrade, so the
  // negative control is the point of this file's third test: the whole link is used against a
  // server that seats `selvage/1` only, and every path that could drop the fragment and come up
  // as version 1 has to refuse instead.
  const sealedServer = await RealServer.start();
  // `selvage/1` alone, which is a server this client refuses to host on and one it cannot
  // silently fall back to.
  const plainServer = await RealServer.start({ serveVersion1Only: true });
  t.after(async () => {
    await plainServer.stop();
    await sealedServer.stop();
  });

  const host = await PeerEngine.host({
    baseUrl: sealedServer.wsBase,
    displayName: 'Ada',
    listing: { current: () => [PATH], replace: () => undefined },
  });
  const sealed = host.inviteUrl();
  host.disconnect();
  assert.ok(sealed !== undefined);
  // The same sealed invite, addressed at the server that does not seat the version. Only the
  // address moves: the fragment is still the whole of what names the room.
  const misplaced = sealed.replace(sealedServer.address, plainServer.address);
  assert.match(
    misplaced,
    /#k=[A-Za-z0-9_-]{43}&h=[A-Za-z0-9_-]{43}$/,
    'the fragment survives the rewrite, so the link still names a selvage/2 room',
  );

  // The Rust client reads the fragment, dials, and the server refuses the version rather than
  // seating the connection as version 1. The refusal names the code it was refused with.
  const rustRefusal = await refusalOf(() =>
    RustPeer.start({ invite: misplaced, path: PATH, name: 'Bob', version: 2 }),
  );
  assert.match(rustRefusal.message, /unsupported_version/, rustRefusal.message);
  assert.match(
    rustRefusal.message,
    /unsupported wire version selvage\/2/,
    rustRefusal.message,
  );

  // The engine must not come up as version 1 either. It raises, and resolving is the silent
  // downgrade this whole test exists to catch. What it was refused with is asserted, not only
  // that it refused: the relay reads the code and the sentence from the `session.error` event's
  // `params`, exactly as `src/engine/engine.ts` reads them for `selvage/1`, so the same refusal
  // the Rust client names arrives at this caller with the same code beneath it. A relay that read
  // the wrong field refused with one generic sentence and no code at all, which left a caller
  // unable to tell `§11`'s terminal codes apart from an ordinary fault.
  const engineRefusal = await refusalOf(() =>
    PeerEngine.join({ invite: misplaced, displayName: 'Bob' }),
  );
  assert.ok(
    isProtocolError(engineRefusal, 'unsupported_version'),
    `the engine refused with ${engineRefusal.name}: ${engineRefusal.message}`,
  );
  assert.match(
    engineRefusal.message,
    /unsupported wire version selvage\/2/,
    engineRefusal.message,
  );

  // The choice is exact in both directions, and a mismatch is an error before a socket opens.
  const fragmentless = `ws://${plainServer.address}/session?room=r-1&token=t-1`;
  const toldTwo = await refusalOf(() =>
    RustPeer.start({ invite: fragmentless, path: PATH, name: 'Bob', version: 2 }),
  );
  assert.match(toldTwo.message, /carries no fragment/, toldTwo.message);
  const toldOne = await refusalOf(() =>
    RustPeer.start({ invite: sealed, path: PATH, name: 'Bob', version: 1 }),
  );
  assert.match(toldOne.message, /two keys/, toldOne.message);
  // And the engine refuses a link that names no key rather than joining it as version 1. Its own
  // sentence says so, and it is read from the link before a socket is opened: §5.1 puts the key
  // material in the fragment, so a link without one leaves this engine nothing to dial for. The
  // factory is armed to hold that: a refusal that dialled anyway fails here rather than passing.
  let dialled = false;
  const keyless = await refusalOf(() =>
    PeerEngine.join({
      invite: fragmentless,
      displayName: 'Bob',
      webSocketFactory: () => {
        dialled = true;
        throw new Error('the engine dialled a link whose fragment names no key');
      },
    }),
  );
  assert.match(keyless.message, /carries no fragment/, keyless.message);
  assert.ok(!dialled, 'the fragment is read before a connection is opened');

  // The positive control, so the refusals above are the fragment's doing and not a server that
  // seats nobody: the same `selvage/1`-only server mints a version-1 room and seats the same
  // Rust client in it, and that client's replies carry no `published` member at all because
  // version 1 has nothing to say about it.
  const plainHost = await SelvageEngine.host(plainServer.wsBase, 'Ada', {
    client: 'selvage-vscode-test/0.1.0',
  });
  t.after(async () => {
    await plainHost.disconnect();
  });
  const plainInvite = plainHost.inviteUrl();
  assert.ok(plainInvite !== undefined);
  assert.ok(
    !plainInvite.includes('#'),
    'a version-1 link carries no fragment, which is what makes the two links distinguishable',
  );
  const plainPeer = await RustPeer.start({ invite: plainInvite, path: PATH, name: 'Bob' });
  t.after(async () => {
    await plainPeer.stop();
  });
  const plainReport = await plainPeer.report();
  assert.equal(plainReport.session.role, 'guest');
  assert.equal(plainReport.session.room, plainHost.session().roomId);
  const plainInsert = await plainPeer.insertReply(0, 'plain ');
  assert.equal(
    plainInsert.published,
    undefined,
    'selvage/1 has no step 4 and so reports nothing about publishing',
  );
});
