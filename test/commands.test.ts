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
import { SelvageEngine } from '../src/engine/index.ts';
import { peerColour, virtualUri } from '../src/bridge/index.ts';

const OPTIONS = { client: 'selvage-vscode-test/0.1.0', meta: 'skip' } as const;

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
  assert.ok(
    bundle.stub.registered.information.some((message) => message.includes('invite link copied')),
    'the user was not told the invite was copied',
  );
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

test('hosting while a guest asks before leaving, and leaves on request', async (t) => {
  const { bundle, server } = await guest(t, ['workspace/README.md']);
  const before = server.acceptedConnections;

  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada again',
  });
  const asked = await waitFor('the leave-and-host question', () =>
    bundle.stub.registered.warnings.find((message) => /guest in room/.test(message)) ?? false,
  );
  assert.match(asked, /guest in room/);
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
    bundle.stub.registered.warnings.find((message) => /hosting room/.test(message)) ?? false,
  );
  assert.match(asked, /hosting room/);
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
  assert.match(reported, /no display name is set/);
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
  assert.match(said, /the next session will use it/);
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

test('a name set during a session says the session keeps the one it started with', async (t) => {
  const { bundle } = await guest(t, ['workspace/README.md']);

  // The name in force is the room's own: it travelled in the handshake and nothing carries
  // it afterwards, so the report names the session, not the setting.
  await bundle.stub.commands.executeCommand('selvage.displayName');
  const reported = await waitFor('the report', () =>
    bundle.stub.registered.information.find((message) =>
      message.includes('the name others see'),
    ) ?? false,
  );
  assert.match(reported, /the name others see is "Bob"/);

  await bundle.stub.commands.executeCommand('selvage.displayName', { name: 'Ada again' });
  const said = await waitFor('the confirmation', () =>
    bundle.stub.registered.information.find((message) => message.includes('display name set')) ??
      false,
  );
  assert.match(said, /this session keeps the name it started with/);
  assert.equal(bundle.stub.registered.settingWrites[0]?.value, 'Ada again');
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
  assert.match(refusal, /33 UTF-16 code units/);
  assert.match(refusal, /limit is 32/);
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
  assert.match(refusal, /33 UTF-16 code units/);
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
    bundle.stub.registered.errors.find((message) =>
      message.includes('selvage.displayName'),
    ) ?? false,
  );
  assert.match(refusal, /33 UTF-16 code units/);

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
    bundle.stub.registered.warnings.find((message) => message.includes('host or join')) ?? false,
  );
  assert.match(outside, /host or join a session first/);

  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  await waitFor('the host to be seated', () => (server.acceptedConnections > 0 ? true : false));
  bundle.stub.reset();
  await bundle.stub.commands.executeCommand('selvage.peers');
  const alone = await waitFor('the warning', () =>
    bundle.stub.registered.warnings.find((message) =>
      message.includes('no other participants'),
    ) ?? false,
  );
  assert.match(alone, /no other participants to name/);
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
