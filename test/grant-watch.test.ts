/**
 * The room's listing follows the host's folder: a file created, deleted or renamed under a
 * granted folder while a session is live reaches the room, a folder that did not change reaches
 * it for nothing, and none of it outlives the session.
 *
 * The host is the built extension with the editor API stubbed — it is the side that watches —
 * and the guest is a second engine in the room, so what the room was told is read from the
 * frames the fake server recorded and not inferred from the host's own state. A filesystem
 * event is fired the way the editor's watcher fires one, and every wait is a bounded poll of
 * something actually held: a count made synchronously with the frame, or a listing and a tree
 * the guest really has.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { SelvageEngine, parseSessionUrl } from '../src/engine/index.ts';
import { virtualUri } from '../src/bridge/index.ts';
import { loadBundle } from './helpers/bundle.ts';
import type { LoadedExtension } from './helpers/bundle.ts';
import { FakeServer } from './helpers/fake-server.ts';
import { waitFor } from './helpers/wait.ts';

const OPTIONS = { client: 'selvage-vscode-test/0.1.0', meta: 'skip' } as const;

/**
 * The interval the adapter coalesces filesystem events over — `GRANT_REFRESH_INTERVAL_MS` in
 * `src/adapter/extension.ts`, spelled here as the presence tests spell theirs.
 */
const REFRESH_MS = 250;

/** The room an invite names, so a virtual document's URI can be built out of it. */
function roomOf(invite: string): string {
  const room = parseSessionUrl(invite)?.join.room;
  assert.ok(room !== undefined, `the invite names no room: ${invite}`);
  return room;
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

/** The invite a host bundle copied, read off the clipboard as a user's click would leave it. */
async function inviteOf(bundle: LoadedExtension): Promise<string> {
  return await waitFor('the invite link', () => {
    void bundle.stub.commands.executeCommand('selvage.copyInvite');
    const clipboard = bundle.stub.registered.clipboard;
    return clipboard.startsWith('ws://') ? clipboard : false;
  });
}

/** The room's listing as the guest holds it, for a poll that reports what it saw. */
function listing(guest: SelvageEngine): string[] {
  return guest.grantedPaths();
}

interface Hosted {
  /** The window hosting: the built extension, which is the side that watches the folder. */
  bundle: LoadedExtension;
  server: FakeServer;
  /** A second engine in the room: what the host published, as the room received it. */
  guest: SelvageEngine;
  invite: string;
}

/** A window hosting over a folder seeded with `contents`, and a guest seated in the room. */
async function hosted(t: TestContext, contents: Record<string, string>): Promise<Hosted> {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const bundle = activated(t);
  for (const [path, content] of Object.entries(contents)) {
    bundle.stub.put(path, content);
  }
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  const invite = await inviteOf(bundle);
  const guest = await SelvageEngine.join(invite, 'Bob', OPTIONS);
  t.after(async () => {
    await guest.disconnect();
  });
  return { bundle, server, guest, invite };
}

/** Waits until the guest's listing holds `path`, and answers with the listing it then held. */
async function roomLearns(guest: SelvageEngine, path: string): Promise<string[]> {
  return await waitFor(`the room to list ${path}`, () => {
    const paths = listing(guest);
    return paths.includes(path) ? paths : false;
  }, { describe: () => listing(guest) });
}

/**
 * Outlasts the window a republish had been armed in. Nothing else can show that a republish did
 * not happen, and what follows it is a count recorded synchronously with the frame rather than
 * a second guess about the clock.
 */
async function quiet(ms = REFRESH_MS * 2): Promise<void> {
  await delay(ms);
}

test('a file created under a granted folder while hosting reaches the room', async (t) => {
  const { bundle, server, guest } = await hosted(t, { 'README.md': 'the readme\n' });
  await roomLearns(guest, 'README.md');
  const published = server.grants.length;

  bundle.stub.put('src/main.rs', 'fn main() {}\n');
  bundle.stub.watchEvent('create', 'src/main.rs');

  const paths = await roomLearns(guest, 'src/main.rs');
  assert.deepEqual(
    paths,
    ['README.md', 'src/main.rs'],
    'the room kept the listing the folder had when the session started',
  );
  assert.equal(
    server.grants.length,
    published + 1,
    `the one change was published more than once: ${JSON.stringify(server.grants)}`,
  );
});

test('a file deleted under a granted folder leaves the room\u2019s listing', async (t) => {
  const { bundle, server, guest } = await hosted(t, {
    'README.md': 'the readme\n',
    'src/main.rs': 'fn main() {}\n',
  });
  await roomLearns(guest, 'src/main.rs');
  const published = server.grants.length;

  bundle.stub.remove('src/main.rs');
  bundle.stub.watchEvent('delete', 'src/main.rs');

  const paths = await waitFor('the room to drop the deleted file', () => {
    const held = listing(guest);
    return held.includes('src/main.rs') ? false : held;
  }, { describe: () => listing(guest) });
  assert.deepEqual(paths, ['README.md'], 'the room kept a path the folder no longer holds');
  assert.equal(server.grants.length, published + 1);
});

test('a folder that did not change is not published again', async (t) => {
  const { bundle, server, guest } = await hosted(t, { 'README.md': 'the readme\n' });
  await roomLearns(guest, 'README.md');
  const published = server.grants.length;

  // A content change is a filesystem event that cannot change which paths the folder holds.
  const walks = bundle.stub.registered.listings;
  bundle.stub.put('README.md', 'the readme, edited\n');
  bundle.stub.watchEvent('change', 'README.md');
  await waitFor('the window to walk the folder again', () =>
    bundle.stub.registered.listings > walks ? true : false,
  );

  // A later event is a whole interval after that walk, so a publication of the unchanged
  // listing would already be here by the time the second one arrives.
  bundle.stub.put('src/main.rs', 'fn main() {}\n');
  bundle.stub.watchEvent('create', 'src/main.rs');
  const paths = await roomLearns(guest, 'src/main.rs');
  assert.deepEqual(paths, ['README.md', 'src/main.rs']);
  assert.equal(
    server.grants.length,
    published + 1,
    `an unchanged listing was published: ${JSON.stringify(server.grants)}`,
  );
});

test('a burst of filesystem events is one republish', async (t) => {
  const { bundle, server, guest } = await hosted(t, { 'README.md': 'the readme\n' });
  await roomLearns(guest, 'README.md');
  const published = server.grants.length;

  const started = performance.now();
  for (let index = 0; index < 200; index += 1) {
    bundle.stub.put(`gen/file-${index}.txt`, 'generated\n');
    bundle.stub.watchEvent('create', `gen/file-${index}.txt`);
  }
  const elapsed = performance.now() - started;

  const paths = await roomLearns(guest, 'gen/file-199.txt');
  assert.equal(paths.length, 201, 'the burst\u2019s last listing is missing paths');
  // The throttle republishes at most once per interval, so what the burst costs is a function
  // of how long it took and not of how many events it held: one frame per event would be 200.
  const allowed = Math.ceil(elapsed / REFRESH_MS) + 1;
  const republished = server.grants.length - published;
  assert.ok(
    republished <= allowed,
    `200 events over ${elapsed.toFixed(1)}ms caused ${republished} republishes (allowed ${allowed})`,
  );
});

test('a guest watches nothing and publishes no listing', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const host = await SelvageEngine.host(server.wsBase, 'Ada', OPTIONS);
  t.after(async () => {
    await host.disconnect();
  });
  const invite = host.inviteUrl();
  assert.ok(invite !== undefined, 'the host was given no invite link');

  const bundle = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room')),
  );

  // Nothing to wait for: a guest creates no watcher at all, so there is nothing that could
  // fire one later, and a room's listing is its host's to publish.
  assert.deepEqual(bundle.stub.registered.watchers, [], 'a guest watched the folder');
  bundle.stub.put('README.md', 'the readme\n');
  bundle.stub.watchEvent('create', 'README.md');
  assert.deepEqual(server.grants, [], 'a guest published a listing');
});

test('leaving the session stops watching, and a queued republish is dropped', async (t) => {
  const { bundle, server } = await hosted(t, { 'README.md': 'the readme\n' });
  const created = bundle.stub.registered.watchers[0];
  assert.ok(created !== undefined, 'hosting created no watcher');
  assert.equal(created.pattern.pattern, '**/*', 'the watch does not cover the whole folder');
  assert.equal(
    String(created.pattern.base?.uri),
    'file:///workspace',
    'the watch is not rooted at the folder the session was invited on',
  );
  assert.equal(created.disposed, false, 'the watcher was disposed while the room was live');

  const walks = bundle.stub.registered.listings;
  const published = server.grants.length;
  bundle.stub.put('src/main.rs', 'fn main() {}\n');
  bundle.stub.watchEvent('create', 'src/main.rs');
  await bundle.stub.commands.executeCommand('selvage.leave');

  assert.equal(
    bundle.stub.registered.watchers.every((watcher) => watcher.disposed),
    true,
    'a watcher outlived the session',
  );
  // A disposed watcher delivers nothing; the window the event had already armed is what is
  // left, and while a session it would have walked the folder and sent a listing.
  bundle.stub.watchEvent('create', 'src/main.rs');
  await quiet();
  assert.equal(bundle.stub.registered.listings, walks, 'the folder was walked after the session');
  assert.equal(
    server.grants.length,
    published,
    `a listing reached the room after the session ended: ${JSON.stringify(server.grants)}`,
  );
});

test('a folder that cannot be watched is reported once, and the session goes on', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const bundle = activated(t);
  bundle.stub.setWorkspaceFolders(['/one', '/two']);
  bundle.stub.put('/one/README.md', 'the readme\n');
  bundle.stub.put('/two/notes.md', 'notes\n');
  bundle.stub.refuseWatchers('this window has no watcher for that folder');

  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  const invite = await inviteOf(bundle);

  const said = await waitFor('the failure to be reported', () =>
    bundle.stub.registered.errors.length > 0 ? bundle.stub.registered.errors : false,
  );
  assert.deepEqual(
    said,
    [
      "Selvage: could not watch the folder this window shares, so the room's listing will not follow it: this window has no watcher for that folder (error)",
    ],
    'two folders that cannot be watched are two failures the user has to read',
  );

  // Not watching is not the session ending: the listing is published, the room holds it, and a
  // guest still joins.
  const guest = await SelvageEngine.join(invite, 'Bob', OPTIONS);
  t.after(async () => {
    await guest.disconnect();
  });
  assert.deepEqual(await roomLearns(guest, 'two/notes.md'), ['one/README.md', 'two/notes.md']);
});

test('a watcher that fails after the first folder stops the watch rather than half-watching', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const bundle = activated(t);
  bundle.stub.setWorkspaceFolders(['/one', '/two']);
  bundle.stub.put('/one/README.md', 'the readme\n');
  bundle.stub.put('/two/notes.md', 'notes\n');
  // The first folder is watched and the second is not: a half-watch is what this rules out.
  bundle.stub.refuseWatchers('this window has no watcher for that folder', 1);

  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  await inviteOf(bundle);

  const created = bundle.stub.registered.watchers[0];
  assert.ok(created !== undefined, 'the first folder was not watched at all');
  assert.equal(created.disposed, true, 'the watcher was left running: the listing follows one folder of two');
  assert.equal(bundle.stub.registered.errors.length, 1, 'the failure was reported more than once');

  // And the watch really is over: an event now walks nothing and publishes nothing.
  const published = server.grants.length;
  bundle.stub.put('/one/src/main.rs', 'fn main() {}\n');
  bundle.stub.watchEvent('create', '/one/src/main.rs');
  await quiet();
  assert.equal(server.grants.length, published, 'a dropped watch still published');
});

test('a server with no grant is not a failure, and the watch goes on', async (t) => {
  const server = await FakeServer.start({ grant: false });
  t.after(async () => {
    await server.stop();
  });
  const bundle = activated(t);
  bundle.stub.put('README.md', 'the readme\n');
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  const invite = await inviteOf(bundle);

  await waitFor('the publication to be attempted', () =>
    server.grantAttempts > 0 ? true : false,
  );
  assert.deepEqual(
    bundle.stub.registered.errors,
    [],
    'a server with no grant was reported as a failure',
  );
  assert.deepEqual(server.grants, [], 'the fake server stored a listing it has no grant for');

  // The listing this server cannot store is remembered, so the same one is not asked for again.
  const walks = bundle.stub.registered.listings;
  bundle.stub.put('README.md', 'the readme, edited\n');
  bundle.stub.watchEvent('change', 'README.md');
  await waitFor('the window to walk the folder again', () =>
    bundle.stub.registered.listings > walks ? true : false,
  );
  await quiet();
  assert.equal(
    server.grantAttempts,
    1,
    'an unchanged listing was sent again to a server that has no grant',
  );

  // The session is still this window's, and the room is still open for a guest.
  const guest = await SelvageEngine.join(invite, 'Bob', OPTIONS);
  t.after(async () => {
    await guest.disconnect();
  });
  assert.equal(guest.session().role, 'guest');
  assert.equal(
    String(bundle.stub.registered.statusBarItems.at(-1)?.text ?? '').includes('hosting'),
    true,
    'the window stopped hosting after the refusal',
  );
});

test('a refused listing is reported, and the session goes on', async (t) => {
  const server = await FakeServer.start({ refuseGrant: true });
  t.after(async () => {
    await server.stop();
  });
  const bundle = activated(t);
  bundle.stub.put('README.md', 'the readme\n');
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  const invite = await inviteOf(bundle);

  const said = await waitFor('the refusal to be reported', () =>
    bundle.stub.registered.errors.length > 0 ? bundle.stub.registered.errors : false,
  );
  assert.deepEqual(said, [
    'Selvage: the server refused the listing of the folder this window shares: ' +
      'the listing is over the bound this server will store (bad_params)',
  ]);

  // A refusal is not a reason to stop watching: the next change is published and refused too.
  bundle.stub.put('src/main.rs', 'fn main() {}\n');
  bundle.stub.watchEvent('create', 'src/main.rs');
  await waitFor('the second refusal', () =>
    bundle.stub.registered.errors.length === 2 ? true : false,
    { describe: () => ({ errors: bundle.stub.registered.errors, attempts: server.grantAttempts }) },
  );
  assert.equal(server.grantAttempts, 2, 'the watch gave up after the first refusal');

  const guest = await SelvageEngine.join(invite, 'Bob', OPTIONS);
  t.after(async () => {
    await guest.disconnect();
  });
  assert.equal(guest.session().role, 'guest');
});

/**
 * The room's shape is two facts, and a listing that shrinks is not a hold released: `doc.grant`
 * replaces the room's grant wholesale and says nothing about the room's open-document set
 * (`PROTOCOL.md` §5 against §6). A path that leaves the listing because the host deleted or
 * renamed it therefore stops being *offered* by the grant alone, while a document somebody is
 * editing stays open and stays readable. The Neovim client keeps the same rule.
 */
test('a path that leaves the listing is a listing that shrank, not a hold released', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const host = await SelvageEngine.host(server.wsBase, 'Ada', OPTIONS);
  t.after(async () => {
    await host.disconnect();
  });
  const invite = host.inviteUrl();
  assert.ok(invite !== undefined, 'the host was given no invite link');
  await host.grant(['README.md', 'docs/notes.md', 'src/main.rs']);

  const bundle = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  const tree = treeOf(bundle);
  await waitFor('the listing to reach the window', () =>
    tree.getChildren().length === 3 ? true : false,
    { describe: () => tree.getChildren() },
  );

  // The guest opens one of the granted paths: the room holds it from here on, and its text
  // arrives because the host put it in the room.
  await bundle.stub.commands.executeCommand('selvage.openDocument', { path: 'src/main.rs' });
  const roomId = roomOf(invite);
  const document = {
    scheme: 'selvage',
    path: '/src/main.rs',
    query: `room=${roomId}`,
    toString: () => virtualUri(roomId, 'src/main.rs'),
  };
  host.insert('src/main.rs', 0, 'fn main() {}\n');
  await waitFor('the guest to hold the room text', () => {
    const bytes = bundle.registered.files?.readFile(document);
    return bytes instanceof Uint8Array &&
      new TextDecoder().decode(bytes) === 'fn main() {}\n'
      ? true
      : false;
  }, { describe: () => bundle.stub.registered.opened });

  // The folder as a watcher now finds it: the file the guest has open is gone from disk, and so
  // is a path nobody holds. Both leave the listing in the same frame.
  await host.grant(['README.md']);
  await waitFor('the shrink to reach the window', () =>
    tree.getChildren().some((node) => node.name === 'docs') ? false : true,
    { describe: () => tree.getChildren() },
  );

  assert.deepEqual(
    tree.getChildren().map((node) => [node.name, node.directory]),
    [
      ['src', true],
      ['README.md', false],
    ],
    'the window dropped a document whose path left the listing',
  );
  assert.equal(
    host.documents().includes('src/main.rs'),
    true,
    'the hold on the path was released with the listing',
  );
  const bytes = bundle.registered.files?.readFile(document);
  assert.ok(bytes instanceof Uint8Array, 'an open document whose path left the listing errored');
  assert.equal(new TextDecoder().decode(bytes), 'fn main() {}\n');
});

interface GrantTreeLike {
  getChildren(node?: { path: string }): Array<{
    name: string;
    path: string;
    directory: boolean;
  }>;
}

function treeOf(bundle: LoadedExtension): GrantTreeLike {
  const view = bundle.registered.treeViews.find((entry) => entry.id === 'selvage.grant');
  assert.ok(view !== undefined, 'activating registered no Explorer view');
  return view.options['treeDataProvider'] as GrantTreeLike;
}
