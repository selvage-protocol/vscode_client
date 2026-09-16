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
import { createRequire } from 'node:module';

import { BUNDLE, loadBundle } from './helpers/bundle.ts';
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
 * Found by name: the session's item is not the only one the window can hold while a follow
 * indicator is up.
 */
function roomOffer(bundle: LoadedExtension): string {
  return String(
    bundle.stub.registered.statusBarItems.find((item) => item.name === 'Selvage')?.tooltip ?? '',
  );
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
  assert.match(String(asked.prompt), /some emoji and accented characters count as more than one/);

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

/** The tree view the extension registered, as the provider a test can ask for children. */
interface GrantTreeLike {
  getChildren(node?: { path: string }): Array<{
    name: string;
    path: string;
    directory: boolean;
  }>;
  getTreeItem(node: { name: string; path: string; directory: boolean }): {
    label: string;
    collapsibleState: number;
    description?: string;
    command?: { command: string; arguments: unknown[] };
  };
}

function treeOf(bundle: LoadedExtension): GrantTreeLike {
  const view = bundle.registered.treeViews.find((entry) => entry.id === 'selvage.grant');
  assert.ok(view !== undefined, 'activating registered no Explorer view');
  return view.options['treeDataProvider'] as GrantTreeLike;
}

/** The invite a bundle host copied, read off the clipboard as a user's click would leave it. */
async function inviteOf(bundle: LoadedExtension): Promise<string> {
  // The copy resolves a microtask after it is asked for, so the check re-asks and reads what
  // the clipboard holds by the next poll, exactly as a user clicking the command would.
  return await waitFor('the invite link', () => {
    void bundle.stub.commands.executeCommand('selvage.copyInvite');
    const clipboard = bundle.stub.registered.clipboard;
    return clipboard.startsWith('ws://') ? clipboard : false;
  });
}

test('a host publishes the listing of the folder it was invited on', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const bundle = activated(t);
  bundle.stub.put('README.md', 'the readme\n');
  bundle.stub.put('src/main.rs', 'fn main() {}\n');
  bundle.stub.put('docs/guide/intro.md', 'intro\n');
  // What a working copy should not share: the defaults `DESIGN.md` §4.2 names, dependency
  // trees and build outputs, a symbolic link, and a file too large for one `Y.Text`.
  bundle.stub.put('.env', 'SECRET=1\n');
  bundle.stub.put('.git/config', '[core]\n');
  bundle.stub.put('node_modules/left-pad/index.js', 'module.exports = 1\n');
  bundle.stub.put('target/debug/selvage', 'binary\n');
  bundle.stub.putLink('src/latest.rs', 'file');
  bundle.stub.put('assets/big.bin', 'x', { size: 4 * 1024 * 1024 });

  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  const invite = await inviteOf(bundle);
  const guest = await SelvageEngine.join(invite, 'Bob', OPTIONS);
  t.after(async () => {
    await guest.disconnect();
  });

  const paths = await waitFor('the room to learn the listing', () =>
    guest.grantedPaths().length > 0 ? guest.grantedPaths() : false,
  );
  assert.deepEqual(paths, ['README.md', 'docs/guide/intro.md', 'src/main.rs']);
  assert.deepEqual(
    paths,
    [...paths].sort(),
    'the listing is not ascending by UTF-16 code unit',
  );
});

test('a symbolic link to a directory is not listed, and nothing behind it is served', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const bundle = activated(t);
  bundle.stub.put('README.md', 'the readme\n');
  // A directory link out of the shared folder, as a monorepo package link or a shared config
  // directory is. The editor reports one as a directory *and* a link, and what is behind it
  // belongs to whatever it names rather than to the folder the invite was accepted on.
  bundle.stub.put('/outside/secret.txt', 'OUTSIDE THE ROOT\n');
  bundle.stub.putLink('linkd', 'directory', '/outside');

  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  const invite = await inviteOf(bundle);
  const guest = await SelvageEngine.join(invite, 'Bob', OPTIONS);
  t.after(async () => {
    await guest.disconnect();
  });

  const paths = await waitFor('the room to learn the listing', () =>
    guest.grantedPaths().length > 0 ? guest.grantedPaths() : false,
  );
  assert.deepEqual(
    paths,
    ['README.md'],
    'the listing carries a directory link or what is behind it, which is a name outside the folder',
  );

  // The path behind the link was never listed, so a guest that guessed it asks for a path the
  // grant leaves out and is refused like any other, with the file on the far side unread.
  await guest.open('linkd/secret.txt');
  const refusals = await waitFor('the refusal of the path through the link to be reported', () =>
    bundle.stub.registered.errors.length > 0 ? bundle.stub.registered.errors : false,
  );
  assert.equal(
    refusals.every((message) => message.includes('linkd/secret.txt')),
    true,
    `the path through the link was not what was refused: ${JSON.stringify(refusals)}`,
  );
  assert.equal(guest.has('linkd/secret.txt'), false, 'a path through a symbolic link was seeded');
  assert.equal(guest.text('linkd/secret.txt'), '', 'a path through a symbolic link was served');
});

test("the Explorer view is the room's listing, as a tree", async (t) => {
  const { host, invite, roomId } = await room(t, []);
  await host.grant(['README.md', 'src/deep/nested.rs', 'src/main.rs']);
  const bundle = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  const tree = treeOf(bundle);

  await waitFor('the listing to reach the view', () =>
    tree.getChildren().length > 0 ? true : false,
  );
  assert.deepEqual(
    tree.getChildren().map((node) => [node.name, node.directory]),
    [
      ['src', true],
      ['README.md', false],
    ],
    'the tree is not the grant derived by splitting its paths',
  );
  assert.deepEqual(
    tree.getChildren({ path: 'src' }).map((node) => [node.name, node.directory]),
    [
      ['deep', true],
      ['main.rs', false],
    ],
  );

  // A file the room never opened is still a row, and opening it is the room path's command.
  const file = tree.getChildren({ path: 'src' }).find((node) => node.name === 'main.rs');
  assert.ok(file !== undefined, 'main.rs is not in the tree');
  assert.deepEqual(tree.getTreeItem(file).command, {
    command: 'selvage.openDocument',
    title: 'Open a document from the room',
    arguments: [{ path: 'src/main.rs' }],
  });
  assert.equal(tree.getTreeItem({ name: 'src', path: 'src', directory: true }).collapsibleState, 1);

  // What the tree rows open is the guest's virtual document, as the picker's are.
  await bundle.stub.commands.executeCommand('selvage.openDocument', { path: 'src/deep/nested.rs' });
  await waitFor('the granted path to open', () =>
    bundle.stub.registered.opened.includes(virtualUri(roomId, 'src/deep/nested.rs')),
  );
});

test('a room with no grant still shows what it holds open', async (t) => {
  const { bundle } = await guest(t, ['workspace/README.md', 'workspace/src/main.rs']);
  const tree = treeOf(bundle);

  await waitFor('the view to show something', () =>
    tree.getChildren().length > 0 ? true : false,
  );
  assert.deepEqual(tree.getChildren().map((node) => node.name), ['workspace']);
  assert.deepEqual(
    tree.getChildren({ path: 'workspace' }).map((node) => [node.name, node.directory]),
    [
      ['src', true],
      ['README.md', false],
    ],
  );
});

test('the open command offers the grant, not only what the room has open', async (t) => {
  const { host, invite } = await room(t, []);
  await host.grant(['README.md', 'src/deep/nested.rs']);
  const bundle = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  const tree = treeOf(bundle);
  await waitFor('the listing to reach the window', () =>
    tree.getChildren().length > 0 ? true : false,
  );

  await bundle.stub.commands.executeCommand('selvage.openDocument');
  const picked = await waitFor('the document picker', () =>
    bundle.stub.registered.quickPicks.length > 0 ? bundle.stub.registered.quickPicks[0] : false,
  );
  assert.deepEqual(
    picked.items,
    ['README.md', 'src/deep/nested.rs'],
    'the picker is not the grant, so a path nobody opened is unreachable',
  );
});

test('the folder a session shares is the one it was invited on, not the window it has now', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const bundle = activated(t);
  bundle.stub.put('README.md', 'shared\n');
  bundle.stub.put('inside.md', 'still shared\n');
  bundle.stub.openWorkspaceDocument('file:///workspace/README.md');

  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  await waitFor('the host file to reach the room', () =>
    roomOffer(bundle).includes('README.md') ? true : false,
  );

  // The window is opened on a second folder and a file in it is opened too. What the room
  // shares is the folder the invite named, so this is not a document the room hears about.
  bundle.stub.setWorkspaceFolders(['file:///workspace', 'file:///other']);
  const outside = bundle.stub.openWorkspaceDocument('file:///other/notes.md');
  bundle.stub.fire('openTextDocument', outside);

  // A file inside the captured folder is shared as before, and its arrival in the room is
  // what says the earlier open had its chance to be sent first.
  const inside = bundle.stub.openWorkspaceDocument('file:///workspace/inside.md');
  bundle.stub.fire('openTextDocument', inside);
  await waitFor('the file inside the captured folder', () =>
    roomOffer(bundle).includes('inside.md') ? true : false,
  );
  assert.equal(
    roomOffer(bundle).includes('notes.md'),
    false,
    'a folder added to the window after the invite widened what the room shares',
  );
});

test('a host serves the path the room asks for, and refuses what the grant leaves out', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const bundle = activated(t);
  bundle.stub.put('README.md', 'the readme\n');
  bundle.stub.put('src/main.rs', 'fn main() {}\n');
  bundle.stub.put('.env', 'SECRET=1\n');
  bundle.stub.put('.git/config', '[core]\n');
  bundle.stub.put('assets/big.bin', 'x', { size: 4 * 1024 * 1024 });
  bundle.stub.put('blob.bin', new Uint8Array([0x89, 0x50, 0x00, 0x0a]));

  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  const invite = await inviteOf(bundle);
  const guest = await SelvageEngine.join(invite, 'Bob', OPTIONS);
  t.after(async () => {
    await guest.disconnect();
  });

  // A path the host's editor has never opened still arrives: the host reads its own working
  // copy because a peer asked, which is the one thing this feature adds.
  await guest.open('src/main.rs');
  const text = await waitFor('the host to serve the requested path', () => {
    const held = guest.text('src/main.rs');
    return held === 'fn main() {}\n' ? held : false;
  });
  assert.equal(text, 'fn main() {}\n');

  // What the grant itself would never publish is dropped silently — a guessed secret buys
  // no dialog confirming it — and what the grant allows but the room cannot carry is
  // refused out loud: the two unreadable files, each in the report its own event earns.
  // Six bogus paths are two dialogs, never six.
  const refused = ['.env', '.git/config', '../etc/passwd', '/etc/passwd', 'assets/big.bin', 'blob.bin'];
  for (const path of refused) {
    await guest.open(path);
  }
  const errors = await waitFor('every refusal to be reported', () =>
    bundle.stub.registered.errors.length >= 2 ? bundle.stub.registered.errors : false,
  );
  assert.equal(errors.length, 2, `two unreadable files earned more than two dialogs`);
  for (const path of refused) {
    assert.equal(guest.has(path), false, `${path} was seeded anyway`);
  }
  assert.ok(
    errors.every((message) => message.includes('not a readable file')),
    `a refusal was worded differently: ${JSON.stringify(errors)}`,
  );

  // A refusal is a decision about the file now: a host opening an excluded file in its own
  // window no longer shares it — the open path passes the grant's own gates — and the
  // refusal is said once instead.
  const own = bundle.stub.openWorkspaceDocument('file:///workspace/.env');
  bundle.stub.fire('openTextDocument', own);
  const gated = await waitFor('the refused open to be reported', () =>
    bundle.stub.registered.errors.find((message) => message.includes('will not share .env')) ??
      false,
  );
  assert.match(gated, /nothing was shared for it/);

  // The room keeps moving while the excluded file stays out of it: a granted file the
  // host opens next still reaches the guest, which is what shows the first one never will.
  bundle.stub.put('after.txt', 'after\n');
  const later = bundle.stub.openWorkspaceDocument('file:///workspace/after.txt');
  bundle.stub.fire('openTextDocument', later);
  await waitFor('the later file to reach the guest', () =>
    guest.text('after.txt') === 'after\n' ? true : false,
  );
  assert.equal(guest.text('.env'), '', 'the excluded file reached the guest after all');
  assert.equal(guest.has('.env'), false);
});

test('a guest read of a granted path waits for the room to send it', async (t) => {
  const { host, invite, roomId } = await room(t, []);
  await host.grant(['README.md']);
  const bundle = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  const tree = treeOf(bundle);
  await waitFor('the listing to reach the window', () =>
    tree.getChildren().length > 0 ? true : false,
  );

  const files = bundle.registered.files;
  assert.ok(files !== undefined, 'activating registered no file system provider');
  const document = {
    scheme: 'selvage',
    path: '/README.md',
    query: `room=${roomId}`,
    toString: () => virtualUri(roomId, 'README.md'),
  };

  // Nothing has this text yet: the read asks the room for it and waits rather than handing
  // the editor an empty buffer for a file that is one round trip away.
  const pending = files.readFile(document);
  assert.ok(pending instanceof Promise, 'the read did not ask the room for the path');
  host.insert('README.md', 0, 'the readme\n');
  assert.equal(new TextDecoder().decode(await pending), 'the readme\n');

  // The window holds it now, and the same read answers with it at once.
  assert.equal(
    new TextDecoder().decode(files.readFile(document) as Uint8Array),
    'the readme\n',
  );
});

test('a host names deletion when the room asks for a file it removed', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const bundle = activated(t);
  bundle.stub.put('doomed.txt', 'was here\n');
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  const invite = await inviteOf(bundle);
  const guest = await SelvageEngine.join(invite, 'Bob', OPTIONS);
  t.after(async () => {
    await guest.disconnect();
  });

  // The host removes the file after publishing it, and the guest opens it from the
  // listing as it stood: the refusal names the likely cause instead of reading as a
  // failure, and nothing is seeded for it.
  bundle.stub.remove('doomed.txt');
  await guest.open('doomed.txt');
  const refusal = await waitFor('the host to refuse the deleted path', () =>
    bundle.stub.registered.errors.find((message) => message.includes('doomed.txt')) ??
      false,
  );
  assert.match(refusal, /not a readable file in the folder this window shares/);
  assert.match(
    refusal,
    /may have been deleted after the listing was published/,
    'a deliberate deletion reads as a failure',
  );
  assert.equal(guest.has('doomed.txt'), false, 'the deleted path was seeded anyway');
});

test('a guest is told when a path it opens left the listing, not handed an empty document', async (t) => {
  const { host, invite, roomId } = await room(t, []);
  await host.grant(['doomed.txt']);
  const bundle = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room'))
      ? true
      : false,
  );
  const tree = treeOf(bundle);
  await waitFor('the listing to reach the window', () =>
    tree.getChildren().length > 0 ? true : false,
  );

  // The host takes the path out of the listing. The guest opens it from the listing as
  // it stood: nothing can arrive, so the open is refused with the reason rather than
  // leaving a phantom empty document.
  await host.grant([]);
  await waitFor('the smaller listing to reach the window', () =>
    tree.getChildren().length === 0 ? true : false,
  );
  const files = bundle.registered.files;
  assert.ok(files !== undefined, 'activating registered no file system provider');
  const document = {
    scheme: 'selvage',
    path: '/doomed.txt',
    query: `room=${roomId}`,
    toString: () => virtualUri(roomId, 'doomed.txt'),
  };
  await assert.rejects(files.readFile(document) as Promise<Uint8Array>, (error: unknown) => {
    assert.match(String((error as Error).message), /the host no longer shares doomed\.txt/);
    assert.match(
      String((error as Error).message),
      /may have been deleted after the listing was published/,
    );
    return true;
  });

  // The hold the fetch took keeps the path offered, and the row says it left the
  // listing rather than looking listed.
  const row = await waitFor('the held path to stay offered', () =>
    tree.getChildren().find((node) => node.name === 'doomed.txt') ?? false,
  );
  assert.equal(tree.getTreeItem(row).description, 'no longer listed');
});

test('a stale openDocument path that left the listing is refused, not silently dropped', async (t) => {
  const { host, invite, roomId } = await room(t, []);
  await host.grant(['doomed.txt']);
  const bundle = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room'))
      ? true
      : false,
  );
  const tree = treeOf(bundle);
  await waitFor('the listing to reach the window', () =>
    tree.getChildren().length > 0 ? true : false,
  );

  // The host takes the path out of the listing while a click on its row is still
  // in flight — or a caller still names it. The command refuses with the same
  // reason the fetch give-up reports instead of returning silently, and the
  // gate never reaches `readFile`, so no document opens either way.
  await host.grant([]);
  await waitFor('the smaller listing to reach the window', () =>
    tree.getChildren().length === 0 ? true : false,
  );
  await bundle.stub.commands.executeCommand('selvage.openDocument', { path: 'doomed.txt' });
  const refusal = await waitFor('the stale path to be refused', () =>
    bundle.stub.registered.errors.find((message) => message.includes('doomed.txt')) ?? false,
  );
  assert.match(refusal, /could not open doomed\.txt from the room/);
  assert.match(refusal, /the host no longer shares doomed\.txt/);
  assert.match(refusal, /may have been deleted after the listing was published/);
  assert.ok(
    !bundle.stub.registered.opened.includes(virtualUri(roomId, 'doomed.txt')),
    'the stale path was opened anyway',
  );
});

test('a programmatic openDocument path the room never shared is refused, not silently dropped', async (t) => {
  // The palette cannot reach this: it only offers paths the room names. A caller naming a
  // path the listing never held falls past the stale-listing refusal to the same silent
  // gate, so it is refused with what the other client says for its own miss.
  const { bundle, roomId } = await guest(t, ['workspace/README.md']);
  bundle.stub.reset();
  await bundle.stub.commands.executeCommand('selvage.openDocument', { path: 'never/shared.md' });
  const refusal = await waitFor('the unknown path to be refused', () =>
    bundle.stub.registered.errors.find((message) => message.includes('never/shared.md')) ?? false,
  );
  assert.equal(refusal, 'Selvage: no shared document matches "never/shared.md".');
  assert.equal(bundle.stub.registered.quickPicks.length, 0, 'a miss drew a picker');
  assert.ok(
    !bundle.stub.registered.opened.includes(virtualUri(roomId, 'never/shared.md')),
    'the unknown path was opened anyway',
  );
});

test('a no-arg open with one document reveals it instead of drawing a one-row picker', async (t) => {
  const { bundle, roomId } = await guest(t, ['workspace/README.md']);
  bundle.stub.reset();
  await bundle.stub.commands.executeCommand('selvage.openDocument');
  await waitFor('the single document to open', () =>
    bundle.stub.registered.opened.includes(virtualUri(roomId, 'workspace/README.md')),
  );
  assert.equal(bundle.stub.registered.quickPicks.length, 0, 'one row was drawn for one document');
});

test('a document open when its path leaves the listing keeps its text and is badged', async (t) => {
  const { host, invite, roomId } = await room(t, ['doomed.txt']);
  host.insert('doomed.txt', 0, 'held text\n');
  await host.grant(['doomed.txt']);
  const bundle = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room'))
      ? true
      : false,
  );
  const tree = treeOf(bundle);
  const files = bundle.registered.files;
  assert.ok(files !== undefined, 'activating registered no file system provider');
  const document = {
    scheme: 'selvage',
    path: '/doomed.txt',
    query: `room=${roomId}`,
    toString: () => virtualUri(roomId, 'doomed.txt'),
  };
  assert.equal(new TextDecoder().decode(await files.readFile(document)), 'held text\n');

  // The host takes the path out of the listing while the guest holds it open: nothing
  // is closed for that, the text stays, and the row is badged.
  await host.grant([]);
  const row = await waitFor('the row to be badged', () => {
    const node = tree.getChildren().find((candidate) => candidate.name === 'doomed.txt');
    return node !== undefined && tree.getTreeItem(node).description === 'no longer listed'
      ? node
      : false;
  });
  assert.equal(new TextDecoder().decode(await files.readFile(document)), 'held text\n');
  assert.equal(row.path, 'doomed.txt');
});

test('the status tooltip names the room but never the invite token', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const bundle = activated(t);
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  const tooltip = await waitFor('the status bar to be drawn', () =>
    roomOffer(bundle).includes('Hosting room') ? roomOffer(bundle) : false,
  );

  // The invite itself, fetched the way a click fetches it: the tooltip must hold no part
  // of it, while still saying where the link is reached from.
  await bundle.stub.commands.executeCommand('selvage.copyInvite');
  const invite = await waitFor('the invite link', () => {
    const clipboard = bundle.stub.registered.clipboard;
    return clipboard.startsWith('ws://') ? clipboard : false;
  });
  const token = invite.slice(invite.indexOf('token='));
  assert.ok(!tooltip.includes(token), 'the token is in the status tooltip');
  assert.ok(!tooltip.includes('token='), 'the tooltip names the token field');
  assert.match(tooltip, /click the status bar to copy/);
});

test('joining asks for the invite link with an empty box, not the clipboard', async (t) => {
  const bundle = activated(t);
  bundle.stub.registered.clipboard = 'the password copied just before joining';

  // No arguments, so the command takes the interactive path; no reply, so it is the box
  // itself under test rather than the session after it.
  await bundle.stub.commands.executeCommand('selvage.join');
  const asked = await waitFor('the join question', () =>
    bundle.stub.registered.inputs[0] ?? false,
  );
  assert.equal(asked.title, 'Join a Selvage session');
  assert.equal(asked.value, '', 'the box was prefilled from the clipboard');
  assert.equal(bundle.stub.registered.clipboardReads.length, 0, 'joining read the clipboard');
  assert.equal(
    bundle.stub.registered.clipboard,
    'the password copied just before joining',
    'joining touched the clipboard',
  );
});

test('hosting asks for the server in plain words, prefilled with the default', async (t) => {
  const bundle = freshBundle();
  bundle.stub.reset();
  bundle.activate({ subscriptions: [] });
  t.after(() => {
    bundle.deactivate();
  });

  // No arguments and no reply: the box itself is under test, not the session after it.
  await bundle.stub.commands.executeCommand('selvage.host');
  const asked = await waitFor('the server question', () =>
    bundle.stub.registered.inputs[0] ?? false,
  );
  assert.equal(asked.title, 'The Selvage server to host on');
  assert.match(String(asked.prompt), /the address it prints when it starts/);
  assert.match(String(asked.prompt), /selvage\.serverUrl/);
  assert.equal(asked.placeHolder, 'The address the server prints when it starts');
  assert.equal(asked.value, 'ws://127.0.0.1:8080');
  assert.doesNotMatch(String(asked.placeHolder), /ws:\/\//);
  assert.doesNotMatch(String(asked.prompt), /selvaged/);
});

test('the typed server is remembered across windows', async (t) => {
  const first = freshBundle();
  first.stub.reset();
  first.activate({ subscriptions: [], globalState: first.stub.globalState });
  t.after(() => {
    first.deactivate();
  });

  // Typed through the box at an address with nothing on it, so hosting fails — but the
  // prompt already kept what was typed.
  first.stub.registered.inputReply = 'ws://127.0.0.1:1';
  await first.stub.commands.executeCommand('selvage.host');
  const kept = await waitFor('the server to be remembered', () =>
    first.stub.globalState.get('selvage.lastServer') === 'ws://127.0.0.1:1' ? true : false,
  );
  assert.ok(kept);
  first.deactivate();

  // A new window is a new module: nothing in memory names the address, only the memento.
  // The recorded boxes are cleared but the memento is deliberately not reset.
  const second = freshBundle();
  second.stub.registered.inputs.length = 0;
  second.stub.registered.inputReply = undefined;
  second.activate({ subscriptions: [], globalState: first.stub.globalState });
  t.after(() => {
    second.deactivate();
  });
  await second.stub.commands.executeCommand('selvage.host');
  const asked = await waitFor('the server question', () =>
    second.stub.registered.inputs[0] ?? false,
  );
  assert.equal(asked.value, 'ws://127.0.0.1:1');
});

/** The built bundle reloaded with fresh module state, for tests about memory across windows. */
function freshBundle(): LoadedExtension {
  const require = createRequire(import.meta.url);
  delete require.cache[require.resolve(BUNDLE)];
  return loadBundle();
}

test('joining refuses a bad link in the box, before connecting', async (t) => {
  const bundle = activated(t);

  await bundle.stub.commands.executeCommand('selvage.join');
  const asked = await waitFor('the join question', () =>
    bundle.stub.registered.inputs[0] ?? false,
  );
  const validate = asked.validateInput as (value: string) => string | undefined;
  assert.equal(
    validate('ws://127.0.0.1:8080/session?room=r&token=t'),
    undefined,
    'a whole invite link was refused',
  );
  // A truncated paste, a server address, and nothing at all: all fail here, in plain
  // words, rather than later as whatever the engine said.
  assert.equal(
    validate('wss://host:8080/session?room=r&token=t'),
    undefined,
    'a secure invite link was refused',
  );
  for (const bad of [
    'ws://127.0.0.1:8080/session?room=r',
    'ws://127.0.0.1:8080/not-a-session',
    'ws://127.0.0.1:8080',
    'not-a-url/session?room=r&token=t',
    'https://host/session?room=r&token=t',
    '',
  ]) {
    const refusal = validate(bad);
    assert.match(String(refusal), /does not look like a Selvage invite link/);
    assert.match(String(refusal), /Paste the whole link the host sent you/);
    assert.match(String(refusal), /\/session\?room=/);
  }
  assert.equal(
    bundle.stub.registered.errors.length,
    0,
    'validating the box opened a connection',
  );
});

test('a join to a dead server says what to check, not just the engine error', async (t) => {
  const bundle = activated(t);

  await bundle.stub.commands.executeCommand('selvage.join', {
    invite: 'ws://127.0.0.1:1/session?room=r&token=t',
    displayName: 'Bob',
  });
  const said = await waitFor('the failure', () =>
    bundle.stub.registered.errors.find((message) => message.includes('could not join')) ?? false,
  );
  assert.match(said, /check the link is complete and the server is running/);
  assert.match(said, /\(the WebSocket reported an error\)/, 'the cause was dropped');
});

test('a host to a dead server says what to check, not just the engine error', async (t) => {
  const bundle = activated(t);
  bundle.stub.registered.inputReply = 'Ada';

  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: 'ws://127.0.0.1:1',
  });
  const said = await waitFor('the failure', () =>
    bundle.stub.registered.errors.find((message) => message.includes('could not host')) ?? false,
  );
  assert.match(said, /ws:\/\/127\.0\.0\.1:1/);
  assert.match(said, /is the server running at that address/);
  assert.match(said, /\(the WebSocket reported an error\)/, 'the cause was dropped');
});

test('joining names the rest of the room the landing does not open', async (t) => {
  const { bundle, roomId } = await guest(t, ['workspace/README.md', 'workspace/src/main.rs']);
  const joined = await waitFor('the join sentence', () =>
    bundle.stub.registered.information.find((message) => message.includes('joined room')) ?? false,
  );
  assert.equal(
    joined,
    `Selvage: joined room ${roomId}; opening workspace/README.md and 1 more in the Selvage view.`,
  );
});

test('a guest sees a fetch loading, and no empty warning when it lands', async (t) => {
  const { host, invite, roomId } = await room(t, []);
  const bundle = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room')) ? true : false,
  );

  const reading = readRoomFile(bundle, roomId, 'workspace/fresh.md');
  const notice = await waitFor('the fetching notice', () =>
    bundle.stub.registered.progress.find((entry) =>
      entry.title === 'Selvage: fetching workspace/fresh.md…',
    ) ?? false,
  );
  assert.equal(notice.location, bundle.stub.ProgressLocation.Notification);

  await host.open('workspace/fresh.md');
  host.insert('workspace/fresh.md', 0, 'hello\n');
  const bytes = await reading;
  assert.equal(new TextDecoder().decode(bytes), 'hello\n');
  assert.equal(
    bundle.stub.registered.warnings.filter((message) => message.includes('still empty')).length,
    0,
    'a fetch that landed was marked empty',
  );
});

test('a fetch that times out names the empty editor instead of leaving it silent', async (t) => {
  // The host holds nothing, so nothing can arrive: the read waits out the whole bounded wait.
  const { invite, roomId } = await room(t, []);
  const bundle = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room')) ? true : false,
  );

  const reading = readRoomFile(bundle, roomId, 'workspace/lonely.md');
  const warned = await waitFor(
    'the still-empty warning',
    () =>
      bundle.stub.registered.warnings.find((message) => message.includes('is still empty')) ?? false,
    { timeoutMs: 15000 },
  );
  assert.equal(
    warned,
    'Selvage: workspace/lonely.md is still empty: the host has not sent its text yet.',
  );
  const bytes = await reading;
  assert.equal(bytes.length, 0, 'the timed-out read resolved with something');
});

/**
 * Reads a room path through the guest provider, as the editor opening it does. The read
 * must wait on the room — a path the replica already holds would answer synchronously
 * and say nothing about loading.
 */
function readRoomFile(bundle: LoadedExtension, roomId: string, path: string): Promise<Uint8Array> {
  const files = bundle.stub.registered.files;
  assert.ok(files !== undefined, 'the guest file system was never registered');
  const uriString = virtualUri(roomId, path);
  const question = uriString.indexOf('?');
  const bytes = files.readFile({
    scheme: 'selvage',
    path: uriString.slice(uriString.indexOf('/'), question),
    query: uriString.slice(question + 1),
    toString: () => uriString,
  });
  assert.ok(bytes instanceof Promise, 'a read that must ask the room answered synchronously');
  return bytes;
}

test('a dropped connection shows reconnecting in the status bar', async (t) => {
  const server = await FakeServer.start();
  let stopped = false;
  t.after(async () => {
    if (!stopped) {
      await server.stop();
    }
  });
  const bundle = activated(t);
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  await waitFor('the host to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('is open')) ? true : false,
  );
  const bar = (): string =>
    String(
      bundle.stub.registered.statusBarItems.find((item) => item.name === 'Selvage')?.text ?? '',
    );
  assert.match(bar(), /hosting/, 'the steady state was never shown');

  // The drop is the server going away mid-session; the bounded retry is the engine's, and
  // the bar must say so instead of holding the steady-state text while retries run.
  await server.stop();
  stopped = true;
  const retrying = await waitFor('the reconnecting state', () =>
    bar().includes('reconnecting') ? bar() : false,
  );
  assert.match(retrying, /reconnecting…/);
});

test('the status tooltip counts the rest instead of listing the room', async (t) => {
  const paths = Array.from({ length: 25 }, (_, index) => `file-${index}.txt`);
  const { bundle } = await guest(t, paths);

  // Twenty-five documents offered: the tooltip is a stranger's input in full, so it shows
  // twenty and counts the rest rather than joining them all.
  const tooltip = await waitFor('the tooltip to bound the listing', () =>
    roomOffer(bundle).includes('… and') ? roomOffer(bundle) : false,
  );
  assert.match(tooltip, /… and 5 more/);
});
