/**
 * Follow-and-jump through the built extension, with the editor API stubbed and a fake
 * `selvaged` in the room: going to a peer lands once where they are, following one keeps
 * landing as they move, and stopping — by command, by the indicator, by leaving, by going
 * somewhere else, or by typing — ends it. A remote edit must not end it.
 *
 * A landing is read back from the stub editors `showTextDocument` answered with: what their
 * `selection` was set to, and what `revealRange` was asked to reveal. The guest's replica
 * reaching the room's text, and the host's caret reaching the guest, are both awaited through
 * the caret the adapter draws — a peer is drawn only once presence arrived and the anchors
 * resolved — never through a sleep.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import { LiveSession } from './helpers/live-session.ts';
import { sessionUrl } from '../src/engine/urls.ts';
import { baseOf } from './helpers/base.ts';
import { peerColour } from '../src/bridge/cursors.ts';
import { landStashedJoin, loadBundle, mirrorWindowDir, testStoragePath, waitForMirrorFiles } from './helpers/bundle.ts';
import type { LoadedExtension } from './helpers/bundle.ts';
import { FakeServer } from './helpers/fake-server.ts';
import { options } from './helpers/session.ts';
import { waitFor } from './helpers/wait.ts';

const PATH_A = 'src/a.rs';
const TEXT_A = 'aaa\nbbb\nccc\n';
const PATH_B = 'src/b.rs';
const TEXT_B = 'xxx\nyyy\nzzz\n';

interface Seat {
  bundle: LoadedExtension;
  storage: string;
  server: FakeServer;
  host: LiveSession;
  invite: string;
  roomId: string;
  hostId: string;
  /** The guest's mirror root: every room file the tests open lives under it. */
  mirrorRoot: string;
  /** A `file:` URI string for a room path, as the adapter opens it. */
  roomFile(path: string): string;
}

/** A room with text in every path, and the bundle joined to it as `Bob`. */
async function seat(t: TestContext, texts: Record<string, string>): Promise<Seat> {
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  const host = await LiveSession.host(
    server.wsBase,
    'Ada',
    options({ baseUrl: server.wsBase, displayName: 'Ada', reconnect: false }),
  );
  for (const [path, text] of Object.entries(texts)) {
    await host.open(path);
    host.insert(path, 0, text);
  }
  const invite = host.inviteUrl();
  assert.ok(invite !== undefined, 'the host was given no invite link');

  const bundle = loadBundle();
  bundle.stub.reset();
  const storage = testStoragePath(t);
  bundle.activate({
    subscriptions: [],
    globalState: bundle.stub.globalState,
    globalStorageUri: bundle.stub.Uri.file(storage),
  });
  t.after(() => {
    bundle.deactivate();
  });
  t.after(async () => {
    await host.disconnect();
    await server.stop();
  });
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  await landStashedJoin(bundle, storage, host.session().roomId, 'Bob');
  const roomId = host.session().roomId;
  const mirrorRoot = mirrorWindowDir(storage, roomId);
  return {
    bundle,
    storage,
    server,
    host,
    invite,
    roomId,
    hostId: host.session().peer.peer_id,
    mirrorRoot,
    roomFile: (path: string) => `file://${mirrorRoot}/${path}`,
  };
}

/**
 * Another engine in the room, named `name`, with its caret at `at` in `path`. The text is
 * the host's — seeded before the join, so every replica already holds the elements the
 * caret anchors into — and the caret waits for the peer's own replica to hold it: a
 * selection made before the sync arrives would publish a path alone, with nothing later
 * re-publishing it.
 */
async function peerIn(
  t: TestContext,
  seat_: Seat,
  name: string,
  path: string,
  text: string,
  at: number,
): Promise<LiveSession> {
  const peer = await LiveSession.join(
    seat_.invite,
    name,
    options({ baseUrl: seat_.server.wsBase, displayName: name, reconnect: false }),
  );
  t.after(async () => {
    await peer.disconnect();
  });
  await peer.open(path);
  await waitFor(`the peer replica to hold ${path}`, () => (peer.text(path) === text ? true : false), {
    describe: () => peer.text(path),
  });
  peer.setSelection(path, { anchor: at, head: at });
  return peer;
}

interface FakeEditor {
  document: Record<string, unknown>;
  selection: { anchor: { line: number; character: number }; active: { line: number; character: number } } | undefined;
  revealed: Array<{ range: unknown; kind: unknown }>;
  decorated: unknown[][];
}

/** A guest document stand-in over mutable text: what the room applied, or what was typed. */
function guestDocument(
  seat_: Seat,
  path: string,
  holder: { text: string },
): Record<string, unknown> {
  const uriString = seat_.roomFile(path);
  return {
    uri: seat_.bundle.stub.Uri.parse(uriString),
    eol: 1,
    isDirty: false,
    getText: () => holder.text,
    positionAt: (offset: number) => ({ line: 0, character: offset }),
    offsetAt: (position: number | { character: number }) =>
      typeof position === 'number' ? position : position.character,
    save: () => Promise.resolve(true),
  };
}

function guestEditor(document: Record<string, unknown>): FakeEditor {
  // A real editor always holds a selection — never `undefined` — so the stand-in starts
  // with a caret at zero the way a newly shown document does.
  const editor: FakeEditor = {
    document,
    selection: { anchor: { line: 0, character: 0 }, active: { line: 0, character: 0 } },
    revealed: [],
    decorated: [],
    // `setDecorations` is what the caret drawing calls: a call carrying ranges is the room's
    // caret made visible, which is presence arrived and anchors resolved.
  } as FakeEditor;
  (editor as unknown as Record<string, unknown>)['setDecorations'] = (...args: unknown[]) => {
    editor.decorated.push(args);
  };
  (editor as unknown as Record<string, unknown>)['revealRange'] = (range: unknown, kind: unknown) => {
    editor.revealed.push({ range, kind });
  };
  return editor;
}

/** Whether a `setDecorations` call paints a zero-width caret at `at` on line zero. */
function hasCaretAt(args: unknown, at: number): boolean {
  const options = (args as Array<unknown>)[1];
  if (!Array.isArray(options)) {
    return false;
  }
  return (options as Array<{ range?: { start?: { character?: number }; end?: { character?: number } } }>).some(
    (option) => option.range?.start?.character === at && option.range?.end?.character === at,
  );
}

/** Whether the editor was ever told to draw a zero-width caret at `at`. */
function drawnCaretAt(editor: FakeEditor, at: number): boolean {
  return editor.decorated.some((args) => hasCaretAt(args, at));
}

/**
 * Stages a held document the way the editor would: the document opens first, and the host's
 * caret moves only once the replica holds the room's text — drawn then means presence
 * arrived and anchors resolved, rather than whichever of the hold and the awareness won.
 */
async function openHeld(
  seat_: Seat,
  path: string,
  holder: { text: string },
  hostAt: number,
): Promise<FakeEditor> {
  const { bundle } = seat_;
  const document = guestDocument(seat_, path, holder);
  const editor = guestEditor(document);
  bundle.stub.window.activeTextEditor = editor;
  bundle.stub.window.visibleTextEditors = [editor];
  // The open reports the document, which is what holds it in the room: the host seeing
  // the hold is the room settled around this window.
  // The room's listing is what makes the path openable: a mirror file the listing does not name
  // is not shared, so the wait is for the listing to have arrived, not for a turn.
  await waitForMirrorFiles(seat_.storage, seat_.roomId, [path]);
  bundle.stub.fire('openTextDocument', document);
  await waitFor(`the room to hold ${path} open`, () =>
    seat_.host.peerDocuments().includes(path) ? true : false,
  );
  // A first frame the guest drops — presence racing the peers it names, the text its
  // anchors resolve against — never comes again on its own, and an identical repeat
  // dedups in awareness without a new broadcast. Alternating two adjacent carets keeps
  // every repeat a genuine change, until a draw at the seated offset proves the pipeline.
  let at = hostAt;
  seat_.host.setSelection(path, { anchor: at, head: at });
  await waitFor(
    `the host caret at ${hostAt} to be drawn in ${path}`,
    () => {
      if (drawnCaretAt(editor, hostAt)) {
        return true;
      }
      at = at === hostAt ? hostAt + 1 : hostAt;
      seat_.host.setSelection(path, { anchor: at, head: at });
      return false;
    },
    { describe: () => ({ decorated: editor.decorated.length }) },
  );
  // The alternation ends on whichever offset drew: two ordered broadcasts ending at the
  // seated offset, then a fresh draw there, is what makes the caret that offset for what
  // follows rather than whichever one the draw above saw.
  const seen = editor.decorated.length;
  // One move per frame: an awareness state is sealed before it is sent and a later move replaces
  // the one before it, so two selections in one tick are one frame carrying the last position.
  seat_.host.setSelection(path, { anchor: hostAt + 1, head: hostAt + 1 });
  await waitFor(`the host caret to move to ${hostAt + 1} in ${path}`, () =>
    editor.decorated.slice(seen).some((args) => hasCaretAt(args, hostAt + 1)) ? true : false,
  );
  const settledFrom = editor.decorated.length;
  seat_.host.setSelection(path, { anchor: hostAt, head: hostAt });
  await waitFor(`the host caret to settle at ${hostAt} in ${path}`, () =>
    editor.decorated.slice(settledFrom).some((args) => hasCaretAt(args, hostAt)) ? true : false,
  );
  return editor;
}

/**
 * The head offset a landed editor's caret sits at. A stub document reads positions as
 * offsets, while the test's own stand-ins read `{ line, character }`: both land here.
 */
function caretOf(editor: FakeEditor): number | undefined {
  const active = editor.selection?.active as { character: number } | number | undefined;
  return typeof active === 'number' ? active : active?.character;
}

/**
 * The guest's Participants rows, as the view drew them: the description is the file the peer
 * says they are in, so a row naming "{path}" is proof the presence frame reached this window.
 */
function guestRows(seat_: Seat): Array<{ peerId?: string; description?: string }> {
  const view = seat_.bundle.stub.registered.treeDataProviders.find(
    (entry) => entry.viewId === 'selvage.participants',
  );
  if (view === undefined) {
    return [];
  }
  const rows = view.provider.getChildren();
  return Array.isArray(rows) ? (rows as Array<{ peerId?: string; description?: string }>) : [];
}

/** The follow indicator, when one is up: a disposed item reads as gone. */
function followItem(seat_: Seat): { text: string; command?: string; color?: string } | undefined {
  return seat_.bundle.stub.registered.statusBarItems.find(
    (item) => item.command === 'selvage.stopFollowing' && (item as { disposed?: boolean }).disposed !== true,
  );
}

/**
 * Every `setDecorations` call that used a whole-line type: the banner's signature. The
 * caret, selection and badge types never set `isWholeLine`, so a paint here is a follow
 * banner on a document line, which must not exist.
 */
function wholeLinePaints(seat_: Seat, editors: FakeEditor[]): Array<unknown> {
  const types = new Map<unknown, Record<string, unknown>>();
  for (
    const entry of seat_.bundle.stub.registered.decorations as Array<{
      options: Record<string, unknown>;
      handle: unknown;
    }>
  ) {
    types.set(entry.handle, entry.options);
  }
  const paints: Array<unknown> = [];
  for (const editor of editors) {
    for (const args of editor.decorated) {
      if (types.get(args[0])?.['isWholeLine'] === true) {
        paints.push(args);
      }
    }
  }
  return paints;
}

/** Every whole-line decoration type the session created: the banner's other half. */
function wholeLineTypes(seat_: Seat): Array<Record<string, unknown>> {
  return (seat_.bundle.stub.registered.decorations as Array<{ options: Record<string, unknown> }>)
    .map((entry) => entry.options)
    .filter((options) => options['isWholeLine'] === true);
}

/**
 * Re-issues a command until its effect shows, at most every 200 ms: an attempt from before
 * presence arrives refuses before opening anything (go-to) or pends on the next frame
 * (follow), so retrying is what a user does by hand. The wait itself is the bounded poll;
 * the throttle only bounds how often the attempt repeats.
 */
function issueUntil(bundle: LoadedExtension, command: string, args: unknown): () => void {
  let issued = 0;
  return () => {
    const now = Date.now();
    if (now - issued > 200) {
      issued = now;
      void bundle.stub.commands.executeCommand(command, args);
    }
  };
}

test('go to lands on a peer in a document this window holds', async (t) => {
  const seat_ = await seat(t, { [PATH_A]: TEXT_A });
  const holder = { text: TEXT_A };
  const editor = await openHeld(seat_, PATH_A, holder, 5);
  const shownBefore = seat_.bundle.stub.registered.shownEditors.length;

  // The peer document is already the active editor, so the landing moves its caret rather
  // than opening anything: the effect is read back from that editor, not from a new show.
  await seat_.bundle.stub.commands.executeCommand('selvage.goToParticipant', { peerId: seat_.hostId });
  await waitFor(
    'the jump to land at the host caret',
    () => (caretOf(editor) === 5 ? true : false),
    { describe: () => caretOf(editor) },
  );
  assert.equal(
    seat_.bundle.stub.registered.shownEditors.length,
    shownBefore,
    'the jump reopened the document it was already in',
  );
  assert.equal(editor.revealed.length, 1, 'the landing reveals what it lands on');
  assert.equal(editor.revealed[0]?.kind, seat_.bundle.stub.TextEditorRevealType.InCenterIfOutsideViewport);
});

test('go to fetches a document this window does not hold, and never lands at offset zero', async (t) => {
  const seat_ = await seat(t, { [PATH_A]: TEXT_A });
  // `B` is named by the room but holds no text yet: an empty document syncs no type, so the
  // guest replica receives nothing for it and the host's caret publishes a path alone.
  await seat_.host.open(PATH_B);
  const holder = { text: TEXT_A };
  await openHeld(seat_, PATH_A, holder, 2);
  seat_.host.setSelection(PATH_B, { anchor: 0, head: 0 });
  const uriB = seat_.roomFile( PATH_B);

  // An attempt from before presence arrives refuses before opening anything, so the command
  // is re-issued until the open it stages shows.
  const retry = issueUntil(seat_.bundle, 'selvage.goToParticipant', { peerId: seat_.hostId });
  const opened = await waitFor(
    'the jump to open the unfetched document',
    () => {
      const editors = seat_.bundle.stub.registered.shownEditors as unknown as FakeEditor[];
      const found = editors.find(
        (editor) => (editor.document['uri'] as { toString(): string }).toString() === uriB,
      );
      if (found !== undefined) {
        return found;
      }
      retry();
      return undefined;
    },
    { describe: () => seat_.bundle.stub.registered.shown },
  );
  assert.ok(opened !== undefined, 'the jump never opened the unfetched document');
  // The text is still on its way — nothing the test staged can have delivered it — so a
  // caret here would be offset zero by default rather than by knowledge. There is none.
  assert.equal(opened.selection, undefined, 'the jump placed a caret before the text arrived');
  assert.equal(opened.revealed.length, 0, 'the jump revealed before the text arrived');

  // The editor reporting the document open is what holds it, and the host's own write is
  // what sends the text: the pending landing resolves on the arrival.
  seat_.bundle.stub.fire('openTextDocument', opened.document);
  seat_.bundle.stub.window.activeTextEditor = opened;
  seat_.host.insert(PATH_B, 0, TEXT_B);
  seat_.host.setSelection(PATH_B, { anchor: 4, head: 4 });
  await waitFor(
    'the pending jump to land once the text arrives',
    () => (caretOf(opened) === 4 ? true : false),
    { describe: () => caretOf(opened) },
  );
  assert.equal(opened.revealed.length, 1);
});

test('follow tracks the peer across caret moves and a document change', async (t) => {
  const seat_ = await seat(t, { [PATH_A]: TEXT_A, [PATH_B]: TEXT_B });
  const holder = { text: TEXT_A };
  const editorA = await openHeld(seat_, PATH_A, holder, 5);
  const shownBefore = seat_.bundle.stub.registered.shownEditors.length;

  await seat_.bundle.stub.commands.executeCommand('selvage.followParticipant', { peerId: seat_.hostId });
  await waitFor('the follow to begin', () =>
    followItem(seat_) !== undefined ? true : false,
  );
  await waitFor('the follow to land at the host caret', () => caretOf(editorA) === 5);

  // A caret move in the same document re-lands without reopening it.
  seat_.host.setSelection(PATH_A, { anchor: 8, head: 8 });
  await waitFor('the follow to track the caret move', () => caretOf(editorA) === 8);
  assert.equal(
    seat_.bundle.stub.registered.shownEditors.length,
    shownBefore,
    'a caret move reopened the document',
  );

  // A document change opens the peer document through the ordinary path and lands there.
  seat_.host.setSelection(PATH_B, { anchor: 3, head: 3 });
  const uriB = seat_.roomFile( PATH_B);
  const editorB = await waitFor(
    'the follow to open the peer document',
    () => {
      const editors = seat_.bundle.stub.registered.shownEditors as unknown as FakeEditor[];
      const found = editors.find(
        (editor) => (editor.document['uri'] as { toString(): string }).toString() === uriB,
      );
      return found;
    },
    { describe: () => seat_.bundle.stub.registered.shown },
  );
  seat_.bundle.stub.fire('openTextDocument', editorB.document);
  // The editor is what the follow re-lands in from here: without seating it active the next
  // frame would open the document again, the way a window that never reported it would.
  seat_.bundle.stub.window.activeTextEditor = editorB;
  await waitFor('the follow to land in the peer document', () => caretOf(editorB) === 3);
  const item = followItem(seat_);
  assert.equal(item?.text, '$(person) Selvage: following Ada');
});

test('stopping works by command and by the indicator, and with nothing to stop', async (t) => {
  const seat_ = await seat(t, { [PATH_A]: TEXT_A });
  const holder = { text: TEXT_A };
  await openHeld(seat_, PATH_A, holder, 5);

  await seat_.bundle.stub.commands.executeCommand('selvage.followParticipant', { peerId: seat_.hostId });
  await waitFor('the follow to begin', () =>
    followItem(seat_) !== undefined ? true : false,
  );
  const item = followItem(seat_);
  assert.ok(item !== undefined, 'no follow indicator while following');
  assert.equal(item.text, '$(person) Selvage: following Ada');
  // The indicator doubles as the stop control: selecting it runs the stop command.
  assert.equal(item.command, 'selvage.stopFollowing');

  // By the indicator: what a click runs.
  await seat_.bundle.stub.commands.executeCommand(item.command as string);
  await waitFor('the follow to stop', () =>
    followItem(seat_) === undefined ? true : false,
  );

  // By the command, and then with nothing left to stop.
  await seat_.bundle.stub.commands.executeCommand('selvage.followParticipant', { peerId: seat_.hostId });
  await waitFor('the second follow to begin', () =>
    followItem(seat_) !== undefined ? true : false,
  );
  await seat_.bundle.stub.commands.executeCommand('selvage.stopFollowing');
  await waitFor('the second follow to stop', () =>
    followItem(seat_) === undefined ? true : false,
  );
  await seat_.bundle.stub.commands.executeCommand('selvage.stopFollowing');
  await waitFor('the empty stop to be refused', () =>
    seat_.bundle.stub.registered.warnings.some((message) => message === 'Selvage: not following anyone.'),
  );
  // An asked-for stop stays silent, the way the indicator going down always has: only a
  // stop the user did not ask for says so.
  assert.deepEqual(
    seat_.bundle.stub.registered.information.filter((message) =>
      message.startsWith('Selvage: stopped following'),
    ),
    [],
    'an explicit stop said so',
  );
});

test('the indicator wears the peer colour, and no banner paints the document', async (t) => {
  const seat_ = await seat(t, { [PATH_A]: TEXT_A });
  const holder = { text: TEXT_A };
  const editor = await openHeld(seat_, PATH_A, holder, 5);
  const colour = peerColour(seat_.hostId);

  // No indicator before anything is followed: the status item is follow state, not chrome.
  assert.equal(followItem(seat_), undefined, 'a follow indicator is up with no follow');

  await seat_.bundle.stub.commands.executeCommand('selvage.followParticipant', { peerId: seat_.hostId });
  await waitFor('the follow to begin', () =>
    followItem(seat_) !== undefined ? true : false,
  );
  const item = followItem(seat_);
  assert.ok(item !== undefined, 'no follow indicator while following');
  // The indicator's colour is the peer's marker colour: the mapping the caret wears.
  assert.equal(item.color, colour);
  // The indicator doubles as the stop control: selecting it runs the stop command.
  assert.equal(item.command, 'selvage.stopFollowing');

  await waitFor('the follow to land at the host caret', () => caretOf(editor) === 5);
  // The regression: following paints no text line. No whole-line type exists, and no
  // paint call on the followed editor used one — the caret and selection types never do.
  assert.deepEqual(wholeLineTypes(seat_), [], 'starting the follow created a whole-line type');
  assert.deepEqual(
    wholeLinePaints(seat_, [editor]),
    [],
    'the follow painted a document line',
  );

  // A caret move re-lands through the indicator alone: still no whole-line type mid-track.
  seat_.host.setSelection(PATH_A, { anchor: 8, head: 8 });
  await waitFor('the follow to track the caret move', () => caretOf(editor) === 8);
  assert.deepEqual(wholeLineTypes(seat_), [], 'tracking the follow created a whole-line type');

  // By the indicator: what a click runs stops the follow silently and paints nothing.
  // Start and stop live in the status item — no toast either way.
  const toasts = (): Array<string> =>
    seat_.bundle.stub.registered.information.filter(
      (message) =>
        message.startsWith('Selvage: following') || message.startsWith('Selvage: stopped following'),
    );
  await seat_.bundle.stub.commands.executeCommand(item.command as string);
  await waitFor('the follow to stop', () =>
    followItem(seat_) === undefined ? true : false,
  );
  assert.equal(followItem(seat_), undefined, 'the indicator survived the stop');
  assert.deepEqual(wholeLineTypes(seat_), [], 'stopping the follow painted a document line');
  assert.deepEqual(toasts(), [], 'starting or stopping the follow toasted');
});

test('a window switch paints no banner on any editor', async (t) => {
  const seat_ = await seat(t, { [PATH_A]: TEXT_A });
  const holder = { text: TEXT_A };
  const editor = await openHeld(seat_, PATH_A, holder, 5);

  await seat_.bundle.stub.commands.executeCommand('selvage.followParticipant', { peerId: seat_.hostId });
  await waitFor('the follow to begin', () =>
    followItem(seat_) !== undefined ? true : false,
  );
  await waitFor('the follow to land at the host caret', () => caretOf(editor) === 5);

  // Another visible editor, showing a document the room never named: the repaint the
  // switch runs is synchronous, so what follows observes it rather than racing it — and
  // no editor in the window carries a whole-line paint.
  const other = guestEditor(guestDocument(seat_, 'src/elsewhere.rs', { text: 'zzz\n' }));
  seat_.bundle.stub.window.visibleTextEditors = [editor, other];
  seat_.bundle.stub.fire('visibleEditors', [editor, other]);
  assert.deepEqual(
    wholeLinePaints(seat_, [editor, other]),
    [],
    'the window switch painted a document line',
  );
  assert.ok(followItem(seat_) !== undefined, 'a window switch ended the follow');
});

test('a peer caret already in the room paints on open, with no local move', async (t) => {
  const seat_ = await seat(t, { [PATH_A]: TEXT_A, [PATH_B]: TEXT_B });
  // Ada's caret arrives while this window holds nothing for PATH_B: the presence frame is
  // received, but a caret whose anchors cannot resolve against an empty replica is dropped.
  seat_.host.setSelection(PATH_B, { anchor: 4, head: 4 });
  await waitFor('the guest to see Ada in the peer document', () =>
    guestRows(seat_).some((row) => row.description === PATH_B) ? true : false,
  );

  // The document opens and the editor becomes visible in the same turn, before the room's text
  // can cross the socket. No selection event follows: this window never moves.
  const holder = { text: TEXT_B };
  const document = guestDocument(seat_, PATH_B, holder);
  const editor = guestEditor(document);
  seat_.bundle.stub.window.activeTextEditor = editor;
  seat_.bundle.stub.window.visibleTextEditors = [editor];
  seat_.bundle.stub.fire('openTextDocument', document);
  seat_.bundle.stub.fire('visibleEditors', [editor]);

  await waitFor(
    'the already-present caret to paint on open',
    () => (drawnCaretAt(editor, 4) ? true : false),
    { describe: () => ({ decorated: editor.decorated.length }) },
  );
});

test('a local edit ends the follow while a remote one does not', async (t) => {
  const seat_ = await seat(t, { [PATH_A]: TEXT_A });
  const holder = { text: TEXT_A };
  const editor = await openHeld(seat_, PATH_A, holder, 5);

  await seat_.bundle.stub.commands.executeCommand('selvage.followParticipant', { peerId: seat_.hostId });
  await waitFor('the follow to begin', () =>
    followItem(seat_) !== undefined ? true : false,
  );

  // Remote: the host's text reaches the buffer first — the apply the bridge stages is the
  // proof the replica holds it — and only then does the change event carry the room's own
  // text. The follow must survive it, and prove it by tracking the next move.
  const remote = `!${TEXT_A}`;
  let applied = 0;
  seat_.bundle.stub.registered.applyEditImpl = async () => {
    applied += 1;
    return true;
  };
  seat_.host.insert(PATH_A, 0, '!');
  await waitFor('the remote edit to reach the guest buffer', () => applied > 0, {
    describe: () => ({ applied }),
  });
  holder.text = remote;
  seat_.bundle.stub.fire('changeTextDocument', { document: editor.document });
  seat_.host.setSelection(PATH_A, { anchor: 9, head: 9 });
  await waitFor('the follow to track past the remote edit', () => caretOf(editor) === 9);
  await seat_.bundle.stub.commands.executeCommand('selvage.stopFollowing');
  await waitFor('the follow to still be stoppable after the remote edit', () =>
    followItem(seat_) === undefined ? true : false,
  );

  // Local: the buffer holds what only this window has, and the follow ends at once.
  await seat_.bundle.stub.commands.executeCommand('selvage.followParticipant', { peerId: seat_.hostId });
  await waitFor('the second follow to begin', () =>
    followItem(seat_) !== undefined ? true : false,
  );
  holder.text = `${remote}typed here`;
  seat_.bundle.stub.fire('changeTextDocument', { document: editor.document });
  await waitFor('the local edit to end the follow', () =>
    followItem(seat_) === undefined ? true : false,
  );
  // Typing ends the follow the user did not ask to end, so it says so — the twin's
  // sentence, which the indicator going down alone does not carry.
  assert.ok(
    seat_.bundle.stub.registered.information.some(
      (message) => message === 'Selvage: stopped following Ada.',
    ),
    'the local edit ended the follow silently',
  );
  await seat_.bundle.stub.commands.executeCommand('selvage.stopFollowing');
  await waitFor('the ended follow to be unstoppable', () =>
    seat_.bundle.stub.registered.warnings.some((message) => message === 'Selvage: not following anyone.'),
  );
});

test('a local cursor move stops the follow and says so', async (t) => {
  const seat_ = await seat(t, { [PATH_A]: TEXT_A });
  const holder = { text: TEXT_A };
  const editor = await openHeld(seat_, PATH_A, holder, 5);

  await seat_.bundle.stub.commands.executeCommand('selvage.followParticipant', { peerId: seat_.hostId });
  await waitFor('the follow to begin', () =>
    followItem(seat_) !== undefined ? true : false,
  );
  await waitFor('the follow to land at the host caret', () => caretOf(editor) === 5);

  // The person reaches for the arrow key: the editor reports the move as a selection change,
  // which is the one thing the follow itself does not produce while it is applying a landing.
  editor.selection = { anchor: { line: 0, character: 9 }, active: { line: 0, character: 9 } };
  seat_.bundle.stub.fire('selection');
  await waitFor('the move to stop the follow', () =>
    followItem(seat_) === undefined ? true : false,
  );
  assert.ok(
    seat_.bundle.stub.registered.information.some(
      (message) => message === 'Stopped following Ada — you moved.',
    ),
    'the move ended the follow silently',
  );

  // And the stop is permanent: the next frame draws the peer's caret, and leaves ours alone.
  seat_.host.setSelection(PATH_A, { anchor: 2, head: 2 });
  await waitFor('the next peer frame to be drawn', () => (drawnCaretAt(editor, 2) ? true : false), {
    describe: () => ({ decorated: editor.decorated.length }),
  });
  assert.equal(caretOf(editor), 9, 'the follow dragged the caret back after it ended');
});

test("a landing's own late echo does not end the follow", async (t) => {
  const seat_ = await seat(t, { [PATH_A]: TEXT_A });
  const holder = { text: TEXT_A };
  const editor = await openHeld(seat_, PATH_A, holder, 5);

  await seat_.bundle.stub.commands.executeCommand('selvage.followParticipant', { peerId: seat_.hostId });
  await waitFor('the follow to begin', () =>
    followItem(seat_) !== undefined ? true : false,
  );
  // The effect the test waits on: the landing placed the peer's caret. The stub never
  // fires a selection event for the programmatic move, so the echo below is staged by
  // hand the way the editor reports it — after the assignment has returned, with the
  // counter back at zero. Publishing our own caret would rebroadcast presence and land
  // again, superseding the expectation before the echo arrives; the echo is staged before
  // the publish runs instead, so it answers the placement it belongs to.
  await waitFor('the follow to land at the host caret', () => caretOf(editor) === 5);
  // The editor hands the landing its own object, while the test's stand-in is a plain
  // record: the echo below names the landing's editor by its document, the identity the
  // implementation can observe through the stub.
  const landed = seat_.bundle.stub.registered.shownEditors.find(
    (candidate) => candidate.document === editor.document,
  ) as unknown as typeof editor | undefined;
  seat_.bundle.stub.fire('selection', {
    textEditor: landed ?? editor,
    selections: [{ active: caretOf(editor) ?? 5 }],
  });
  // The echo must not end the follow: the indicator stays up and nothing says the person
  // moved — which is what a misread echo broke. Tracking the next genuine move proves the
  // follow survived it.
  assert.ok(followItem(seat_) !== undefined, "the landing's echo ended the follow");
  assert.deepEqual(
    seat_.bundle.stub.registered.information.filter((message) => message.includes('you moved')),
    [],
    "the landing's echo said the person moved",
  );
  seat_.host.setSelection(PATH_A, { anchor: 8, head: 8 });
  await waitFor('the follow to track past its own echo', () => caretOf(editor) === 8);
  assert.ok(followItem(seat_) !== undefined, 'the follow ended on the move after its echo');
});

test('going somewhere stops following first', async (t) => {
  const seat_ = await seat(t, { [PATH_A]: TEXT_A, [PATH_B]: TEXT_B });
  const holder = { text: TEXT_A };
  await openHeld(seat_, PATH_A, holder, 5);
  const cara = await peerIn(t, seat_, 'Cara', PATH_B, TEXT_B, 6);
  const caraId = cara.session().peer.peer_id;

  await seat_.bundle.stub.commands.executeCommand('selvage.followParticipant', { peerId: seat_.hostId });
  await waitFor('the follow to begin', () =>
    followItem(seat_) !== undefined ? true : false,
  );

  await seat_.bundle.stub.commands.executeCommand('selvage.goToParticipant', { peerId: caraId });
  const retryGoTo = issueUntil(seat_.bundle, 'selvage.goToParticipant', { peerId: caraId });
  await waitFor('the go-to to stop the follow', () =>
    followItem(seat_) === undefined ? true : false,
  );
  // The navigation supersedes the follow the user did not ask to end, so it says so.
  assert.ok(
    seat_.bundle.stub.registered.information.some(
      (message) => message === 'Selvage: stopped following Ada.',
    ),
    'the go-to superseded the follow silently',
  );
  const uriB = seat_.roomFile( PATH_B);
  const editorB = await waitFor(
    'the go-to to open the other peer document',
    () => {
      const editors = seat_.bundle.stub.registered.shownEditors as unknown as FakeEditor[];
      const found = editors.find(
        (editor) => (editor.document['uri'] as { toString(): string }).toString() === uriB,
      );
      if (found !== undefined) {
        return found;
      }
      retryGoTo();
      return undefined;
    },
    { describe: () => seat_.bundle.stub.registered.shown },
  );
  assert.ok(editorB !== undefined, 'the go-to never opened the other peer document');
  seat_.bundle.stub.fire('openTextDocument', editorB.document);
  seat_.bundle.stub.window.activeTextEditor = editorB;
  await waitFor('the go-to to land on the other peer', () => caretOf(editorB) === 6);
  assert.equal(followItem(seat_), undefined, 'the go-to left the follow indicator up');
});

test('the follow ends when the peer leaves, and the name re-labels while they stay', async (t) => {
  const seat_ = await seat(t, { [PATH_A]: TEXT_A });
  const holder = { text: TEXT_A };
  await openHeld(seat_, PATH_A, holder, 5);
  const cara = await peerIn(t, seat_, 'Cara', PATH_A, TEXT_A, 7);
  const caraId = cara.session().peer.peer_id;

  // The peer may still be joining when the command runs: re-issue until the follow establishes.
  const retryFollow = issueUntil(seat_.bundle, 'selvage.followParticipant', { peerId: caraId });
  await waitFor('the follow of the second peer to begin', () => {
    if (followItem(seat_) !== undefined) {
      return true;
    }
    retryFollow();
    return false;
  });
  assert.equal(followItem(seat_)?.text, '$(person) Selvage: following Cara');

  // A rename re-labels the indicator rather than ending anything: the target is a peer id,
  // so only the name it is shown under changes. The leave sentence below then says the new
  // name, which proves the re-label stuck.
  await cara.rename('Cora');
  await waitFor('the indicator to re-label while the follow holds', () =>
    followItem(seat_)?.text === '$(person) Selvage: following Cora' ? true : false,
  );

  await cara.disconnect();
  await waitFor('the follow to end with the peer', () =>
    seat_.bundle.stub.registered.warnings.some(
      (message) => message === 'Selvage: Cora left the room, so following stopped.',
    ),
  );
});

test('two peers sharing a name are told apart in the picker', async (t) => {
  const seat_ = await seat(t, { [PATH_A]: TEXT_A, [PATH_B]: TEXT_B });
  const holder = { text: TEXT_A };
  await openHeld(seat_, PATH_A, holder, 5);
  // A second `Ada`: the display name is not an identity, and the rows must not pretend it is.
  const other = await peerIn(t, seat_, 'Ada', PATH_B, TEXT_B, 6);
  const otherId = other.session().peer.peer_id;
  assert.notEqual(otherId, seat_.hostId);

  await seat_.bundle.stub.commands.executeCommand('selvage.followParticipant');
  const retryPick = issueUntil(seat_.bundle, 'selvage.followParticipant', undefined);
  const picked = await waitFor(
    'the picker to list both Adas',
    () => {
      const calls = seat_.bundle.stub.registered.quickPicks;
      const last = calls.at(-1) as { items: Array<{ label: string; peerId: string }> } | undefined;
      const rows = last?.items.filter((item) => item.label.startsWith('Ada'));
      if (rows !== undefined && rows.length >= 2) {
        return { call: last as { items: Array<{ label: string; peerId: string }> }, rows };
      }
      retryPick();
      return undefined;
    },
    { describe: () => seat_.bundle.stub.registered.quickPicks.length },
  );
  const rows = picked.rows;
  assert.equal(rows.length, 2);
  const labels = rows.map((row) => row.label).sort();
  assert.notEqual(labels[0], labels[1], 'two peers share one bare label');
  for (const row of rows) {
    const fragment = /^Ada \((.+)\)$/.exec(row.label)?.[1];
    assert.ok(fragment !== undefined, `${row.label} carries no disambiguator`);
    assert.ok(row.peerId.startsWith(fragment), `${row.label} names no prefix of ${row.peerId}`);
    const rival = rows.find((other_) => other_ !== row);
    assert.ok(
      rival !== undefined && !rival.peerId.startsWith(fragment),
      `${row.label} does not tell the two apart`,
    );
  }

  // Following through the disambiguated row lands on the peer it names, in their document.
  // The answer must be a row the picker rendered after presence arrived: an earlier round
  // still names the peer without a document, and the picker refuses its own stale rows.
  const fresh = await waitFor(
    'the picker to see the chosen peer document',
    () => {
      const calls = seat_.bundle.stub.registered.quickPicks;
      const last = calls.at(-1) as
        | { items: Array<{ label: string; peerId: string; path?: string }> }
        | undefined;
      const row = last?.items.find((item) => item.peerId === otherId);
      if (row !== undefined && row.path !== undefined) {
        return row;
      }
      retryPick();
      return undefined;
    },
    { describe: () => seat_.bundle.stub.registered.quickPicks.length },
  );
  assert.ok(fresh !== undefined, 'the picker never saw the chosen peer document');
  seat_.bundle.stub.registered.quickPickReply = fresh;
  await seat_.bundle.stub.commands.executeCommand('selvage.followParticipant');
  const uriB = seat_.roomFile( PATH_B);
  const editorB = await waitFor(
    'the follow to open the chosen peer document',
    () => {
      const editors = seat_.bundle.stub.registered.shownEditors as unknown as FakeEditor[];
      const found = editors.find(
        (editor) => (editor.document['uri'] as { toString(): string }).toString() === uriB,
      );
      return found;
    },
    { describe: () => seat_.bundle.stub.registered.shown },
  );
  seat_.bundle.stub.fire('openTextDocument', editorB.document);
  seat_.bundle.stub.window.activeTextEditor = editorB;
  await waitFor('the follow to land on the chosen peer', () => caretOf(editorB) === 6);
});

test('going to a peer in no document is refused, not landed', async (t) => {
  const seat_ = await seat(t, { [PATH_A]: TEXT_A });
  const holder = { text: TEXT_A };
  await openHeld(seat_, PATH_A, holder, 5);
  // `Nora` joins and publishes no document: a fresh seat publishes an empty presence, which
  // names her with no path, and the picker row says so.
  const nora = await LiveSession.join(
    seat_.invite,
    'Nora',
    options({ baseUrl: seat_.server.wsBase, displayName: 'Nora', reconnect: false }),
  );
  t.after(async () => {
    await nora.disconnect();
  });
  const noraId = nora.session().peer.peer_id;

  // Picking her row refuses where the row says as much, instead of landing anywhere.
  const retry = issueUntil(seat_.bundle, 'selvage.goToParticipant', undefined);
  const row = await waitFor(
    'the picker to list the peer without a document',
    () => {
      const calls = seat_.bundle.stub.registered.quickPicks;
      const last = calls.at(-1) as
        | { items: Array<{ label: string; peerId: string; path?: string }> }
        | undefined;
      const found = last?.items.find((item) => item.peerId === noraId);
      if (found !== undefined && found.path === undefined) {
        return found;
      }
      retry();
      return undefined;
    },
    { describe: () => seat_.bundle.stub.registered.quickPicks.length },
  );
  assert.ok(row !== undefined, 'the picker never listed the peer without a document');
  seat_.bundle.stub.registered.quickPickReply = row;
  await seat_.bundle.stub.commands.executeCommand('selvage.goToParticipant');
  await waitFor('the refusal to name the peer without a document', () =>
    seat_.bundle.stub.registered.warnings.some(
      (message) => message === 'Selvage: nothing to go to: Nora is not in a document.',
    ),
  );
  assert.equal(
    seat_.bundle.stub.registered.shownEditors.length,
    1,
    'the refused go-to opened an editor',
  );
});

test('a host jumps to a peer through its own working copy', async (t) => {
  // A host holds no mirror documents: the peer path opens as the window's own file, through
  // the check a read on a peer's behalf goes through rather than a bare join.
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  const bundle = loadBundle();
  bundle.stub.reset();
  bundle.activate({ subscriptions: [] });
  t.after(() => {
    bundle.deactivate();
  });
  const FILE_TEXT = 'hello room\n';
  bundle.stub.put('notes.txt', FILE_TEXT);
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  const invite = await waitFor(
    'the host invite to reach the clipboard',
    () => {
      void bundle.stub.commands.executeCommand('selvage.copyInvite');
      const text = bundle.stub.registered.clipboard;
      return /^https?:\/\//.test(text) ? text : false;
    },
    { describe: () => bundle.stub.registered.clipboard },
  );
  const page = new URL(invite);
  // `§5.1`: the room's two keys travel in the fragment of the link the host handed on, so the
  // peer joins with that link's own wire form and its fragment, not with the query alone.
  const wire = sessionUrl(
    baseOf(page.searchParams.get('server') ?? server.wsBase),
    page.searchParams.get('room') ?? '',
    page.searchParams.get('token') ?? '',
  ) + page.hash;
  const guest = await LiveSession.join(
    wire,
    'Cara',
    options({ baseUrl: server.wsBase, displayName: 'Cara', reconnect: false }),
  );
  t.after(async () => {
    await guest.disconnect();
  });
  await guest.open('notes.txt');
  const guestId = guest.session().peer.peer_id;
  // No text yet, so this publishes the path alone: enough for the jump to open the file,
  // whose hold is what seeds the text the caret then resolves against.
  guest.setSelection('notes.txt', { anchor: 6, head: 6 });

  // The host holds nothing yet, so the jump opens the file and pends on the text the hold
  // brings: the host's own seed, read off the working copy the guest asked for.
  const retry = issueUntil(bundle, 'selvage.followParticipant', { peerId: guestId });
  const opened = await waitFor(
    'the jump to open the working-copy file',
    () => {
      const editors = bundle.stub.registered.shownEditors as unknown as FakeEditor[];
      const found = editors.find((editor) =>
        (editor.document['uri'] as { toString(): string }).toString() === 'file:///workspace/notes.txt',
      );
      if (found !== undefined) {
        return found;
      }
      retry();
      return undefined;
    },
    { describe: () => bundle.stub.registered.shown },
  );
  assert.ok(opened !== undefined, 'the jump never opened the working-copy file');
  bundle.stub.fire('openTextDocument', opened.document);
  bundle.stub.window.activeTextEditor = opened;
  await waitFor('the room to hold the file text', () => (guest.text('notes.txt') === FILE_TEXT ? true : false), {
    describe: () => guest.text('notes.txt'),
  });
  guest.setSelection('notes.txt', { anchor: 6, head: 6 });
  await waitFor('the jump to land on the peer caret', () => (caretOf(opened) === 6 ? true : false), {
    describe: () => caretOf(opened),
  });
  await waitFor('the follow to begin', () =>
    bundle.stub.registered.statusBarItems.some(
      (item) => item.command === 'selvage.stopFollowing',
    )
      ? true
      : false,
  );
});

test('a display name lands without the palette when it names one peer', async (t) => {
  const seat_ = await seat(t, { [PATH_A]: TEXT_A });
  const holder = { text: TEXT_A };
  const editor = await openHeld(seat_, PATH_A, holder, 5);
  const cara = await peerIn(t, seat_, 'Cara', PATH_A, TEXT_A, 7);
  void cara;
  // The name is what automation can know: retry until the room names her.
  const retry = issueUntil(seat_.bundle, 'selvage.followParticipant', { displayName: 'Cara' });
  await waitFor('the named follow to begin', () => {
    if (followItem(seat_) !== undefined) {
      return true;
    }
    retry();
    return false;
  });
  await waitFor('the named follow to land', () => caretOf(editor) === 7);
});

test('a display name shared by two peers falls through to the pick', async (t) => {
  const seat_ = await seat(t, { [PATH_A]: TEXT_A, [PATH_B]: TEXT_B });
  const holder = { text: TEXT_A };
  await openHeld(seat_, PATH_A, holder, 5);
  const other = await peerIn(t, seat_, 'Ada', PATH_B, TEXT_B, 6);
  void other;
  // Palette rounds without a reply never land, so they are the wait for settled rows; the one
  // named round then runs against both Adas and still establishes nothing.
  const look = issueUntil(seat_.bundle, 'selvage.followParticipant', undefined);
  await waitFor('the picker to list both Adas', () => {
    const calls = seat_.bundle.stub.registered.quickPicks;
    const last = calls.at(-1) as { items: Array<{ label: string }> } | undefined;
    const rows = last?.items.filter((item) => item.label.startsWith('Ada'));
    if (rows !== undefined && rows.length >= 2) {
      return true;
    }
    look();
    return false;
  });
  await seat_.bundle.stub.commands.executeCommand('selvage.followParticipant', { displayName: 'Ada' });
  const last = seat_.bundle.stub.registered.quickPicks.at(-1) as
    | { items: Array<{ label: string }> }
    | undefined;
  assert.equal(
    last?.items.filter((item) => item.label.startsWith('Ada')).length,
    2,
    'the named round did not reach the pick',
  );
  assert.ok(
    !seat_.bundle.stub.registered.information.some((message) => message.startsWith('Selvage: following')),
    'an ambiguous name followed someone',
  );
});

test('a remote CRLF apply does not end the follow while local CRLF typing does', async (t) => {
  const seat_ = await seat(t, { [PATH_A]: TEXT_A });
  const holder = { text: TEXT_A };
  const editor = await openHeld(seat_, PATH_A, holder, 5);

  await seat_.bundle.stub.commands.executeCommand('selvage.followParticipant', { peerId: seat_.hostId });
  await waitFor('the follow to begin', () =>
    followItem(seat_) !== undefined ? true : false,
  );

  // The buffer holds CRLF while the replica holds LF: the steady state of a CRLF document,
  // which a raw `===` against the replica would read as divergent on every remote apply.
  const crlf = (text: string): string => text.replaceAll('\n', '\r\n');
  holder.text = crlf(TEXT_A);

  // Remote: the host's text reaches the buffer first — the apply the bridge stages is the
  // proof the replica holds it — and only then does the change event carry the room's own
  // text, rendered with this document's line endings. The follow must survive it, and prove
  // it by tracking the next move.
  const remote = `!${TEXT_A}`;
  let applied = 0;
  seat_.bundle.stub.registered.applyEditImpl = async () => {
    applied += 1;
    return true;
  };
  seat_.host.insert(PATH_A, 0, '!');
  await waitFor('the remote edit to reach the guest buffer', () => applied > 0, {
    describe: () => ({ applied }),
  });
  holder.text = crlf(remote);
  seat_.bundle.stub.fire('changeTextDocument', { document: editor.document });
  seat_.host.setSelection(PATH_A, { anchor: 9, head: 9 });
  await waitFor('the follow to track past the CRLF remote edit', () => caretOf(editor) === 9);
  await seat_.bundle.stub.commands.executeCommand('selvage.stopFollowing');
  await waitFor('the follow to still be stoppable after the CRLF remote edit', () =>
    followItem(seat_) === undefined ? true : false,
  );

  // Local: the buffer holds what only this window has, and the follow ends at once.
  await seat_.bundle.stub.commands.executeCommand('selvage.followParticipant', { peerId: seat_.hostId });
  await waitFor('the second follow to begin', () =>
    followItem(seat_) !== undefined ? true : false,
  );
  holder.text = `${crlf(remote)}typed here`;
  seat_.bundle.stub.fire('changeTextDocument', { document: editor.document });
  await waitFor('the local CRLF edit to end the follow', () =>
    followItem(seat_) === undefined ? true : false,
  );
  await seat_.bundle.stub.commands.executeCommand('selvage.stopFollowing');
  await waitFor('the ended follow to be unstoppable', () =>
    seat_.bundle.stub.registered.warnings.some((message) => message === 'Selvage: not following anyone.'),
  );
});

test('a superseded landing never places', async (t) => {
  const seat_ = await seat(t, { [PATH_A]: TEXT_A, [PATH_B]: TEXT_B });
  const holder = { text: TEXT_A };
  await openHeld(seat_, PATH_A, holder, 5);

  await seat_.bundle.stub.commands.executeCommand('selvage.followParticipant', { peerId: seat_.hostId });
  await waitFor('the follow to begin', () =>
    followItem(seat_) !== undefined ? true : false,
  );

  // The first landing's open is held across the peer's next move: the older frame must not
  // place once a newer one exists. Only the first show for the peer document waits; later
  // frames pass, so the second move lands while the first is still in flight. Draining the
  // microtasks after the release settles the held frame — its path from there is synchronous
  // — so what follows observes it rather than racing it.
  const uriB = seat_.roomFile( PATH_B);
  const windowState = seat_.bundle.stub.window as unknown as Record<string, unknown>;
  const show = windowState['showTextDocument'] as (
    document: unknown,
    options?: unknown,
  ) => Promise<unknown>;
  let gated = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  windowState['showTextDocument'] = async (document: unknown, options?: unknown) => {
    const shown = (document as { uri: { toString(): string } }).uri.toString();
    if (shown === uriB && gated === 0) {
      gated += 1;
      await gate;
    }
    return show(document, options);
  };
  t.after(() => {
    windowState['showTextDocument'] = show;
  });
  const editorsForB = (): FakeEditor[] =>
    (seat_.bundle.stub.registered.shownEditors as unknown as FakeEditor[]).filter(
      (editor) => (editor.document['uri'] as { toString(): string }).toString() === uriB,
    );

  seat_.host.setSelection(PATH_B, { anchor: 6, head: 6 });
  await waitFor('the first landing to reach its held open', () => (gated > 0 ? true : false), {
    describe: () => ({ gated }),
  });
  seat_.host.setSelection(PATH_B, { anchor: 9, head: 9 });
  await waitFor(
    'the second move to land while the first is held',
    () => (editorsForB().some((editor) => caretOf(editor) === 9) ? true : false),
    { describe: () => editorsForB().map((editor) => caretOf(editor)) },
  );

  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    editorsForB().every((editor) => caretOf(editor) !== 6),
    'the superseded landing placed the first offset',
  );
  assert.ok(
    editorsForB().some((editor) => caretOf(editor) === 9),
    'the follow lost the second offset',
  );
  await seat_.bundle.stub.commands.executeCommand('selvage.stopFollowing');
  await waitFor('the follow to still be stoppable after the overlap', () =>
    followItem(seat_) === undefined ? true : false,
  );
});

test('following a peer in no document pends until they enter one', async (t) => {
  const seat_ = await seat(t, { [PATH_A]: TEXT_A });
  const holder = { text: TEXT_A };
  const editor = await openHeld(seat_, PATH_A, holder, 5);
  // `Nora` joins and publishes no document: a programmatic follow names her by id, past the
  // picker that would refuse its own row, and pends on the next frame rather than refusing a
  // peer whose update may be one frame away.
  const nora = await LiveSession.join(
    seat_.invite,
    'Nora',
    options({ baseUrl: seat_.server.wsBase, displayName: 'Nora', reconnect: false }),
  );
  t.after(async () => {
    await nora.disconnect();
  });
  const noraId = nora.session().peer.peer_id;

  // Membership first: following an id the room has never named reads as gone, not as waiting.
  // Each probe opens a picker that is left unanswered, which establishes nothing.
  const look = issueUntil(seat_.bundle, 'selvage.followParticipant', undefined);
  await waitFor('the room to name the peer without a document', () => {
    const calls = seat_.bundle.stub.registered.quickPicks;
    const last = calls.at(-1) as { items: Array<{ peerId: string }> } | undefined;
    if (last?.items.some((item) => item.peerId === noraId) === true) {
      return true;
    }
    look();
    return false;
  });
  await seat_.bundle.stub.commands.executeCommand('selvage.followParticipant', { peerId: noraId });

  // Her entering a document is the next frame the pend waited on: the follow lands there,
  // which proves the pend held the target instead of refusing or dropping it.
  await nora.open(PATH_A);
  await waitFor(`the peer replica to hold ${PATH_A}`, () => (nora.text(PATH_A) === TEXT_A ? true : false), {
    describe: () => nora.text(PATH_A),
  });
  nora.setSelection(PATH_A, { anchor: 7, head: 7 });
  await waitFor('the pending follow to land once she enters a document', () => caretOf(editor) === 7);
  await waitFor('the pending follow to begin', () =>
    followItem(seat_) !== undefined ? true : false,
  );
  assert.equal(followItem(seat_)?.text, '$(person) Selvage: following Nora');
});

test('an unknown peer id falls through to the pick', async (t) => {
  const seat_ = await seat(t, { [PATH_A]: TEXT_A });
  const holder = { text: TEXT_A };
  const editor = await openHeld(seat_, PATH_A, holder, 5);
  void editor;

  // Membership first: a successful jump proves the room names its peers, so the id below is
  // provably unknown rather than merely not yet arrived.
  await seat_.bundle.stub.commands.executeCommand('selvage.goToParticipant', { peerId: seat_.hostId });
  await waitFor('the jump to land at the host caret', () => (caretOf(editor) === 5 ? true : false), {
    describe: () => caretOf(editor),
  });
  const picksBefore = seat_.bundle.stub.registered.quickPicks.length;
  const warningsBefore = seat_.bundle.stub.registered.warnings.length;
  const errorsBefore = seat_.bundle.stub.registered.errors.length;
  const shownBefore = seat_.bundle.stub.registered.shownEditors.length;

  // A stale programmatic id names nobody: the rows carry the names, so the palette answers
  // instead of an invented sentence, and nothing lands anywhere.
  await seat_.bundle.stub.commands.executeCommand('selvage.goToParticipant', { peerId: 'no-such-peer' });
  assert.equal(
    seat_.bundle.stub.registered.quickPicks.length,
    picksBefore + 1,
    'the unknown id never reached the palette',
  );
  const last = seat_.bundle.stub.registered.quickPicks.at(-1) as { options: { title: string } } | undefined;
  assert.equal(last?.options.title, 'Go to a participant');
  assert.equal(seat_.bundle.stub.registered.warnings.length, warningsBefore, 'the unknown id warned');
  assert.equal(seat_.bundle.stub.registered.errors.length, errorsBefore, 'the unknown id errored');
  assert.equal(seat_.bundle.stub.registered.shownEditors.length, shownBefore, 'the unknown id landed');
});

test('a host jump to a path it does not share is refused without opening', async (t) => {
  // A host holds no mirror documents: the peer path opens as the window's own file, through
  // the check a read on a peer's behalf goes through. A path the grant deliberately leaves
  // out — here `.env`, which no listing ever names — fails that check, with the same sentence
  // a deleted path reports, and opens nothing.
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  const bundle = loadBundle();
  bundle.stub.reset();
  bundle.activate({ subscriptions: [] });
  t.after(() => {
    bundle.deactivate();
  });
  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  const invite = await waitFor(
    'the host invite to reach the clipboard',
    () => {
      void bundle.stub.commands.executeCommand('selvage.copyInvite');
      const text = bundle.stub.registered.clipboard;
      return /^https?:\/\//.test(text) ? text : false;
    },
    { describe: () => bundle.stub.registered.clipboard },
  );
  const page = new URL(invite);
  // `§5.1`: the room's two keys travel in the fragment of the link the host handed on, so the
  // peer joins with that link's own wire form and its fragment, not with the query alone.
  const wire = sessionUrl(
    baseOf(page.searchParams.get('server') ?? server.wsBase),
    page.searchParams.get('room') ?? '',
    page.searchParams.get('token') ?? '',
  ) + page.hash;
  const guest = await LiveSession.join(
    wire,
    'Cara',
    options({ baseUrl: server.wsBase, displayName: 'Cara', reconnect: false }),
  );
  t.after(async () => {
    await guest.disconnect();
  });
  await guest.open('.env');
  const guestId = guest.session().peer.peer_id;
  // No text, so this publishes the path alone: enough for the jump to reach the grant check.
  guest.setSelection('.env', { anchor: 0, head: 0 });
  const shownBefore = bundle.stub.registered.shownEditors.length;

  // An attempt from before presence arrives pends before opening anything, so the command is
  // re-issued until the refusal it stages shows.
  const retry = issueUntil(bundle, 'selvage.goToParticipant', { peerId: guestId });
  await waitFor('the refused jump to say it could not open the path', () => {
    if (
      bundle.stub.registered.errors.some(
        (message) =>
          message === 'Selvage: could not open .env from the room: the path is not one this window shares',
      )
    ) {
      return true;
    }
    retry();
    return false;
  });
  assert.equal(
    bundle.stub.registered.shownEditors.length,
    shownBefore,
    'the refused jump opened an editor',
  );
});

test('a guest follow to a peer-named path outside the grant is refused without opening', async (t) => {
  // The guest branch of the open had no grant check: a peer publishing awareness for
  // `../../x` — or the mirror's own marker — made a following window open it. The gate
  // lives at `mirrorUri` now, so both refuse with the grant's sentence and open nothing.
  const seat_ = await seat(t, { [PATH_A]: TEXT_A });
  const holder = { text: TEXT_A };
  await openHeld(seat_, PATH_A, holder, 5);

  const mallory = await LiveSession.join(
    seat_.invite,
    'Mallory',
    options({ baseUrl: seat_.server.wsBase, displayName: 'Mallory', reconnect: false }),
  );
  t.after(async () => {
    await mallory.disconnect();
  });
  const malloryId = mallory.session().peer.peer_id;
  // No text, so this publishes the path alone: enough for the follow to reach the gate.
  mallory.setSelection('../../outside.md', { anchor: 0, head: 0 });
  const openedBefore = seat_.bundle.stub.registered.opened.length;

  // An attempt from before presence arrives pends before opening anything, so the command
  // is re-issued until the refusal it stages shows.
  const retry = issueUntil(seat_.bundle, 'selvage.followParticipant', { peerId: malloryId });
  await waitFor('the traversal to be refused', () => {
    if (
      seat_.bundle.stub.registered.errors.some(
        (message) =>
          message ===
          'Selvage: could not open ../../outside.md from the room: the path is not one this window shares',
      )
    ) {
      return true;
    }
    retry();
    return false;
  });

  // The mirror's own marker names bookkeeping, never a document: refused the same way.
  mallory.setSelection('.selvage-mirror.json', { anchor: 0, head: 0 });
  await waitFor('the marker to be refused', () =>
    seat_.bundle.stub.registered.errors.some(
      (message) =>
        message ===
        'Selvage: could not open .selvage-mirror.json from the room: the path is not one this window shares',
    )
      ? true
      : false,
  );

  assert.deepEqual(
    seat_.bundle.stub.registered.opened.slice(openedBefore),
    [],
    'a peer-named path reached the editor',
  );
  await seat_.bundle.stub.commands.executeCommand('selvage.stopFollowing');
});
