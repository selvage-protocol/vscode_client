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
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  BUNDLE,
  loadBundle,
  mirrorFileUri,
  mirrorWindowDir,
  testStoragePath,
  waitForMirrorFiles,
  waitForMirrorGone,
} from './helpers/bundle.ts';
import type { LoadedExtension } from './helpers/bundle.ts';
import { FakeServer } from './helpers/fake-server.ts';
import { waitFor } from './helpers/wait.ts';
import { SelvageEngine, parseSessionUrl } from '../src/engine/index.ts';
import { peerColour } from '../src/bridge/index.ts';

const OPTIONS = { client: 'selvage-vscode-test/0.1.0', meta: 'skip' } as const;

/** The room an invite names, so a message that has to name it can be read as a whole. */
function roomOf(invite: string): string {
  const room = parseSessionUrl(invite)?.join.room;
  assert.ok(room !== undefined, `the invite names no room: ${invite}`);
  return room;
}

/** The directory entries at `dir`, sorted: the mirror's shape read back off disk. */
function readdirSorted(dir: string): string[] {
  return readdirSync(dir).sort();
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

/**
 * The bundle, activated, with its recorded state cleared. Every activation carries its
 * own storage directory: a guest join mints exactly one mirror under it, which the test
 * reads back through `mirrorFileUri` and `waitForMirrorFiles`.
 */
function activated(t: TestContext): { bundle: LoadedExtension; storage: string } {
  const bundle = loadBundle();
  bundle.stub.reset();
  const storage = testStoragePath(t);
  bundle.activate({ subscriptions: [], globalState: bundle.stub.globalState, globalStorageUri: bundle.stub.Uri.file(storage) });
  t.after(() => {
    bundle.deactivate();
  });
  return { bundle, storage };
}

/** A guest session in `bundle`, seated and with its first document opened by the adapter. */
async function guest(
  t: TestContext,
  paths: string[],
): Promise<{
  bundle: LoadedExtension;
  storage: string;
  server: FakeServer;
  invite: string;
  roomId: string;
}> {
  const { server, invite, roomId } = await room(t, paths);
  const { bundle, storage } = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room')) ? true : false,
  );
  return { bundle, storage, server, invite, roomId };
}

test('hosting while hosting copies the invite rather than minting a room', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const { bundle } = activated(t);

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
  const { bundle } = activated(t);

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
  const { bundle, storage, roomId } = await guest(t, [
    'workspace/README.md',
    'workspace/src/main.rs',
  ]);

  const shown = await waitFor('the room document to open', () => {
    const found = bundle.stub.registered.shown.filter((uri) => uri.startsWith('file:'));
    return found.length > 0 ? found : false;
  });
  assert.deepEqual(
    shown,
    [mirrorFileUri(storage, roomId, 'workspace/README.md')],
    'a guest with several room documents must land in one of them, not all of them',
  );
  assert.deepEqual(
    bundle.stub.registered.opened,
    [mirrorFileUri(storage, roomId, 'workspace/README.md')],
    'exactly one room document was opened',
  );
});

test('a guest drops into the room\'s only document with no input', async (t) => {
  const { bundle, storage, roomId } = await guest(t, ['workspace/notes.md']);
  const shown = await waitFor('the room document to open', () =>
    bundle.stub.registered.shown.length > 0 ? bundle.stub.registered.shown : false,
  );
  assert.deepEqual(shown, [mirrorFileUri(storage, roomId, 'workspace/notes.md')]);
});

test('a guest lands in the room\'s first document, even one that arrives after the join', async (t) => {
  const { host, invite, roomId } = await room(t, []);
  const { bundle, storage: landingStorage } = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  const joined = await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.find((message) => message.includes('joined room')) ?? false,
  );
  assert.equal(joined, `Selvage: joined room ${roomId}; the room has no open documents yet.`);
  assert.deepEqual(bundle.stub.registered.shown, [], 'an empty room put something in the window');

  // A room that was empty at join still owes the guest the landing the join could not make.
  await host.open('workspace/README.md');
  const shown = await waitFor('the room document to open', () => {
    const found = bundle.stub.registered.shown.filter((uri) => uri.startsWith('file:'));
    return found.length > 0 ? found : false;
  });
  assert.deepEqual(shown, [mirrorFileUri(landingStorage, roomId, 'workspace/README.md')]);

  // A document after the first is left alone: the landing is spent, and pulling the window away
  // from a guest who is already editing is not a join.
  await host.open('workspace/notes.md');
  await waitFor('the guest to be told the room holds both', () =>
    roomOffer(bundle).includes('notes.md') ? true : false,
  );
  assert.deepEqual(
    bundle.stub.registered.shown,
    [mirrorFileUri(landingStorage, roomId, 'workspace/README.md')],
    'a document that arrived later pulled the window away from the guest',
  );
});

test('selvage.openOnJoin off keeps a join from taking the window', async (t) => {
  const { host, invite, roomId } = await room(t, ['workspace/README.md']);
  const { bundle } = activated(t);
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
  const { bundle } = activated(t);
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
    bundle.stub.registered.shown,
    [],
    'a host was handed a second copy of a file it already has open',
  );
});

test('the open command offers the room\'s document list, not a path to type', async (t) => {
  const { bundle } = await guest(t, ['workspace/README.md', 'workspace/src/main.rs']);
  await waitFor('the room document to open', () =>
    bundle.stub.registered.shown.some((uri) => uri.startsWith('file:')) ? true : false,
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
  const { bundle } = activated(t);
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
  // The one moment this client refuses with words of its own: a host has no mirror to open,
  // and the room's set is the host's own open files.
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const { bundle } = activated(t);
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
  const { bundle } = activated(t);
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
  const { bundle } = activated(t);

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
  const { bundle } = activated(t);
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
  const { bundle } = activated(t);
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
  const { bundle } = activated(t);
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
  const { bundle } = activated(t);

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
  const { bundle } = activated(t);
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
  const { bundle } = activated(t);

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
  const { bundle } = activated(t);
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

  const { bundle } = activated(t);
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
  const { bundle } = activated(t);
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
  const { bundle } = activated(t);
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

test("the mirror is the room's listing, as files", async (t) => {
  const { host, invite, roomId } = await room(t, []);
  await host.grant(['README.md', 'src/deep/nested.rs', 'src/main.rs']);
  const { bundle, storage } = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });

  // The room's shape on disk: one file per listed path, with the directories on the way.
  await waitForMirrorFiles(storage, roomId, ['README.md', 'src/deep/nested.rs', 'src/main.rs']);
  const root = mirrorWindowDir(storage, roomId);
  assert.deepEqual(readdirSorted(join(root, 'src')), ['deep', 'main.rs']);
  assert.deepEqual(readdirSorted(join(root, 'src', 'deep')), ['nested.rs']);

  // What the picker opens is the guest's mirror file, as the landing's is.
  await bundle.stub.commands.executeCommand('selvage.openDocument', { path: 'src/deep/nested.rs' });
  await waitFor('the granted path to open', () =>
    bundle.stub.registered.opened.includes(mirrorFileUri(storage, roomId, 'src/deep/nested.rs'))
      ? true
      : false,
  );
});

test('a room with no grant still offers what it holds open', async (t) => {
  const { bundle } = await guest(t, ['workspace/README.md', 'workspace/src/main.rs']);
  await bundle.stub.commands.executeCommand('selvage.openDocument');
  const picked = await waitFor('the document picker', () =>
    bundle.stub.registered.quickPicks.length > 0 ? bundle.stub.registered.quickPicks[0] : false,
  );
  assert.deepEqual(
    picked.items,
    ['workspace/README.md', 'workspace/src/main.rs'],
    'the picker is not the room\'s open-document set',
  );
});

test('the open command offers the grant, not only what the room has open', async (t) => {
  const { host, invite, roomId } = await room(t, []);
  await host.grant(['README.md', 'src/deep/nested.rs']);
  const { bundle, storage } = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitForMirrorFiles(storage, roomId, ['README.md', 'src/deep/nested.rs']);

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
  const { bundle } = activated(t);
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
  const { bundle } = activated(t);
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

test('a host names deletion when the room asks for a file it removed', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const { bundle } = activated(t);
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

test('a stale openDocument path that left the listing is refused, not silently dropped', async (t) => {
  const { host, invite, roomId } = await room(t, []);
  await host.grant(['doomed.txt']);
  const { bundle, storage } = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room'))
      ? true
      : false,
  );
  await waitForMirrorFiles(storage, roomId, ['doomed.txt']);

  // The host takes the path out of the listing while a caller still names it. The
  // command refuses with the same reason the fetch give-up reports instead of
  // returning silently — and the file the republish removed stays removed.
  await host.grant([]);
  await waitForMirrorGone(storage, roomId, ['doomed.txt']);
  await bundle.stub.commands.executeCommand('selvage.openDocument', { path: 'doomed.txt' });
  const refusal = await waitFor('the stale path to be refused', () =>
    bundle.stub.registered.errors.find((message) => message.includes('doomed.txt')) ?? false,
  );
  assert.match(refusal, /could not open doomed\.txt from the room/);
  assert.match(refusal, /the host no longer shares doomed\.txt/);
  assert.match(refusal, /may have been deleted after the listing was published/);
  assert.ok(
    !bundle.stub.registered.opened.includes(mirrorFileUri(storage, roomId, 'doomed.txt')),
    'the stale path was opened anyway',
  );
});

test('a programmatic openDocument path the room never shared is refused, not silently dropped', async (t) => {
  // The palette cannot reach this: it only offers paths the room names. A caller naming a
  // path the listing never held falls past the stale-listing refusal to the same silent
  // gate, so it is refused with what the other client says for its own miss.
  const { bundle, storage, roomId } = await guest(t, ['workspace/README.md']);
  bundle.stub.reset();
  await bundle.stub.commands.executeCommand('selvage.openDocument', { path: 'never/shared.md' });
  const refusal = await waitFor('the unknown path to be refused', () =>
    bundle.stub.registered.errors.find((message) => message.includes('never/shared.md')) ?? false,
  );
  assert.equal(refusal, 'Selvage: no shared document matches "never/shared.md".');
  assert.equal(bundle.stub.registered.quickPicks.length, 0, 'a miss drew a picker');
  assert.ok(
    !bundle.stub.registered.opened.includes(mirrorFileUri(storage, roomId, 'never/shared.md')),
    'the unknown path was opened anyway',
  );
});

test('a no-arg open with one document reveals it instead of drawing a one-row picker', async (t) => {
  const { bundle, storage, roomId } = await guest(t, ['workspace/README.md']);
  bundle.stub.reset();
  await bundle.stub.commands.executeCommand('selvage.openDocument');
  await waitFor('the single document to open', () =>
    bundle.stub.registered.opened.includes(mirrorFileUri(storage, roomId, 'workspace/README.md'))
      ? true
      : false,
  );
  assert.equal(bundle.stub.registered.quickPicks.length, 0, 'one row was drawn for one document');
});

test('a document open when its path leaves the listing keeps its file and its hold', async (t) => {
  const { host, invite, roomId } = await room(t, ['doomed.txt']);
  host.insert('doomed.txt', 0, 'held text\n');
  await host.grant(['doomed.txt', 'gone.txt']);
  const { bundle, storage } = activated(t);
  // The room's text is applied to the holder, as the editor's own model would apply it.
  const holder = { text: '' };
  bundle.stub.registered.applyEditImpl = async (edit: unknown) => {
    const changes = (edit as { edits: Array<{ text: string }> }).edits;
    for (const change of changes) {
      holder.text += change.text;
    }
    return true;
  };
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room'))
      ? true
      : false,
  );
  await waitForMirrorFiles(storage, roomId, ['doomed.txt', 'gone.txt']);
  // The guest opens the granted path the way the editor reports one: the hold the open
  // takes is what keeps the file past the listing, and the room's text arrives through it.
  await bundle.stub.commands.executeCommand('selvage.openDocument', { path: 'doomed.txt' });
  const uri = mirrorFileUri(storage, roomId, 'doomed.txt');
  await waitFor('the granted path to open', () =>
    bundle.stub.registered.opened.includes(uri) ? true : false,
  );
  bundle.stub.fire('openTextDocument', {
    uri: bundle.stub.Uri.parse(uri),
    eol: 1,
    isDirty: false,
    getText: () => holder.text,
    positionAt: (offset: number) => offset,
    offsetAt: (position: number) => position,
    save: () => Promise.resolve(true),
  });
  await waitFor('the hold to reach the room', () =>
    host.documents().includes('doomed.txt') ? true : false,
  );
  await waitFor('the room text to arrive', () => (holder.text === 'held text\n' ? true : false));

  // The host takes both paths out of the listing while the guest holds one open: the held
  // file stays, with its text and its hold, and the unheld one goes with the republish.
  await host.grant([]);
  await waitForMirrorGone(storage, roomId, ['gone.txt']);
  assert.equal(
    existsSync(join(mirrorWindowDir(storage, roomId), 'doomed.txt')),
    true,
    'a held file was removed with the listing',
  );
  assert.equal(holder.text, 'held text\n', 'the held document lost its text');
  assert.equal(
    host.documents().includes('doomed.txt'),
    true,
    'the hold on the path was released with the listing',
  );
});

test('the status tooltip names the room but never the invite token', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const { bundle } = activated(t);
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
  const { bundle } = activated(t);
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
  // Nothing configured and nothing remembered: the box starts from the demo server.
  assert.equal(asked.value, 'ws://100.64.0.3:8080');
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

test('an explicit server address beats the remembered server', async (t) => {
  const bundle = freshBundle();
  bundle.stub.reset();
  bundle.activate({ subscriptions: [], globalState: bundle.stub.globalState });
  t.after(() => {
    bundle.deactivate();
  });

  // Seed memory: a typed address on a dead server fails to host, but is still kept.
  bundle.stub.registered.inputReply = 'ws://127.0.0.1:1';
  await bundle.stub.commands.executeCommand('selvage.host');
  const kept = await waitFor('the server to be remembered', () =>
    bundle.stub.globalState.get('selvage.lastServer') === 'ws://127.0.0.1:1' ? true : false,
  );
  assert.ok(kept);

  // The explicit address wins over the remembered one, with no question asked —
  // and what was explicit is what is remembered next.
  bundle.stub.registered.inputs.length = 0;
  bundle.stub.registered.inputReply = undefined;
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: 'ws://127.0.0.1:2',
    displayName: 'Ada',
  });
  const said = await waitFor('the failure', () =>
    bundle.stub.registered.errors.find((message) =>
      message.includes('could not host on ws://127.0.0.1:2'),
    ) ?? false,
  );
  assert.ok(said, 'hosting did not use the explicit address');
  assert.equal(bundle.stub.registered.inputs.length, 0, 'the remembered server was asked about');
  assert.equal(bundle.stub.globalState.get('selvage.lastServer'), 'ws://127.0.0.1:2');
});

test('a configured server address answers without asking', async (t) => {
  const { bundle } = activated(t);
  bundle.stub.configure({ serverUrl: 'ws://127.0.0.1:9', displayName: 'Ada' });

  // The setting answers: no box opens, and the failure names the configured address.
  await bundle.stub.commands.executeCommand('selvage.host');
  const said = await waitFor('the failure', () =>
    bundle.stub.registered.errors.find((message) =>
      message.includes('could not host on ws://127.0.0.1:9'),
    ) ?? false,
  );
  assert.ok(said, 'hosting did not use the configured address');
  assert.equal(bundle.stub.registered.inputs.length, 0, 'a configured server was asked about');
});

test('a configured server address beats the remembered server', async (t) => {
  const bundle = freshBundle();
  bundle.stub.reset();
  bundle.activate({ subscriptions: [], globalState: bundle.stub.globalState });
  t.after(() => {
    bundle.deactivate();
  });

  // Seed memory, then configure: the setting answers, not the memory.
  bundle.stub.registered.inputReply = 'ws://127.0.0.1:1';
  await bundle.stub.commands.executeCommand('selvage.host');
  const kept = await waitFor('the server to be remembered', () =>
    bundle.stub.globalState.get('selvage.lastServer') === 'ws://127.0.0.1:1' ? true : false,
  );
  assert.ok(kept);

  bundle.stub.registered.inputs.length = 0;
  bundle.stub.registered.inputReply = undefined;
  bundle.stub.configure({ serverUrl: 'ws://127.0.0.1:9', displayName: 'Ada' });
  await bundle.stub.commands.executeCommand('selvage.host');
  const said = await waitFor('the failure', () =>
    bundle.stub.registered.errors.find((message) =>
      message.includes('could not host on ws://127.0.0.1:9'),
    ) ?? false,
  );
  assert.ok(said, 'hosting did not use the configured address');
  assert.equal(bundle.stub.registered.inputs.length, 0, 'a configured server was asked about');
});

/** The built bundle reloaded with fresh module state, for tests about memory across windows. */
function freshBundle(): LoadedExtension {
  const require = createRequire(import.meta.url);
  delete require.cache[require.resolve(BUNDLE)];
  return loadBundle();
}

test('joining refuses a bad link in the box, before connecting', async (t) => {
  const { bundle } = activated(t);

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
  const { bundle } = activated(t);

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
  const { bundle } = activated(t);
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
    `Selvage: joined room ${roomId}; opening workspace/README.md and 1 more; Selvage: Open a document from the room lists every path.`,
  );
});

test('a fetch that times out names the empty path and reports no fetch', async (t) => {
  // The host lists the path but never opens it, so nothing can arrive: the fetch waits
  // out the whole bounded wait.
  const { host, invite, roomId } = await room(t, []);
  await host.grant(['workspace/lonely.md']);
  const { bundle, storage } = activated(t);
  bundle.stub.configure({ openOnJoin: false });
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room')) ? true : false,
  );
  await waitForMirrorFiles(storage, roomId, ['workspace/lonely.md']);

  await bundle.stub.commands.executeCommand('selvage.fetch', { path: 'workspace/lonely.md' });
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
  // A wait that gave up is not a fetch: the warning is the wait's terminal state, and the
  // report stays silent about files that never arrived rather than naming them fetched.
  assert.equal(
    bundle.stub.registered.information.filter((message) => message.includes('fetched the files'))
      .length,
    0,
    'a fetch that landed nothing reported a fetch',
  );
});

test('fetch outside a session says to join first', async (t) => {
  const { bundle } = activated(t);
  await bundle.stub.commands.executeCommand('selvage.fetch', { path: 'notes/a.md' });
  const refusal = await waitFor('the join-first refusal', () =>
    bundle.stub.registered.warnings.find((message) => message.includes('join a session first')) ??
    false,
  );
  assert.equal(refusal, 'Selvage: join a session first.');
});

test('fetch while hosting says the disk already holds what a mirror would', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const { bundle } = activated(t);
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  await waitFor('the host to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('is open')) ? true : false,
  );
  await bundle.stub.commands.executeCommand('selvage.fetch', { path: 'notes/a.md' });
  const refusal = await waitFor('the host refusal', () =>
    bundle.stub.registered.information.find((message) => message.includes('already on your disk')) ??
    false,
  );
  assert.equal(
    refusal,
    'Selvage: you are hosting, so the files a mirror would hold are already on your disk.',
  );
});

test('fetch in a room with no listing says there is nothing to fetch', async (t) => {
  const { bundle } = await guest(t, []);
  await bundle.stub.commands.executeCommand('selvage.fetch');
  const said = await waitFor('the empty-listing report', () =>
    bundle.stub.registered.information.find((message) => message.includes('lists no files')) ??
    false,
  );
  assert.equal(said, 'Selvage: the room lists no files to fetch.');
});

test('fetch with a trailing slash names the directory', async (t) => {
  const { host, invite, roomId } = await room(t, []);
  await host.grant(['notes/a.md']);
  const { bundle, storage } = activated(t);
  // No landing: the fetch's own hold is what must pull the content, not the join's.
  bundle.stub.configure({ openOnJoin: false });
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room')) ? true : false,
  );
  await waitForMirrorFiles(storage, roomId, ['notes/a.md']);
  // The slash is stripped before the prefix match: without it the directory misses the
  // listing and the fetch reports no match. The hold runs detached; the host publishes
  // while it waits, as a slow host does.
  await bundle.stub.commands.executeCommand('selvage.fetch', { path: 'notes/' });
  await waitFor('the fetch to ask the room', () =>
    bundle.stub.registered.progress.find(
      (entry) => entry.title === 'Selvage: fetching notes/a.md…',
    ) ?? false,
  );
  await host.open('notes/a.md');
  host.insert('notes/a.md', 0, 'fetched\n');
  const done = await waitFor('the fetched report', () =>
    bundle.stub.registered.information.find((message) => message.includes('fetched the files')) ??
    false,
  );
  assert.equal(done, 'Selvage: fetched the files.');
  assert.equal(bundle.stub.registered.errors.length, 0, 'the slashed directory errored');
});

test('fetch refuses a listing past what one fetch holds', async (t) => {
  // Every held path is a `doc.open` every peer absorbs and a `Y.Text` every replica
  // keeps: past the bound the fetch refuses with a narrower target rather than holding
  // the room sequentially, each path up to the fetch timeout.
  const { host, invite, roomId } = await room(t, []);
  const paths = Array.from({ length: 101 }, (_, index) => `dir/file${index}.md`);
  await host.grant(paths);
  const { bundle, storage } = activated(t);
  bundle.stub.configure({ openOnJoin: false });
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room')) ? true : false,
  );
  // The mirror materialises from the grant report, so every file on disk proves the
  // guest sees the whole listing the refusal counts.
  await waitForMirrorFiles(storage, roomId, paths);
  const picksBefore = bundle.stub.registered.quickPicks.length;
  await bundle.stub.commands.executeCommand('selvage.fetch');
  const refusal = await waitFor('the fetch-all refusal', () =>
    bundle.stub.registered.errors.find((message) => message.includes('would hold every one')) ??
    false,
  );
  assert.match(refusal, /fetching all 101 listed files/);
  assert.match(refusal, /fetch a file or a directory instead/);
  assert.equal(
    bundle.stub.registered.quickPicks.length,
    picksBefore,
    'the refused fetch-all offered the picker',
  );
  assert.equal(
    bundle.stub.registered.progress.length,
    0,
    'the refused fetch-all held anything',
  );
});

test('fetch holds one listed path and says what it fetched', async (t) => {
  const { host, invite, roomId } = await room(t, []);
  await host.grant(['notes/a.md']);
  const { bundle, storage } = activated(t);
  // No landing: the fetch's own hold is what must pull the content, not the join's.
  bundle.stub.configure({ openOnJoin: false });
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room')) ? true : false,
  );
  await waitForMirrorFiles(storage, roomId, ['notes/a.md']);
  // The hold runs detached; the host publishes while it waits, as a slow host does.
  await bundle.stub.commands.executeCommand('selvage.fetch', { path: 'notes/a.md' });
  await waitFor('the fetch to ask the room', () =>
    bundle.stub.registered.progress.find(
      (entry) => entry.title === 'Selvage: fetching notes/a.md…',
    ) ?? false,
  );
  await host.open('notes/a.md');
  host.insert('notes/a.md', 0, 'fetched\n');
  const notice = await waitFor('the fetch notice', () =>
    bundle.stub.registered.information.find((message) => message.includes('fetching opens')) ??
    false,
  );
  assert.equal(
    notice,
    'Selvage: fetching opens notes/a.md in the room, so every peer receives it.',
  );
  const done = await waitFor('the fetched report', () =>
    bundle.stub.registered.information.find((message) => message.includes('fetched the files')) ??
    false,
  );
  assert.equal(done, 'Selvage: fetched the files.');
  assert.equal(
    bundle.stub.registered.warnings.filter((message) => message.includes('still empty')).length,
    0,
    'a fetch that landed was marked empty',
  );
  assert.equal(bundle.stub.registered.errors.length, 0, 'a fetch that landed errored');
});

test('fetch of a path the window already holds resolves without asking again', async (t) => {
  // The room's sync carried the text at join, so there is nothing to wait for: no
  // notice names the path, no progress runs, and the report still confirms the fetch.
  const { host, invite, roomId } = await room(t, []);
  await host.grant(['notes/a.md']);
  await host.open('notes/a.md');
  host.insert('notes/a.md', 0, 'already here\n');
  const { bundle, storage } = activated(t);
  bundle.stub.configure({ openOnJoin: false });
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room')) ? true : false,
  );
  await waitForMirrorFiles(storage, roomId, ['notes/a.md']);
  await bundle.stub.commands.executeCommand('selvage.fetch', { path: 'notes/a.md' });
  const done = await waitFor('the fetched report', () =>
    bundle.stub.registered.information.find((message) => message.includes('fetched the files')) ??
    false,
  );
  assert.equal(done, 'Selvage: fetched the files.');
  assert.equal(
    bundle.stub.registered.information.filter((message) => message.includes('fetching opens'))
      .length,
    0,
    'a fetch that asked for nothing announced a hold',
  );
  assert.equal(bundle.stub.registered.progress.length, 0, 'a fetch that asked for nothing waited');
});

test('fetch of a directory holds every listed path under it', async (t) => {
  const { host, invite, roomId } = await room(t, []);
  await host.grant(['notes/a.md', 'notes/b.md', 'other.md']);
  const { bundle, storage } = activated(t);
  // No landing: the fetch's own holds are what must pull the content, not the join's.
  bundle.stub.configure({ openOnJoin: false });
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room')) ? true : false,
  );
  await waitForMirrorFiles(storage, roomId, ['notes/a.md', 'notes/b.md', 'other.md']);
  // One path at a time: the second hold starts once the first has landed.
  await bundle.stub.commands.executeCommand('selvage.fetch', { path: 'notes' });
  await waitFor('the first hold to ask the room', () =>
    bundle.stub.registered.progress.find(
      (entry) => entry.title === 'Selvage: fetching notes/a.md…',
    ) ?? false,
  );
  await host.open('notes/a.md');
  host.insert('notes/a.md', 0, 'held\n');
  await waitFor('the second hold to ask the room', () =>
    bundle.stub.registered.progress.find(
      (entry) => entry.title === 'Selvage: fetching notes/b.md…',
    ) ?? false,
  );
  await host.open('notes/b.md');
  host.insert('notes/b.md', 0, 'held\n');
  const notice = await waitFor('the plural fetch notice', () =>
    bundle.stub.registered.information.find((message) => message.includes('fetching opens')) ??
    false,
  );
  assert.equal(
    notice,
    'Selvage: fetching opens them in the room, so every peer receives them.',
  );
  const done = await waitFor('the fetched report', () =>
    bundle.stub.registered.information.find((message) => message.includes('fetched the files')) ??
    false,
  );
  assert.equal(done, 'Selvage: fetched the files.');
  assert.equal(
    bundle.stub.registered.warnings.filter((message) => message.includes('still empty')).length,
    0,
    'a fetch that landed was marked empty',
  );
});

test('fetch refuses a name the listing never held', async (t) => {
  const { host, invite, roomId } = await room(t, []);
  await host.grant(['a.md']);
  const { bundle, storage } = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room')) ? true : false,
  );
  await waitForMirrorFiles(storage, roomId, ['a.md']);
  await bundle.stub.commands.executeCommand('selvage.fetch', { path: 'missing.md' });
  const refusal = await waitFor('the miss to be refused', () =>
    bundle.stub.registered.errors.find((message) => message.includes('missing.md')) ?? false,
  );
  assert.equal(refusal, 'Selvage: no file the room lists matches "missing.md".');
  assert.equal(
    bundle.stub.registered.opened.length,
    0,
    'a refused fetch opened an editor anyway',
  );
});

test('fetch of a path that left the listing reports the reason', async (t) => {
  const { host, invite, roomId } = await room(t, []);
  await host.grant(['doomed.txt']);
  const { bundle, storage } = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room')) ? true : false,
  );
  await waitForMirrorFiles(storage, roomId, ['doomed.txt']);
  await host.grant([]);
  await waitForMirrorGone(storage, roomId, ['doomed.txt']);
  await bundle.stub.commands.executeCommand('selvage.fetch', { path: 'doomed.txt' });
  const refusal = await waitFor('the stale path to be refused', () =>
    bundle.stub.registered.errors.find((message) => message.includes('doomed.txt')) ?? false,
  );
  assert.match(refusal, /could not fetch doomed\.txt from the room/);
  assert.match(refusal, /the host no longer shares doomed\.txt/);
  assert.ok(
    !bundle.stub.registered.opened.includes(mirrorFileUri(storage, roomId, 'doomed.txt')),
    'the stale path was opened anyway',
  );
});

test('fetch without a path offers the listing to pick from', async (t) => {
  const { host, invite, roomId } = await room(t, []);
  await host.grant(['picked.md']);
  const { bundle, storage } = activated(t);
  // No landing: the fetch's own hold is what must pull the content, not the join's.
  bundle.stub.configure({ openOnJoin: false });
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room')) ? true : false,
  );
  await waitForMirrorFiles(storage, roomId, ['picked.md']);
  bundle.stub.registered.quickPickReply = 'picked.md';
  await bundle.stub.commands.executeCommand('selvage.fetch');
  await waitFor('the picked hold to ask the room', () =>
    bundle.stub.registered.progress.find(
      (entry) => entry.title === 'Selvage: fetching picked.md…',
    ) ?? false,
  );
  await host.open('picked.md');
  host.insert('picked.md', 0, 'picked\n');
  const asked = await waitFor('the listing prompt', () =>
    bundle.stub.registered.quickPicks.find(
      (entry) => (entry.options as { title?: string }).title === 'Fetch a path from the room',
    ) ?? false,
  );
  assert.deepEqual(asked.items, [
    { label: 'Fetch the whole listing', description: '1 files' },
    'picked.md',
  ]);
  const done = await waitFor('the fetched report', () =>
    bundle.stub.registered.information.find((message) => message.includes('fetched the files')) ??
    false,
  );
  assert.equal(done, 'Selvage: fetched the files.');
});

test('a dropped connection shows reconnecting in the status bar', async (t) => {
  const server = await FakeServer.start();
  let stopped = false;
  t.after(async () => {
    if (!stopped) {
      await server.stop();
    }
  });
  const { bundle } = activated(t);
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

/**
 * A document stand-in for a mirror file, as the editor reports one open: the URI is what
 * shares it, and the holder is what the room's text is applied to.
 */
function mirrorDocument(
  bundle: LoadedExtension,
  storage: string,
  roomId: string,
  path: string,
  holder: { text: string },
): Record<string, unknown> {
  return {
    uri: bundle.stub.Uri.parse(mirrorFileUri(storage, roomId, path)),
    eol: 1,
    isDirty: false,
    getText: () => holder.text,
    positionAt: (offset: number) => offset,
    offsetAt: (position: number) => position,
    save: () => Promise.resolve(true),
  };
}

test('joining with no folder stashes the invite and reloads onto the mirror', async (t) => {
  const { invite } = await room(t, []);
  const roomId = roomOf(invite);
  const { bundle, storage } = activated(t);
  bundle.stub.setWorkspaceFolders([]);

  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  // The reload is the whole join: `openFolder` on the fresh mirror, and nothing else — no
  // folder call, no session, no joined message.
  const reloaded = await waitFor('the reload onto the mirror', () =>
    bundle.stub.registered.executed.find((call) => call.id === 'vscode.openFolder') ?? false,
  );
  assert.equal(bundle.stub.registered.folderCalls.length, 0, 'a folder was added to nothing');
  assert.equal(
    bundle.stub.registered.information.some((message) => message.includes('joined room')),
    false,
    'a session started before the reload and died with it',
  );
  const root = mirrorWindowDir(storage, roomId);
  assert.ok(String(reloaded.args[0]).startsWith('file:'), 'the reload names no mirror folder');
  assert.deepEqual(reloaded.args[1], { forceReuseWindow: true });
  const marker = JSON.parse(readFileSync(join(root, '.selvage-mirror.json'), 'utf8')) as {
    room?: string;
    invite?: string;
  };
  assert.equal(marker.room, roomId, 'the stashed mirror names another room');
  assert.equal(marker.invite, invite, 'the reload carries no invite to finish with');
});

test('a reload onto the mirror finishes the stashed join', async (t) => {
  const { invite } = await room(t, []);
  const roomId = roomOf(invite);
  const first = activated(t);
  first.bundle.stub.setWorkspaceFolders([]);
  await first.bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the reload onto the mirror', () =>
    first.bundle.stub.registered.executed.some((call) => call.id === 'vscode.openFolder')
      ? true
      : false,
  );
  const root = mirrorWindowDir(first.storage, roomId);

  // Stage two: the window reopens on the mirror with the display name configured, so no
  // question interrupts the landing.
  first.bundle.stub.reset();
  first.bundle.stub.setWorkspaceFolders([root]);
  first.bundle.stub.configure({ displayName: 'Bob' });
  first.bundle.activate({
    subscriptions: [],
    globalState: first.bundle.stub.globalState,
    globalStorageUri: first.bundle.stub.Uri.file(first.storage),
  });
  const joined = await waitFor('the stashed join to land', () =>
    first.bundle.stub.registered.information.find((message) =>
      message.includes(`joined room ${roomId}`),
    ) ?? false,
  );
  assert.match(joined, /the room has no open documents yet/);
  // The folder was the window already: no add, and the invite left the marker on landing.
  assert.equal(first.bundle.stub.registered.folderCalls.length, 0, 'the reload added its own folder');
  const marker = JSON.parse(readFileSync(join(root, '.selvage-mirror.json'), 'utf8')) as {
    invite?: string;
  };
  assert.equal(marker.invite, undefined, 'the landed join kept its invite');
});

test('a join whose folder the editor refuses reports joining again', async (t) => {
  const { invite } = await room(t, []);
  const roomId = roomOf(invite);
  const { bundle, storage } = activated(t);
  bundle.stub.registered.updateFoldersReturn = false;

  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  const refusal = await waitFor('the refused folder to be reported', () =>
    bundle.stub.registered.errors.find((message) => message.includes("room's folder")) ?? false,
  );
  assert.equal(
    refusal,
    `Selvage: could not add the room's folder to this window (the editor refused the folder); join again.`,
  );
  // The add was attempted and read back, not trusted — and a failed join leaves no
  // room-shaped folder, and no mirror directory, behind.
  assert.equal(bundle.stub.registered.folderCalls.length, 1, 'the folder was never attempted');
  assert.deepEqual(
    bundle.stub.registered.folderCalls[0]?.added.length,
    1,
    'the refused add carried no folder',
  );
  assert.equal(
    bundle.stub.registered.information.some((message) => message.includes('joined room')),
    false,
    'a session started without its folder',
  );
  assert.equal(dirEntries(join(storage, 'rooms', roomId)).length, 0, 'the failed join kept its mirror');
});

test('a join with no storage says the window cannot mirror', async (t) => {
  const { invite } = await room(t, []);
  const bundle = freshBundle();
  bundle.stub.reset();
  bundle.activate({ subscriptions: [] });
  t.after(() => {
    bundle.deactivate();
  });

  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  const refusal = await waitFor('the missing storage to be reported', () =>
    bundle.stub.registered.errors.find((message) => message.includes('no storage')) ?? false,
  );
  assert.equal(
    refusal,
    `Selvage: could not join room ${roomOf(invite)}: the editor gave this window no storage for the room's files.`,
  );
});

test('activation clears a stale mirror and leaves a live sibling alone', async (t) => {
  const storage = testStoragePath(t);
  const staleRoot = join(storage, 'rooms', 'r-stale', 'w-stale');
  const liveRoot = join(storage, 'rooms', 'r-stale', 'w-live');
  mkdirSync(staleRoot, { recursive: true });
  mkdirSync(liveRoot, { recursive: true });
  const marker = (window: string, pid: number): string =>
    `${JSON.stringify({ room: 'r-stale', window, pid, created: new Date(0).toISOString() })}\n`;
  writeFileSync(join(staleRoot, '.selvage-mirror.json'), marker('w-stale', 2147483647));
  writeFileSync(join(liveRoot, '.selvage-mirror.json'), marker('w-live', process.pid));

  // The window was restored onto the stale mirror: no session, nothing alive behind it.
  const { bundle } = activated(t);
  bundle.stub.setWorkspaceFolders([staleRoot]);
  bundle.deactivate();
  bundle.stub.reset();
  bundle.stub.setWorkspaceFolders([staleRoot]);
  bundle.activate({
    subscriptions: [],
    globalState: bundle.stub.globalState,
    globalStorageUri: bundle.stub.Uri.file(storage),
  });
  const said = await waitFor('the stale mirror to be reported', () =>
    bundle.stub.registered.warnings.find((message) => message.includes('leftover files')) ?? false,
  );
  assert.equal(
    said,
    `Selvage: removed room r-stale's leftover files from the last session; they were the room's text, not unsaved work.`,
  );
  assert.equal(existsSync(staleRoot), false, 'the stale mirror survived activation');
  assert.equal(isFile(join(liveRoot, '.selvage-mirror.json')), true, 'a live sibling was cleared');
  assert.equal(
    bundle.stub.registered.warnings.filter((message) => message.includes('leftover files')).length,
    1,
    'the live sibling earned its own sentence',
  );
});

test('leaving closes the room tabs, the folder, and the directory', async (t) => {
  const { host, invite, roomId } = await room(t, []);
  await host.grant(['notes/a.md']);
  const { bundle, storage } = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room')) ? true : false,
  );
  await waitForMirrorFiles(storage, roomId, ['notes/a.md']);
  const root = mirrorWindowDir(storage, roomId);
  // One tab in the room, one in the window's own folder: only the room's closes.
  const roomTab = { input: { uri: bundle.stub.Uri.parse(mirrorFileUri(storage, roomId, 'notes/a.md')) } };
  const ownTab = { input: { uri: bundle.stub.Uri.parse('file:///workspace/own.md') } };
  bundle.stub.window.tabGroups.all.push({ tabs: [roomTab, ownTab] });

  await bundle.stub.commands.executeCommand('selvage.leave');
  const said = await waitFor('the leave to be reported', () =>
    bundle.stub.registered.information.find((message) => message.includes('left the session')) ??
    false,
  );
  assert.equal(said, 'Selvage: left the session.');
  const closed = bundle.stub.registered.closedTabs.flat();
  assert.ok(closed.includes(roomTab), 'the room tab stayed open on a deleted directory');
  assert.ok(!closed.includes(ownTab), 'the window\'s own tab was closed with the room');
  // The folder added at join is removed, and the directory goes with it.
  const removals = bundle.stub.registered.folderCalls.filter((call) => call.deleteCount === 1);
  assert.equal(removals.length, 1, 'the room folder stayed in the window');
  assert.equal(existsSync(root), false, 'the mirror survived the leave');
});

test('leaving a window that is only the room deletes before removing the folder', async (t) => {
  const { host, invite, roomId } = await room(t, []);
  await host.grant(['notes/a.md']);
  const { bundle, storage } = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room')) ? true : false,
  );
  await waitForMirrorFiles(storage, roomId, ['notes/a.md']);
  const root = mirrorWindowDir(storage, roomId);
  // The window narrowed to the room: removing its only folder reloads it, so the
  // directory is already gone when the folder goes.
  bundle.stub.setWorkspaceFolders([root]);
  const roomTab = { input: { uri: bundle.stub.Uri.parse(mirrorFileUri(storage, roomId, 'notes/a.md')) } };
  bundle.stub.window.tabGroups.all.push({ tabs: [roomTab] });

  await bundle.stub.commands.executeCommand('selvage.leave');
  await waitFor('the leave to be reported', () =>
    bundle.stub.registered.information.some((message) => message.includes('left the session'))
      ? true
      : false,
  );
  assert.ok(
    bundle.stub.registered.closedTabs.flat().includes(roomTab),
    'the room tab stayed open on a deleted directory',
  );
  assert.equal(existsSync(root), false, 'the mirror survived the leave');
  const removals = bundle.stub.registered.folderCalls.filter((call) => call.deleteCount === 1);
  assert.equal(removals.length, 1, 'the only folder stayed after the directory went');
  assert.deepEqual(removals[0]?.added ?? [], [], 'the removal added a folder');
});

test('opening a file the room does not list says so once and shares nothing', async (t) => {
  const { host, invite, roomId } = await room(t, []);
  await host.grant(['a.md']);
  const { bundle, storage } = activated(t);
  bundle.stub.configure({ openOnJoin: false });
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room')) ? true : false,
  );
  await waitForMirrorFiles(storage, roomId, ['a.md']);

  // A tool's file in the mirror: opened twice, said once, and never shared — the room's
  // open-document set is the witness, and a listed open beside it is the control.
  const holder = { text: '' };
  const unlisted = mirrorDocument(bundle, storage, roomId, 'notes/scratch.md', holder);
  // The editor holds the document open, which is what a later listing rejoins.
  bundle.stub.registered.textDocuments.push(unlisted);
  bundle.stub.fire('openTextDocument', unlisted);
  bundle.stub.fire('openTextDocument', unlisted);
  const said = await waitFor('the unlisted open to be reported', () =>
    bundle.stub.registered.warnings.find((message) => message.includes('is not in the room')) ??
    false,
  );
  assert.equal(
    said,
    'Selvage: notes/scratch.md is not in the room, so it is not shared; the mirror holds the room\'s files and is removed when the session ends.',
  );
  assert.equal(
    bundle.stub.registered.warnings.filter((message) => message.includes('is not in the room'))
      .length,
    1,
    'the sentence repeated for the same path',
  );
  const listedHolder = { text: '' };
  bundle.stub.fire('openTextDocument', mirrorDocument(bundle, storage, roomId, 'a.md', listedHolder));
  await waitFor('the listed open to be shared', () =>
    host.documents().includes('a.md') ? true : false,
  );
  assert.equal(
    host.documents().includes('notes/scratch.md'),
    false,
    'an unlisted file reached the room',
  );

  // The listing naming it later joins it: the open the room skipped is not announced
  // twice, and the hold it takes is what shares it from here on.
  await host.grant(['a.md', 'notes/scratch.md']);
  await waitFor('the listed file to join the room', () =>
    host.documents().includes('notes/scratch.md') ? true : false,
  );
  assert.equal(
    bundle.stub.registered.warnings.filter((message) => message.includes('is not in the room'))
      .length,
    1,
    'joining the room repeated the sentence',
  );
});

test('a document the room opens joins even with no listing at all', async (t) => {
  // The open-document set is the room's other half: a document opened while neither half
  // named it is skipped, and the set naming it later joins it the way a listing does.
  // Joining is proven by an edit round trip, since the host's own open is already in
  // the set before the guest can join it.
  const { host, invite } = await room(t, []);
  const roomId = roomOf(invite);
  const { bundle, storage } = activated(t);
  bundle.stub.configure({ openOnJoin: false });
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room')) ? true : false,
  );
  const holder = { text: '' };
  const document = mirrorDocument(bundle, storage, roomId, 'late.md', holder);
  bundle.stub.registered.textDocuments.push(document);
  bundle.stub.fire('openTextDocument', document);
  await waitFor('the unlisted open to be reported', () =>
    bundle.stub.registered.warnings.some((message) => message.includes('is not in the room'))
      ? true
      : false,
  );

  await host.open('late.md');
  await waitFor('the room to name the opened document', () =>
    roomOffer(bundle).includes('late.md') ? roomOffer(bundle) : false,
  );
  // The set naming it rejoined what the open skipped: a local edit publishes now.
  holder.text = 'guest edit\n';
  bundle.stub.fire('changeTextDocument', { document });
  const echoed = await waitFor('the joined document to publish', () =>
    host.text('late.md') === 'guest edit\n' ? host.text('late.md') : false,
  );
  assert.equal(echoed, 'guest edit\n');
});

test('saving a file the room does not list says so once', async (t) => {
  const { host, invite, roomId } = await room(t, []);
  await host.grant(['a.md']);
  const { bundle, storage } = activated(t);
  bundle.stub.configure({ openOnJoin: false });
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room')) ? true : false,
  );
  await waitForMirrorFiles(storage, roomId, ['a.md']);

  // The editor writes the file — no provider refuses it anymore — and the client says
  // afterwards that the save is not shared. A listed save stays silent.
  const holder = { text: 'mine\n' };
  const document = mirrorDocument(bundle, storage, roomId, 'notes/scratch.md', holder);
  bundle.stub.fire('saveTextDocument', document);
  bundle.stub.fire('saveTextDocument', document);
  const said = await waitFor('the unlisted save to be reported', () =>
    bundle.stub.registered.warnings.find((message) => message.includes('save is not shared')) ??
    false,
  );
  assert.equal(
    said,
    'Selvage: notes/scratch.md is not in the room, so the save is not shared; copy it out of the mirror to keep it.',
  );
  assert.equal(
    bundle.stub.registered.warnings.filter((message) => message.includes('save is not shared'))
      .length,
    1,
    'the sentence repeated for the same path',
  );
  bundle.stub.fire(
    'saveTextDocument',
    mirrorDocument(bundle, storage, roomId, 'a.md', { text: '' }),
  );
  assert.equal(
    bundle.stub.registered.warnings.filter((message) => message.includes('save is not shared'))
      .length,
    1,
    'a listed save earned the sentence',
  );
});

test('a listing the mirror cannot hold is said out loud', async (t) => {
  // The marker's own name is a valid grant path and the one listing entry the mirror
  // refuses: it would overwrite the directory's own provenance.
  const { host, invite, roomId } = await room(t, []);
  await host.grant(['.selvage-mirror.json', 'a.md']);
  const { bundle, storage } = activated(t);
  bundle.stub.configure({ openOnJoin: false });
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room')) ? true : false,
  );
  const said = await waitFor('the refused listing to be reported', () =>
    bundle.stub.registered.warnings.find((message) => message.includes('could not be mirrored')) ??
    false,
  );
  assert.equal(
    said,
    `Selvage: 1 of the room's files could not be mirrored, starting with .selvage-mirror.json.`,
  );
  await waitForMirrorFiles(storage, roomId, ['a.md']);
});

function dirEntries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

test('fetch offers the whole listing first and confirms before holding it', async (t) => {
  const { host, invite, roomId } = await room(t, []);
  await host.grant(['a.md', 'notes/b.md']);
  const { bundle, storage } = activated(t);
  bundle.stub.configure({ openOnJoin: false });
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room')) ? true : false,
  );
  await waitForMirrorFiles(storage, roomId, ['a.md', 'notes/b.md']);

  // The picker's first row is the whole listing; choosing it asks what the yes means.
  bundle.stub.registered.quickPickReply = { label: 'Fetch the whole listing' };
  bundle.stub.registered.warningReply = 'Fetch the whole listing';
  await bundle.stub.commands.executeCommand('selvage.fetch');
  const confirmed = await waitFor('the whole-listing confirm', () =>
    bundle.stub.registered.warnings.find((message) => message.includes('fetch all 2 listed files')) ??
    false,
  );
  assert.equal(
    confirmed,
    'Selvage: fetch all 2 listed files into the mirror? Each is held in the room so every peer receives it, and the mirror holds whatever arrives.',
  );
  await waitFor('the first hold to ask the room', () =>
    bundle.stub.registered.progress.some((entry) => entry.title === 'Selvage: fetching a.md…') ? true : false,
  );
  await host.open('a.md');
  host.insert('a.md', 0, 'a\n');
  await waitFor('the second hold to ask the room', () =>
    bundle.stub.registered.progress.some((entry) => entry.title === 'Selvage: fetching notes/b.md…')
      ? true
      : false,
  );
  await host.open('notes/b.md');
  host.insert('notes/b.md', 0, 'b\n');
  const done = await waitFor('the fetched report', () =>
    bundle.stub.registered.information.find((message) => message.includes('fetched the files')) ??
    false,
  );
  assert.equal(done, 'Selvage: fetched the files.');
});

test('a whole-listing fetch dismissed at the confirm holds nothing', async (t) => {
  const { host, invite, roomId } = await room(t, []);
  await host.grant(['a.md']);
  const { bundle, storage } = activated(t);
  bundle.stub.configure({ openOnJoin: false });
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room')) ? true : false,
  );
  await waitForMirrorFiles(storage, roomId, ['a.md']);

  // The row is chosen and the confirm dismissed: no hold, no wait, no report.
  bundle.stub.registered.quickPickReply = { label: 'Fetch the whole listing' };
  bundle.stub.registered.warningReply = undefined;
  await bundle.stub.commands.executeCommand('selvage.fetch');
  await waitFor('the whole-listing confirm', () =>
    bundle.stub.registered.warnings.some((message) => message.includes('fetch all 1 listed files'))
      ? true
      : false,
  );
  assert.equal(bundle.stub.registered.progress.length, 0, 'a dismissed fetch held a path');
  assert.equal(
    bundle.stub.registered.information.filter((message) => message.includes('fetched the files'))
      .length,
    0,
    'a dismissed fetch reported a fetch',
  );
  assert.equal(host.documents().length, 0, 'a dismissed fetch holds a path in the room');
});
