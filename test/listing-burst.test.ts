/**
 * What the room's listing costs a guest, and what it is allowed to remember.
 *
 * The room is a stranger's: a host publishes its listing whenever it likes, the server
 * relays the whole of it to every peer, and a guest must not pay for that per event or
 * keep it per name ever seen. Two properties are pinned here, both against a real guest
 * window over a real mirror on disk and a fake `selvaged` in the room:
 *
 * - a burst of listings is applied once for the burst rather than once per event, so a
 *   host that republishes as fast as its socket allows cannot make every guest re-walk
 *   its whole mirror per frame;
 * - the names a listing is remembered by are one listing wide, so a host that churns
 *   distinct names grows this window's memory by nothing.
 *
 * Each test names the mutation that turns it red.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';

import {
  landStashedJoin,
  loadBundle,
  testStoragePath,
  waitForMirrorFiles,
  waitForMirrorGone,
} from './helpers/bundle.ts';
import type { LoadedExtension } from './helpers/bundle.ts';
import { FakeServer } from './helpers/fake-server.ts';
import { waitFor } from './helpers/wait.ts';
import { SelvageEngine } from '../src/engine/index.ts';

const OPTIONS = { client: 'selvage-vscode-test/0.1.0', meta: 'skip' } as const;

/** How many applications one burst may cost: the leading one, the window's end, and slack. */
const MAX_APPLICATIONS = 3;

/** The interval the adapter spreads one listing window over, from `extension.ts`. */
const WINDOW_MS = 250;

/** How many distinct listings a burst carries. */
const BURST = 12;

/** The sentence one application of a listing that names a directory says. */
const UNMIRRORABLE = 'could not be written to disk';

interface Room {
  host: SelvageEngine;
  bundle: LoadedExtension;
  storage: string;
  roomId: string;
  /** The guest's mirror root on disk: the directory the listing is applied to. */
  root: string;
}

/** A room a source engine hosts, and a guest window landed on its mirror. */
async function seated(t: TestContext): Promise<Room> {
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
  const roomId = host.session().roomId;

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
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  const root = await landStashedJoin(bundle, storage, roomId, 'Bob');
  return { host, bundle, storage, roomId, root };
}

/** Every listing application the guest reported: one sentence per application. */
function applications(bundle: LoadedExtension): string[] {
  return bundle.stub.registered.warnings.filter((message) => message.includes(UNMIRRORABLE));
}

test('a burst of the room’s listings is applied once for the burst, not once per event', async (t) => {
  const { host, bundle, storage, roomId, root } = await seated(t);
  // A directory where the listing names a file: nothing can be materialised there, so
  // every application says so once, which is how many applications there were.
  mkdirSync(join(root, 'blocked'));

  // Distinct listings, sent back to back on one socket: the room republishing faster than
  // any window can follow. Red without the coalescing: one application per listing, and
  // each of them walks the whole mirror and writes a file per path.
  const listings = Array.from({ length: BURST }, (_, index) => ['blocked', `burst-${index}.md`]);
  await Promise.all(listings.map((paths) => host.grant(paths)));

  // The listing in force at the end of the burst is the one the mirror holds: coalescing
  // drops the intermediate applications, never the last one.
  await waitForMirrorFiles(storage, roomId, [`burst-${BURST - 1}.md`]);
  await waitForMirrorGone(
    storage,
    roomId,
    Array.from({ length: BURST - 1 }, (_, index) => `burst-${index}.md`),
  );
  // The first listing of the burst lands at once (the mirror is shaped before anything
  // opens into it) and the rest of the window lands at its end, so two applications are
  // the answer; the slack is for a runner slow enough to straddle a window boundary.
  const said = applications(bundle);
  assert.ok(
    said.length <= MAX_APPLICATIONS,
    `${BURST} listings cost ${said.length} applications: ${JSON.stringify(said)}`,
  );
});

test('a listing that names nothing never wipes what the room never had', async (t) => {
  // What the engine emits when the socket dies is an empty listing, and its removal pass
  // takes every mirror file no document of this window holds — including whatever a tool of
  // the person's own wrote into the mirror while the room was live. The room's listing
  // follows within a frame or two on the re-seat, so applying the empty one first wipes the
  // mirror and materialises it again empty. A listing that names nothing therefore never
  // opens a window; it waits, and the listing that follows supersedes it.
  const { host, storage, roomId, root } = await seated(t);
  const listing = ['a.md', 'local.txt'];
  await host.grant(listing);
  await waitForMirrorFiles(storage, roomId, listing);

  // The person's own work, in the mirror the room's listing made: no document of this
  // window has it open, so nothing but the listing protects it.
  const local = join(root, 'local.txt');
  writeFileSync(local, 'typed into the mirror while the room was live\n');

  // The listing above opened a window, and the burst below is a second one: a window is a
  // timer, so waiting it out is what makes the burst the leading edge of its own window
  // rather than part of the first. Bounded, and longer than the interval by a margin.
  await delay(WINDOW_MS * 2);

  // The re-seat's burst, and a path only the listing after it names, so the wait below is
  // the burst having been applied and not the burst merely having been sent.
  const settled = [...listing, 'settled.md'];
  await Promise.all([host.grant([]), host.grant(settled)]);
  await waitForMirrorFiles(storage, roomId, ['settled.md']);
  assert.equal(
    readFileSync(local, 'utf8'),
    'typed into the mirror while the room was live\n',
    'the empty listing of a re-seat wiped a file the room never had',
  );
});

test('the name a listing dropped is remembered for one listing, not for ever', async (t) => {
  const { host, bundle, storage, roomId } = await seated(t);
  await host.grant(['one.md', 'two.md']);
  await waitForMirrorFiles(storage, roomId, ['one.md', 'two.md']);

  // The host stops sharing it: the path has left the listing as it stands.
  await host.grant(['two.md']);
  await waitForMirrorGone(storage, roomId, ['one.md']);
  await bundle.stub.commands.executeCommand('selvage.openDocument', { path: 'one.md' });
  const stale = await waitFor('the stale path to be refused', () =>
    bundle.stub.registered.errors.find((message) => message.includes('one.md')) ?? false,
  );
  assert.match(stale, /the host no longer shares one\.md/);

  // A second listing later, the name is one the room never carried as far as this window
  // remembers: the window is one listing wide, so a host churning distinct names cannot
  // grow what this window holds. Red with a set of every name ever listed: the sentence
  // above is said here too, and the set is as large as the room chose to make it.
  bundle.stub.reset();
  await host.grant(['three.md']);
  // Waiting on the listing that names it: the window moves when the report is read, so a
  // mirror holding it is the effect that says the report was read.
  await waitForMirrorFiles(storage, roomId, ['three.md']);
  await bundle.stub.commands.executeCommand('selvage.openDocument', { path: 'one.md' });
  const forgotten = await waitFor('the forgotten path to be refused', () =>
    bundle.stub.registered.errors.find((message) => message.includes('one.md')) ?? false,
  );
  assert.match(forgotten, /no shared document matches "one\.md"/);
});
