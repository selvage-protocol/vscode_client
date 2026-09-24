/**
 * The bridge, over the fake `selvaged` and a fake editor: the host path and the guest path
 * without VS Code in scope.
 *
 * The engines here are the real `LiveSession`, so these tests exercise the seam as it is
 * used — the handshake, `doc.open`, sync frames, awareness and reconnect semantics are all
 * the engine's, and what is under test is the adapter's half: seeding, the two directions
 * of the loop, the EOL policy, the save policy and cursor attribution. The editor fake
 * reproduces the one timing that matters (`SPIKES.md`, spike 2): a change this adapter
 * applied itself reports back a few macrotasks later, as a coalesced editor event does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import {
  SessionBridge,
  DEFAULT_MAX_APPLY_ATTEMPTS,
  MAX_CONCURRENT_GRANTED_READS,
} from '../src/bridge/bridge.ts';
import type { BridgeOptions, Engine, GrantedRead, Timers } from '../src/bridge/bridge.ts';
import { MAX_GRANT_FILE_BYTES } from '../src/bridge/grant.ts';
import { peerColour } from '../src/bridge/cursors.ts';
import type { Cursor } from '../src/bridge/cursors.ts';
import type { TextChange } from '../src/bridge/editing.ts';
import type { AwarenessState, OffsetSelection, Presence, Selection } from '../src/engine/presence.ts';
import type { PeerInfo, Role } from '../src/engine/envelope.ts';
import type { SessionInfo } from '../src/engine/session.ts';
import type { LiveSession } from './helpers/live-session.ts';
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
function slice(engine: LiveSession): Engine {
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
 * a real replica does. A real `LiveSession` satisfies the same interface in the tests above.
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



/**
 * An editor that takes a change and never answers it, as a front-end that dropped the message
 * does. `applyChange`'s promise is the only thing that settles a document's apply in the
 * bridge, and nothing else ever fails it.
 */
class UnansweringEditor extends FakeEditor {
  override applyChange(path: string, change: TextChange): Promise<boolean> {
    const asked = this.changes.get(path) ?? [];
    asked.push(change);
    this.changes.set(path, asked);
    return new Promise(() => undefined);
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

test('an emoji replacement converges the room, and the buffer keeps what was typed', async (t) => {
  const { session, host } = await twoWindows(t);
  host.editor.open(PATH, 'a\u{1F600}b\n');
  host.bridge.documentOpened(PATH);
  await waitFor('the guest to have the document', () => session.guest.text(PATH) === 'a\u{1F600}b\n');

  // The publish this raised used to be a lone surrogate as a CRDT delta — a delete of one
  // half of the pair and an insert of the other — and the codec that carries an update over
  // the wire has no encoding for half a character: the room ended up holding U+FFFD where the
  // emoji was, on both sides and differently on each, with the state vectors still agreeing.
  host.editor.type(PATH, 'a\u{1F601}b\n');
  assert.equal(session.host.text(PATH), 'a\u{1F601}b\n');
  assert.equal(await converge(session.host, session.guest, PATH), 'a\u{1F601}b\n');
  assert.equal(host.editor.text(PATH), 'a\u{1F601}b\n');
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
  // The staged apply lands when the editor is pumped, and the keystroke's publication is a
  // round trip: a fixed number of turns is not the macrotask either arrives on, so the wait is
  // for the buffer to hold both.
  await waitFor(
    'the keystroke and the peer’s edit to land in the buffer',
    () => {
      editor.pump();
      return editor.text(PATH) === 'REMOTE\nbase\ntyped\n' ? true : false;
    },
    { describe: () => ({ buffer: editor.text(PATH), replica: session.host.text(PATH) }) },
  );

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
  const { session, host, guest } = await twoWindows(t);
  // The guest opens the path from its virtual document before the room has sent its text.
  guest.editor.open(PATH, 'a guest disk copy\n');
  guest.bridge.documentOpened(PATH);
  assert.equal(guest.bridge.role(), 'guest');
  await guest.editor.settle();
  assert.equal(session.guest.text(PATH), '', 'the guest seeded the room');

  // Nothing of the guest's own buffer reached the room, and the room's text still wins when
  // it arrives.
  host.editor.open(PATH, 'from the room\n');
  host.bridge.documentOpened(PATH);
  await waitFor('the room text to reach the guest buffer', () =>
    guest.editor.text(PATH) === 'from the room\n',
  );
  assert.equal(session.guest.text(PATH), 'from the room\n', 'the guest doubled the content');
});

test('a guest that opens before the room text has arrived never inserts its buffer', async (t) => {
  const { session, host, guest } = await twoWindows(t);
  // The editor reports the reconcile's clear as landed without the buffer moving, which is
  // the window the VS Code document model sits in while a virtual document materialises.
  guest.editor.stallApply = true;
  guest.editor.open(PATH, 'hello world\n');
  guest.bridge.documentOpened(PATH);
  await guest.editor.settle();
  assert.equal(session.guest.text(PATH), '', 'the guest published its own buffer into the room');

  // The room's text arrives; the guest adopts it and the room holds it once.
  host.editor.open(PATH, 'hello world\n');
  host.bridge.documentOpened(PATH);
  await waitFor('the room text to reach the guest replica', () =>
    session.guest.text(PATH) === 'hello world\n',
  );
  assert.equal(guest.editor.text(PATH), 'hello world\n');
  assert.equal(session.guest.text(PATH), 'hello world\n', 'the room ended up holding the text twice');
});

test('a guest never publishes a stale buffer over the room it has already received', async (t) => {
  const { session, host, guest } = await twoWindows(t);
  host.editor.open(PATH, 'from the room\n');
  host.bridge.documentOpened(PATH);
  await waitFor('the guest to have the room text', () => session.guest.has(PATH));

  // The guest's tab still holds a stale copy — a session rejoined, a document reopened — and
  // the editor reports the reconcile as landed without moving the buffer.
  guest.editor.stallApply = true;
  guest.editor.open(PATH, 'a stale disk copy\n');
  guest.bridge.documentOpened(PATH);
  await guest.editor.settle();
  assert.equal(session.guest.text(PATH), 'from the room\n', 'the stale buffer overwrote the room');
});

test('a change to a guest buffer before its room text arrives is superseded', async (t) => {
  const { session, guest } = await twoWindows(t);
  // The guest opens a buffer of its own, and the editor reports a change to it before the
  // room has sent the document. Neither reaches the room; the room's text supersedes both.
  guest.editor.open(PATH, 'a guest disk copy\n');
  guest.bridge.documentOpened(PATH);
  await guest.editor.settle();
  guest.editor.type(PATH, 'typed before arrival\n');
  await guest.editor.settle();
  assert.equal(session.guest.text(PATH), '', 'a pre-arrival change was published');
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

test('a peer edit between two astral characters lands as whole characters', () => {
  const engine = new EngineStub();
  engine.texts.set(PATH, 'a\u{1F601}b\n');
  const host = new FakeEditor();
  host.open(PATH, 'a\u{1F601}b\n');
  const bridge = new SessionBridge({ engine, host, autoSave: false, reconcileSettleMs: 0 });
  host.attach(bridge);
  bridge.documentOpened(PATH);

  // The room replaces the emoji. A change cut through the pair carries the low surrogate on
  // its own, which is an edit no editor has to accept and a string no JSON decoder has to
  // read.
  engine.texts.set(PATH, 'a\u{1F600}b\n');
  bridge.reconcile(PATH);

  assert.deepEqual(host.changes.get(PATH), [{ start: 1, end: 3, text: '\u{1F600}' }]);
  assert.equal(host.text(PATH), 'a\u{1F600}b\n');
  bridge.dispose();
});

test('a local edit between two astral characters is published as whole characters', () => {
  const engine = new EngineStub();
  engine.texts.set(PATH, 'a\u{1F600}b\n');
  const host = new FakeEditor();
  host.open(PATH, 'a\u{1F600}b\n');
  const bridge = new SessionBridge({ engine, host, autoSave: false, reconcileSettleMs: 0 });
  host.attach(bridge);
  bridge.documentOpened(PATH);

  // The user replaces the emoji. A change cut through the pair would write half a character
  // into the room, where the replica of every peer that receives it holds it.
  host.type(PATH, 'a\u{1F601}b\n');

  assert.deepEqual(engine.deleted, [[PATH, 1, 2]]);
  assert.deepEqual(engine.inserted, [[PATH, 1, '\u{1F601}']]);
  assert.equal(engine.text(PATH), 'a\u{1F601}b\n');
  bridge.dispose();
});

test('a document whose apply is never answered takes no edits, and says nothing', async () => {
  // The other half of the same story, pinned so it is not rediscovered as a mystery: a
  // document is in flight from `issue` until `settle` or the catch runs, and the editor's
  // answer is the only thing that reaches either. An editor that never answers — a front-end
  // that dropped the message it could not decode — leaves `inFlight` set for the rest of the
  // session, and every later remote edit and local keystroke is parked in `pending` behind
  // it without a report. The diff no longer produces a line a decoder must refuse
  // (`test/editing.test.ts`), so what is left is the missing bound, not the message.
  const engine = new EngineStub();
  engine.texts.set(PATH, 'base\n');
  const host = new UnansweringEditor();
  host.open(PATH, 'base\n');
  const timers = new ManualTimers();
  const bridge = new SessionBridge({
    engine,
    host,
    autoSave: false,
    timers,
    reconcileSettleMs: 100,
  });
  host.attach(bridge);
  bridge.documentOpened(PATH);

  engine.texts.set(PATH, 'REMOTE\nbase\n');
  bridge.reconcile(PATH);
  assert.deepEqual(host.changes.get(PATH), [{ start: 0, end: 0, text: 'REMOTE\n' }]);

  // The user types, and the room edits again, while the apply is outstanding.
  host.type(PATH, 'base\ntyped\n');
  engine.texts.set(PATH, 'REMOTE\nbase\nMORE\n');
  bridge.reconcile(PATH);
  timers.fire();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(engine.inserted, [], 'the keystroke was published');
  assert.deepEqual(host.changes.get(PATH), [{ start: 0, end: 0, text: 'REMOTE\n' }]);
  assert.equal(host.text(PATH), 'base\ntyped\n', "the room's edit reached the buffer");
  assert.deepEqual(host.reports, [], 'the wedge was reported');
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
  ]) {
    assert.ok(name in bridge, `the bridge's public surface has no ${name}`);
  }
});


test("the room's grant reaches the adapter as a report, whole and in order", async (t) => {
  const { session, guest } = await twoWindows(t);

  // Ascending by UTF-16 code unit, and the reverse of what a code-point sort would write:
  // the event is the host's listing, and the bridge is a pass-through, not a re-writer.
  const paths = ['README.md', '\u{1F600}.txt', 'ｆ.txt'];
  await session.host.grant(paths);

  const granted = await waitFor('the grant to be reported', () =>
    guest.editor.reportsOf('grant').at(-1) ?? false,
  );
  assert.deepEqual(granted.paths, paths);

  // A shorter listing is a smaller grant, not a partial one: the report replaces the last.
  await session.host.grant(['src/main.rs']);
  const shrunk = await waitFor('the smaller grant to be reported', () =>
    guest.editor.reportsOf('grant').some((report) => report.paths.length === 1)
      ? guest.editor.reportsOf('grant').at(-1)
      : false,
  );
  assert.deepEqual(shrunk.paths, ['src/main.rs']);
});
/** A host editor whose read of the working copy is held open until the test lets it land. */
class HeldRead extends FakeEditor {
  private release?: () => void;

  override readGrantedFile(path: string): Promise<GrantedRead> {
    this.reads.push(path);
    return new Promise((resolve) => {
      this.release = () => {
        resolve(
          this.disk.has(path)
            ? { kind: 'text', text: this.disk.get(path) ?? '' }
            : { kind: 'refused', cause: 'binary' },
        );
      };
    });
  }

  /** Lets the read that was asked for finish. */
  let(): void {
    this.release?.();
  }
}

test('a host refuses a requested path that is not a readable file, and seeds nothing', async (t) => {
  const { session, host, guest } = await twoWindows(t);

  // The read answers with a cause for a path it will not serve: this one is a name that is
  // not there. The path came from a peer, so a refusal is reported rather than guessed at.
  guest.editor.open(OTHER, '');
  guest.bridge.documentOpened(OTHER);

  const refusal = await waitFor('the refusal to be reported', () =>
    host.editor.reportsOf('sessionError')[0] ?? false,
  );
  assert.match(refusal.message, /there is no readable file there any more/);
  assert.match(
    refusal.message,
    /may have been deleted after the listing was published/,
    'a file gone from the shared folder reads as a failure rather than as a deletion',
  );
  assert.deepEqual(host.editor.reads, [OTHER], 'the path was not even offered to the disk');
  assert.equal(session.host.has(OTHER), false, 'a refusal was seeded as an empty document');
  assert.equal(session.host.text(OTHER), '');
});

test('a host refused a binary file the room asked for says what it is, not that it is gone', async (t) => {
  const { session, host, guest } = await twoWindows(t);

  // A zip in the shared folder: a listing names it — the walk rules on a file's type and size
  // and does not read it — so a guest can ask for it, and the answer has to be about the file
  // rather than about a deletion nobody made. This is the sentence the owner was sent looking
  // for a `logs_96234608913.zip` that was on disk the whole time.
  host.editor.refusals.set(OTHER, 'binary');
  guest.editor.open(OTHER, '');
  guest.bridge.documentOpened(OTHER);

  const refusal = await waitFor('the refusal to be reported', () =>
    host.editor.reportsOf('sessionError')[0] ?? false,
  );
  assert.equal(
    refusal.message,
    `could not share ${OTHER}: it is a binary file, and a room carries text, so this is not a file that can be shared at all; nothing was shared for it`,
  );
  assert.doesNotMatch(
    refusal.message,
    /deleted|readable file/,
    'a binary file was refused as though it had gone missing',
  );
  assert.equal(session.host.has(OTHER), false, 'a refused file was seeded as an empty document');
  assert.equal(session.host.text(OTHER), '');
});

test('a host says nothing about a path the grant would never publish', async (t) => {
  const { session, host, guest } = await twoWindows(t);

  // The bridge drops a path the grant excludes before any read; this is the same rule one
  // layer down, where an adapter's own resolution refuses a name the grant allowed. A peer
  // that guessed must learn nothing from the answer — not even that the name was refused
  // rather than absent.
  host.editor.refusals.set(OTHER, 'not-granted');
  guest.editor.open(OTHER, '');
  guest.bridge.documentOpened(OTHER);

  await waitFor('the read to be offered to the disk', () => host.editor.reads.length > 0);
  await host.editor.settle();
  assert.deepEqual(host.editor.reportsOf('sessionError'), [], 'a refusal confirmed a guessed name');
  assert.equal(session.host.has(OTHER), false, 'the path was seeded');
});

test('a host refuses a requested path whose read outgrew the size a session will carry', async (t) => {
  const { session, host, guest } = await twoWindows(t);
  // The read answers with more than the session carries, as a file that grew between the
  // size check and the read does. The seed must refuse it rather than publish an oversized
  // document past the sharing bound.
  host.editor.disk.set(OTHER, 'x'.repeat(MAX_GRANT_FILE_BYTES + 1));
  guest.editor.open(OTHER, '');
  guest.bridge.documentOpened(OTHER);

  const refusal = await waitFor('the refusal to be reported', () =>
    host.editor.reportsOf('sessionError')[0] ?? false,
  );
  assert.match(refusal.message, /over the .* bytes a session will carry/);
  assert.equal(session.host.has(OTHER), false, 'an oversized read was seeded');
  assert.equal(session.host.text(OTHER), '');
});

test('a guest never reads its working copy for the room', async (t) => {
  const { session, host, guest } = await twoWindows(t);
  guest.editor.disk.set(OTHER, 'a guest copy that must never be shared\n');

  host.editor.open(OTHER, 'from the host\n');
  host.bridge.documentOpened(OTHER);
  await waitFor('the room to offer the path', () =>
    guest.editor.reportsOf('documents').some((report) => report.documents.includes(OTHER)),
  );

  assert.deepEqual(guest.editor.reads, [], 'a guest read its disk for a requested path');
  await waitFor('the room text to arrive', () => session.guest.text(OTHER) === 'from the host\n');
});

test('a seed in flight does not land over text the room supplied while it was reading', async (t) => {
  const session = await fakeSession();
  const editor = new HeldRead();
  const bridge = new SessionBridge({
    engine: slice(session.host),
    host: editor,
    autoSave: false,
  });
  editor.attach(bridge);
  t.after(async () => {
    bridge.dispose();
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  editor.disk.set(OTHER, 'a stale copy on disk\n');

  await session.guest.open(OTHER);
  await waitFor('the host to ask its disk', () => editor.reads.length === 1);
  session.guest.insert(OTHER, 0, 'from the room\n');
  await waitFor('the room text to reach this replica', () =>
    session.host.text(OTHER) === 'from the room\n',
  );

  editor.let();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    session.host.text(OTHER),
    'from the room\n',
    'the disk copy was seeded over text the replica had already received',
  );
});

/** A host editor that holds every read open, counting how many are in flight at once. */
class CountedReads extends FakeEditor {
  inFlight = 0;
  mostInFlight = 0;
  private readonly held: Array<() => void> = [];

  override readGrantedFile(path: string): Promise<GrantedRead> {
    this.reads.push(path);
    this.inFlight += 1;
    this.mostInFlight = Math.max(this.mostInFlight, this.inFlight);
    return new Promise((resolve) => {
      this.held.push(() => {
        this.inFlight -= 1;
        resolve({ kind: 'text', text: `${path}\n` });
      });
    });
  }

  /** Lets every read that is waiting finish. */
  letAll(): void {
    for (const release of this.held.splice(0)) {
      release();
    }
  }
}

test('a host reads the paths the room asks for a few at a time', async (t) => {
  const session = await fakeSession();
  const editor = new CountedReads();
  const bridge = new SessionBridge({
    engine: slice(session.host),
    host: editor,
    autoSave: false,
  });
  editor.attach(bridge);
  t.after(async () => {
    bridge.dispose();
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });

  // One room event can name every path a peer opened; the reads it starts are bounded, and the
  // rest wait their turn rather than going to the disk together.
  const paths = Array.from({ length: 10 }, (_, index) => `src/file${index}.rs`);
  await Promise.all(paths.map((path) => session.guest.open(path)));
  await waitFor('the first reads to start', () => editor.reads.length > 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    editor.inFlight <= MAX_CONCURRENT_GRANTED_READS,
    `${editor.inFlight} reads were in flight at once`,
  );

  await waitFor(
    'every path to be read and seeded',
    () => {
      editor.letAll();
      return paths.every((path) => session.host.text(path) === `${path}\n`);
    },
    { describe: () => ({ reads: editor.reads }) },
  );
  assert.equal(new Set(editor.reads).size, paths.length, 'a path was not read, or read twice');
  assert.ok(
    editor.mostInFlight <= MAX_CONCURRENT_GRANTED_READS,
    `${editor.mostInFlight} reads were in flight at once`,
  );
});

/**
 * Read-on-hold, through two adapters: a guest opens a path the host's own window never opens,
 * and the host has to read its working copy because the guest asked. The hold is the ask, the
 * room's open-document set is how the host hears it, and the host's copy is what the guest is
 * given — nothing else in this suite covers a path that was only ever a name until somebody
 * held it.
 *
 * The host's window reads the replica for the path first, which is what a window that draws the
 * room's documents does, and what the browser client's own proof caught: reading a room path's
 * text used to give the replica a document for it, so a host that had merely looked read its own
 * attention as the room's word and never seeded its working copy at all.
 */
test('a guest holding a path the host has never opened is given the host’s copy of it', async (t) => {
  const session = await fakeSession();
  const disk = 'the host’s own copy of it\n';
  const hostEditor = new FakeEditor();
  hostEditor.disk.set(OTHER, disk);
  const hostBridge = new SessionBridge({
    engine: slice(session.host),
    host: hostEditor,
    autoSave: false,
  });
  hostEditor.attach(hostBridge);
  const guestEditor = new FakeEditor();
  const guestBridge = new SessionBridge({
    engine: slice(session.guest),
    host: guestEditor,
    autoSave: false,
  });
  guestEditor.attach(guestBridge);
  t.after(async () => {
    hostBridge.dispose();
    guestBridge.dispose();
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });

  // The room has published nothing for the path, so a window drawing it reads an empty
  // document: that is attention, and not the room's receipt.
  assert.equal(session.host.text(OTHER), '', 'the room has published nothing for the path');
  assert.equal(session.host.has(OTHER), false, 'reading a path is not the room publishing it');

  // The guest's adapter opens the path; the hold it takes is what asks the host for the text.
  guestEditor.open(OTHER, '');
  guestBridge.documentOpened(OTHER);

  await waitFor('the host to read its working copy', () =>
    hostEditor.reads.includes(OTHER) ? true : false,
    { describe: () => ({ reads: [...hostEditor.reads] }) },
  );
  await waitFor(
    'the guest to be given the host’s copy',
    () => (session.guest.text(OTHER) === disk ? true : false),
    {
      describe: () => ({
        host: session.host.text(OTHER),
        guest: session.guest.text(OTHER),
        documents: session.guest.documents(),
      }),
    },
  );
  // And the adapter puts it in front of the guest, over the empty placeholder the mirror filled.
  await waitFor(
    'the guest’s buffer to hold it',
    () => (guestEditor.text(OTHER) === disk ? true : false),
    { describe: () => guestEditor.text(OTHER) },
  );
});
