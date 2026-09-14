/**
 * The bridge, over the fake `selvaged` and a fake editor: the host path and the guest path
 * without VS Code in scope.
 *
 * The engines here are the real `SelvageEngine`, so these tests exercise the seam as it is
 * used — the handshake, `doc.open`, sync frames, awareness and reconnect semantics are all
 * the engine's, and what is under test is the adapter's half: seeding, the two directions
 * of the loop, the EOL policy, the save policy and cursor attribution. The editor fake
 * reproduces the one timing that matters (`SPIKES.md`, spike 2): a change this adapter
 * applied itself reports back a few macrotasks later, as a coalesced editor event does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import { SessionBridge, DEFAULT_MAX_APPLY_ATTEMPTS } from '../src/bridge/bridge.ts';
import type { BridgeOptions, Engine, Timers } from '../src/bridge/bridge.ts';
import { peerColour } from '../src/bridge/cursors.ts';
import type { Cursor } from '../src/bridge/cursors.ts';
import { render } from '../src/bridge/editing.ts';
import type { AwarenessState, OffsetSelection, Presence, Selection } from '../src/engine/presence.ts';
import type { PeerInfo, Role } from '../src/engine/envelope.ts';
import type { SessionInfo, SelvageEngine } from '../src/engine/engine.ts';
import { FakeEditor, QueuedEditor } from './helpers/fake-editor.ts';
import type { FakeServerOptions } from './helpers/fake-server.ts';
import { fakeSession } from './helpers/session.ts';
import { converge, waitFor, waitForPeer, waitForSelection } from './helpers/wait.ts';

const PATH = 'src/main.rs';
const OTHER = 'src/other.rs';
const FILE = 'fn main() {}\n';

/** Timers a test drives, so the save policy is checked without waiting for one. */
class ManualTimers implements Timers {
  private readonly pending = new Map<number, { delayMs: number; run: () => void }>();
  /** Every deadline ever asked for, so a reschedule can be told from a first schedule. */
  readonly scheduled: number[] = [];
  private next = 1;

  after(delayMs: number, run: () => void): () => void {
    const id = this.next;
    this.next += 1;
    this.scheduled.push(delayMs);
    this.pending.set(id, { delayMs, run });
    return () => {
      this.pending.delete(id);
    };
  }

  /** The deadlines waiting, in order. */
  delays(): number[] {
    return [...this.pending.values()].map((entry) => entry.delayMs);
  }

  /** The deadlines waiting for the save, with the backstop's filtered out. */
  saveDelays(): number[] {
    return this.delays().filter((delay) => delay === 500);
  }

  /** Runs everything waiting, whichever deadline it was given. */
  fire(): void {
    for (const [id, entry] of [...this.pending]) {
      this.pending.delete(id);
      entry.run();
    }
  }
}

/** The real engine, as the slice the bridge talks to. A drift here is a compile error. */
function slice(engine: SelvageEngine): Engine {
  return engine;
}

interface Windows {
  session: Awaited<ReturnType<typeof fakeSession>>;
  host: { editor: FakeEditor; bridge: SessionBridge };
  guest: { editor: FakeEditor; bridge: SessionBridge };
}

/** A host window and a guest window on one room, each with an editor of its own. */
async function twoWindows(
  t: TestContext,
  serverOptions: FakeServerOptions = {},
  bridgeOptions: Partial<Omit<BridgeOptions, 'engine' | 'host'>> = {},
): Promise<Windows> {
  const session = await fakeSession(serverOptions);
  const hostEditor = new FakeEditor();
  const guestEditor = new FakeEditor();
  const hostBridge = new SessionBridge({
    ...bridgeOptions,
    engine: slice(session.host),
    host: hostEditor,
  });
  const guestBridge = new SessionBridge({
    ...bridgeOptions,
    engine: slice(session.guest),
    host: guestEditor,
  });
  hostEditor.attach(hostBridge);
  guestEditor.attach(guestBridge);
  t.after(async () => {
    hostBridge.dispose();
    guestBridge.dispose();
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  return {
    session,
    host: { editor: hostEditor, bridge: hostBridge },
    guest: { editor: guestEditor, bridge: guestBridge },
  };
}

/** A host window whose `applyEdit` is a macrotask, against the real engine and fake server. */
async function queuedWindows(
  t: TestContext,
  bridgeOptions: Partial<Omit<BridgeOptions, 'engine' | 'host'>> = {},
  serverOptions: FakeServerOptions = {},
): Promise<{ session: Awaited<ReturnType<typeof fakeSession>>; editor: QueuedEditor; bridge: SessionBridge }> {
  const session = await fakeSession(serverOptions);
  const editor = new QueuedEditor();
  const bridge = new SessionBridge({
    ...bridgeOptions,
    engine: slice(session.host),
    host: editor,
  });
  editor.attach(bridge);
  t.after(async () => {
    bridge.dispose();
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  return { session, editor, bridge };
}

/** Lands every queued apply, and the applies the ones that land ask for, until it stops. */
async function drain(editor: QueuedEditor, turns = 8): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    editor.pump();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * An engine stub for the rules that are about what the bridge asks the engine, not about what
 * a real replica does. A real `SelvageEngine` satisfies the same interface in the tests above.
 */
class EngineStub implements Engine {
  readonly texts = new Map<string, string>();
  readonly inserted: Array<[string, number, string]> = [];
  readonly deleted: Array<[string, number, number]> = [];
  readonly selections: Array<[string, OffsetSelection]> = [];
  presenceList: Presence[] = [];
  resolved: OffsetSelection | undefined;
  role: Role = 'host';

  has(path: string): boolean {
    return this.texts.has(path);
  }

  text(path: string): string {
    return this.texts.get(path) ?? '';
  }

  session(): SessionInfo {
    return {
      roomId: 'r-1',
      role: this.role,
      peer: { peer_id: 'p-local', display_name: 'Me', role: this.role },
    } as unknown as SessionInfo;
  }

  open(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  insert(path: string, index: number, text: string): void {
    this.inserted.push([path, index, text]);
    const current = this.text(path);
    this.texts.set(path, current.slice(0, index) + text + current.slice(index));
  }

  delete(path: string, index: number, length: number): void {
    this.deleted.push([path, index, length]);
    const current = this.text(path);
    this.texts.set(path, current.slice(0, index) + current.slice(index + length));
  }

  setSelection(path: string, selection: OffsetSelection): void {
    this.selections.push([path, selection]);
  }

  setAwareness(_state: AwarenessState | null): void {
    // Nothing to publish in a stub.
  }

  presence(): Presence[] {
    return this.presenceList;
  }

  resolveSelection(_path: string, _selection: Selection): OffsetSelection | undefined {
    return this.resolved;
  }

  on(): () => void {
    return () => undefined;
  }
}

/** A peer presence record carrying a caret, for the cursor tests. */
function peerCaret(path: string): Presence {
  const peer: PeerInfo = { peer_id: 'p-bob', display_name: 'Bob', role: 'guest' };
  const selection: Selection = {
    anchor: { assoc: 0, tname: path },
    head: { assoc: 0, tname: path },
  };
  return { clientId: 2, peer, state: { path, selection } };
}

test('a host seeds an open file into the replica and offers it to the room', async (t) => {
  const { session, host, guest } = await twoWindows(t);
  host.editor.open(PATH, FILE);
  host.bridge.documentOpened(PATH);

  // Seeding is this adapter's own transaction, so it needs no round trip.
  assert.equal(session.host.text(PATH), FILE);
  assert.deepEqual(host.bridge.openDocuments(), [PATH]);
  assert.equal(host.bridge.role(), 'host');

  await waitFor('the room to offer the path to the guest', () =>
    guest.editor.reportsOf('documents').some((report) => report.documents.includes(PATH)),
  );
  assert.deepEqual(session.host.documents(), [PATH]);
});

test('a local edit reaches the room, and the change event it raises is not published again', async (t) => {
  const { session, host } = await twoWindows(t);
  host.editor.open(PATH, 'base\n');
  host.bridge.documentOpened(PATH);
  await waitFor('the guest to have the document', () => session.guest.text(PATH) === 'base\n');

  host.editor.type(PATH, 'base\ntyped\n');
  assert.equal(session.host.text(PATH), 'base\ntyped\n');
  assert.equal(await converge(session.host, session.guest, PATH), 'base\ntyped\n');

  // The fake editor reports the change back as it would any other; the buffer already
  // holds the replica, so nothing is written a second time.
  await host.editor.settle();
  assert.equal(session.host.text(PATH), 'base\ntyped\n');
});

test("a peer's edit lands as the smallest change, and its change event publishes nothing", async (t) => {
  const { session, host } = await twoWindows(t);
  host.editor.open(PATH, 'line one\nline two\n');
  host.bridge.documentOpened(PATH);
  await waitFor('the guest to have the document', () =>
    session.guest.text(PATH) === 'line one\nline two\n',
  );

  session.guest.insert(PATH, 9, 'X');
  await waitFor('the peer edit to reach the buffer', () =>
    host.editor.text(PATH) === 'line one\nXline two\n',
  );

  // Not a whole-document replacement: the prefix and suffix are left alone, which is what
  // keeps a remote edit from collapsing undo granularity or resetting folding.
  assert.deepEqual(host.editor.changes.get(PATH), [{ start: 9, end: 9, text: 'X' }]);

  const before = JSON.stringify(session.host.stateVector());
  await host.editor.settle();
  assert.equal(session.host.text(PATH), 'line one\nXline two\n');
  assert.equal(
    JSON.stringify(session.host.stateVector()),
    before,
    'the echo of the applied change made a transaction',
  );
  assert.equal(session.guest.text(PATH), 'line one\nXline two\n');
});

test('a CRLF document keeps its line endings, and a CRLF never reaches the replica', async (t) => {
  const { session, host } = await twoWindows(t);
  host.editor.open(PATH, 'line one\r\nline two\r\n', '\r\n');
  host.bridge.documentOpened(PATH);
  assert.equal(session.host.text(PATH), 'line one\nline two\n');
  await waitFor('the guest to have it', () => session.guest.text(PATH) === 'line one\nline two\n');

  // The guest edits the second line: offset 9 in the replica, offset 10 in this buffer,
  // because the line above it is one byte longer here.
  session.guest.insert(PATH, 9, 'Y');
  await waitFor('the peer edit to reach the buffer', () =>
    host.editor.text(PATH) === 'line one\r\nYline two\r\n',
  );
  assert.deepEqual(host.editor.changes.get(PATH), [{ start: 10, end: 10, text: 'Y' }]);

  const before = JSON.stringify(session.host.stateVector());
  await host.editor.settle();
  assert.equal(session.host.text(PATH), 'line one\nYline two\n', 'a CRLF reached the replica');
  assert.equal(JSON.stringify(session.host.stateVector()), before);
  assert.equal(render(session.guest.text(PATH), '\r\n'), host.editor.text(PATH));
});

test('a keystroke inside the apply window is published, not swallowed as the echo', async (t) => {
  const { session, host } = await twoWindows(t);
  host.editor.open(PATH, 'base\n');
  host.bridge.documentOpened(PATH);
  await waitFor('the guest to have the document', () => session.guest.text(PATH) === 'base\n');

  // The applied change's own event arrives three macrotasks late; the user types inside
  // that window, which is where a boolean guard loses the keystroke.
  host.editor.eventDelayTicks = 3;
  session.guest.insert(PATH, 0, 'REMOTE\n');
  await waitFor('the peer edit to reach the buffer', () =>
    (host.editor.text(PATH) ?? '').startsWith('REMOTE'),
  );
  host.editor.type(PATH, 'REMOTE\nbase\ntyped\n');

  await host.editor.settle();
  assert.equal(session.host.text(PATH), 'REMOTE\nbase\ntyped\n', 'the keystroke was lost');
  assert.equal(await converge(session.host, session.guest, PATH), 'REMOTE\nbase\ntyped\n');
});

test('a refused change settles and is reported rather than retried forever', async (t) => {
  const { session, host } = await twoWindows(t);
  host.editor.open(PATH, 'base\n');
  host.bridge.documentOpened(PATH);
  await waitFor('the guest to have the document', () => session.guest.text(PATH) === 'base\n');

  // `workspace.applyEdit` returns false and leaves the buffer alone.
  host.editor.accepts = false;
  session.guest.insert(PATH, 0, 'REMOTE\n');
  await waitFor('the refusal to be reported', () => host.editor.reportsOf('applyRefused').length === 1);
  assert.equal(host.editor.text(PATH), 'base\n');
  const attempts = host.editor.refused.length;
  assert.ok(attempts > 0, 'the change was never attempted');
  assert.ok(
    attempts <= DEFAULT_MAX_APPLY_ATTEMPTS,
    `the refusal was retried ${attempts} times`,
  );

  // It has settled: no timer is left, and nothing retries behind the user's back.
  await host.editor.settle();
  assert.equal(host.editor.refused.length, attempts, 'the refusal kept retrying');

  // The editor accepts again; a reconcile is what brings the room's change in.
  host.editor.accepts = true;
  host.bridge.reconcile(PATH);
  assert.equal(host.editor.text(PATH), 'REMOTE\nbase\n');
});

test('a remote edit is written once the room settles on it', async (t) => {
  const timers = new ManualTimers();
  const { session, host } = await twoWindows(t, {}, { timers });
  host.editor.open(PATH, 'base\n');
  host.bridge.documentOpened(PATH);
  await waitFor('the guest to have the document', () => session.guest.text(PATH) === 'base\n');

  session.guest.insert(PATH, 0, 'one\n');
  await waitFor('the peer edit to reach the buffer', () => host.editor.text(PATH) === 'one\nbase\n');
  assert.deepEqual(timers.saveDelays(), [500], 'no write is pending');
  assert.deepEqual(host.editor.saves, [], 'the document was written before the room settled');

  // A second edit inside the window moves the deadline rather than adding a write.
  session.guest.insert(PATH, 0, 'two\n');
  await waitFor('the second edit to reach the buffer', () =>
    host.editor.text(PATH) === 'two\none\nbase\n',
  );
  assert.deepEqual(timers.saveDelays(), [500], 'a second remote edit added a second write');

  timers.fire();
  assert.deepEqual(host.editor.saves, [PATH]);

  // A local edit is not the room's: the document is the user's own and it is the editor
  // that decides when it is written.
  host.editor.type(PATH, 'two\none\nbase\ntyped\n');
  assert.deepEqual(timers.saveDelays(), []);
  assert.deepEqual(host.editor.saves, [PATH]);
});

test('auto-save can be turned off, and a closed document is never written', async (t) => {
  const timers = new ManualTimers();
  const { session, host } = await twoWindows(t, {}, { timers, autoSave: false });
  host.editor.open(PATH, 'base\n');
  host.bridge.documentOpened(PATH);
  await waitFor('the guest to have the document', () => session.guest.text(PATH) === 'base\n');

  session.guest.insert(PATH, 0, 'one\n');
  await waitFor('the peer edit to reach the buffer', () => host.editor.text(PATH) === 'one\nbase\n');
  assert.deepEqual(timers.saveDelays(), [], 'a write was scheduled with auto-save off');

  // The same session, saving: a document the editor closed inside the window is not
  // written, because there is nothing left to write it to.
  const saving = new ManualTimers();
  const second = await twoWindows(t, {}, { timers: saving });
  second.host.editor.open(PATH, 'base\n');
  second.host.bridge.documentOpened(PATH);
  await waitFor('the guest to have the second document', () =>
    second.session.guest.text(PATH) === 'base\n',
  );
  second.session.guest.insert(PATH, 0, 'one\n');
  await waitFor('the peer edit to reach the second buffer', () =>
    second.host.editor.text(PATH) === 'one\nbase\n',
  );
  second.host.editor.close(PATH);
  second.host.bridge.documentClosed(PATH);
  saving.fire();
  assert.deepEqual(second.host.editor.saves, []);
});

test("closing a file releases this client's hold on the room's document set", async (t) => {
  const { session, host } = await twoWindows(t);
  host.editor.open(PATH, FILE);
  host.bridge.documentOpened(PATH);
  await waitFor('the room to offer the path', () => session.host.documents().includes(PATH));

  host.editor.close(PATH);
  host.bridge.documentClosed(PATH);
  await waitFor('the room to drop the path', () => session.host.documents().length === 0);
  assert.deepEqual(host.bridge.openDocuments(), []);
  assert.deepEqual(
    session.server.requests.filter((request) => request.method === 'doc.close'),
    [{ client: 'Ada', method: 'doc.close', path: PATH }],
  );
});

test('a refused doc.open is reported, and leaves no hold to release', async (t) => {
  const { session, host } = await twoWindows(t);
  session.server.refusedOpens.add(PATH);
  host.editor.open(PATH, FILE);
  host.bridge.documentOpened(PATH);

  await waitFor('the refusal to be reported', () =>
    host.editor.reportsOf('sessionError').length === 1,
  );
  const refusal = host.editor.reportsOf('sessionError')[0];
  assert.equal(refusal?.code, 'bad_params');
  assert.match(refusal?.message ?? '', /refused to open src\/main\.rs/);

  host.editor.close(PATH);
  host.bridge.documentClosed(PATH);
  assert.equal(
    session.server.requests.filter((request) => request.method === 'doc.close').length,
    0,
    'a close was sent for a document this client never held',
  );
});

test('a guest adopts what the room has, and never seeds over it', async (t) => {
  const { session, host, guest } = await twoWindows(t);

  // The guest opens the path first, from its virtual document, before anything is shared.
  guest.editor.open(PATH, '');
  guest.bridge.documentOpened(PATH);
  assert.equal(guest.bridge.role(), 'guest');
  assert.equal(session.guest.text(PATH), '', 'the guest seeded something');

  host.editor.open(PATH, 'from the host\n');
  host.bridge.documentOpened(PATH);
  await waitFor('the content to reach the guest buffer', () =>
    guest.editor.text(PATH) === 'from the host\n',
  );
  await guest.editor.settle();
  assert.equal(session.guest.text(PATH), 'from the host\n', 'the guest doubled the content');
  assert.equal(guest.editor.text(PATH), 'from the host\n');
});

test('a host that opens a file the room has already edited follows the room', async (t) => {
  const { session, host } = await twoWindows(t);
  session.guest.insert(PATH, 0, 'from the room\n');
  await waitFor('the room to hold the text', () => session.host.text(PATH) === 'from the room\n');

  host.editor.open(PATH, 'a stale copy on disk\n');
  host.bridge.documentOpened(PATH);

  assert.equal(session.host.text(PATH), 'from the room\n', 'the disk copy was seeded over');
  assert.equal(host.editor.text(PATH), 'from the room\n', 'the stale buffer was left in place');
});

test('a peer cursor resolves to offsets here, in a colour every client agrees on', async (t) => {
  const { session, host, guest } = await twoWindows(t);
  host.editor.open(PATH, 'line one\nline two\n');
  host.bridge.documentOpened(PATH);
  await waitFor('the guest to have the document', () =>
    session.guest.text(PATH) === 'line one\nline two\n',
  );
  // The guest's virtual document reads what the replica holds, and the guest opens it.
  guest.editor.open(PATH, session.guest.text(PATH));
  guest.bridge.documentOpened(PATH);
  const bob = await waitForPeer(session.host, 'Bob');

  guest.bridge.selectionChanged(PATH, { anchor: 0, head: 4 });
  const cursor = await waitFor('the host to draw a cursor for Bob', () => host.editor.cursors[0]);
  assert.equal(cursor.peerId, bob.peer_id);
  assert.equal(cursor.label, 'Bob');
  assert.equal(cursor.role, 'guest');
  assert.equal(cursor.path, PATH);
  assert.deepEqual([cursor.anchor, cursor.head], [0, 4]);
  assert.equal(cursor.colour, peerColour(bob.peer_id));
  assert.equal(cursor.fill, `${cursor.colour}40`);

  // The user's own cursor is the editor's to draw.
  host.bridge.selectionChanged(PATH, { anchor: 9, head: 9 });
  await host.editor.settle(2);
  assert.equal(host.editor.cursors.length, 1);

  // A peer in a document this replica has received nothing for renders no cursor at all,
  // rather than a caret at offset 0. The sender is the one that withholds here — it cannot
  // anchor an endpoint in a text it does not have (§8.1), so it publishes the path alone —
  // and the receiver draws nothing rather than guessing.
  guest.editor.open(OTHER, '');
  guest.bridge.documentOpened(OTHER);
  guest.bridge.selectionChanged(OTHER, { anchor: 0, head: 1 });
  await waitFor('the cursor to be withdrawn', () => host.editor.cursors.length === 0);

  // And a peer that clears its state — the adapter does that when the user leaves the
  // session's documents, which is any editor that is not a shared one — draws nothing too.
  guest.bridge.selectionCleared();
  await waitFor('the peer to leave with its cursor', () => host.editor.cursors.length === 0);
});

test('a leaving host, a destroyed room and a dead connection are reported in order', async (t) => {
  const { session, guest } = await twoWindows(t, { roomGraceMs: 100 });

  await session.host.disconnect();
  await waitFor('the detachment to be reported', () =>
    guest.editor.reportsOf('hostDetached').length === 1,
  );
  assert.equal(guest.editor.reportsOf('hostDetached')[0]?.graceMs, 100);

  await waitFor('the room to be reported gone', () =>
    guest.editor.reportsOf('roomGone').length === 1,
  );
  assert.equal(guest.editor.reportsOf('roomGone')[0]?.reason, 'host did not return');

  await waitFor('the connection to be reported ended', () =>
    guest.editor.reportsOf('disconnected').length === 1,
  );
  const kinds = guest.editor.reports.map((report) => report.kind);
  assert.ok(
    kinds.indexOf('hostDetached') < kinds.indexOf('roomGone'),
    `detachment came after the room was gone: ${kinds.join(', ')}`,
  );
  assert.ok(
    kinds.indexOf('roomGone') < kinds.indexOf('disconnected'),
    `the room was reported gone after the connection ended: ${kinds.join(', ')}`,
  );
});

test('two remote updates inside one apply round-trip corrupt neither the room nor the file', async (t) => {
  const timers = new ManualTimers();
  const { session, editor, bridge } = await queuedWindows(t, { timers });
  editor.open(PATH, 'base\n');
  bridge.documentOpened(PATH);
  await waitFor('the guest to have the document', () => session.guest.text(PATH) === 'base\n');

  // Both peer updates reach the replica before the first `applyEdit` has landed.
  session.guest.insert(PATH, 0, 'ONE\n');
  session.guest.insert(PATH, 4, 'TWO\n');
  await waitFor('the replica to hold both', () => session.host.text(PATH) === 'ONE\nTWO\nbase\n');
  await drain(editor);

  const settled = 'ONE\nTWO\nbase\n';
  assert.equal(editor.text(PATH), settled, 'the buffer was corrupted by a stale range');
  assert.equal(session.host.text(PATH), settled, 'the room converged on a corrupt buffer');

  timers.fire();
  assert.deepEqual(editor.savedText, [settled], 'the file on disk was corrupted');
});

test('a keystroke while a remote edit is in flight is published, not doubled', async (t) => {
  const { session, editor, bridge } = await queuedWindows(t, { autoSave: false });
  editor.open(PATH, 'base\n');
  bridge.documentOpened(PATH);
  await waitFor('the guest to have the document', () => session.guest.text(PATH) === 'base\n');

  session.guest.insert(PATH, 0, 'REMOTE\n');
  // The user typed at the end before the queued apply ran. The buffer is the pre-apply text
  // plus the keystroke, and a diff against the replica now would delete the peer's edit.
  editor.type(PATH, 'base\ntyped\n');
  await drain(editor);

  assert.equal(editor.text(PATH), 'REMOTE\nbase\ntyped\n');
  assert.equal(session.host.text(PATH), 'REMOTE\nbase\ntyped\n', 'the keystroke was lost');
  assert.equal(await converge(session.host, session.guest, PATH), 'REMOTE\nbase\ntyped\n');
  assert.equal(editor.text(PATH), 'REMOTE\nbase\ntyped\n', 'the remote edit was doubled');
});

test('a CRLF document publishes and draws carets at buffer offsets, end of file included', async (t) => {
  const { session, host, guest } = await twoWindows(t);
  host.editor.open(PATH, 'line one\r\nline two\r\n', '\r\n');
  host.bridge.documentOpened(PATH);
  await waitFor('the guest to have it', () => session.guest.text(PATH) === 'line one\nline two\n');
  guest.editor.open(PATH, session.guest.text(PATH));
  guest.bridge.documentOpened(PATH);

  // Outgoing: the caret after the first line break is buffer offset 10, replica offset 9.
  host.bridge.selectionChanged(PATH, { anchor: 10, head: 10 });
  const mid = await waitForSelection(session.guest, 'Ada', PATH, (selection) => selection.anchor === 9);
  assert.equal(mid.selection.anchor, 9);

  // End of file: buffer offset 20 is replica offset 18, the replica's last position. The
  // sender withholds a selection it cannot anchor, so a missing conversion here is no caret.
  host.bridge.selectionChanged(PATH, { anchor: 20, head: 20 });
  const atEnd = await waitForSelection(session.guest, 'Ada', PATH, (selection) => selection.anchor === 18);
  assert.equal(atEnd.selection.anchor, 18);

  // Incoming: a peer's replica offset 9 is drawn one column further right here.
  guest.bridge.selectionChanged(PATH, { anchor: 9, head: 9 });
  const cursor: Cursor = await waitFor('the host to draw Bob', () =>
    host.editor.cursors.find((drawn) => drawn.label === 'Bob'),
  );
  assert.equal(cursor.anchor, 10);
  assert.equal(cursor.head, 10);
});

test('a host whose disk copy is empty does not overwrite a room that has emptied a document', async (t) => {
  const { session, host } = await twoWindows(t);
  host.editor.open(PATH, 'the file\n');
  host.bridge.documentOpened(PATH);
  await waitFor('the guest to have the document', () => session.guest.text(PATH) === 'the file\n');

  // The room legitimately empties the document; "received nothing" is not "holds nothing".
  session.guest.delete(PATH, 0, 'the file\n'.length);
  await waitFor('the room to empty', () => session.host.text(PATH) === '');
  assert.equal(session.host.has(PATH), true, 'the path was never received');

  // A fresh bridge, as a reopened window is, has seeded nothing and holds the disk copy.
  const reopened = new FakeEditor();
  const bridge = new SessionBridge({ engine: slice(session.host), host: reopened, autoSave: false });
  reopened.attach(bridge);
  reopened.open(PATH, 'the file\n');
  bridge.documentOpened(PATH);
  assert.equal(session.host.text(PATH), '', 'the disk copy was seeded over the emptied room');
  assert.equal(reopened.text(PATH), '', 'the stale buffer was left in place');
  bridge.dispose();
});

test('a failed save is reported, and a local edit moves the write instead of racing it', async (t) => {
  const timers = new ManualTimers();
  const { session, host } = await twoWindows(t, {}, { timers });
  host.editor.open(PATH, 'base\n');
  host.bridge.documentOpened(PATH);
  await waitFor('the guest to have the document', () => session.guest.text(PATH) === 'base\n');

  session.guest.insert(PATH, 0, 'one\n');
  await waitFor('the peer edit to reach the buffer', () => host.editor.text(PATH) === 'one\nbase\n');
  assert.deepEqual(timers.saveDelays(), [500]);

  // A local edit inside the window reschedules the write rather than letting it land mid-word.
  host.editor.type(PATH, 'one\nbase\ntyped\n');
  assert.deepEqual(timers.saveDelays(), [500], 'a second write was queued instead of moved');
  assert.equal(
    timers.scheduled.filter((delay) => delay === 500).length,
    2,
    'the local edit did not move the deadline',
  );

  host.editor.saveFails = true;
  timers.fire();
  await waitFor('the failed save to be reported', () =>
    host.editor.reportsOf('saveFailed').length === 1,
  );
});

test('a peer caret that does not resolve here is not drawn at offset zero', () => {
  const engine = new EngineStub();
  engine.texts.set(PATH, 'base\n');
  engine.presenceList = [peerCaret(PATH)];
  const host = new FakeEditor();
  host.open(PATH, 'base\n');
  const bridge = new SessionBridge({ engine, host, autoSave: false, reconcileSettleMs: 0 });

  // `resolveSelection` answers nothing: a peer whose anchor this replica has never seen draws
  // nothing rather than a caret at 0.
  engine.resolved = undefined;
  assert.deepEqual(bridge.cursors(), []);

  // When it does resolve, the same presence is drawn.
  engine.resolved = { anchor: 4, head: 4 };
  const drawn = bridge.cursors();
  assert.equal(drawn.length, 1);
  assert.deepEqual([drawn[0]?.anchor, drawn[0]?.head], [4, 4]);
  bridge.dispose();
});

test('a guest never seeds the room, even from a non-empty buffer', async (t) => {
  const { session, guest } = await twoWindows(t);
  guest.editor.open(PATH, 'a guest disk copy\n');
  guest.bridge.documentOpened(PATH);
  assert.equal(guest.bridge.role(), 'guest');
  assert.equal(session.guest.text(PATH), '', 'the guest seeded the room');
  assert.equal(guest.editor.text(PATH), '', 'the guest buffer kept the disk copy');
});

test('a local keystroke is published as the smallest change', () => {
  const engine = new EngineStub();
  engine.texts.set(PATH, 'base\n');
  const host = new FakeEditor();
  host.open(PATH, 'base\n');
  const bridge = new SessionBridge({ engine, host, autoSave: false, reconcileSettleMs: 0 });
  host.attach(bridge);
  bridge.documentOpened(PATH);

  host.type(PATH, 'base\ntyped\n');
  assert.deepEqual(engine.inserted, [[PATH, 5, 'typed\n']], 'a whole-document replacement was sent');
  assert.deepEqual(engine.deleted, []);
  bridge.dispose();
});

test('the bridge exports the vocabulary an adapter is written against', async () => {
  const bridge = await import('../src/bridge/index.ts');
  for (const name of [
    'SessionBridge',
    'realTimers',
    'DEFAULT_SAVE_SETTLE_MS',
    'DEFAULT_RECONCILE_SETTLE_MS',
    'DEFAULT_MAX_APPLY_ATTEMPTS',
    'diff',
    'render',
    'toCrdt',
    'toBufferOffset',
    'toReplicaOffset',
    'matchesReplica',
    'applyChange',
    'peerColour',
    'translucent',
    'cursorFor',
    'virtualUri',
    'virtualDocument',
    'roomFromQuery',
    'SCHEME',
  ]) {
    assert.ok(name in bridge, `the bridge's public surface has no ${name}`);
  }
});
