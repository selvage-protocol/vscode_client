/**
 * The command flows, through the built extension with the editor API stubbed and a fake
 * `selvaged` in the room. `test/manifest.test.ts` checks that the commands exist; this
 * checks what they do when a user is already in a session, and what a guest sees when it
 * joins a room that has documents.
 *
 * A command's handler starts its work detached (`void host(files, args)`), so every
 * expectation here is a bounded poll of what the stub recorded, not an `await` on the
 * command's own promise.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import { loadBundle } from './helpers/bundle.ts';
import type { LoadedExtension } from './helpers/bundle.ts';
import { FakeServer } from './helpers/fake-server.ts';
import { waitFor } from './helpers/wait.ts';
import { SelvageEngine, parseSessionUrl } from '../src/engine/index.ts';
import { peerColour, virtualUri } from '../src/bridge/index.ts';

const OPTIONS = { client: 'selvage-vscode-test/0.1.0', meta: 'skip' } as const;

/** The room an invite names, so a message that has to name it can be read as a whole. */
function roomOf(invite: string): string {
  const room = parseSessionUrl(invite)?.join.room;
  assert.ok(room !== undefined, `the invite names no room: ${invite}`);
  return room;
}

/** The refusal both clients send for a name over the protocol's 32-unit bound. */
function overBound(units: number): string {
  return `Selvage: this name is ${units} UTF-16 code units and the limit is 32; a name is refused rather than shortened.`;
}

/**
 * What the status bar says the room offers. The bar is the only place this client publishes the
 * room's own document set, so it is what a test reads to know a `documents` report has landed.
 */
function roomOffer(bundle: LoadedExtension): string {
  return String(bundle.stub.registered.statusBarItems.at(-1)?.tooltip ?? '');
}

/** A server with a room, minted by a source engine, and its invite. */
async function room(
  t: TestContext,
  paths: string[],
): Promise<{ server: FakeServer; host: SelvageEngine; invite: string; roomId: string }> {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const host = await SelvageEngine.host(server.wsBase, 'Ada', OPTIONS);
  t.after(async () => {
    await host.disconnect();
  });
  for (const path of paths) {
    await host.open(path);
  }
  const invite = host.inviteUrl();
  assert.ok(invite !== undefined, 'the host was given no invite link');
  return { server, host, invite, roomId: host.session().roomId };
}

/** The bundle, activated, with its recorded state cleared. */
function activated(t: TestContext): LoadedExtension {
  const bundle = loadBundle();
  bundle.stub.reset();
  bundle.activate({ subscriptions: [] });
  t.after(() => {
    bundle.deactivate();
  });
  return bundle;
}

/** A guest session in `bundle`, seated and with its first document opened by the adapter. */
async function guest(
  t: TestContext,
  paths: string[],
): Promise<{ bundle: LoadedExtension; server: FakeServer; invite: string; roomId: string }> {
  const { server, invite, roomId } = await room(t, paths);
  const bundle = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room')) ? true : false,
  );
  return { bundle, server, invite, roomId };
}

test('hosting while hosting copies the invite rather than minting a room', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const bundle = activated(t);

  const hostArgs = { serverUrl: server.wsBase, displayName: 'Ada' };
  await bundle.stub.commands.executeCommand('selvage.host', hostArgs);
  const invite = await waitFor('the first session to be ready', () => {
    void bundle.stub.commands.executeCommand('selvage.copyInvite');
    const text = bundle.stub.registered.clipboard;
    return text.startsWith('ws://') ? text : false;
  });
  assert.equal(server.acceptedConnections, 1, 'the first host opened one connection');

  // The second `Host` is the user reaching for the invite; it must copy the same room's
  // link, not open a second connection and not tell them to run `Copy invite link`.
  bundle.stub.reset();
  await bundle.stub.commands.executeCommand('selvage.host', { ...hostArgs, displayName: 'Ada again' });
  const copied = await waitFor('the invite to be copied again', () => {
    const text = bundle.stub.registered.clipboard;
    return text.startsWith('ws://') ? text : false;
  });
  assert.equal(copied, invite, 'the second host copied a different invite');
  assert.equal(server.acceptedConnections, 1, 'the second host minted a second room');
  const said = await waitFor('the room to be named', () =>
    bundle.stub.registered.information.find((message) => message.includes('already hosting')) ??
      false,
  );
  assert.equal(
    said,
    `Selvage: you are already hosting room ${roomOf(invite)}; the invite link is on the clipboard.`,
  );
});

test('the copy command says where the invite went, and a window with none is told why', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const bundle = activated(t);

  // Nothing has minted a room in this window, so there is no invite to put anywhere.
  await bundle.stub.commands.executeCommand('selvage.copyInvite');
  const none = await waitFor('the warning', () =>
    bundle.stub.registered.warnings.find((message) => message.includes('invite')) ?? false,
  );
  assert.equal(
    none,
    'Selvage: there is no invite link: only the connection that opened the room has one.',
  );
  assert.equal(bundle.stub.registered.clipboard, '', 'something reached the clipboard');

  bundle.stub.reset();
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  const opened = await waitFor('the host to be seated', () =>
    bundle.stub.registered.information.find((message) => message.includes('is open')) ?? false,
  );
  // The room id is the server's, so the sentence is read with the id as its one loose part.
  assert.match(opened, /^Selvage: room \S+ is open; copy the invite link to let someone join\.$/);

  bundle.stub.reset();
  await bundle.stub.commands.executeCommand('selvage.copyInvite');
  const said = await waitFor('the invite to be copied', () =>
    bundle.stub.registered.information.find((message) => message.includes('clipboard')) ?? false,
  );
  assert.equal(said, 'Selvage: the invite link is on the clipboard.');
  assert.ok(bundle.stub.registered.clipboard.startsWith('ws://'), 'nothing reached the clipboard');
});

test('a guest opens the room\'s first document by itself, and only that one', async (t) => {
  const { bundle, roomId } = await guest(t, ['workspace/README.md', 'workspace/src/main.rs']);

  const shown = await waitFor('the room document to open', () => {
    const found = bundle.stub.registered.shown.filter((uri) => uri.startsWith('selvage:'));
    return found.length > 0 ? found : false;
  });
  assert.deepEqual(
    shown,
    [virtualUri(roomId, 'workspace/README.md')],
    'a guest with several room documents must land in one of them, not all of them',
  );
  assert.deepEqual(
    bundle.stub.registered.opened,
    [virtualUri(roomId, 'workspace/README.md')],
    'exactly one room document was opened',
  );
});

test('a guest drops into the room\'s only document with no input', async (t) => {
  const { bundle, roomId } = await guest(t, ['workspace/notes.md']);
  const shown = await waitFor('the room document to open', () =>
    bundle.stub.registered.shown.length > 0 ? bundle.stub.registered.shown : false,
  );
  assert.deepEqual(shown, [virtualUri(roomId, 'workspace/notes.md')]);
});

test('a guest lands in the room\'s first document, even one that arrives after the join', async (t) => {
  const { host, invite, roomId } = await room(t, []);
  const bundle = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  const joined = await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.find((message) => message.includes('joined room')) ?? false,
  );
  assert.equal(joined, `Selvage: joined room ${roomId}; the room has no open documents yet.`);
  assert.deepEqual(bundle.stub.registered.shown, [], 'an empty room put something in the window');

  // A room that was empty at join still owes the guest the landing the join could not make.
  await host.open('workspace/README.md');
  const shown = await waitFor('the room document to open', () => {
    const found = bundle.stub.registered.shown.filter((uri) => uri.startsWith('selvage:'));
    return found.length > 0 ? found : false;
  });
  assert.deepEqual(shown, [virtualUri(roomId, 'workspace/README.md')]);

  // A document after the first is left alone: the landing is spent, and pulling the window away
  // from a guest who is already editing is not a join.
  await host.open('workspace/notes.md');
  await waitFor('the guest to be told the room holds both', () =>
    roomOffer(bundle).includes('notes.md') ? true : false,
  );
  assert.deepEqual(
    bundle.stub.registered.shown,
    [virtualUri(roomId, 'workspace/README.md')],
    'a document that arrived later pulled the window away from the guest',
  );
});

test('selvage.openOnJoin off keeps a join from taking the window', async (t) => {
  const { host, invite, roomId } = await room(t, ['workspace/README.md']);
  const bundle = activated(t);
  bundle.stub.configure({ openOnJoin: false });
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  const joined = await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.find((message) => message.includes('joined room')) ?? false,
  );
  assert.equal(joined, `Selvage: joined room ${roomId}.`);

  // A second document is witness that the room's own report reached this window — the set the
  // join arrived with included — and neither document may have taken the window.
  await host.open('workspace/notes.md');
  await waitFor('the guest to be told the room holds both', () =>
    roomOffer(bundle).includes('notes.md') ? true : false,
  );
  assert.deepEqual(
    bundle.stub.registered.shown,
    [],
    'the join took the window with the setting off',
  );
});

test('a host with a file open is not handed a second, virtual copy of it', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const bundle = activated(t);
  // A host's open files are the room's, and it already has them in front of it. The stub answers
  // a workspace folder for the seeded file, which is what makes the adapter share it at all.
  bundle.stub.openWorkspaceDocument('file:///workspace/README.md');

  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  await waitFor('the host to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('is open')) ? true : false,
  );
  // The room's report is what a landing is decided from; wait for the host's own file to be in
  // it, so the assertion is made after the moment a guest would have been opened into.
  await waitFor('the room to report the host\'s file', () =>
    roomOffer(bundle).includes('README.md') ? true : false,
  );
  assert.deepEqual(
    bundle.stub.registered.shown.filter((uri) => uri.startsWith('selvage:')),
    [],
    'a host was handed a second, virtual copy of a file it already has open',
  );
});

test('the open command offers the room\'s document list, not a path to type', async (t) => {
  const { bundle } = await guest(t, ['workspace/README.md', 'workspace/src/main.rs']);
  await waitFor('the room document to open', () =>
    bundle.stub.registered.shown.length > 0 ? true : false,
  );

  await bundle.stub.commands.executeCommand('selvage.openDocument');
  const picked = await waitFor('the document picker', () =>
    bundle.stub.registered.quickPicks.length > 0 ? bundle.stub.registered.quickPicks[0] : false,
  );
  assert.deepEqual(
    picked.items,
    ['workspace/README.md', 'workspace/src/main.rs'],
    'the picker is not the room\'s own document set',
  );
  assert.equal(bundle.stub.registered.inputs.length, 0, 'a path was asked for by hand');
});

test('the open command refuses outside a session and in a room with nothing in it', async (t) => {
  const bundle = activated(t);
  await bundle.stub.commands.executeCommand('selvage.openDocument');
  const outside = await waitFor('the warning', () =>
    bundle.stub.registered.warnings.find((message) => message.includes('session')) ?? false,
  );
  assert.equal(outside, 'Selvage: join a session first.');

  const { invite } = await room(t, []);
  bundle.stub.reset();
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room'))
      ? true
      : false,
  );

  bundle.stub.reset();
  await bundle.stub.commands.executeCommand('selvage.openDocument');
  const empty = await waitFor('the message', () =>
    bundle.stub.registered.information.find((message) => message.includes('documents')) ?? false,
  );
  assert.equal(empty, 'Selvage: the room has no open documents yet.');
  assert.equal(bundle.stub.registered.quickPicks.length, 0, 'a list was drawn for an empty room');
});

test('open while hosting says the host\'s own files are the room\'s', async (t) => {
  // The one moment this client refuses with words of its own: a host has no virtual documents
  // to open, and the room's set is the host's own open files.
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const bundle = activated(t);
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  await waitFor('the host to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('is open')) ? true : false,
  );

  bundle.stub.reset();
  await bundle.stub.commands.executeCommand('selvage.openDocument');
  const said = await waitFor('the message', () =>
    bundle.stub.registered.information.find((message) => message.includes('hosting')) ?? false,
  );
  assert.equal(said, 'Selvage: you are hosting, so the files you open are the ones the room has.');
  assert.equal(bundle.stub.registered.quickPicks.length, 0, 'a host was offered its own files');
});

test('hosting while a guest asks before leaving, and leaves on request', async (t) => {
  const { bundle, server, roomId } = await guest(t, ['workspace/README.md']);
  const before = server.acceptedConnections;

  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada again',
  });
  const asked = await waitFor('the leave-and-host question', () =>
    bundle.stub.registered.warnings.find((message) => message.includes('hosting a session means leaving it first')) ?? false,
  );
  assert.equal(asked, `Selvage: you are in room ${roomId}; hosting a session means leaving it first.`);
  assert.equal(server.acceptedConnections, before, 'a dismissed question opened a connection');

  bundle.stub.registered.warningReply = 'Leave and host';
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada again',
  });
  await waitFor('the new host to connect', () =>
    server.acceptedConnections > before ? true : false,
  );
});

test('joining while hosting asks before ending the room', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const bundle = activated(t);
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  await waitFor('the host to be seated', () => {
    void bundle.stub.commands.executeCommand('selvage.copyInvite');
    return bundle.stub.registered.clipboard.startsWith('ws://') ? true : false;
  });
  const before = server.acceptedConnections;

  await bundle.stub.commands.executeCommand('selvage.join', {
    invite: 'ws://127.0.0.1:1/session?room=r&token=t',
    displayName: 'Bob',
  });
  const asked = await waitFor('the leave-and-join question', () =>
    bundle.stub.registered.warnings.find((message) => message.includes('joining another session ends this room')) ?? false,
  );
  // The room id is the server's, so the sentence is read with the id as the one loose part.
  assert.match(asked, /^Selvage: you are hosting room \S+; joining another session ends this room for everyone\.$/);
  assert.equal(server.acceptedConnections, before, 'a dismissed question opened a connection');
});

test('the display-name command reports the name in force and offers to change it', async (t) => {
  const bundle = activated(t);

  // With nothing set there is no name to report, and the report is the first thing the
  // command says: a palette entry takes no argument, so reading and setting share one
  // command where a Neovim one takes `:SelvageDisplayName [name]`.
  await bundle.stub.commands.executeCommand('selvage.displayName');
  const reported = await waitFor('the report', () =>
    bundle.stub.registered.information.find((message) => message.includes('display name')) ??
      false,
  );
  assert.equal(reported, 'Selvage: no display name is set yet.');
  assert.deepEqual(
    bundle.stub.registered.informationItems[0],
    ['Change the name'],
    'the report offered no way to change the name',
  );

  bundle.stub.registered.informationReply = 'Change the name';
  bundle.stub.registered.inputReply = 'Ada';
  await bundle.stub.commands.executeCommand('selvage.displayName');
  const asked = await waitFor('the question', () =>
    bundle.stub.registered.inputs[0] ?? false,
  );
  assert.match(String(asked.prompt), /At most 32 UTF-16 code units/);

  const write = await waitFor('the setting to be written', () =>
    bundle.stub.registered.settingWrites[0] ?? false,
  );
  assert.equal(write.key, 'displayName');
  assert.equal(write.value, 'Ada');
  assert.equal(
    write.target,
    bundle.stub.ConfigurationTarget.Global,
    'the name belongs to the person, not to the workspace it happens to be open in',
  );
  const said = await waitFor('the confirmation', () =>
    bundle.stub.registered.information.find((message) => message.includes('display name set')) ??
      false,
  );
  assert.match(said, /display name set to "Ada"/);
  assert.match(said, /^Selvage: display name set to "Ada"\.$/);
});

test('a settings file that will not take the name is reported, not swallowed', async (t) => {
  const bundle = activated(t);
  bundle.stub.registered.settingWriteFails = true;

  await bundle.stub.commands.executeCommand('selvage.displayName', { name: 'Ada' });
  const refusal = await waitFor('the refusal', () =>
    bundle.stub.registered.errors.find((message) => message.includes('setting')) ?? false,
  );
  assert.match(refusal, /could not write the "selvage.displayName" setting/);
  assert.equal(
    bundle.stub.registered.information.length,
    0,
    'a name that was not written was reported as set',
  );
});

test('a name of nothing is refused in the words both clients use', async (t) => {
  const bundle = activated(t);
  await bundle.stub.commands.executeCommand('selvage.displayName', { name: '   ' });
  const refusal = await waitFor('the refusal', () =>
    bundle.stub.registered.errors.find((message) => message.includes('name')) ?? false,
  );
  assert.equal(refusal, 'Selvage: a name is needed.');
  assert.equal(bundle.stub.registered.settingWrites.length, 0, 'a blank name was written');
});

test('leaving says so, and a window that is not in a session is told that instead', async (t) => {
  const { bundle } = await guest(t, ['workspace/README.md']);

  bundle.stub.reset();
  await bundle.stub.commands.executeCommand('selvage.leave');
  const left = await waitFor('the message', () =>
    bundle.stub.registered.information.find((message) => message.includes('left')) ?? false,
  );
  assert.equal(left, 'Selvage: left the session.');

  bundle.stub.reset();
  await bundle.stub.commands.executeCommand('selvage.leave');
  const again = await waitFor('the warning', () =>
    bundle.stub.registered.warnings.find((message) => message.includes('session')) ?? false,
  );
  assert.equal(again, 'Selvage: not in a session.');
});

test('a name set during a session is a live rename, told to the room', async (t) => {
  const { bundle, server } = await guest(t, ['workspace/README.md']);

  // The name in force is the room's own: the report names the session, not the setting.
  await bundle.stub.commands.executeCommand('selvage.displayName');
  const reported = await waitFor('the report', () =>
    bundle.stub.registered.information.find((message) =>
      message.includes('the name others see'),
    ) ?? false,
  );
  assert.equal(reported, 'Selvage: the name others see is "Bob".');

  await bundle.stub.commands.executeCommand('selvage.displayName', { name: 'Robert' });
  const said = await waitFor('the confirmation', () =>
    bundle.stub.registered.information.find((message) => message.includes('display name set')) ??
      false,
  );
  assert.match(said, /^Selvage: display name set to "Robert"\.$/);
  assert.equal(bundle.stub.registered.settingWrites[0]?.value, 'Robert');

  // The setting write is what the listener saw; the listener is the one sender, so one
  // rename went out, and the room's own record moves to the new name.
  const rename = await waitFor('the rename to reach the room', () => server.renames[0] ?? false);
  assert.equal(rename.displayName, 'Robert');
  assert.equal(server.renames.length, 1, 'the rename was sent more than once');
  await waitFor('the room to know the new name', () =>
    server.displayNames().includes('Robert') ? true : false,
  );
});

test('a name already in force sends no rename, and one over the bound is refused first', async (t) => {
  const { bundle, server } = await guest(t, ['workspace/README.md']);

  // The same name: the setting write fires the listener, which finds nothing to change.
  await bundle.stub.commands.executeCommand('selvage.displayName', { name: 'Bob' });
  const unchanged = await waitFor('the confirmation', () =>
    bundle.stub.registered.information.find((message) => message.includes('display name set')) ??
      false,
  );
  assert.match(unchanged, /^Selvage: display name set to "Bob"\.$/);
  assert.equal(bundle.stub.registered.settingWrites[0]?.value, 'Bob');
  assert.equal(server.renames.length, 0, 'a no-op change sent a rename');

  // Thirty-two code points and thirty-three UTF-16 units: refused before it is written or sent.
  const overLong = `${'a'.repeat(31)}\u{1f600}`;
  await bundle.stub.commands.executeCommand('selvage.displayName', { name: overLong });
  const refusal = await waitFor('the refusal', () =>
    bundle.stub.registered.errors.find((message) => message.includes('UTF-16')) ?? false,
  );
  assert.equal(refusal, overBound(33));
  assert.equal(bundle.stub.registered.settingWrites.length, 1, 'a refused name was written');
  assert.equal(server.renames.length, 0, 'a refused name reached the server');
});

test('a name over the bound is refused with both counts and never written', async (t) => {
  const bundle = activated(t);
  // Thirty-two code points and thirty-three UTF-16 code units: the emoji is the case that
  // tells the room's unit apart from the number of characters typed.
  const name = `${'a'.repeat(31)}\u{1f600}`;
  await bundle.stub.commands.executeCommand('selvage.displayName', { name });

  const refusal = await waitFor('the refusal', () =>
    bundle.stub.registered.errors.find((message) => message.includes('UTF-16')) ?? false,
  );
  assert.equal(refusal, overBound(33));
  assert.equal(bundle.stub.registered.settingWrites.length, 0, 'a refused name was written');
  assert.equal(
    bundle.stub.registered.information.length,
    0,
    'a refused name was reported as set',
  );
});

test('an over-long name never reaches the server', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const bundle = activated(t);

  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: `${'a'.repeat(31)}\u{1f600}`
  });
  const refusal = await waitFor('the refusal', () =>
    bundle.stub.registered.errors.find((message) => message.includes('UTF-16')) ?? false,
  );
  assert.equal(refusal, overBound(33));
  assert.equal(
    server.acceptedConnections,
    0,
    'the handshake went out with a name the server refuses',
  );
});

test('the setting is checked before it is sent, and the question asks for a shorter name', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const bundle = activated(t);
  // A hand-edited settings.json, which no command here would write: this is the path a
  // settings UI takes, and the client has to catch it before the handshake.
  bundle.stub.configure({ displayName: 'a'.repeat(33) });
  bundle.stub.registered.inputReply = 'Ada';

  await bundle.stub.commands.executeCommand('selvage.host', { serverUrl: server.wsBase });
  const refusal = await waitFor('the setting to be refused', () =>
    bundle.stub.registered.errors.find((message) => message.includes('UTF-16')) ?? false,
  );
  assert.equal(refusal, overBound(33));

  const asked = await waitFor('the question', () =>
    bundle.stub.registered.inputs[0] ?? false,
  );
  assert.equal(
    asked.value,
    'a'.repeat(33),
    'the box must start from the refused name so it can be shortened',
  );
  await waitFor('the host to be seated with the shorter name', () =>
    server.displayNames().includes('Ada') ? true : false,
  );
  assert.deepEqual(server.displayNames(), ['Ada'], 'the refused setting reached the server');
});

test('the peers command refuses outside a session and in a room with no one else', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const bundle = activated(t);

  await bundle.stub.commands.executeCommand('selvage.peers');
  const outside = await waitFor('the warning', () =>
    bundle.stub.registered.warnings.find((message) => message.includes('session')) ?? false,
  );
  assert.equal(outside, 'Selvage: join a session first.');

  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  // The session exists once `host()` has built it and said so; the socket being accepted is
  // earlier than that, and a command run in the gap warns `join a session first`.
  await waitFor('the host to be seated', () =>
    bundle.stub.registered.information.some((message) => /is open/.test(message)) ? true : false,
  );
  bundle.stub.reset();
  await bundle.stub.commands.executeCommand('selvage.peers');
  const alone = await waitFor('the warning', () =>
    bundle.stub.registered.warnings.find((message) =>
      message.includes('no other participants'),
    ) ?? false,
  );
  assert.equal(alone, 'Selvage: no other participants yet.');
  assert.equal(bundle.stub.registered.quickPicks.length, 0, 'a list was drawn for an empty room');
});

/** One row of the participant list, as the stub recorded it. */
interface PeerRow {
  label: string;
  description: string;
  detail: string;
  iconPath: { toString(): string };
}

test('the peers command lists the room in the colours the carets are drawn in', async (t) => {
  const { host, invite } = await room(t, ['workspace/README.md']);
  const bundle = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room'))
      ? true
      : false,
  );
  // Published after the guest is seated: awareness converges peer to peer through a relay
  // that forgets, so a state sent before the guest arrived was forwarded to nobody.
  await host.setSelection('workspace/README.md', { anchor: 0, head: 0 });

  const row = await waitFor('the list to name the document the host is in', () => {
    void bundle.stub.commands.executeCommand('selvage.peers');
    const items = bundle.stub.registered.quickPicks.at(-1)?.items as PeerRow[] | undefined;
    const first = items?.[0];
    return first?.detail === 'workspace/README.md' ? first : false;
  });
  assert.equal(row.label, 'Ada');
  assert.equal(row.description, 'host', 'the role the room gives the peer is not in the list');
  assert.equal(row.detail, 'workspace/README.md');

  // The colour is the one the caret is drawn in, derived from the same peer id by the same
  // function the cursor model uses: a second way of choosing a colour is the defect here.
  const colour = peerColour(host.session().peer.peer_id);
  const swatch = decodeURIComponent(row.iconPath.toString());
  assert.ok(swatch.includes(colour), `the list drew ${swatch}, not the caret colour ${colour}`);
});

test('joining again asks before leaving the room this window is in', async (t) => {
  const { bundle, roomId } = await guest(t, ['workspace/README.md']);

  bundle.stub.reset();
  await bundle.stub.commands.executeCommand('selvage.join', {
    invite: 'ws://127.0.0.1:1/session?room=r&token=t',
    displayName: 'Bob',
  });
  const asked = await waitFor('the question', () =>
    bundle.stub.registered.warnings.find((message) => message.includes('joining another session leaves it')) ?? false,
  );
  assert.equal(asked, `Selvage: you are in room ${roomId}; joining another session leaves it.`);

  // A dismissed question leaves the room alone, so this window is still in the one it was in.
  bundle.stub.reset();
  await bundle.stub.commands.executeCommand('selvage.displayName');
  const reported = await waitFor('the report', () =>
    bundle.stub.registered.information.find((message) =>
      message.includes('name others see'),
    ) ?? false,
  );
  assert.equal(reported, 'Selvage: the name others see is "Bob".');
});

test('a host that goes away and comes back is announced', async (t) => {
  const { bundle, server } = await guest(t, ['workspace/README.md']);

  bundle.stub.reset();
  server.drop('Ada');
  const away = await waitFor('the warning', () =>
    bundle.stub.registered.warnings.find((message) => message.includes('host left')) ?? false,
  );
  assert.equal(away, 'Selvage: the host left the room; it closes in 30s unless they come back.');

  const back = await waitFor('the announcement', () =>
    bundle.stub.registered.information.find((message) => message.includes('hosting again')) ??
      false,
  );
  assert.equal(back, 'Selvage: Ada is hosting again.');
});

test('a room that is gone is named before the session ends', async (t) => {
  const server = await FakeServer.start({ roomGraceMs: 2000 });
  t.after(async () => {
    await server.stop();
  });
  const host = await SelvageEngine.host(server.wsBase, 'Ada', OPTIONS);
  t.after(async () => {
    await host.disconnect();
  });
  await host.open('workspace/README.md');
  const invite = host.inviteUrl();
  assert.ok(invite !== undefined, 'the host was given no invite link');

  const bundle = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room'))
      ? true
      : false,
  );

  bundle.stub.reset();
  await host.disconnect();
  const away = await waitFor('the warning', () =>
    bundle.stub.registered.warnings.find((message) => message.includes('host left')) ?? false,
  );
  assert.equal(away, 'Selvage: the host left the room; it closes in 2s unless they come back.');

  const gone = await waitFor('the room to be reported gone', () =>
    bundle.stub.registered.warnings.find((message) => message.includes('gone')) ?? false,
  );
  assert.equal(gone, 'Selvage: the room is gone (host did not return).');

  // The session goes with the room, so the window is in nothing.
  bundle.stub.reset();
  await bundle.stub.commands.executeCommand('selvage.peers');
  const ended = await waitFor('the warning', () =>
    bundle.stub.registered.warnings.find((message) => message.includes('session')) ?? false,
  );
  assert.equal(ended, 'Selvage: join a session first.');
});
