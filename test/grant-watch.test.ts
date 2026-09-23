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
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { SelvageEngine, parseSessionUrl, sessionUrl } from '../src/engine/index.ts';
import { baseOf } from './helpers/base.ts';
import {
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

const OPTIONS = { client: 'selvage-vscode-test/0.1.0', meta: 'skip' } as const;

/**
 * The interval the adapter coalesces filesystem events over — `GRANT_REFRESH_INTERVAL_MS` in
 * `src/adapter/extension.ts`, spelled here as the presence tests spell theirs.
 */
const REFRESH_MS = 250;

/** The room an invite names, for the sentences that have to name it. */
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
  return sessionUrl(baseOf(server), room, token);
}

/** The bundle, activated with its own storage, with its recorded state cleared. */
function activated(t: TestContext): { bundle: LoadedExtension; storage: string } {
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
  return { bundle, storage };
}

/** The invite a host bundle copied, read off the clipboard as a user's click would leave it. */
async function inviteOf(bundle: LoadedExtension): Promise<string> {
  return await waitFor('the invite link', () => {
    void bundle.stub.commands.executeCommand('selvage.copyInvite');
    const clipboard = bundle.stub.registered.clipboard;
    return /^https?:\/\//.test(clipboard) ? clipboard : false;
  });
}

/** The room's listing as the guest holds it, for a poll that reports what it saw. */
function listing(guest: SelvageEngine): string[] {
  return guest.grantedPaths();
}

interface Hosted {
  /** The window hosting: the built extension, which is the side that watches the folder. */
  bundle: LoadedExtension;
  /** The window's storage: a guest mirror is never minted here, but joins use it. */
  storage: string;
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
  const { bundle, storage } = activated(t);
  for (const [path, content] of Object.entries(contents)) {
    bundle.stub.put(path, content);
  }
  // A room in this suite is a version-1 one: a hosting client takes its version from what the
  // server's `/meta` says it seats unless `selvage.wireVersion` pins it, so a window that means
  // `selvage/1` says so.
  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  const invite = await inviteOf(bundle);
  const guest = await SelvageEngine.join(wireOf(invite), 'Bob', OPTIONS);
  t.after(async () => {
    await guest.disconnect();
  });
  return { bundle, storage, server, guest, invite };
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

/**
 * The interval bounds the walks it *starts*, not the walks running: a walk of a large tree
 * outlasts it, so an event during one starts a second. Each walk compares its own listing
 * against what the room holds when it *finishes*, so without a walk guard the slower, older one
 * sends its older snapshot last and leaves the room behind the folder, which is the defect this
 * feature exists to remove. Only the walk that started last may publish.
 */
test('a walk overtaken by a later one does not publish its older listing', async (t) => {
  const { bundle, server, guest } = await hosted(t, { 'README.md': 'the readme\n' });
  await roomLearns(guest, 'README.md');
  const published = server.grants.length;

  // The first republish walk is held until the test releases it, so the walk the next event
  // starts is guaranteed to read the folder and publish first.
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holds = 1;
  bundle.stub.registered.readHold = () => {
    holds -= 1;
    return holds < 0 ? undefined : released;
  };

  const walks = bundle.stub.registered.listings;
  bundle.stub.put('a.txt', 'a\n');
  bundle.stub.watchEvent('create', 'a.txt');
  await waitFor('the held walk to begin', () =>
    bundle.stub.registered.listings > walks ? true : false,
  );

  bundle.stub.put('b.txt', 'b\n');
  bundle.stub.watchEvent('create', 'b.txt');
  const paths = await roomLearns(guest, 'b.txt');
  assert.deepEqual(paths, ['README.md', 'a.txt', 'b.txt'], 'the newer walk did not publish');

  // The held walk answers now, holding the folder as it stood before b.txt existed.
  release();
  await quiet();
  assert.deepEqual(
    listing(guest),
    ['README.md', 'a.txt', 'b.txt'],
    'the room went backwards to the older walk\u2019s listing',
  );
  assert.equal(
    server.grants.length,
    published + 1,
    `an overtaken walk published: ${JSON.stringify(server.grants)}`,
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

  const { bundle, storage } = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  await landStashedJoin(bundle, storage, roomOf(invite), 'Bob');

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

/**
 * A walk that is in flight when the session ends resolves against an engine the session has
 * closed. Publishing through it is answered by the engine rather than by the server, so without
 * a check after the walk the user is shown a refusal they did not get and cannot act on. The
 * Neovim client re-checks its engine here; this is the same rule.
 */
test('leaving while a republish is walking reports nothing and sends nothing', async (t) => {
  const { bundle, server } = await hosted(t, { 'README.md': 'the readme\n' });
  const published = server.grants.length;

  // Hold the republish walk the event arms until the session has ended, so the walk is provably
  // in flight when it does.
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  bundle.stub.registered.readHold = () => released;
  const walks = bundle.stub.registered.listings;
  bundle.stub.put('src/main.rs', 'fn main() {}\n');
  bundle.stub.watchEvent('create', 'src/main.rs');
  await waitFor('the republish walk to begin', () =>
    bundle.stub.registered.listings > walks ? true : false,
  );

  await bundle.stub.commands.executeCommand('selvage.leave');
  release();
  await quiet();

  assert.deepEqual(
    bundle.stub.registered.errors,
    [],
    'leaving during a walk reported a failure the user did not have',
  );
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
  const { bundle } = activated(t);
  bundle.stub.setWorkspaceFolders(['/one', '/two']);
  bundle.stub.put('/one/README.md', 'the readme\n');
  bundle.stub.put('/two/notes.md', 'notes\n');
  bundle.stub.refuseWatchers('this window has no watcher for that folder');

  bundle.stub.configure({ wireVersion: 'selvage/1' });
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
      "Selvage: could not watch the folder this window shares: this window has no watcher for that folder.",
    ],
    'two folders that cannot be watched are two failures the user has to read',
  );

  // Not watching is not the session ending: the listing is published, the room holds it, and a
  // guest still joins.
  const guest = await SelvageEngine.join(wireOf(invite), 'Bob', OPTIONS);
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
  const { bundle } = activated(t);
  bundle.stub.setWorkspaceFolders(['/one', '/two']);
  bundle.stub.put('/one/README.md', 'the readme\n');
  bundle.stub.put('/two/notes.md', 'notes\n');
  // The first folder is watched and the second is not: a half-watch is what this rules out.
  bundle.stub.refuseWatchers('this window has no watcher for that folder', 1);

  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  await inviteOf(bundle);

  const created = bundle.stub.registered.watchers[0];
  assert.ok(created !== undefined, 'the first folder was not watched at all');
  assert.equal(created.disposed, true, 'the watcher was left running: the listing follows one folder of two');
  assert.equal(bundle.stub.registered.errors.length, 1, 'the failure was reported more than once');

  // The session's own first publication is a websocket round trip and lands after `host`
  // resolves; wait for it, so the count below is a count after the room holds the listing and
  // not a sample taken mid-flight.
  await waitFor('the session to publish its first listing', () =>
    server.grants.length > 0 ? true : false,
  );

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
  const { bundle } = activated(t);
  bundle.stub.put('README.md', 'the readme\n');
  bundle.stub.configure({ wireVersion: 'selvage/1' });
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
  const guest = await SelvageEngine.join(wireOf(invite), 'Bob', OPTIONS);
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
  const { bundle } = activated(t);
  bundle.stub.put('README.md', 'the readme\n');
  bundle.stub.configure({ wireVersion: 'selvage/1' });
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
      'the listing is over the bound this server will store.',
  ]);

  // A refusal is not a reason to stop watching: the next *different* listing is published and
  // refused too.
  bundle.stub.put('src/main.rs', 'fn main() {}\n');
  bundle.stub.watchEvent('create', 'src/main.rs');
  await waitFor('the second refusal', () =>
    bundle.stub.registered.errors.length === 2 ? true : false,
    { describe: () => ({ errors: bundle.stub.registered.errors, attempts: server.grantAttempts }) },
  );
  assert.equal(server.grantAttempts, 2, 'the watch gave up after the first refusal');

  const guest = await SelvageEngine.join(wireOf(invite), 'Bob', OPTIONS);
  t.after(async () => {
    await guest.disconnect();
  });
  assert.equal(guest.session().role, 'guest');
});

/**
 * A refusal is a property of the listing, not of the moment: re-enumerating the folder every
 * window cannot change what the server will store, so an unchanged refused listing is neither
 * sent nor reported again. Before this, a host whose project exceeds the server's bound got one
 * error per window for as long as anything kept touching the folder.
 */
test('a refused listing is offered and reported once while it says the same thing', async (t) => {
  const server = await FakeServer.start({ refuseGrant: true });
  t.after(async () => {
    await server.stop();
  });
  const { bundle } = activated(t);
  bundle.stub.put('README.md', 'the readme\n');
  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  await waitFor('the refusal to be reported', () =>
    bundle.stub.registered.errors.length > 0 ? true : false,
  );

  // Six windows, each opened by a content change: a write cannot alter which paths the folder
  // holds, so every walk enumerates the listing the server has already refused.
  for (let index = 0; index < 6; index += 1) {
    bundle.stub.put('README.md', `the readme, edited ${index}\n`);
    bundle.stub.watchEvent('change', 'README.md');
    const walks = bundle.stub.registered.listings;
    await waitFor('the window to walk the folder', () =>
      bundle.stub.registered.listings > walks ? true : false,
    );
  }
  await quiet();

  assert.equal(
    bundle.stub.registered.errors.length,
    1,
    `the same refusal was reported again: ${JSON.stringify(bundle.stub.registered.errors)}`,
  );
  assert.equal(
    server.grantAttempts,
    1,
    'the same listing was sent again to a server that has already refused it',
  );
});

/**
 * A refusal belongs to the walk that is current when its answer arrives, not to the one
 * that sent it: with a slow room, the send of an older walk is still out when the walk a
 * later event starts sends its own, and only the latest walk's answer may report. Before
 * this, the older walk reported its refusal too, so one refused listing cost one error per
 * overlapping walk.
 */
test('a walk overtaken by a later one reports no refusal of its own', async (t) => {
  const server = await FakeServer.start({ refuseGrant: true });
  t.after(async () => {
    await server.stop();
  });
  const { bundle } = activated(t);
  bundle.stub.put('README.md', 'the readme\n');
  bundle.stub.configure({ wireVersion: 'selvage/1' });
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  await waitFor('the first refusal to be reported', () =>
    bundle.stub.registered.errors.length > 0 ? true : false,
  );
  const attempts = server.grantAttempts;
  const errors = bundle.stub.registered.errors.length;

  // Every grant answer waits, so the republish this event starts is still sending when the
  // walk the next event starts sends its own listing.
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.grantHold = released;

  bundle.stub.put('a.txt', 'a\n');
  bundle.stub.watchEvent('create', 'a.txt');
  await waitFor('the first send to be held', () =>
    server.grantAttempts > attempts ? true : false,
  );
  bundle.stub.put('b.txt', 'b\n');
  bundle.stub.watchEvent('create', 'b.txt');
  await waitFor('the second send to be held', () =>
    server.grantAttempts > attempts + 1 ? true : false,
  );

  release();
  server.grantHold = undefined;
  await quiet();

  assert.equal(
    server.grantAttempts,
    attempts + 2,
    `the held sends never arrived: ${server.grantAttempts}`,
  );
  assert.equal(
    bundle.stub.registered.errors.length,
    errors + 1,
    `an overtaken walk reported its own refusal: ${JSON.stringify(bundle.stub.registered.errors)}`,
  );
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

  const { bundle, storage } = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  const roomId = roomOf(invite);
  await landStashedJoin(bundle, storage, roomId, 'Bob');
  await waitForMirrorFiles(storage, roomId, ['README.md', 'docs/notes.md', 'src/main.rs']);

  // The guest opens one of the granted paths: the room holds it from here on, and its text
  // arrives because the host put it in the room.
  await bundle.stub.commands.executeCommand('selvage.openDocument', { path: 'src/main.rs' });
  const uri = mirrorFileUri(storage, roomId, 'src/main.rs');
  await waitFor('the granted path to open', () =>
    bundle.stub.registered.opened.includes(uri) ? true : false,
  );
  const holder = { text: '' };
  bundle.stub.registered.applyEditImpl = async (edit: unknown) => {
    for (const change of (edit as { edits: Array<{ text: string }> }).edits) {
      holder.text += change.text;
    }
    return true;
  };
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
    host.documents().includes('src/main.rs') ? true : false,
  );
  host.insert('src/main.rs', 0, 'fn main() {}\n');
  await waitFor('the guest to hold the room text', () =>
    holder.text === 'fn main() {}\n' ? true : false,
  );

  // The folder as a watcher now finds it: the file the guest has open is gone from disk,
  // and so is a path nobody holds. Both leave the listing in the same frame.
  await host.grant(['README.md']);
  await waitForMirrorGone(storage, roomId, ['docs/notes.md']);

  // A republished listing removes what nobody holds and keeps what a document holds: the
  // held file stays on disk, with its hold, while the unheld one goes.
  assert.equal(
    existsSync(join(mirrorWindowDir(storage, roomId), 'src', 'main.rs')),
    true,
    'the window dropped a document whose path left the listing',
  );
  assert.equal(
    host.documents().includes('src/main.rs'),
    true,
    'the hold on the path was released with the listing',
  );
  assert.equal(holder.text, 'fn main() {}\n', 'an open document whose path left the listing lost its text');
});
