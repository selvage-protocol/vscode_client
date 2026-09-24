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
  landStashedJoin,
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
import { LiveSession } from './helpers/live-session.ts';
import { parseSessionUrl, sessionUrl } from '../src/engine/index.ts';
import { encodeKey } from '../src/engine/sealed.ts';
import { baseOf } from './helpers/base.ts';
import { peerColour } from '../src/bridge/index.ts';

const OPTIONS = { client: 'selvage-vscode-test/0.1.0' } as const;


/**
 * A valid `§5.1` fragment, for a link a test builds by hand: the room key and the host key a
 * guest reads, each 32 bytes in base64url.
 */
const KEYS = `#k=${encodeKey(new Uint8Array(32).fill(7))}&h=${encodeKey(new Uint8Array(32).fill(9))}`;

/** The room an invite names, so a message that has to name it can be read as a whole. */
function roomOf(invite: string): string {
  const wire = parseSessionUrl(invite)?.join.room;
  if (wire !== undefined) {
    return wire;
  }
  const page = new URL(invite).searchParams.get('room');
  assert.ok(page !== null && page !== '', `the invite names no room: ${invite}`);
  return page as string;
}

/** The wire URL a copied page link names, as the adapter's own join resolves it. */
function wireOf(link: string): string {
  const page = new URL(link);
  const room = page.searchParams.get('room');
  const token = page.searchParams.get('token');
  assert.ok(room !== null && room !== '', `the link names no room: ${link}`);
  assert.ok(token !== null && token !== '', `the link carries no token: ${link}`);
  // The origin is the server: the scheme a browser speaks read back as the one a socket does.
  const server = `${page.protocol === 'https:' ? 'wss:' : 'ws:'}//${page.host}${page.pathname.replace(/\/+$/, '')}`;
  // `§5.1`: the room's two keys are in the link's fragment, and a join needs them, so the wire
  // form of a page link carries the fragment the page link had.
  return `${sessionUrl(baseOf(server), room, token)}${page.hash}`;
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
 * What the mirror holds on disk for a room path: the text the bridge wrote back, or why it
 * could not be read. A wait that ran out reports it, so a failure says whether the room's
 * text reached the window at all or only the buffer did not take it.
 */
function mirrorDiskText(storage: string, room: string, path: string): string {
  try {
    return readFileSync(join(mirrorWindowDir(storage, room), ...path.split('/')), 'utf8');
  } catch (error) {
    return `not readable: ${String(error)}`;
  }
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
): Promise<{ server: FakeServer; host: LiveSession; invite: string; roomId: string }> {
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  const host = await LiveSession.host(server.wsBase, 'Ada', OPTIONS);
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

/**
 * The progress notices that are a fetch's own. The join and the host say they are connecting
 * through the same API, so an assertion that *nothing* waited has to name the fetch it means.
 */
function fetchNotices(bundle: LoadedExtension): Array<{ title?: string }> {
  return bundle.stub.registered.progress.filter((entry) =>
    String(entry.title).includes('fetching'),
  );
}

/** A guest session in `bundle`: the join stashes the invite and stages the
 * reload, and the reactivation onto the mirror lands it — the two halves a
 * real window is split into, staged back to back in the stub.
 */
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
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  await landStashedJoin(bundle, storage, roomId, 'Bob');
  return { bundle, storage, server, invite, roomId };
}

test('hosting while hosting copies the invite rather than minting a room', async (t) => {
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  const { bundle } = activated(t);

  const hostArgs = { serverUrl: server.wsBase, displayName: 'Ada' };
  // A room in this suite is a version-1 one: a hosting client takes its version from what the
  // server's `/meta` says it seats unless `selvage.wireVersion` pins it, so a window that means
  // `selvage/1` says so.
  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', hostArgs);
  const invite = await waitFor('the first session to be ready', () => {
    void bundle.stub.commands.executeCommand('selvage.copyInvite');
    const text = bundle.stub.registered.clipboard;
    return /^https?:\/\//.test(text) ? text : false;
  });
  assert.equal(server.acceptedConnections, 1, 'the first host opened one connection');

  // The second `Host` is the user reaching for the invite; it must copy the same room's
  // link, not open a second connection and not tell them to run `Copy invite link`.
  bundle.stub.reset();
  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', { ...hostArgs, displayName: 'Ada again' });
  const copied = await waitFor('the invite to be copied again', () => {
    const text = bundle.stub.registered.clipboard;
    return /^https?:\/\//.test(text) ? text : false;
  });
  assert.equal(copied, invite, 'the second host copied a different invite');
  assert.equal(server.acceptedConnections, 1, 'the second host minted a second room');
  const said = await waitFor('the room to be named', () =>
    bundle.stub.registered.information.find((message) => message.includes('already hosting')) ??
      false,
  );
  assert.equal(
    said,
    `Selvage: you are already hosting this session; the invite link is on the clipboard.`,
  );
});

test('hosting with no folder open is refused: a room from it would share nothing', async (t) => {
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  const { bundle } = activated(t);
  // No folder open, as an untitled window has none: the room would grant no folder and
  // share no document under one, so a guest would reload their own window onto nothing.
  bundle.stub.setWorkspaceFolders([]);
  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  const refused = await waitFor('the refusal', () =>
    bundle.stub.registered.warnings.find((message) => message.includes('open a folder')) ?? false,
  );
  assert.equal(
    refused,
    'Selvage: open a folder first \u2014 hosting shares the folder this window is open on, and a room from a window with no folder would share nothing.',
  );
  assert.equal(
    server.acceptedConnections,
    0,
    'a room was minted from a window with nothing to share',
  );
  assert.deepEqual(
    bundle.stub.registered.clipboardWrites,
    [],
    'an invite link for an empty room reached the clipboard',
  );
  assert.equal(roomOffer(bundle), '', 'a session started anyway');
  assert.deepEqual(bundle.stub.registered.errors, [], 'the refusal read as a failure');
});

test('the copy command says where the invite went, and a window with none is told why', async (t) => {
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
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
    'Selvage: there is no invite link; host or join a room first.',
  );
  assert.equal(bundle.stub.registered.clipboard, '', 'something reached the clipboard');

  bundle.stub.reset();
  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  const opened = await waitFor('the host to be seated', () =>
    bundle.stub.registered.information.find((message) => message.includes('is open')) ?? false,
  );
  // The notice confirms the copy hosting already made, instead of asking for one.
  assert.match(opened, /^Selvage: the room is open. Send this link to your friend — it is on the clipboard\.$/);

  bundle.stub.reset();
  await bundle.stub.commands.executeCommand('selvage.copyInvite');
  const said = await waitFor('the invite to be copied', () =>
    bundle.stub.registered.information.find((message) => message.includes('clipboard')) ?? false,
  );
  assert.equal(said, 'Selvage: the invite link is on the clipboard.');
  assert.ok(/^https?:\/\//.test(bundle.stub.registered.clipboard), 'nothing reached the clipboard');
});

test('a guest hands on the page link it joined by, origin and all', async (t) => {
  const { invite, roomId } = await room(t, []);
  const wire = parseSessionUrl(invite);
  assert.ok(wire !== undefined, `the room gave no wire invite: ${invite}`);
  // The page the room's server serves, which is the link a host on it produces: the guest's
  // copy keeps that origin — the origin *is* the server — instead of re-homing the link on
  // an address of this window's own.
  const source = new URL(invite);
  const page =
    `${wire.base.replace(/^ws/, 'http')}/?room=${source.searchParams.get('room') ?? ''}&token=${source.searchParams.get('token') ?? ''}${source.hash}`;
  const { bundle, storage } = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite: page, displayName: 'Bob'});
  await landStashedJoin(bundle, storage, roomId, 'Bob');
  await bundle.stub.commands.executeCommand('selvage.copyInvite');
  const said = await waitFor('the guest copy', () =>
    bundle.stub.registered.information.find((message) => message.includes('clipboard')) ?? false,
  );
  assert.equal(said, 'Selvage: the invite link is on the clipboard.');
  assert.equal(
    bundle.stub.registered.clipboard,
    page,
    'the guest copied a link that is not the one it joined by',
  );
});

test('a guest that reached the room over ws:// hands that link on', async (t) => {
  const { bundle, invite } = await guest(t, ['workspace/README.md']);
  await bundle.stub.commands.executeCommand('selvage.copyInvite');
  const said = await waitFor('the guest copy', () =>
    bundle.stub.registered.information.find((message) => message.includes('clipboard')) ?? false,
  );
  assert.equal(said, 'Selvage: the invite link is on the clipboard.');
  assert.equal(
    bundle.stub.registered.clipboard,
    invite,
    'the guest copied a link that is not the one it joined by',
  );
  assert.deepEqual(
    bundle.stub.registered.warnings,
    [],
    'a guest able to hand the invite on was told it could not',
  );
});

test('a guest’s status bar hands the invite on too', async (t) => {
  const { bundle } = await guest(t, ['workspace/README.md']);
  // The bar is the one Selvage surface a window always has, so what it says is pinned here:
  // the side of the room the person is on, and how many people are in it. The guest sees the
  // host, so the count is plural. The side is the applied state's word and arrives after the
  // join — §13.4 gives this connection no role until a state commits its key, so the bar reads
  // "waiting for the host" until then — which is why the wait is for the settled text and not
  // for the moment the item exists.
  const item = await waitFor(
    'the guest’s bar to name the side of the room it is on',
    () => {
      const bar = bundle.stub.registered.statusBarItems.find((entry) => entry.name === 'Selvage');
      return bar !== undefined && String(bar.text).startsWith('$(radio-tower) Selvage: guest ')
        ? bar
        : false;
    },
    { describe: () => bundle.stub.registered.statusBarItems.map((entry) => String(entry.text)) },
  );
  assert.equal(String(item.text), '$(radio-tower) Selvage: guest — 2 people in the room');
  assert.equal(
    item.command,
    'selvage.copyInvite',
    'the guest’s status bar tells a person to click it and does nothing',
  );
  assert.match(String(item.tooltip), /Invite link: click the status bar to copy it\./);
});

test('hosting puts the invite link on the clipboard without being asked', async (t) => {
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  const { bundle } = activated(t);

  // No reply to any button: the notice confirms a copy that already happened, rather
  // than asking for one. Nothing is read back either: the link goes out, not in.
  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  const link = await waitFor('the invite to be copied on host', () => {
    const text = bundle.stub.registered.clipboard;
    return /^https?:\/\//.test(text) ? text : false;
  });
  assert.equal(
    bundle.stub.registered.clipboardWrites.length,
    1,
    'hosting wrote the clipboard more than once',
  );
  assert.deepEqual(bundle.stub.registered.clipboardReads, [], 'hosting read the clipboard');
  const copied = new URL(link);
  assert.ok(copied.searchParams.get('room') !== null, 'the copied link names no room');
  assert.ok(copied.searchParams.get('token') !== null, 'the copied link carries no token');
  const said = await waitFor('the host notice', () =>
    bundle.stub.registered.information.find((message) => message.includes('on the clipboard')) ??
      false,
  );
  assert.equal(said, 'Selvage: the room is open. Send this link to your friend — it is on the clipboard.');
});

test('a clipboard that will not take the invite is said out loud, and the room stands', async (t) => {
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  const { bundle } = activated(t);
  bundle.stub.registered.clipboardWriteThrows = 'the clipboard is busy';

  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  const warned = await waitFor('the copy failure', () =>
    bundle.stub.registered.warnings.find((message) => message.includes('could not be copied')) ??
      false,
  );
  assert.equal(
    warned,
    'Selvage: the room is open, but the invite link could not be copied (the clipboard is busy).',
  );
  assert.equal(bundle.stub.registered.clipboard, '', 'a failed copy left the clipboard written');
  // The session stands: the failure cost the copy, not the room.
  const tooltip = await waitFor('the status bar to be drawn', () =>
    roomOffer(bundle).includes('Hosting this session') ? roomOffer(bundle) : false,
  );
  assert.match(tooltip, /Hosting this session/);
});

test('a host never sees the room id: notices, tooltip and warnings say the room', async (t) => {
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  const { bundle } = activated(t);
  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  await bundle.stub.commands.executeCommand('selvage.copyInvite');
  const invite = await waitFor('the invite link', () => {
    void bundle.stub.commands.executeCommand('selvage.copyInvite');
    const text = bundle.stub.registered.clipboard;
    return /^https?:\/\//.test(text) ? text : false;
  });
  const roomId = roomOf(invite);

  // Hosting again, and the warning a second command stages: every surface the host
  // reads. The clipboard's own link is the one deliberate exception — the link is
  // machine-readable data, and joining needs the room it names.
  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  await bundle.stub.commands.executeCommand('selvage.join', {
    invite: 'ws://127.0.0.1:1/session?room=r&token=t',
    displayName: 'Bob',
  });
  const surfaces = [
    ...bundle.stub.registered.information,
    ...bundle.stub.registered.warnings,
    ...bundle.stub.registered.errors,
    roomOffer(bundle),
    ...bundle.stub.registered.quickPicks.map((pick) => JSON.stringify(pick.options)),
  ];
  assert.ok(surfaces.length > 0, 'no user-visible surface was exercised');
  for (const surface of surfaces) {
    assert.ok(
      !surface.includes(roomId),
      `the room id reached a user-visible surface: ${surface}`,
    );
  }
});

test('a guest never sees the room id: join notice, tooltip and pickers say the room', async (t) => {
  const { bundle, roomId } = await guest(t, ['workspace/README.md', 'workspace/src/main.rs']);

  await bundle.stub.commands.executeCommand('selvage.openDocument');
  await bundle.stub.commands.executeCommand('selvage.peers');
  const surfaces = [
    ...bundle.stub.registered.information,
    ...bundle.stub.registered.warnings,
    ...bundle.stub.registered.errors,
    roomOffer(bundle),
    ...bundle.stub.registered.quickPicks.map((pick) => JSON.stringify(pick)),
  ];
  assert.ok(bundle.stub.registered.quickPicks.length > 0, 'no picker was exercised');
  for (const surface of surfaces) {
    assert.ok(
      !surface.includes(roomId),
      `the room id reached a user-visible surface: ${surface}`,
    );
  }
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
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  await landStashedJoin(bundle, landingStorage, roomId, 'Bob');
  const joined = bundle.stub.registered.information.find((message) => message.includes('joined the room')) ?? false;
  assert.equal(joined, `Selvage: joined the room; the room has no open documents yet.`);
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
  const { bundle, storage } = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  await landStashedJoin(bundle, storage, roomId, 'Bob', { openOnJoin: false });
  const joined = bundle.stub.registered.information.find((message) => message.includes('joined the room')) ?? false;
  assert.equal(joined, `Selvage: joined the room.`);

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
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  const { bundle } = activated(t);
  // A host's open files are the room's, and it already has them in front of it. The stub answers
  // a workspace folder for the seeded file, which is what makes the adapter share it at all.
  bundle.stub.openWorkspaceDocument('file:///workspace/README.md');

  bundle.stub.configure({ wireVersion: 'selvage/1' });
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
  const { bundle, storage } = activated(t);
  await bundle.stub.commands.executeCommand('selvage.openDocument');
  const outside = await waitFor('the warning', () =>
    bundle.stub.registered.warnings.find((message) => message.includes('session')) ?? false,
  );
  assert.equal(outside, 'Selvage: join a session first.');

  const { invite } = await room(t, []);
  bundle.stub.reset();
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  await landStashedJoin(bundle, storage, roomOf(invite), 'Bob');

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
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  const { bundle } = activated(t);
  bundle.stub.configure({ wireVersion: 'selvage/1' });
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
    bundle.stub.registered.information.find((message) => message.includes('the host')) ?? false,
  );
  assert.equal(said, 'Selvage: you are the host — the files you open are the ones your guests see.');
  assert.equal(bundle.stub.registered.quickPicks.length, 0, 'a host was offered its own files');
});

test('hosting while a guest asks before leaving, and an emptied window is told to open a folder', async (t) => {
  const { bundle, server } = await guest(t, ['workspace/README.md']);
  const before = server.acceptedConnections;

  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada again',
  });
  const asked = await waitFor('the leave-and-host question', () =>
    bundle.stub.registered.warnings.find((message) => message.includes('hosting a session means leaving it first')) ?? false,
  );
  assert.equal(asked, `Selvage: you are in this session; hosting a session means leaving it first.`);
  assert.equal(server.acceptedConnections, before, 'a dismissed question opened a connection');

  // Leaving takes the room's folder with it — the mirror was the whole tree — so the window
  // the host would now be seated in has nothing to share, and says so instead of minting a
  // room that grants nothing.
  bundle.stub.registered.warningReply = 'Leave and host';
  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada again',
  });
  const refused = await waitFor('the refusal', () =>
    bundle.stub.registered.warnings.find((message) => message.includes('open a folder')) ?? false,
  );
  assert.equal(
    refused,
    'Selvage: open a folder first \u2014 hosting shares the folder this window is open on, and a room from a window with no folder would share nothing.',
  );
  assert.equal(
    server.acceptedConnections,
    before,
    'a room was minted from a window with nothing to share',
  );

  // A folder of the user's own, and the same command hosts from it.
  bundle.stub.setWorkspaceFolders(['/workspace']);
  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada again',
  });
  await waitFor('the new host to connect', () =>
    server.acceptedConnections > before ? true : false,
  );
});

test('joining while hosting asks before ending the room', async (t) => {
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  const { bundle } = activated(t);
  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  await waitFor('the host to be seated', () => {
    void bundle.stub.commands.executeCommand('selvage.copyInvite');
    return /^https?:\/\//.test(bundle.stub.registered.clipboard) ? true : false;
  });
  const before = server.acceptedConnections;

  await bundle.stub.commands.executeCommand('selvage.join', {
    invite: 'ws://127.0.0.1:1/session?room=r&token=t',
    displayName: 'Bob',
  });
  const asked = await waitFor('the leave-and-join question', () =>
    bundle.stub.registered.warnings.find((message) => message.includes('joining another session ends this room')) ?? false,
  );
  // The id is the server's, so the sentence is read without it: no loose part names the room.
  assert.match(
    asked,
    /^Selvage: you are hosting this session; joining another session ends this room for everyone\.$/,
  );
  assert.equal(server.acceptedConnections, before, 'a dismissed question opened a connection');
});

test('the display-name command reports the name in force and offers to change it', async (t) => {
  // A fresh window with nothing set and nothing remembered: the report is the first
  // thing the command says. Fresh because the module remembers names other tests type.
  const bundle = freshBundle();
  bundle.stub.reset();
  bundle.activate({ subscriptions: [], globalState: bundle.stub.globalState });
  t.after(() => {
    bundle.deactivate();
  });

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

test('leaving says so, and a window that is Not in a session is told that instead', async (t) => {
  const { bundle } = await guest(t, ['workspace/README.md']);

  bundle.stub.reset();
  await bundle.stub.commands.executeCommand('selvage.leave');
  const left = await waitFor('the message', () =>
    bundle.stub.registered.information.find((message) => message.includes('left the session')) ?? false,
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
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  const { bundle } = activated(t);

  bundle.stub.configure({ wireVersion: 'selvage/1' });
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
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  const { bundle } = activated(t);
  // A hand-edited settings.json, which no command here would write: this is the path a
  // settings UI takes, and the client has to catch it before the handshake.
  bundle.stub.configure({ displayName: 'a'.repeat(33) });
  bundle.stub.registered.inputReply = 'Ada';

  bundle.stub.configure({ wireVersion: 'selvage/1' });
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
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  const { bundle } = activated(t);

  await bundle.stub.commands.executeCommand('selvage.peers');
  const outside = await waitFor('the warning', () =>
    bundle.stub.registered.warnings.find((message) => message.includes('session')) ?? false,
  );
  assert.equal(outside, 'Selvage: join a session first.');

  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  // The session exists once `host()` has built it and said so; the socket being accepted is
  // earlier than that, and a command run in the gap warns `Join a session first`.
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
  const { bundle, storage } = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  await landStashedJoin(bundle, storage, roomOf(invite), 'Bob');
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
  const { bundle } = await guest(t, ['workspace/README.md']);

  bundle.stub.reset();
  await bundle.stub.commands.executeCommand('selvage.join', {
    invite: 'ws://127.0.0.1:1/session?room=r&token=t',
    displayName: 'Bob',
  });
  const asked = await waitFor('the question', () =>
    bundle.stub.registered.warnings.find((message) => message.includes('joining another session leaves it')) ?? false,
  );
  assert.equal(asked, `Selvage: you are in this session; joining another session leaves it.`);

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

/** The invite a bundle host copied, read off the clipboard as a user's click would leave it. */
async function inviteOf(bundle: LoadedExtension): Promise<string> {
  // The copy resolves a microtask after it is asked for, so the check re-asks and reads what
  // the clipboard holds by the next poll, exactly as a user clicking the command would.
  return await waitFor('the invite link', () => {
    void bundle.stub.commands.executeCommand('selvage.copyInvite');
    const clipboard = bundle.stub.registered.clipboard;
    return /^https?:\/\//.test(clipboard) ? clipboard : false;
  });
}

test('a host publishes the listing of the folder it was invited on', async (t) => {
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
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

  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  const invite = await inviteOf(bundle);
  const guest = await LiveSession.join(wireOf(invite), 'Bob', OPTIONS);
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
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
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

  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  const invite = await inviteOf(bundle);
  const guest = await LiveSession.join(wireOf(invite), 'Bob', OPTIONS);
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
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  await landStashedJoin(bundle, storage, roomId, 'Bob');

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

test('the open command offers the grant, not only what the room has open', async (t) => {
  const { host, invite, roomId } = await room(t, []);
  await host.grant(['README.md', 'src/deep/nested.rs']);
  const { bundle, storage } = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  await landStashedJoin(bundle, storage, roomId, 'Bob');
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
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  const { bundle } = activated(t);
  bundle.stub.put('README.md', 'shared\n');
  bundle.stub.put('inside.md', 'still shared\n');
  bundle.stub.openWorkspaceDocument('file:///workspace/README.md');

  bundle.stub.configure({ wireVersion: 'selvage/1' });
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

test('a host names deletion when the room asks for a file it removed', async (t) => {
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  const { bundle } = activated(t);
  bundle.stub.put('doomed.txt', 'was here\n');
  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  const invite = await inviteOf(bundle);
  const guest = await LiveSession.join(wireOf(invite), 'Bob', OPTIONS);
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
  assert.match(refusal, /there is no readable file there any more/);
  assert.match(
    refusal,
    /may have been deleted after the listing was published/,
    'a deliberate deletion reads as a failure',
  );
  assert.equal(guest.has('doomed.txt'), false, 'the deleted path was seeded anyway');
});

test('a host refuses a zip the room asks for as a binary file, never as a deletion', async (t) => {
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  const { bundle } = activated(t);
  // A zip as it is on disk: a local file header, whose first bytes carry a NUL. A listing
  // names it — the walk rules on a file's type and the size a session will carry, and does
  // not read it — so a guest can ask for it, and the answer has to be about what the file is
  // rather than about a deletion nobody made.
  bundle.stub.put(
    'logs_96234608913.zip',
    new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]),
  );
  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  const invite = await inviteOf(bundle);
  const guest = await LiveSession.join(wireOf(invite), 'Bob', OPTIONS);
  t.after(async () => {
    await guest.disconnect();
  });

  await guest.open('logs_96234608913.zip');
  const refusal = await waitFor('the host to refuse the binary path', () =>
    bundle.stub.registered.errors.find((message) => message.includes('logs_96234608913.zip')) ??
      false,
  );
  assert.equal(
    refusal,
    'Selvage: could not share logs_96234608913.zip: it is a binary file, and a room carries text, so this is not a file that can be shared at all; nothing was shared for it.',
  );
  assert.equal(guest.has('logs_96234608913.zip'), false, 'the binary path was seeded anyway');
});

test('a stale openDocument path that left the listing is refused, not silently dropped', async (t) => {
  const { host, invite, roomId } = await room(t, []);
  await host.grant(['doomed.txt']);
  const { bundle, storage } = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  await landStashedJoin(bundle, storage, roomId, 'Bob');
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
  // Set after the landing: the reload clears what the stub recorded, and what fills
  // the holder is the open below, not the landing.
  const holder = { text: '' };
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  await landStashedJoin(bundle, storage, roomId, 'Bob');
  bundle.stub.registered.applyEditImpl = async (edit: unknown) => {
    const changes = (edit as { edits: Array<{ text: string }> }).edits;
    for (const change of changes) {
      holder.text += change.text;
    }
    return true;
  };
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

test('the status tooltip names the session but never the room id or the invite token', async (t) => {
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  const { bundle } = activated(t);
  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  const tooltip = await waitFor('the status bar to be drawn', () =>
    roomOffer(bundle).includes('Hosting this session') ? roomOffer(bundle) : false,
  );

  // The invite itself, fetched the way a click fetches it: the tooltip must hold no part
  // of it, while still saying where the link is reached from — and no part of the room
  // id either, which is the server's to know.
  await bundle.stub.commands.executeCommand('selvage.copyInvite');
  const invite = await waitFor('the invite link', () => {
    const clipboard = bundle.stub.registered.clipboard;
    return /^https?:\/\//.test(clipboard) ? clipboard : false;
  });
  const token = invite.slice(invite.indexOf('token='));
  const roomId = roomOf(invite);
  assert.ok(!tooltip.includes(roomId), 'the room id is in the status tooltip');
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
  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host');
  const asked = await waitFor('the server question', () =>
    bundle.stub.registered.inputs[0] ?? false,
  );
  assert.equal(asked.title, 'The Selvage server to host on');
  assert.match(String(asked.prompt), /the server you and your guest both connect to/i);
  // The settings id is not in the prompt: a person who wants the setting finds it in the
  // Settings UI, and a first-run question is the wrong place to teach it.
  assert.doesNotMatch(String(asked.prompt), /selvage\.serverUrl/);
  assert.equal(asked.placeHolder, 'The address the server prints when it starts');
  // Nothing configured and nothing remembered: the box starts from the demo server.
  assert.equal(asked.value, 'ws://100.64.0.3:8080');
  assert.doesNotMatch(String(asked.placeHolder), /ws:\/\//);
  assert.doesNotMatch(String(asked.prompt), /selvaged/);
});

test('the typed server is remembered across windows, and hosting reuses it without asking', async (t) => {
  const first = freshBundle();
  first.stub.reset();
  first.activate({ subscriptions: [], globalState: first.stub.globalState });
  t.after(() => {
    first.deactivate();
  });

  // Typed through the box at an address with nothing on it, so hosting fails — but the
  // prompt already kept what was typed.
  first.stub.registered.inputReply = 'ws://127.0.0.1:1';
  first.stub.configure({ wireVersion: 'selvage/1' });
  await first.stub.commands.executeCommand('selvage.host');
  const kept = await waitFor('the server to be remembered', () =>
    first.stub.globalState.get('selvage.lastServer') === 'ws://127.0.0.1:1' ? true : false,
  );
  assert.ok(kept);
  // The remembered write lands before the dial even starts; waiting past it and on into the
  // dial's own failure keeps that failure from landing in the stub's shared record — first and
  // second are different module instances, but registered.errors/errorItems are one array
  // underneath both — after it has been reset for the next window.
  await waitFor('the first window to finish failing to host', () =>
    first.stub.registered.errors.some((message) =>
      message.includes('could not host on ws://127.0.0.1:1'),
    )
      ? true
      : false,
  );
  first.deactivate();

  // A new window is a new module: nothing in memory names the address, only the memento.
  // The recorded messages are cleared alongside the boxes — but the memento is deliberately
  // not reset. Hosting again reuses the remembered address with no question — which is read
  // here off the failure the dead address earns, so the box count is the assertion and not
  // the poll.
  const second = freshBundle();
  second.stub.registered.inputs.length = 0;
  second.stub.registered.errors.length = 0;
  second.stub.registered.errorItems.length = 0;
  second.stub.registered.inputReply = undefined;
  second.activate({ subscriptions: [], globalState: first.stub.globalState });
  t.after(() => {
    second.deactivate();
  });
  second.stub.configure({ wireVersion: 'selvage/1' });
  await second.stub.commands.executeCommand('selvage.host', { displayName: 'Ada' });
  const said = await waitFor('the failure', () =>
    second.stub.registered.errors.find((message) =>
      message.includes('could not host on ws://127.0.0.1:1'),
    ) ?? false,
  );
  assert.ok(said, 'hosting did not reuse the remembered server');
  assert.equal(
    second.stub.registered.inputs.length,
    0,
    'the remembered server was asked for again',
  );
  // Only the reuse offers the change: the typed host's own failure named an address that
  // was asked for, not reused.
  const at = second.stub.registered.errors.indexOf(said);
  assert.deepEqual(second.stub.registered.errorItems[at], ['Change the server']);

  // The failure already names the dead address, so its button reaches the same question
  // the first run asked, prefilled with that address — and the typed answer is what the
  // next host reuses.
  second.stub.registered.errorReply = 'Change the server';
  second.stub.registered.inputReply = 'ws://127.0.0.1:2';
  second.stub.configure({ wireVersion: 'selvage/1' });
  await second.stub.commands.executeCommand('selvage.host', { displayName: 'Ada' });
  await waitFor('the dead host to fail again', () =>
    second.stub.registered.errors.filter((message) =>
      message.includes('could not host on ws://127.0.0.1:1'),
    ).length >= 2
      ? true
      : false,
  );
  const changed = await waitFor('the change box', () =>
    second.stub.registered.inputs[0] ?? false,
  );
  assert.equal(changed.value, 'ws://127.0.0.1:1', 'the change box started from the demo, not the address');
  assert.equal(second.stub.globalState.get('selvage.lastServer'), 'ws://127.0.0.1:2');
  const confirmed = await waitFor('the change to be confirmed', () =>
    second.stub.registered.information.find((message) => message.includes('will host on')) ??
      false,
  );
  assert.equal(
    confirmed,
    'Selvage: will host on ws://127.0.0.1:2 next. Leave this session and host again to move there.',
  );
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
  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host');
  const kept = await waitFor('the server to be remembered', () =>
    bundle.stub.globalState.get('selvage.lastServer') === 'ws://127.0.0.1:1' ? true : false,
  );
  assert.ok(kept);

  // The explicit address wins over the remembered one, with no question asked —
  // and what was explicit is what is remembered next.
  bundle.stub.registered.inputs.length = 0;
  bundle.stub.registered.inputReply = undefined;
  bundle.stub.configure({ wireVersion: 'selvage/1' });
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

test('the server address a command is given is trimmed, and that is what is remembered', async (t) => {
  const bundle = freshBundle();
  bundle.stub.reset();
  bundle.activate({ subscriptions: [], globalState: bundle.stub.globalState });
  t.after(() => {
    bundle.deactivate();
  });

  // A pasted-with-padding address is the address: the setting and the box answer are
  // trimmed, and an address given to the command has to be too, or the first host is the
  // only one that ever sees the whitespace — every later host reuses it.
  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: '  ws://127.0.0.1:1  ',
    displayName: 'Ada',
  });
  const said = await waitFor('the failure', () =>
    bundle.stub.registered.errors.find((message) => message.includes('could not host')) ?? false,
  );
  assert.match(String(said), /could not host on ws:\/\/127\.0\.0\.1:1\./);
  assert.equal(
    bundle.stub.globalState.get('selvage.lastServer'),
    'ws://127.0.0.1:1',
    'the remembered address carries the whitespace it was given',
  );
});

test('a configured server address answers without asking', async (t) => {
  const { bundle } = activated(t);
  bundle.stub.configure({ serverUrl: 'ws://127.0.0.1:9', displayName: 'Ada' });

  // The setting answers: no box opens, and the failure names the configured address.
  bundle.stub.configure({ wireVersion: 'selvage/1' });
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
  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host');
  const kept = await waitFor('the server to be remembered', () =>
    bundle.stub.globalState.get('selvage.lastServer') === 'ws://127.0.0.1:1' ? true : false,
  );
  assert.ok(kept);

  bundle.stub.registered.inputs.length = 0;
  bundle.stub.registered.inputReply = undefined;
  bundle.stub.configure({ serverUrl: 'ws://127.0.0.1:9', displayName: 'Ada' });
  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host');
  const said = await waitFor('the failure', () =>
    bundle.stub.registered.errors.find((message) =>
      message.includes('could not host on ws://127.0.0.1:9'),
    ) ?? false,
  );
  assert.ok(said, 'hosting did not use the configured address');
  assert.equal(bundle.stub.registered.inputs.length, 0, 'a configured server was asked about');
});

test('the host notice names a reused server and offers to change it', async (t) => {
  const first = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await first.stop();
  });
  const second = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await second.stop();
  });
  const bundle = freshBundle();
  bundle.stub.reset();
  bundle.stub.configure({ displayName: 'Ada' });
  bundle.activate({ subscriptions: [], globalState: bundle.stub.globalState });
  t.after(() => {
    bundle.deactivate();
  });

  // The first host types nothing: the box answers with the first server, and hosting
  // remembers it. The notice on a typed address offers no change — nothing was reused.
  bundle.stub.registered.inputReply = first.wsBase;
  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host');
  const seated = await waitFor('the first host to be seated', () =>
    bundle.stub.registered.information.find((message) => message.includes('the room is open')) ??
      false,
  );
  assert.equal(
    seated,
    'Selvage: the room is open. Send this link to your friend — it is on the clipboard.',
  );
  const remembered = await waitFor('the server to be remembered', () =>
    bundle.stub.globalState.get('selvage.lastServer') === first.wsBase ? true : false,
  );
  assert.ok(remembered);

  // A second window is a new module: nothing in memory names the address, only the
  // memento. Hosting reuses it silently, names it in the notice, and offers the change
  // the palette never had — the recorded boxes are cleared but the memento is not reset.
  bundle.deactivate();
  const next = freshBundle();
  next.stub.registered.inputs.length = 0;
  next.stub.registered.information.length = 0;
  next.stub.registered.informationItems.length = 0;
  next.stub.configure({ displayName: 'Ada' });
  next.activate({ subscriptions: [], globalState: bundle.stub.globalState });
  t.after(() => {
    next.deactivate();
  });

  // The reuse answers the notice's own question: taking the button opens the same box
  // the first run asked, prefilled with the address in force, and the typed answer is
  // what the next host reuses.
  next.stub.registered.informationReply = 'Change the server';
  next.stub.registered.inputReply = second.wsBase;
  next.stub.configure({ wireVersion: 'selvage/1' });
  await next.stub.commands.executeCommand('selvage.host');
  const reused = await waitFor('the reused host to be seated', () =>
    next.stub.registered.information.find((message) => message.includes('the room is open on')) ??
      false,
  );
  assert.equal(
    reused,
    `Selvage: the room is open on ${first.wsBase}. Send this link to your friend — it is on the clipboard.`,
  );
  const at = next.stub.registered.information.indexOf(reused);
  assert.deepEqual(next.stub.registered.informationItems[at], ['Copy again', 'Change the server']);
  const asked = await waitFor('the change box', () =>
    next.stub.registered.inputs[0] ?? false,
  );
  assert.equal(asked.value, first.wsBase, 'the change box started from the demo, not the address');
  const kept = await waitFor('the changed server to be remembered', () =>
    next.stub.globalState.get('selvage.lastServer') === second.wsBase ? true : false,
  );
  assert.ok(kept);
  const confirmed = await waitFor('the change to be confirmed', () =>
    next.stub.registered.information.find((message) => message.includes('will host on')) ??
      false,
  );
  assert.equal(
    confirmed,
    `Selvage: will host on ${second.wsBase} next. Leave this session and host again to move there.`,
  );

  // A configured address still wins over the changed memory — and its notice offers no
  // change, because the setting is changed where it is set, in Settings.
  await next.stub.commands.executeCommand('selvage.leave');
  await waitFor('the session to be left', () =>
    next.stub.registered.information.some((message) => message.includes('left the session')) ? true : false,
  );
  next.stub.registered.information.length = 0;
  next.stub.registered.informationItems.length = 0;
  next.stub.registered.inputs.length = 0;
  next.stub.configure({ serverUrl: first.wsBase });
  next.stub.registered.informationReply = undefined;
  next.stub.configure({ wireVersion: 'selvage/1' });
  await next.stub.commands.executeCommand('selvage.host');
  const configuredNotice = await waitFor('the configured host to be seated', () =>
    next.stub.registered.information.find((message) => message.includes('the room is open')) ??
      false,
  );
  assert.match(
    String(configuredNotice),
    /^Selvage: the room is open\. Send this link to your friend/,
  );
  const configuredAt = next.stub.registered.information.indexOf(configuredNotice);
  assert.deepEqual(next.stub.registered.informationItems[configuredAt], ['Copy again']);
  assert.equal(next.stub.registered.inputs.length, 0, 'a configured server was asked about');
});

test('the change-server command reports the address in force and offers to change it', async (t) => {
  // Fresh module state: `lastServer` is a module-level variable, and other tests in this file
  // remember real addresses that a shared module would still carry.
  const bundle = freshBundle();
  bundle.stub.reset();
  bundle.activate({ subscriptions: [], globalState: bundle.stub.globalState });
  t.after(() => {
    bundle.deactivate();
  });

  // Nothing remembered and nothing configured: the report is the first thing the command
  // says, and the box it offers starts from the demo default.
  await bundle.stub.commands.executeCommand('selvage.changeServer');
  const first = await waitFor('the first report', () =>
    bundle.stub.registered.information.find((message) => message.includes('remembered')) ?? false,
  );
  assert.equal(first, 'Selvage: no server is remembered yet; the next host asks.');
  assert.deepEqual(bundle.stub.registered.informationItems[0], ['Change the server']);

  bundle.stub.registered.informationReply = 'Change the server';
  bundle.stub.registered.inputReply = 'ws://198.51.100.1:9';
  await bundle.stub.commands.executeCommand('selvage.changeServer');
  const asked = await waitFor('the change box', () => bundle.stub.registered.inputs[0] ?? false);
  assert.equal(asked.value, 'ws://100.64.0.3:8080', 'the box did not start from the demo default');
  const kept = await waitFor('the address to be remembered', () =>
    bundle.stub.globalState.get('selvage.lastServer') === 'ws://198.51.100.1:9' ? true : false,
  );
  assert.ok(kept);
  const confirmed = await waitFor('the change to be confirmed', () =>
    bundle.stub.registered.information.find((message) => message.includes('will host on')) ?? false,
  );
  assert.equal(
    confirmed,
    'Selvage: will host on ws://198.51.100.1:9 next. Leave this session and host again to move there.',
  );

  // The remembered address is now in force: the next report names it, and asking for it
  // opens no box until the button is taken.
  bundle.stub.registered.information.length = 0;
  bundle.stub.registered.informationItems.length = 0;
  bundle.stub.registered.inputs.length = 0;
  bundle.stub.registered.informationReply = undefined;
  await bundle.stub.commands.executeCommand('selvage.changeServer');
  const second = await waitFor('the second report', () =>
    bundle.stub.registered.information.find((message) => message.includes('next host uses')) ?? false,
  );
  assert.equal(second, 'Selvage: the next host uses ws://198.51.100.1:9.');
  assert.deepEqual(bundle.stub.registered.informationItems[0], ['Change the server']);
  assert.equal(bundle.stub.registered.inputs.length, 0, 'the box opened before the button was taken');

  // A configured setting outranks the remembered address: the command says so and offers
  // no button, so writing the memento — which the next host would ignore — never happens.
  bundle.stub.configure({ serverUrl: 'ws://203.0.113.5:9' });
  bundle.stub.registered.information.length = 0;
  bundle.stub.registered.informationItems.length = 0;
  await bundle.stub.commands.executeCommand('selvage.changeServer');
  const configuredReport = await waitFor('the configured report', () =>
    bundle.stub.registered.information.find((message) => message.includes('selvage.serverUrl')) ?? false,
  );
  assert.equal(
    configuredReport,
    'Selvage: the "selvage.serverUrl" setting fixes the server at ws://203.0.113.5:9; change it in Settings to use a different one.',
  );
  assert.deepEqual(bundle.stub.registered.informationItems[0], []);
  assert.equal(bundle.stub.registered.inputs.length, 0, 'a configured server was asked about');
  assert.equal(
    bundle.stub.globalState.get('selvage.lastServer'),
    'ws://198.51.100.1:9',
    'the configured setting changed the remembered address',
  );

  // The same honesty applies to a programmatic argument: it is not a second way around the
  // setting the palette respects.
  bundle.stub.registered.information.length = 0;
  await bundle.stub.commands.executeCommand('selvage.changeServer', { serverUrl: 'ws://192.0.2.9:9' });
  const trapped = await waitFor('the report on the trapped write', () =>
    bundle.stub.registered.information.find((message) => message.includes('selvage.serverUrl')) ?? false,
  );
  assert.equal(
    trapped,
    'Selvage: the "selvage.serverUrl" setting fixes the server at ws://203.0.113.5:9; change it in Settings to use a different one.',
  );
  assert.equal(
    bundle.stub.globalState.get('selvage.lastServer'),
    'ws://198.51.100.1:9',
    'an explicit argument wrote the memento while the setting outranks it',
  );

  // With the setting cleared, the same argument writes directly: no box is opened.
  bundle.stub.configure({ serverUrl: '' });
  bundle.stub.registered.information.length = 0;
  await bundle.stub.commands.executeCommand('selvage.changeServer', { serverUrl: 'ws://192.0.2.9:9' });
  const direct = await waitFor('the direct confirmation', () =>
    bundle.stub.registered.information.find((message) => message.includes('will host on')) ?? false,
  );
  assert.equal(
    direct,
    'Selvage: will host on ws://192.0.2.9:9 next. Leave this session and host again to move there.',
  );
  assert.equal(bundle.stub.registered.inputs.length, 0, 'an explicit argument opened a box');
  assert.equal(bundle.stub.globalState.get('selvage.lastServer'), 'ws://192.0.2.9:9');
});

test('the typed name is remembered across windows, and hosting skips the question', async (t) => {
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  const first = freshBundle();
  first.stub.reset();
  first.stub.configure({ serverUrl: 'ws://127.0.0.1:1' });
  first.activate({ subscriptions: [], globalState: first.stub.globalState });
  t.after(() => {
    first.deactivate();
  });

  // The server is dead so hosting fails — but the name box already kept its answer.
  first.stub.registered.inputReply = 'Ada';
  first.stub.configure({ wireVersion: 'selvage/1' });
  await first.stub.commands.executeCommand('selvage.host');
  const kept = await waitFor('the name to be remembered', () =>
    first.stub.globalState.get('selvage.lastDisplayName') === 'Ada' ? true : false,
  );
  assert.ok(kept);
  first.deactivate();

  // A new window is a new module: nothing in memory names Ada, only the memento — and
  // hosting with her remembered name asks nothing. The recorded boxes are cleared but
  // the memento is deliberately not reset.
  const second = freshBundle();
  second.stub.registered.inputs.length = 0;
  second.stub.registered.inputReply = undefined;
  second.activate({ subscriptions: [], globalState: first.stub.globalState });
  t.after(() => {
    second.deactivate();
  });
  second.stub.configure({ wireVersion: 'selvage/1' });
  await second.stub.commands.executeCommand('selvage.host', { serverUrl: server.wsBase });
  await waitFor('the remembered host to be seated', () =>
    second.stub.registered.information.some((message) => message.includes('is open')) ? true : false,
  );
  assert.equal(second.stub.registered.inputs.length, 0, 'the remembered name was asked for again');
  assert.ok(
    server.displayNames().includes('Ada'),
    'the remembered name did not seat the host',
  );
});

test('the first run asks for the name once, then never again', async (t) => {
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  const bundle = freshBundle();
  bundle.stub.reset();
  bundle.activate({ subscriptions: [], globalState: bundle.stub.globalState });
  t.after(() => {
    bundle.deactivate();
  });

  // Nothing remembered and nothing configured: the question is asked, and its answer is
  // what the memento keeps.
  bundle.stub.registered.inputReply = 'Ada';
  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', { serverUrl: server.wsBase });
  const asked = await waitFor('the name question', () =>
    bundle.stub.registered.inputs[0] ?? false,
  );
  assert.equal(asked.title, 'The name other participants see');
  await waitFor('the host to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('is open')) ? true : false,
  );
  assert.equal(bundle.stub.globalState.get('selvage.lastDisplayName'), 'Ada');

  // The answer is kept: hosting again, after leaving, asks nothing. Only the recorded
  // boxes and notices are cleared — a reset would clear the memento under test.
  await bundle.stub.commands.executeCommand('selvage.leave');
  await waitFor('the leave to be said', () =>
    bundle.stub.registered.information.some((message) => message.includes('left the session'))
      ? true
      : false,
  );
  bundle.stub.registered.inputs.length = 0;
  bundle.stub.registered.information.length = 0;
  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', { serverUrl: server.wsBase });
  await waitFor('the second host to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('is open')) ? true : false,
  );
  assert.equal(bundle.stub.registered.inputs.length, 0, 'the kept name was asked for again');
});

test('an explicit name beats the remembered name, and is what is remembered next', async (t) => {
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  const bundle = freshBundle();
  bundle.stub.reset();
  await bundle.stub.globalState.update('selvage.lastDisplayName', 'Remembered');
  bundle.activate({ subscriptions: [], globalState: bundle.stub.globalState });
  t.after(() => {
    bundle.deactivate();
  });

  // The explicit name wins over the remembered one, with no question asked — and what
  // was explicit is what is remembered next.
  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  await waitFor('the host to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('is open')) ? true : false,
  );
  assert.equal(bundle.stub.registered.inputs.length, 0, 'the remembered name was asked about');
  assert.ok(server.displayNames().includes('Ada'), 'hosting did not use the explicit name');
  assert.equal(bundle.stub.globalState.get('selvage.lastDisplayName'), 'Ada');
});

test('a configured name beats the remembered name', async (t) => {
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  const bundle = freshBundle();
  bundle.stub.reset();
  await bundle.stub.globalState.update('selvage.lastDisplayName', 'Remembered');
  bundle.stub.configure({ displayName: 'Configured' });
  bundle.activate({ subscriptions: [], globalState: bundle.stub.globalState });
  t.after(() => {
    bundle.deactivate();
  });

  // The setting answers, not the memory: no box opens, and the room seats the
  // configured name.
  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', { serverUrl: server.wsBase });
  await waitFor('the host to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('is open')) ? true : false,
  );
  assert.equal(bundle.stub.registered.inputs.length, 0, 'a configured name was asked about');
  assert.ok(
    server.displayNames().includes('Configured'),
    'hosting did not use the configured name',
  );
  assert.ok(
    !server.displayNames().includes('Remembered'),
    'hosting seated the remembered name',
  );
});

test('the display-name command reports a remembered name and prefills it', async (t) => {
  // Nothing set, but a name remembered: the report reads what a host or join would be
  // seated with, and the change box starts from it rather than from the OS user.
  const bundle = freshBundle();
  bundle.stub.reset();
  await bundle.stub.globalState.update('selvage.lastDisplayName', 'Remembered');
  bundle.activate({ subscriptions: [], globalState: bundle.stub.globalState });
  t.after(() => {
    bundle.deactivate();
  });

  await bundle.stub.commands.executeCommand('selvage.displayName');
  const reported = await waitFor('the report', () =>
    bundle.stub.registered.information.find((message) =>
      message.includes('the name others see'),
    ) ?? false,
  );
  assert.equal(reported, 'Selvage: the name others see is "Remembered".');

  bundle.stub.registered.informationReply = 'Change the name';
  bundle.stub.registered.inputReply = 'Remembered';
  await bundle.stub.commands.executeCommand('selvage.displayName');
  const asked = await waitFor('the change box', () =>
    bundle.stub.registered.inputs[0] ?? false,
  );
  assert.equal(asked.value, 'Remembered', 'the box started from the OS user, not the name');
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
  assert.equal(
    validate('https://page.example/?room=r&token=t'),
    undefined,
    'a whole page link was refused',
  );
  assert.equal(
    validate('wss://host:8080/session?room=r&token=t'),
    undefined,
    'a secure invite link was refused',
  );
  // A link written before the format changed carries `server`. The format defines `room` and
  // `token` alone, so the parameter is unknown and ignored: the link is valid, and the server
  // a guest reaches is the one its origin names.
  assert.equal(
    validate('https://page.example/?room=r&token=t&server=ws%3A%2F%2Fother%3A8080'),
    undefined,
    'a link whose unknown parameter names another server was refused',
  );
  // A truncated paste, a server address, a page link missing half of itself, a wire invite
  // the engine would not dial as pasted, and nothing at all: all fail here, in plain words,
  // rather than later as whatever the engine said.
  for (const bad of [
    'ws://127.0.0.1:8080/session?room=r',
    'ws://127.0.0.1:8080/not-a-session',
    'ws://127.0.0.1:8080',
    'not-a-url/session?room=r&token=t',
    'https://host/?room=r',
    'https://host/',
    'ws:///session?room=r&token=t',
    'ws://127.0.0.1:8080//session?room=r&token=t',
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

test('a wire invite is refused when the engine would not dial it as pasted', async (t) => {
  const { bundle } = activated(t);

  await bundle.stub.commands.executeCommand('selvage.join');
  const asked = await waitFor('the join question', () =>
    bundle.stub.registered.inputs[0] ?? false,
  );
  const validate = asked.validateInput as (value: string) => string | undefined;

  // `ws:///session?…` reads as host `session` with path `/`: the URL parser swallows the
  // authority into the path, `parseSessionUrl` hands the engine `ws://` as the base, and
  // the wire URL the engine rebuilds from it — `ws:/session?…` — is not the endpoint the
  // paste named. A base the engine would rewrite is refused here, before the name
  // question and the reload, rather than dialled and lost.
  for (const rewritten of [
    'ws:///session?room=r&token=t',
    'ws://127.0.0.1:8080//session?room=r&token=t',
  ]) {
    assert.match(
      String(validate(rewritten)),
      /does not look like a Selvage invite link/,
      `the engine would not dial ${rewritten} as pasted`,
    );
  }
  // A base the engine dials as pasted is an invite whatever it resolves to: a host that
  // is not there fails at the dial, in the sentence that says to check the server, the
  // way `ws://127.0.0.1:1/session?…` does in the join below. Refusing it would refuse
  // every hostname that carries no port — `ws://lumi-raspberrypi/session?…` behind a
  // reverse proxy is a room the page default does not name.
  assert.equal(
    validate('ws://name/session?room=r&token=t'),
    undefined,
    'a well-formed invite to a host that is not there was refused as a bad paste',
  );
  // The spelling a special scheme does not need: `ws:host/session?…` is `ws://host/session?…`
  // to the URL parser and to the engine's one reading of a base, so it is the invitation the
  // engine dials and the box admits it. It is also the shape that shipped un-normalised — the
  // producer kept the spelling, `metaUrl` matched a prefix that was not there, and the `/meta`
  // read became a cleartext `http://host/meta` GET — so admitting it here is what pins the
  // engine as the component that reads it, not the box.
  for (const withoutSlashes of [
    'ws:127.0.0.1:8080/session?room=r&token=t',
    'wss:name/session?room=r&token=t',
  ]) {
    assert.equal(
      validate(withoutSlashes),
      undefined,
      `${withoutSlashes} names the endpoint the engine dials`,
    );
  }
});

/**
 * A window with nothing remembered and nothing configured, so the name question is the
 * next thing any join would reach: a refusal has to come before it.
 */
function freshWindow(t: TestContext): LoadedExtension {
  const bundle = freshBundle();
  bundle.stub.reset();
  bundle.activate({ subscriptions: [], globalState: bundle.stub.globalState });
  t.after(() => {
    bundle.deactivate();
  });
  return bundle;
}

/** Every user-visible surface a command left behind, for a scan that must find no token. */
function surfaces(bundle: LoadedExtension): string[] {
  return [
    ...bundle.stub.registered.errors,
    ...bundle.stub.registered.warnings,
    ...bundle.stub.registered.information,
  ];
}

test('an invite that arrives by argument is refused before the name question', async (t) => {
  const token = 'tok-by-argument';
  // Each one is a link no socket can open: `ws://` shapes `parseSessionUrl` alone would
  // pass, two of them bases the engine would rewrite before it dialled, and two page
  // links with half the query missing. An invite that arrives by argument used to skip
  // the box's own check entirely, so it was not refused until after the name was asked
  // and the window had reloaded onto the mirror.
  const unusable = [
    'wss://host:8080/session?room=r',
    `not-a-url/session?room=r&token=${token}`,
    `https://page.example/?room=r`,
    `https://page.example/?room=r&token=`,
    `ws:///session?room=r&token=${token}`,
    `ws://127.0.0.1:8080//session?room=r&token=${token}`,
  ];
  for (const [index, invite] of unusable.entries()) {
    const bundle = freshWindow(t);
    await bundle.stub.commands.executeCommand('selvage.join', { invite });
    const said = await waitFor(`the refusal of invite ${index}`, () =>
      bundle.stub.registered.errors[0] ?? false,
    );
    assert.match(
      String(said),
      /does not look like a Selvage invite link/,
      `invite ${index} was refused in the engine's words`,
    );
    assert.equal(bundle.stub.registered.errors.length, 1, 'the refusal was said more than once');
    assert.ok(
      !surfaces(bundle).some((surface) => surface.includes(token)),
      `the refusal echoed the token: ${said}`,
    );
    assert.equal(
      bundle.stub.registered.inputs.length,
      0,
      `the name was asked for unusable invite ${index}`,
    );
    assert.equal(
      bundle.stub.registered.executed.some((call) => call.id === 'vscode.openFolder'),
      false,
      `the window reloaded for unusable invite ${index}`,
    );
  }
});

test('a link the box lets through is refused before the name question, and before the reload', async (t) => {
  const bundle = freshBundle();
  bundle.stub.reset();
  const token = 'tok-from-the-box';
  const storage = testStoragePath(t);
  bundle.activate({
    subscriptions: [],
    globalState: bundle.stub.globalState,
    globalStorageUri: bundle.stub.Uri.file(storage),
  });
  t.after(() => {
    bundle.deactivate();
  });
  // The box refuses this while it is typed; this stages the value reaching the command
  // anyway — what a validation that let one through, or another caller than the box,
  // would do. The same check refuses it, and the answer to the name question is never
  // read.
  bundle.stub.registered.inputReply = `https://page.example/?room=r&token=`;
  await bundle.stub.commands.executeCommand('selvage.join');
  const said = await waitFor('the refusal', () => bundle.stub.registered.errors[0] ?? false);
  assert.match(String(said), /does not look like a Selvage invite link/);
  assert.ok(!surfaces(bundle).some((surface) => surface.includes(token)), `the refusal echoed the token: ${said}`);
  assert.deepEqual(
    bundle.stub.registered.inputs.map((input) => input['title']),
    ['Join a Selvage session'],
    'the name was asked for a link that cannot join',
  );
  assert.equal(
    bundle.stub.registered.executed.some((call) => call.id === 'vscode.openFolder'),
    false,
    'the window reloaded onto a mirror for a link that cannot join',
  );
  assert.equal(
    existsSync(join(storage, 'rooms', 'r')),
    false,
    'a mirror was minted for a link that cannot join',
  );
});

test('a join to a dead server says what to check, not just the engine error', async (t) => {
  const { bundle, storage } = activated(t);

  await bundle.stub.commands.executeCommand('selvage.join', {
    invite: 'ws://127.0.0.1:1/session?room=r&token=t',
    displayName: 'Bob',
  });
  // The reload is staged first — detached, so the read below waits for it rather than
  // for a number of turns; the failure lands after it, when the room is dialled.
  await waitFor('the reload onto the mirror', () =>
    bundle.stub.registered.executed.some((call) => call.id === 'vscode.openFolder') ? true : false,
  );
  const root = mirrorWindowDir(storage, 'r');
  bundle.stub.reset();
  bundle.stub.setWorkspaceFolders([root]);
  bundle.activate({
    subscriptions: [],
    globalState: bundle.stub.globalState,
    globalStorageUri: bundle.stub.Uri.file(storage),
  });
  const said = await waitFor('the failure', () =>
    bundle.stub.registered.errors.find((message) => message.includes('could not join')) ?? false,
  );
  assert.equal(
    said,
    'Selvage: could not join the session. No server answered — check the invite is complete, and that the server is running at the address it names.',
  );
  assert.doesNotMatch(said, /WebSocket|socket|ECONNREFUSED|room r/, 'the cause is a socket, or the room');
  assert.equal(
    bundle.stub.registered.information.some((message) => message.includes('joined the room')),
    false,
    'a session started without its room',
  );
  assert.equal(
    bundle.stub.registered.folderCalls.some((call) => call.deleteCount === 1),
    true,
    'the failed join kept its room-shaped folder',
  );
});

test('a host to a dead server says what to check, not just the engine error', async (t) => {
  const { bundle } = activated(t);
  bundle.stub.registered.inputReply = 'Ada';

  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: 'ws://127.0.0.1:1',
  });
  const said = await waitFor('the failure', () =>
    bundle.stub.registered.errors.find((message) => message.includes('could not host')) ?? false,
  );
  assert.equal(
    said,
    'Selvage: could not host on ws://127.0.0.1:1. No server answered — check the address is the one the server printed, and that the server is running.',
  );
  assert.doesNotMatch(said, /WebSocket|socket|ECONNREFUSED/, 'the address was checked, the socket was not');
});

test('joining names the rest of the room the landing does not open', async (t) => {
  const { bundle } = await guest(t, ['workspace/README.md', 'workspace/src/main.rs']);
  const joined = await waitFor('the join sentence', () =>
    bundle.stub.registered.information.find((message) => message.includes('joined the room')) ?? false,
  );
  assert.equal(
    joined,
    `Selvage: joined the room — opening workspace/README.md; 1 more in the room.`,
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
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  const { bundle } = activated(t);
  bundle.stub.configure({ wireVersion: 'selvage/1' });
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
    'Selvage: your files are already on your disk, so there is nothing to fetch while you host.',
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
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  await landStashedJoin(bundle, storage, roomId, 'Bob', { openOnJoin: false });
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
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  await landStashedJoin(bundle, storage, roomId, 'Bob', { openOnJoin: false });
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
    fetchNotices(bundle).length,
    0,
    'the refused fetch-all held anything',
  );
});

test('fetch holds one listed path and says what it fetched', async (t) => {
  const { host, invite, roomId } = await room(t, []);
  await host.grant(['notes/a.md']);
  const { bundle, storage } = activated(t);
  // No landing: the fetch's own hold is what must pull the content, not the join's.
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  await landStashedJoin(bundle, storage, roomId, 'Bob', { openOnJoin: false });
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
  // The hold is what the fetch checks, not the arrival order behind it: opening
  // the path holds it, and the room's text arriving through that hold proves it
  // before the fetch runs. Fetching straight after the listing would race the
  // join sync still in flight — a hold taken there is correct, not silent — so
  // the test never fetches on timing.
  const { host, invite, roomId } = await room(t, []);
  await host.grant(['notes/a.md']);
  await host.open('notes/a.md');
  host.insert('notes/a.md', 0, 'already here\n');
  const { bundle, storage } = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  await landStashedJoin(bundle, storage, roomId, 'Bob', { openOnJoin: false });
  await waitForMirrorFiles(storage, roomId, ['notes/a.md']);
  const holder = { text: '' };
  bundle.stub.registered.applyEditImpl = async (edit: unknown) => {
    for (const change of (edit as { edits: Array<{ text: string }> }).edits) {
      holder.text += change.text;
    }
    return true;
  };
  // Opening holds the path; the room's text arriving through that hold proves it
  // before the fetch runs. The open is reported the way the editor reports one,
  // so both orders converge: text already here renders at open, text still on
  // the wire renders when its sync arrives.
  await bundle.stub.commands.executeCommand('selvage.openDocument', { path: 'notes/a.md' });
  const uri = mirrorFileUri(storage, roomId, 'notes/a.md');
  await waitFor('the held path to open', () =>
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
  await waitFor(
    'the opened path to hold the room text',
    () => (holder.text === 'already here\n' ? true : false),
    {
      describe: () => ({
        buffer: holder.text,
        mirror: mirrorDiskText(storage, roomId, 'notes/a.md'),
        room: roomOffer(bundle),
        errors: bundle.stub.registered.errors,
      }),
    },
  );
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
  assert.equal(fetchNotices(bundle).length, 0, 'a fetch that asked for nothing waited');
});

test('fetch of a directory holds every listed path under it', async (t) => {
  const { host, invite, roomId } = await room(t, []);
  await host.grant(['notes/a.md', 'notes/b.md', 'other.md']);
  const { bundle, storage } = activated(t);
  // No landing: the fetch's own holds are what must pull the content, not the join's.
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  await landStashedJoin(bundle, storage, roomId, 'Bob', { openOnJoin: false });
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
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  await landStashedJoin(bundle, storage, roomId, 'Bob');
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
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  await landStashedJoin(bundle, storage, roomId, 'Bob');
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
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  await landStashedJoin(bundle, storage, roomId, 'Bob', { openOnJoin: false });
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
      (entry) => (entry.options as { title?: string }).title === 'Download a file from the room',
    ) ?? false,
  );
  assert.deepEqual(asked.items, [
    { label: 'Fetch the whole listing', description: '1 file' },
    'picked.md',
  ]);
  const done = await waitFor('the fetched report', () =>
    bundle.stub.registered.information.find((message) => message.includes('fetched the files')) ??
    false,
  );
  assert.equal(done, 'Selvage: fetched the files.');
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

  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  // The reload is the whole join: `openFolder` on the fresh mirror, and nothing else — no
  // folder call, no session, no joined message.
  const reloaded = await waitFor('the reload onto the mirror', () =>
    bundle.stub.registered.executed.find((call) => call.id === 'vscode.openFolder') ?? false,
  );
  assert.equal(bundle.stub.registered.folderCalls.length, 0, 'a folder was added to nothing');
  assert.equal(
    bundle.stub.registered.information.some((message) => message.includes('joined the room')),
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

test('a join reloads the window onto the mirror, never a second root beside it', async (t) => {
  const { invite } = await room(t, []);
  const roomId = roomOf(invite);
  const { bundle, storage } = activated(t);
  // The stub window holds the person's own folder: the owner's shape, not the empty one.
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  // The reload is staged first — exactly one, with no folder added beside anything —
  // and the reactivation lands the session the reload carried across.
  const root = await landStashedJoin(bundle, storage, roomId, 'Bob');
  const marker = JSON.parse(readFileSync(join(root, '.selvage-mirror.json'), 'utf8')) as {
    invite?: string;
  };
  assert.equal(marker.invite, undefined, 'the landed join kept its invite');
});

test('host, leave, join: the first join lands', async (t) => {
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  const { bundle, storage } = activated(t);
  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  await waitFor('the host to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('is open')) ? true : false,
  );
  await bundle.stub.commands.executeCommand('selvage.leave');
  const left = await waitFor('the leave to be said', () =>
    bundle.stub.registered.information.find((message) => message.includes('left the session')) ?? false,
  );
  assert.equal(left, 'Selvage: left the session.');
  // A second room on the same server: the invite names what the first join must land in.
  const host = await LiveSession.host(server.wsBase, 'Zed', OPTIONS);
  t.after(async () => {
    await host.disconnect();
  });
  const invite = host.inviteUrl();
  assert.ok(invite !== undefined, 'the second room minted no invite');
  const roomId = roomOf(invite);
  bundle.stub.reset();
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  await landStashedJoin(bundle, storage, roomId, 'Bob');
});

test('the stashed name joins without a second question', async (t) => {
  const { invite } = await room(t, []);
  const roomId = roomOf(invite);
  const { bundle, storage } = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  await waitFor('the reload onto the mirror', () =>
    bundle.stub.registered.executed.some((call) => call.id === 'vscode.openFolder') ? true : false,
  );
  const root = mirrorWindowDir(storage, roomId);
  const reloads = bundle.stub.registered.executed.filter((call) => call.id === 'vscode.openFolder');
  assert.equal(reloads.length, 1, 'the join staged no reload to carry the name across');
  // The reload's window: no setting, no answer — the stashed name is the whole join.
  bundle.stub.reset();
  bundle.stub.setWorkspaceFolders([root]);
  bundle.activate({
    subscriptions: [],
    globalState: bundle.stub.globalState,
    globalStorageUri: bundle.stub.Uri.file(storage),
  });
  await waitFor('the stashed join to land', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined the room')) ? true : false,
  );
  assert.equal(bundle.stub.registered.inputs.length, 0, 'the landing asked for the name again');
  const marker = JSON.parse(readFileSync(join(root, '.selvage-mirror.json'), 'utf8')) as {
    invite?: string;
  };
  assert.equal(marker.invite, undefined, 'the landed join kept its invite');
});

test('a reloaded window holding more than the mirror reloads again, never beside it', async (t) => {
  const { invite } = await room(t, []);
  const roomId = roomOf(invite);
  const { bundle, storage } = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  await waitFor('the reload onto the mirror', () =>
    bundle.stub.registered.executed.some((call) => call.id === 'vscode.openFolder') ? true : false,
  );
  const root = mirrorWindowDir(storage, roomId);
  // The reload landed somewhere else: the room's folder plus the person's own.
  bundle.stub.reset();
  bundle.stub.setWorkspaceFolders([root, '/elsewhere']);
  bundle.stub.configure({ displayName: 'Bob' });
  bundle.activate({
    subscriptions: [],
    globalState: bundle.stub.globalState,
    globalStorageUri: bundle.stub.Uri.file(storage),
  });
  await waitFor('the second reload', () =>
    bundle.stub.registered.executed.some((call) => call.id === 'vscode.openFolder') ? true : false,
  );
  const reloads = bundle.stub.registered.executed.filter((call) => call.id === 'vscode.openFolder');
  assert.equal(reloads.length, 1, 'the resume staged no second reload');
  assert.equal(
    bundle.stub.registered.folderCalls.length,
    0,
    'the resume added the mirror beside the window',
  );
  assert.equal(
    bundle.stub.registered.information.some((message) => message.includes('joined the room')),
    false,
    'a session started in half a window',
  );
  const marker = JSON.parse(readFileSync(join(root, '.selvage-mirror.json'), 'utf8')) as {
    invite?: string;
  };
  assert.equal(marker.invite, invite, 'the retry dropped the stashed invite');
});

test('a reload onto the mirror finishes the stashed join', async (t) => {
  const { invite } = await room(t, []);
  const roomId = roomOf(invite);
  const first = activated(t);
  first.bundle.stub.setWorkspaceFolders([]);
  await first.bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
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
      message.includes(`joined the room`),
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

test('the landed join adopts the mirror into the reloaded window', async (t) => {
  // The marker still names the minting process, which the reload tore down: landing
  // rewrites it with the live pid, so a second window reading a dead pid cannot take
  // a live room for a stale cache. The invite leaves with the landing as usual.
  const { invite } = await room(t, []);
  const roomId = roomOf(invite);
  const storage = testStoragePath(t);
  const root = join(storage, 'rooms', roomId, 'w-adopted');
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, '.selvage-mirror.json'),
    `${JSON.stringify({ room: roomId, window: 'w-adopted', pid: 2147483647, created: new Date(0).toISOString(), invite, displayName: 'Bob' })}\n`,
  );
  const bundle = loadBundle();
  bundle.stub.reset();
  bundle.stub.setWorkspaceFolders([root]);
  bundle.activate({
    subscriptions: [],
    globalState: bundle.stub.globalState,
    globalStorageUri: bundle.stub.Uri.file(storage),
  });
  t.after(() => {
    bundle.deactivate();
  });
  const joined = await waitFor('the stashed join to land', () =>
    bundle.stub.registered.information.find((message) => message.includes('joined the room')) ?? false,
  );
  assert.match(joined, /the room has no open documents yet/);
  const marker = JSON.parse(readFileSync(join(root, '.selvage-mirror.json'), 'utf8')) as {
    invite?: string;
    displayName?: string;
    pid?: number;
  };
  assert.equal(marker.invite, undefined, 'the landed join kept its invite');
  assert.equal(marker.displayName, undefined, 'the landed join kept its name');
  assert.equal(marker.pid, process.pid, 'the landed join kept the dead minting pid');
});

test('a join whose reload the editor refuses reports joining again', async (t) => {
  const { invite } = await room(t, []);
  const roomId = roomOf(invite);
  const { bundle, storage } = activated(t);
  bundle.stub.registered.openFolderThrows = 'the editor refused the reload';

  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  const refusal = await waitFor('the refused reload to be reported', () =>
    bundle.stub.registered.errors.find((message) => message.includes("room's folder")) ?? false,
  );
  assert.equal(
    refusal,
    `Selvage: could not open the room's folder in this window (the editor refused the reload); join again.`,
  );
  // The reload was staged and refused — and a failed join leaves no session and no
  // mirror directory behind.
  assert.equal(
    bundle.stub.registered.executed.filter((call) => call.id === 'vscode.openFolder').length,
    1,
    'the reload was never staged',
  );
  assert.equal(
    bundle.stub.registered.information.some((message) => message.includes('joined the room')),
    false,
    'a session started without its window',
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

  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  const refusal = await waitFor('the missing storage to be reported', () =>
    bundle.stub.registered.errors.find((message) => message.includes('no storage')) ?? false,
  );
  assert.equal(
    refusal,
    `Selvage: could not join the session: the editor gave this window no storage for the room's files.`,
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
    bundle.stub.registered.warnings.find((message) => message.includes('cleaned up the files')) ?? false,
  );
  assert.equal(
    said,
    `Selvage: cleaned up the files left by the last session.`,
  );
  assert.equal(existsSync(staleRoot), false, 'the stale mirror survived activation');
  assert.equal(isFile(join(liveRoot, '.selvage-mirror.json')), true, 'a live sibling was cleared');
  assert.equal(
    bundle.stub.registered.warnings.filter((message) => message.includes('cleaned up the files')).length,
    1,
    'the live sibling earned its own sentence',
  );
});

test("activation leaves a live room's mirror alone, even in this window", async (t) => {
  // A second window onto a live room's mirror — or a person opening the mirror by
  // hand — must not take the room out from under the live owner: no warning, no
  // removal, no folder call. A dead sibling proves the triage pass ran, so the
  // live one's survival is observed, not hoped for.
  const storage = testStoragePath(t);
  const liveRoot = join(storage, 'rooms', 'r-live', 'w-live');
  const deadRoot = join(storage, 'rooms', 'r-live', 'w-dead');
  mkdirSync(liveRoot, { recursive: true });
  mkdirSync(deadRoot, { recursive: true });
  const marker = (window: string, pid: number): string =>
    `${JSON.stringify({ room: 'r-live', window, pid, created: new Date(0).toISOString() })}\n`;
  writeFileSync(join(liveRoot, '.selvage-mirror.json'), marker('w-live', process.pid));
  writeFileSync(join(deadRoot, '.selvage-mirror.json'), marker('w-dead', 2147483647));
  const bundle = loadBundle();
  bundle.stub.reset();
  bundle.stub.setWorkspaceFolders([liveRoot]);
  bundle.activate({
    subscriptions: [],
    globalState: bundle.stub.globalState,
    globalStorageUri: bundle.stub.Uri.file(storage),
  });
  t.after(() => {
    bundle.deactivate();
  });
  await waitFor('the dead sibling to be reported', () =>
    bundle.stub.registered.warnings.find((message) => message.includes('cleaned up the files')) ?? false,
  );
  assert.equal(existsSync(liveRoot), true, "a live room's mirror was cleared");
  assert.equal(bundle.stub.registered.folderCalls.length, 0, "a live room's folder was taken");
  assert.equal(
    bundle.stub.registered.warnings.filter((message) => message.includes('cleaned up the files')).length,
    1,
    'the live room earned its own sentence',
  );
});

test('activation drops a mirror whose stashed invite cannot join, before asking for a name', async (t) => {
  const storage = testStoragePath(t);
  const root = join(storage, 'rooms', 'r-stale', 'w-stale');
  mkdirSync(root, { recursive: true });
  const token = 'tok-in-the-marker';
  // A marker an older build could have left: its stashed invite is the paste, not the
  // wire URL the engine dials, and nothing remembers a name, so the question is what the
  // resumed join would reach next. The invite has to be refused before it.
  writeFileSync(
    join(root, '.selvage-mirror.json'),
    `${JSON.stringify({
      room: 'r-stale',
      window: 'w-stale',
      pid: 2147483647,
      created: new Date(0).toISOString(),
      invite: `not-a-url/session?room=r-stale&token=${token}`,
    })}\n`,
  );

  const bundle = loadBundle();
  bundle.stub.reset();
  bundle.stub.setWorkspaceFolders([root]);
  bundle.activate({
    subscriptions: [],
    globalState: bundle.stub.globalState,
    globalStorageUri: bundle.stub.Uri.file(storage),
  });
  t.after(() => {
    bundle.deactivate();
  });

  const said = await waitFor('the unusable stashed invite to be reported', () =>
    bundle.stub.registered.warnings.find((message) => message.includes('cleaned up the files')) ?? false,
  );
  assert.equal(
    said,
    `Selvage: cleaned up the files left by the last session; its invite link no longer works.`,
  );
  assert.equal(
    bundle.stub.registered.inputs.length,
    0,
    'the name was asked for a link that cannot join',
  );
  assert.equal(
    bundle.stub.registered.errors.length,
    0,
    'the engine was reached with the unusable invite',
  );
  assert.ok(
    !surfaces(bundle).some((surface) => surface.includes(token)),
    `the token reached a user-visible surface: ${surfaces(bundle).join(' | ')}`,
  );
  assert.equal(
    bundle.stub.registered.executed.some((call) => call.id === 'vscode.openFolder'),
    false,
    'the window was reloaded for a link that cannot join',
  );
  assert.equal(existsSync(root), false, 'the refused mirror survived activation');
});

test('activation does not dial a stashed invite it refuses', async (t) => {
  const { server, invite } = await room(t, []);
  // A hand-edited marker naming a room that is really there: the invite carries the room
  // and its token, and only the base has a stray slash the engine would rewrite before
  // dialling. Refused, the room is never opened — a link in a mirror's own marker is not
  // a reason to reach somebody else's room.
  const storage = testStoragePath(t);
  const root = join(storage, 'rooms', 'r-stale', 'w-stale');
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, '.selvage-mirror.json'),
    `${JSON.stringify({
      room: 'r-stale',
      window: 'w-stale',
      pid: 2147483647,
      created: new Date(0).toISOString(),
      invite: invite.replace('/session?', '//session?'),
      displayName: 'Ada',
    })}\n`,
  );
  const before = server.acceptedConnections;

  const bundle = loadBundle();
  bundle.stub.reset();
  bundle.stub.setWorkspaceFolders([root]);
  bundle.activate({
    subscriptions: [],
    globalState: bundle.stub.globalState,
    globalStorageUri: bundle.stub.Uri.file(storage),
  });
  t.after(() => {
    bundle.deactivate();
  });

  await waitFor('the refused mirror to be reported', () =>
    bundle.stub.registered.warnings.find((message) => message.includes('cleaned up the files')) ?? false,
  );
  assert.equal(server.acceptedConnections, before, 'a refused invite was dialled anyway');
  assert.equal(
    bundle.stub.registered.information.some((message) => message.includes('joined the room')),
    false,
    'a session was seated from a refused invite',
  );
  assert.equal(existsSync(root), false, 'the refused mirror survived activation');
});

test('leaving closes the room tabs, the folder, and the directory', async (t) => {
  const { host, invite, roomId } = await room(t, []);
  await host.grant(['notes/a.md']);
  const { bundle, storage } = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  await landStashedJoin(bundle, storage, roomId, 'Bob');
  await waitForMirrorFiles(storage, roomId, ['notes/a.md']);
  const root = mirrorWindowDir(storage, roomId);
  // One tab in the room, one outside it: only the room's closes.
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
  // The room's folder is removed, and the directory goes with it.
  const removals = bundle.stub.registered.folderCalls.filter((call) => call.deleteCount === 1);
  assert.equal(removals.length, 1, 'the room folder stayed in the window');
  assert.equal(existsSync(root), false, 'the mirror survived the leave');
});

test('leaving a window that is only the room deletes before removing the folder', async (t) => {
  const { host, invite, roomId } = await room(t, []);
  await host.grant(['notes/a.md']);
  const { bundle, storage } = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  await landStashedJoin(bundle, storage, roomId, 'Bob');
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
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  await landStashedJoin(bundle, storage, roomId, 'Bob', { openOnJoin: false });
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
    bundle.stub.registered.warnings.find((message) => message.includes('is not part of the room')) ??
    false,
  );
  assert.equal(
    said,
    'Selvage: notes/scratch.md is not part of the room, so it is not shared. Save it outside the room\'s folder to keep it.',
  );
  assert.equal(
    bundle.stub.registered.warnings.filter((message) => message.includes('is not part of the room'))
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
    bundle.stub.registered.warnings.filter((message) => message.includes('is not part of the room'))
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
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  await landStashedJoin(bundle, storage, roomId, 'Bob', { openOnJoin: false });
  const holder = { text: '' };
  const document = mirrorDocument(bundle, storage, roomId, 'late.md', holder);
  bundle.stub.registered.textDocuments.push(document);
  bundle.stub.fire('openTextDocument', document);
  await waitFor('the unlisted open to be reported', () =>
    bundle.stub.registered.warnings.some((message) => message.includes('is not part of the room'))
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
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  await landStashedJoin(bundle, storage, roomId, 'Bob', { openOnJoin: false });
  await waitForMirrorFiles(storage, roomId, ['a.md']);

  // The editor writes the file — no provider refuses it anymore — and the client says
  // afterwards that the save is not shared. A listed save stays silent.
  const holder = { text: 'mine\n' };
  const document = mirrorDocument(bundle, storage, roomId, 'notes/scratch.md', holder);
  bundle.stub.fire('saveTextDocument', document);
  bundle.stub.fire('saveTextDocument', document);
  const said = await waitFor('the unlisted save to be reported', () =>
    bundle.stub.registered.warnings.find((message) => message.includes('this save was not shared')) ??
    false,
  );
  assert.equal(
    said,
    'Selvage: notes/scratch.md is not part of the room, so this save was not shared. Copy it outside the room\'s folder to keep it.',
  );
  assert.equal(
    bundle.stub.registered.warnings.filter((message) => message.includes('this save was not shared'))
      .length,
    1,
    'the sentence repeated for the same path',
  );
  bundle.stub.fire(
    'saveTextDocument',
    mirrorDocument(bundle, storage, roomId, 'a.md', { text: '' }),
  );
  assert.equal(
    bundle.stub.registered.warnings.filter((message) => message.includes('this save was not shared'))
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
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  await landStashedJoin(bundle, storage, roomId, 'Bob', { openOnJoin: false });
  const said = await waitFor('the refused listing to be reported', () =>
    bundle.stub.registered.warnings.find((message) => message.includes('could not be written to disk')) ??
    false,
  );
  assert.equal(
    said,
    `Selvage: 1 of the room's files could not be written to disk, starting with .selvage-mirror.json.`,
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
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  await landStashedJoin(bundle, storage, roomId, 'Bob', { openOnJoin: false });
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
    'Selvage: fetch all 2 listed files? Everyone in the room receives them, and they are stored on your disk.',
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
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  await landStashedJoin(bundle, storage, roomId, 'Bob', { openOnJoin: false });
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
  assert.equal(fetchNotices(bundle).length, 0, 'a dismissed fetch held a path');
  assert.equal(
    bundle.stub.registered.information.filter((message) => message.includes('fetched the files'))
      .length,
    0,
    'a dismissed fetch reported a fetch',
  );
  assert.equal(host.documents().length, 0, 'a dismissed fetch holds a path in the room');
});

/**
 * Stages a join and lands the reload it asks for, then stops: what a join looks like when the
 * room refuses it, and the shape a host with no fix on the far side reaches. The reload is the
 * join's own first half — `landStashedJoin` is the other half, and it expects a landing.
 */
async function joinOntoItsReload(
  bundle: LoadedExtension,
  storage: string,
  invite: string,
  roomId: string,
  displayName: string,
): Promise<void> {
  await bundle.stub.commands.executeCommand('selvage.join', {
    invite,
    displayName,
  });
  await waitFor('the reload onto the mirror', () =>
    bundle.stub.registered.executed.some((call) => call.id === 'vscode.openFolder') ? true : false,
  );
  const root = mirrorWindowDir(storage, roomId);
  bundle.stub.reset();
  bundle.stub.setWorkspaceFolders([root]);
  bundle.activate({
    subscriptions: [],
    globalState: bundle.stub.globalState,
    globalStorageUri: bundle.stub.Uri.file(storage),
  });
}

test('a host says it is connecting while the handshake happens', async (t) => {
  const { server } = await room(t, []);
  const { bundle } = activated(t);

  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  await waitFor('the host to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('the room is open'))
      ? true
      : false,
  );
  assert.ok(
    bundle.stub.registered.progress.some(
      (entry) => entry.title === `Selvage: connecting to ${server.wsBase}…`,
    ),
    'a host handshaked with nothing on screen to say it was happening',
  );
});

test('a join says it is connecting while the handshake happens', async (t) => {
  const { server, invite, roomId } = await room(t, ['workspace/README.md']);
  const { bundle, storage } = activated(t);
  await joinOntoItsReload(bundle, storage, invite, roomId, 'Bob');
  await waitFor('the join to land', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined the room'))
      ? true
      : false,
  );
  assert.ok(
    bundle.stub.registered.progress.some(
      (entry) => entry.title === `Selvage: connecting to ${server.wsBase}…`,
    ),
    'a join handshaked with nothing on screen to say it was happening',
  );
});

test('a join asks before it takes the window, and a decline costs nothing', async (t) => {
  const { server, invite } = await room(t, []);
  const { bundle, storage } = activated(t);
  const connections = server.acceptedConnections;
  // Half driven: the invite by argument, the name answered in the box. A caller that has
  // taken over only one of the command's own two prompts still gets asked about its window.
  bundle.stub.registered.inputReply = 'Bob';

  // No answer: the modal a person dismisses. The command is detached, so the question is
  // what the test waits on — the shape a person meets before they answer it.
  await bundle.stub.commands.executeCommand('selvage.join', { invite });
  const asked = await waitFor('the question about the window', () =>
    bundle.stub.registered.warnings.find((message) => message.includes('joining replaces')) ?? false,
  );
  assert.equal(
    asked,
    "Selvage: joining replaces this window's folder with the room's files. Your own folder stays on disk — reopen it whenever you like.",
  );
  assert.equal(
    bundle.stub.registered.executed.some((call) => call.id === 'vscode.openFolder'),
    false,
    'a declined join reloaded the window anyway',
  );
  assert.equal(server.acceptedConnections, connections, 'a declined join dialled the room');
  assert.equal(existsSync(join(storage, 'rooms')), false, 'a declined join minted a mirror');

  // The person's own answer: the same command now stages the reload it always did.
  bundle.stub.registered.warningReply = 'Join';
  await bundle.stub.commands.executeCommand('selvage.join', { invite });
  await waitFor('the reload onto the mirror', () =>
    bundle.stub.registered.executed.some((call) => call.id === 'vscode.openFolder') ? true : false,
  );
});

test('a host that changes its mind about the window keeps the room it was hosting', async (t) => {
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  const { bundle } = activated(t);
  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  await waitFor('the host to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('is open')) ? true : false,
  );
  const other = await room(t, []);
  bundle.stub.configure({ displayName: 'Bob' });
  // One answer for both questions: `Leave and join` is the button that ends the room, and it is
  // not the button that takes the window, so the second question is declined — the change of
  // mind a person has after the first.
  bundle.stub.registered.warningReply = 'Leave and join';

  await bundle.stub.commands.executeCommand('selvage.join', { invite: other.invite });
  const asked = await waitFor('the window question', () =>
    bundle.stub.registered.warnings.find((message) => message.includes('joining replaces')) ??
      false,
  );
  assert.match(asked, /joining replaces this window's folder/);
  assert.equal(
    bundle.stub.registered.executed.some((call) => call.id === 'vscode.openFolder'),
    false,
    'a declined window question reloaded the window anyway',
  );
  // Nothing was given up for a join that never happened: the room this window was hosting is
  // still open, for the guests in it as much as for its host.
  assert.equal(server.connectionCount, 1, 'the room ended on a question that was declined');
  bundle.stub.reset();
  await bundle.stub.commands.executeCommand('selvage.copyInvite');
  const copied = await waitFor('the invite of the room this window still hosts', () =>
    bundle.stub.registered.information.find((message) => message.includes('clipboard')) ?? false,
  );
  assert.equal(copied, 'Selvage: the invite link is on the clipboard.');
});

test('a join from a window with no folder reloads without asking about the window', async (t) => {
  const { invite } = await room(t, []);
  const { bundle } = activated(t);
  bundle.stub.setWorkspaceFolders([]);
  // Undriven: the invite is pasted into the box and the name comes from the setting, which
  // is the shape a person's first join takes. The answer to a question that must not be
  // asked is a warning waiting to be recorded if it is.
  bundle.stub.configure({ displayName: 'Bob' });
  bundle.stub.registered.inputReply = invite;
  bundle.stub.registered.warningReply = 'Join';

  await bundle.stub.commands.executeCommand('selvage.join');
  await waitFor('the reload onto the mirror', () =>
    bundle.stub.registered.executed.some((call) => call.id === 'vscode.openFolder') ? true : false,
  );
  assert.equal(
    bundle.stub.registered.warnings.some((message) => message.includes('joining replaces')),
    false,
    'a window with no folder was asked what the reload costs it',
  );
});

test("a window holding only the room's mirror is not asked about a folder of its own", async (t) => {
  const { invite } = await room(t, []);
  const roomId = roomOf(invite);
  const { bundle, storage } = activated(t);
  bundle.stub.setWorkspaceFolders([]);
  bundle.stub.configure({ displayName: 'Bob' });
  bundle.stub.registered.inputReply = invite;
  await bundle.stub.commands.executeCommand('selvage.join');
  await waitFor('the reload onto the mirror', () =>
    bundle.stub.registered.executed.some((call) => call.id === 'vscode.openFolder') ? true : false,
  );
  const root = mirrorWindowDir(storage, roomId);

  // The window the reload landed on holds the mirror — a cache the session made, not a folder
  // of the person's — and a second join replaces it. Nothing of the person's is open, so
  // there is nothing for `replaceWindowWarning`'s promise to be about.
  const second = await room(t, []);
  bundle.stub.reset();
  bundle.stub.setWorkspaceFolders([root]);
  bundle.stub.configure({ displayName: 'Bob' });
  bundle.stub.registered.inputReply = second.invite;
  bundle.stub.registered.warningReply = 'Join';
  await bundle.stub.commands.executeCommand('selvage.join');
  await waitFor('the reload onto the second room', () =>
    bundle.stub.registered.executed.some((call) => call.id === 'vscode.openFolder') ? true : false,
  );
  assert.equal(
    bundle.stub.registered.warnings.some((message) => message.includes('joining replaces')),
    false,
    'a window whose only folder is a room mirror was told its own folder stays on disk',
  );
});

test("the reload's own resume never asks about the window it already replaced", async (t) => {
  const { invite } = await room(t, []);
  const roomId = roomOf(invite);
  const { bundle, storage } = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the reload onto the mirror', () =>
    bundle.stub.registered.executed.some((call) => call.id === 'vscode.openFolder') ? true : false,
  );
  const root = mirrorWindowDir(storage, roomId);

  // The reload landed beside something else, so the resume runs again rather than joining half
  // a window. It is the reload the mint already asked about — asked here with a folder that is
  // not a mirror among the window's, so the only thing that can silence the question is the
  // resume's own suppression.
  bundle.stub.reset();
  bundle.stub.setWorkspaceFolders([root, '/elsewhere']);
  bundle.stub.configure({ displayName: 'Bob' });
  bundle.stub.registered.warningReply = 'Join';
  bundle.activate({
    subscriptions: [],
    globalState: bundle.stub.globalState,
    globalStorageUri: bundle.stub.Uri.file(storage),
  });
  await waitFor('the second reload', () =>
    bundle.stub.registered.executed.some((call) => call.id === 'vscode.openFolder') ? true : false,
  );
  assert.equal(
    bundle.stub.registered.warnings.some((message) => message.includes('joining replaces')),
    false,
    'the resume asked about a window the reload had already taken',
  );
});

test('a join refused because the room already has a host says so, without the code', async (t) => {
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  server.helloRefusal = { code: 'host_present', message: 'the room already has a host' };
  const { bundle, storage } = activated(t);
  await joinOntoItsReload(bundle, storage, `${sessionUrl(server.wsBase, 'r', 't')}${KEYS}`, 'r', 'Bob');

  const said = await waitFor('the refusal', () =>
    bundle.stub.registered.errors.find((message) => message.includes('could not join')) ?? false,
  );
  assert.equal(said, 'Selvage: could not join the session. That room already has a host.');
  assert.doesNotMatch(said, /host_present/, 'the wire code is on screen');
});

test('a join refused for a room that is gone says it once', async (t) => {
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  // The reference server's own words for this code are the sentence itself, so the client's
  // parenthetical used to read `That room is gone (the room is gone).`
  server.helloRefusal = { code: 'room_gone', message: 'the room is gone' };
  const { bundle, storage } = activated(t);
  await joinOntoItsReload(bundle, storage, `${sessionUrl(server.wsBase, 'r', 't')}${KEYS}`, 'r', 'Bob');

  const said = await waitFor('the refusal', () =>
    bundle.stub.registered.errors.find((message) => message.includes('could not join')) ?? false,
  );
  assert.equal(said, 'Selvage: could not join the session. That room is gone.');
  assert.doesNotMatch(said, /room_gone|the room is gone/, 'the wire code or the server’s own text');
});

test('a refused join says what happened, without the room id or a wire word', async (t) => {
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  // The reference server's own refusals, verbatim (`crates/selvaged/src/net/session.rs`): an
  // unknown room names the id in its message, and a bad token says "room token".
  server.helloRefusal = { code: 'room_unknown', message: 'no such room: 5f0fd9c1b2' };
  const { bundle, storage } = activated(t);
  await joinOntoItsReload(bundle, storage, `${sessionUrl(server.wsBase, '5f0fd9c1b2', 't')}${KEYS}`, '5f0fd9c1b2', 'Bob');

  const said = await waitFor('the refusal', () =>
    bundle.stub.registered.errors.find((message) => message.includes('could not join')) ?? false,
  );
  assert.equal(
    said,
    'Selvage: could not join the session. That invite names a room the server does not have. Ask the host for a fresh invite.',
  );
  assert.doesNotMatch(said, /5f0fd9c1b2|room_unknown|no such room/, 'the sentence is the server’s');
});

test('a join refused for its token says the invite is out of date, not "room token"', async (t) => {
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  server.helloRefusal = { code: 'token_invalid', message: 'invalid room token' };
  const { bundle, storage } = activated(t);
  await joinOntoItsReload(bundle, storage, `${sessionUrl(server.wsBase, 'r', 'stale')}${KEYS}`, 'r', 'Bob');

  const said = await waitFor('the refusal', () =>
    bundle.stub.registered.errors.find((message) => message.includes('could not join')) ?? false,
  );
  assert.equal(
    said,
    'Selvage: could not join the session. That invite is no longer valid. Ask the host for a fresh invite.',
  );
  assert.doesNotMatch(said, /token|invalid/, 'a wire word is in the sentence');
});

test('a full room is a sentence, never the wire code that refused it', async (t) => {
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  // A room at its cap, refused with the code this server invents for it (`x.room_full`).
  server.helloRefusal = { code: 'x.room_full', message: 'the room seats no more peers' };
  const { bundle, storage } = activated(t);
  await joinOntoItsReload(bundle, storage, `${sessionUrl(server.wsBase, 'r', 't')}${KEYS}`, 'r', 'Bob');

  const said = await waitFor('the refusal', () =>
    bundle.stub.registered.errors.find((message) => message.includes('could not join')) ?? false,
  );
  assert.equal(said, 'Selvage: could not join the session. The room is full — it seats no more people.');
  assert.doesNotMatch(said, /x\.room_full|room_full/, 'the code the server refused with is on screen');
});

test('a reconnect refused as full says the room is full rather than a wire code', async (t) => {
  const { bundle, server } = await guest(t, ['workspace/README.md']);
  const seated = bundle.stub.registered.information.some((message) =>
    message.includes('joined the room'),
  );
  assert.ok(seated, 'the guest never landed, so there is no session to reconnect');

  // The cap fills after the guest is in: the re-hello is what hears about it, and the room's
  // own report is the one surface left for the sentence.
  server.helloRefusal = { code: 'x.room_full', message: 'the room seats no more peers' };
  bundle.stub.reset();
  server.drop('Bob');

  const said = await waitFor(
    'the refusal to reach the window',
    () => bundle.stub.registered.errors.find((message) => message.includes('full')) ?? false,
    { timeoutMs: 15000 },
  );
  assert.equal(said, 'Selvage: the room is full — it seats no more people.');
  assert.doesNotMatch(said, /x\.room_full|seats no more peers/, 'the wire code or the server’s text');
});

test('the join notice offers the room’s other documents as a button', async (t) => {
  const { host, invite, roomId } = await room(t, ['workspace/README.md']);
  await host.open('workspace/notes.md');
  const { bundle, storage } = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', {
    invite,
    displayName: 'Bob',
  });
  await waitFor('the reload onto the mirror', () =>
    bundle.stub.registered.executed.some((call) => call.id === 'vscode.openFolder') ? true : false,
  );
  const root = mirrorWindowDir(storage, roomId);
  bundle.stub.reset();
  bundle.stub.setWorkspaceFolders([root]);
  // The person takes the button the notice offers.
  bundle.stub.registered.informationReply = 'Open a document from the room';
  bundle.activate({
    subscriptions: [],
    globalState: bundle.stub.globalState,
    globalStorageUri: bundle.stub.Uri.file(storage),
  });

  const at = await waitFor('the landing notice', () => {
    const index = bundle.stub.registered.information.findIndex((message) =>
      message.includes('joined the room'),
    );
    return index === -1 ? false : index;
  });
  assert.equal(
    bundle.stub.registered.information[at],
    'Selvage: joined the room — opening workspace/README.md; 1 more in the room.',
  );
  assert.deepEqual(bundle.stub.registered.informationItems[at], [
    'Open a document from the room',
  ]);
  await waitFor(
    'the room’s list to open',
    () =>
      bundle.stub.registered.quickPicks.some(
        (entry) => (entry.options as { title?: string }).title === 'Open a document from the room',
      )
        ? true
        : false,
  );
});

test('the host notice can put the invite on the clipboard again', async (t) => {
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  const { bundle } = activated(t);
  bundle.stub.registered.informationReply = 'Copy again';

  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  const said = await waitFor('the host notice', () =>
    bundle.stub.registered.information.find((message) => message.includes('the room is open')) ??
    false,
  );
  assert.equal(
    said,
    'Selvage: the room is open. Send this link to your friend — it is on the clipboard.',
  );
  const at = bundle.stub.registered.information.indexOf(said);
  assert.deepEqual(bundle.stub.registered.informationItems[at], ['Copy again']);
  await waitFor('the second copy', () =>
    bundle.stub.registered.clipboardWrites.length >= 2 ? true : false,
  );
  assert.equal(
    bundle.stub.registered.clipboardWrites[0],
    bundle.stub.registered.clipboardWrites[1],
    'the button copied something other than the invite',
  );
});
