/**
 * Reclaim republishes the grant (probe `ai_notes/.tmp/hostleave-probe.md` §4): after an
 * explicit reclaim the room kept advertising the dead host's listing while the new host
 * served nothing — a granted-never-opened file fetched empty. The host therefore publishes
 * the folder as it stands whenever its engine reseats after a drop, and a reclaim with a
 * different grant moves the guests onto the new listing.
 *
 * The host is the built extension with the editor API stubbed — it is the side that
 * publishes — and the guest is a second engine in the room, so what the room was told is
 * read from the listing the guest really holds and the frames the fake server recorded.
 * The folder moves silently (no watcher event fires), which is the shape a reclaim meets
 * when the working copy changed under a dead socket; every wait is a bounded poll.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import { SelvageEngine, sessionUrl } from '../src/engine/index.ts';
import { isProtocolError } from '../src/engine/errors.ts';
import { FakeServer } from './helpers/fake-server.ts';
import { loadBundle, testStoragePath } from './helpers/bundle.ts';
import type { LoadedExtension } from './helpers/bundle.ts';
import { waitFor } from './helpers/wait.ts';
import { options } from './helpers/session.ts';

const OPTIONS = { client: 'selvage-vscode-test/0.1.0', meta: 'skip' } as const;

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
    return clipboard.startsWith('https://') ? clipboard : false;
  });
}

/** The wire URL a copied page link names, as the adapter's own join resolves it. */
function wireOf(link: string): string {
  const page = new URL(link);
  const room = page.searchParams.get('room');
  const token = page.searchParams.get('token');
  const server = page.searchParams.get('server');
  assert.ok(room !== null && room !== '', `the link names no room: ${link}`);
  assert.ok(token !== null && token !== '', `the link carries no token: ${link}`);
  assert.ok(server !== null && server !== '', `the link carries no server: ${link}`);
  return sessionUrl(server, room, token);
}

test('a host that reclaims its room publishes its current listing, not the dead one', async (t) => {
  // No grace reaping: the room outlives its host, so the drop below is a reclaim rather
  // than a room gone.
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const { bundle } = activated(t);
  bundle.stub.put('old.txt', 'the old listing\n');
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  const invite = await inviteOf(bundle);
  const guest = await SelvageEngine.join(wireOf(invite), 'Bob', OPTIONS);
  t.after(async () => {
    await guest.disconnect();
  });
  await waitFor('the guest to learn the starting listing', () => {
    const paths = guest.grantedPaths();
    return paths.includes('old.txt') ? paths : false;
  }, { describe: () => guest.grantedPaths() });

  // The folder moves while the room still names the old listing, and no watcher event
  // fires for it — so nothing is published before the socket dies.
  bundle.stub.put('new.txt', 'the new listing\n');
  bundle.stub.remove('old.txt');
  assert.deepEqual(
    server.grants.map((grant) => grant.paths),
    [['old.txt']],
    'the silent folder move published before the drop',
  );

  server.drop('Ada');

  const relearned = await waitFor(
    'the guest to learn the reclaimed listing',
    () => {
      const paths = guest.grantedPaths();
      return paths.includes('new.txt') && !paths.includes('old.txt') ? paths : false;
    },
    { timeoutMs: 10000, describe: () => guest.grantedPaths() },
  );
  assert.deepEqual(relearned, ['new.txt'], 'the guest converged on the dead listing');
  assert.deepEqual(
    server.grants.map((grant) => grant.paths),
    [['old.txt'], ['new.txt']],
    'the reclaim published nothing new',
  );
});

test('a hello after the grace expires is room_unknown for either role', async (t) => {
  const server = await FakeServer.start({ roomGraceMs: 200 });
  t.after(async () => {
    await server.stop();
  });
  const host = await SelvageEngine.host(server.wsBase, 'Ada', {
    meta: 'skip',
    reconnect: false,
  });
  const invite = host.inviteUrl() ?? '';
  assert.notEqual(invite, '', 'the host was given no invite link');
  const roomId = host.session().roomId;
  const token = host.session().token ?? '';
  assert.notEqual(token, '', 'the host was given no token');
  const guest = await SelvageEngine.join(
    invite,
    'Bob',
    options({ baseUrl: server.wsBase, displayName: 'Bob', reconnect: false }),
  );
  t.after(async () => {
    await host.disconnect();
    await guest.disconnect();
  });

  // Neither side comes back, so the grace period reaps the room while both are down.
  server.drop('Ada');
  server.drop('Bob');
  await waitFor('the room to be reaped', () => server.roomOf(roomId) === undefined, {
    timeoutMs: 10000,
    describe: () => server.roomOf(roomId),
  });

  // §9.1: a destroyed room is gone for good, on any URL, for a guest and for a host hello.
  await assert.rejects(
    SelvageEngine.join(
      invite,
      'Dan',
      options({ baseUrl: server.wsBase, displayName: 'Dan' }),
    ),
    (error: unknown) => isProtocolError(error, 'room_unknown'),
    'a guest hello after expiry seated',
  );
  await assert.rejects(
    SelvageEngine.connect(
      options({
        baseUrl: server.wsBase,
        displayName: 'Ada again',
        room: roomId,
        token,
        role: 'host',
        reconnect: false,
      }),
    ),
    (error: unknown) => isProtocolError(error, 'room_unknown'),
    'a host hello after expiry reclaimed a dead room',
  );
});
