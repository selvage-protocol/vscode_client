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

import { SelvageEngine } from '../src/engine/engine.ts';
import { virtualUri } from '../src/bridge/virtual.ts';
import { loadBundle } from './helpers/bundle.ts';
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
  server: FakeServer;
  host: SelvageEngine;
  invite: string;
  roomId: string;
  hostId: string;
}

/** A room with text in every path, and the bundle joined to it as `Bob`. */
async function seat(t: TestContext, texts: Record<string, string>): Promise<Seat> {
  const server = await FakeServer.start();
  const host = await SelvageEngine.host(
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
  bundle.activate({ subscriptions: [] });
  t.after(() => {
    bundle.deactivate();
  });
  t.after(async () => {
    await host.disconnect();
    await server.stop();
  });
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room')),
  );
  return { bundle, server, host, invite, roomId: host.session().roomId, hostId: host.session().peer.peer_id };
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
): Promise<SelvageEngine> {
  const peer = await SelvageEngine.join(
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
  roomId: string,
  path: string,
  holder: { text: string },
): Record<string, unknown> {
  const uriString = virtualUri(roomId, path);
  const question = uriString.indexOf('?');
  return {
    uri: {
      scheme: 'selvage',
      path: uriString.slice(uriString.indexOf('/'), question),
      query: uriString.slice(question + 1),
      toString: () => uriString,
    },
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
  const { bundle, roomId } = seat_;
  const document = guestDocument(roomId, path, holder);
  const editor = guestEditor(document);
  bundle.stub.window.activeTextEditor = editor;
  bundle.stub.window.visibleTextEditors = [editor];
  bundle.stub.fire('openTextDocument', document);
  // The hold the open took is what makes the room send the text: poll the provider the way
  // the editor reads, until the synchronous answer holds it.
  const uri = document['uri'] as { scheme: string; path: string; query: string; toString(): string };
  await waitFor(
    `the guest replica to hold ${path}`,
    () => {
      const files = bundle.registered.files;
      if (files === undefined) {
        return false;
      }
      try {
        const bytes = files.readFile(uri);
        return bytes instanceof Uint8Array && new TextDecoder().decode(bytes) === holder.text;
      } catch {
        return false;
      }
    },
    { describe: () => holder.text },
  );
  seat_.host.setSelection(path, { anchor: hostAt, head: hostAt });
  await waitFor(
    `the host caret at ${hostAt} to be drawn in ${path}`,
    () =>
      editor.decorated.some(
        (args) => Array.isArray(args[1]) && (args[1] as unknown[]).length > 0,
      ),
    { describe: () => ({ decorated: editor.decorated.length }) },
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

/** The follow indicator, when one is up: a disposed item reads as gone. */
function followItem(seat_: Seat): { text: string; command?: string } | undefined {
  return seat_.bundle.stub.registered.statusBarItems.find(
    (item) => item.command === 'selvage.stopFollowing' && (item as { disposed?: boolean }).disposed !== true,
  );
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
  const uriB = virtualUri(seat_.roomId, PATH_B);

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
    seat_.bundle.stub.registered.information.some((message) => message === 'Selvage: following Ada.'),
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
  const uriB = virtualUri(seat_.roomId, PATH_B);
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
    seat_.bundle.stub.registered.information.some((message) => message === 'Selvage: following Ada.'),
  );
  const item = followItem(seat_);
  assert.ok(item !== undefined, 'no follow indicator while following');
  assert.equal(item.text, '$(person) Selvage: following Ada');
  // The indicator doubles as the stop control: selecting it runs the stop command.
  assert.equal(item.command, 'selvage.stopFollowing');

  // By the indicator: what a click runs.
  await seat_.bundle.stub.commands.executeCommand(item.command as string);
  await waitFor('the follow to stop', () =>
    seat_.bundle.stub.registered.information.some((message) => message === 'Selvage: stopped following Ada.'),
  );

  // By the command, and then with nothing left to stop.
  await seat_.bundle.stub.commands.executeCommand('selvage.followParticipant', { peerId: seat_.hostId });
  await waitFor('the second follow to begin', () =>
    seat_.bundle.stub.registered.information.filter((message) => message === 'Selvage: following Ada.')
      .length >= 2,
  );
  await seat_.bundle.stub.commands.executeCommand('selvage.stopFollowing');
  await waitFor('the second follow to stop', () =>
    seat_.bundle.stub.registered.information.filter((message) => message === 'Selvage: stopped following Ada.')
      .length >= 2,
  );
  await seat_.bundle.stub.commands.executeCommand('selvage.stopFollowing');
  await waitFor('the empty stop to be refused', () =>
    seat_.bundle.stub.registered.warnings.some((message) => message === 'Selvage: not following anyone.'),
  );
});

test('a local edit ends the follow while a remote one does not', async (t) => {
  const seat_ = await seat(t, { [PATH_A]: TEXT_A });
  const holder = { text: TEXT_A };
  const editor = await openHeld(seat_, PATH_A, holder, 5);

  await seat_.bundle.stub.commands.executeCommand('selvage.followParticipant', { peerId: seat_.hostId });
  await waitFor('the follow to begin', () =>
    seat_.bundle.stub.registered.information.some((message) => message === 'Selvage: following Ada.'),
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
    seat_.bundle.stub.registered.information.some((message) => message === 'Selvage: stopped following Ada.'),
  );

  // Local: the buffer holds what only this window has, and the follow ends at once.
  await seat_.bundle.stub.commands.executeCommand('selvage.followParticipant', { peerId: seat_.hostId });
  await waitFor('the second follow to begin', () =>
    seat_.bundle.stub.registered.information.filter((message) => message === 'Selvage: following Ada.')
      .length >= 2,
  );
  holder.text = `${remote}typed here`;
  seat_.bundle.stub.fire('changeTextDocument', { document: editor.document });
  await waitFor('the local edit to end the follow', () =>
    seat_.bundle.stub.registered.information.some((message) => message === 'Selvage: stopped following Ada.'),
  );
  await seat_.bundle.stub.commands.executeCommand('selvage.stopFollowing');
  await waitFor('the ended follow to be unstoppable', () =>
    seat_.bundle.stub.registered.warnings.some((message) => message === 'Selvage: not following anyone.'),
  );
});

test('going somewhere stops following first', async (t) => {
  const seat_ = await seat(t, { [PATH_A]: TEXT_A, [PATH_B]: TEXT_B });
  const holder = { text: TEXT_A };
  await openHeld(seat_, PATH_A, holder, 5);
  const cara = await peerIn(t, seat_, 'Cara', PATH_B, TEXT_B, 6);
  const caraId = cara.session().peer.peer_id;

  await seat_.bundle.stub.commands.executeCommand('selvage.followParticipant', { peerId: seat_.hostId });
  await waitFor('the follow to begin', () =>
    seat_.bundle.stub.registered.information.some((message) => message === 'Selvage: following Ada.'),
  );

  await seat_.bundle.stub.commands.executeCommand('selvage.goToParticipant', { peerId: caraId });
  const retryGoTo = issueUntil(seat_.bundle, 'selvage.goToParticipant', { peerId: caraId });
  await waitFor('the go-to to stop the follow', () =>
    seat_.bundle.stub.registered.information.some((message) => message === 'Selvage: stopped following Ada.'),
  );
  const uriB = virtualUri(seat_.roomId, PATH_B);
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
    if (
      seat_.bundle.stub.registered.information.some((message) => message === 'Selvage: following Cara.')
    ) {
      return true;
    }
    retryFollow();
    return false;
  });
  assert.equal(followItem(seat_)?.text, '$(person) Selvage: following Cara');

  await cara.disconnect();
  await waitFor('the follow to end with the peer', () =>
    seat_.bundle.stub.registered.warnings.some(
      (message) => message === 'Selvage: Cara left the room, so following stopped.',
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
  const uriB = virtualUri(seat_.roomId, PATH_B);
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
  const nora = await SelvageEngine.join(
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
  // A host holds no virtual documents: the peer path opens as the window's own file, through
  // the check a read on a peer's behalf goes through rather than a bare join.
  const server = await FakeServer.start();
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
      return text.startsWith('ws://') ? text : false;
    },
    { describe: () => bundle.stub.registered.clipboard },
  );
  const guest = await SelvageEngine.join(
    invite,
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
    bundle.stub.registered.information.some((message) => message === 'Selvage: following Cara.'),
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
    if (
      seat_.bundle.stub.registered.information.some((message) => message === 'Selvage: following Cara.')
    ) {
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
