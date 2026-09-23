/**
 * The extension as the third adapter of a `selvage/2` room, against a real `selvaged` on its
 * defaults, which seat both versions: the window hosts a version-2 room and a second peer verifies
 * its state, and the window joins a version-2 room through a page link and lands on the room's
 * mirror.
 *
 * What it adds over `test/selvage2-adapter.test.ts` — which drives the same paths over the fake
 * server — is the server: the handshake the real one answers, the frames it relays byte for byte
 * without reading, and the version gate that seats a version-2 room only for a connection that
 * speaks it. It is not part of `npm run test:fast`; it needs a built sibling `selvaged` (see
 * `test/helpers/selvaged.ts`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { createRequire } from 'node:module';

import { PeerEngine } from '../src/bridge/peer-engine.ts';
import { SelvageEngine } from '../src/engine/engine.ts';
import { isProtocolError } from '../src/engine/errors.ts';
import { RelaySession } from '../src/engine/relay.ts';
import { sessionUrl } from '../src/engine/urls.ts';
import { BUNDLE, landStashedJoin, loadBundle, testStoragePath, waitForMirrorFiles } from './helpers/bundle.ts';
import type { LoadedExtension } from './helpers/bundle.ts';
import { RealServer } from './helpers/selvaged.ts';
import { waitFor } from './helpers/wait.ts';

const V2 = 'selvage/2';
const PATH = 'notes.txt';
const SEED = 'a room the extension hosts at version two\n';

/** The bundle's pure invite helpers, as `test/selvage2-adapter.test.ts` reaches them. */
interface AdapterExports {
  buildPageLink(
    serverBase: string,
    room: string,
    token: string,
    keys?: { roomKey?: string; hostKey?: string },
  ): string;
}

/**
 * The bundle's own exports, for the one case that needs a function rather than a window. The
 * `vscode` specifier is answered by the stub for this call only, as `loadBundle` does for its
 * own.
 */
function adapterExports(): AdapterExports {
  const require = createRequire(import.meta.url);
  const Module = require('node:module') as { _resolveFilename: (...args: unknown[]) => string };
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = (...args: unknown[]): string =>
    args[0] === 'vscode' ? require.resolve('./helpers/vscode-stub.cjs') : resolveFilename(...args);
  try {
    return require(BUNDLE) as AdapterExports;
  } finally {
    Module._resolveFilename = resolveFilename;
  }
}

/** One row of the extension's own participant list, as the view hands it over. */
interface RowNode {
  label?: unknown;
  description?: unknown;
}

/** The rows the extension's participant view lists, as a window would draw them. */
function viewNodes(bundle: LoadedExtension): RowNode[] {
  const found = (
    bundle.stub.registered as unknown as {
      treeDataProviders: Array<{ viewId: string; provider: { getChildren(): unknown } }>;
    }
  ).treeDataProviders.find((entry) => entry.viewId === 'selvage.participants');
  assert.ok(found !== undefined, 'activation registered no participant view');
  const children = found.provider.getChildren();
  assert.ok(Array.isArray(children), 'the view listed no rows');
  return children as RowNode[];
}

/** The bundle activated with its own storage, at `selvage/2`. */
function activated(t: TestContext): { bundle: LoadedExtension; storage: string } {
  const bundle = loadBundle();
  bundle.stub.reset();
  const storage = testStoragePath(t);
  bundle.stub.configure({ wireVersion: V2, openOnJoin: false });
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

/** The page link a host copied, read off the clipboard as its own click leaves it. */
async function copiedInvite(bundle: LoadedExtension): Promise<string> {
  void bundle.stub.commands.executeCommand('selvage.copyInvite');
  return await waitFor<string>('the host to hand its invite on', () => {
    const clipboard = bundle.stub.registered.clipboard;
    return /^https?:\/\//.test(clipboard) ? clipboard : false;
  });
}

/** The room, token and `§5.1` keys a page link carries. */
function parts(link: string): {
  room: string;
  token: string;
  roomKey: string;
  hostKey: string;
  origin: string;
} {
  const url = new URL(link);
  const keys = new Map(
    url.hash
      .replace(/^#/, '')
      .split('&')
      .map((part) => [part.split('=')[0] ?? '', part.split('=').slice(1).join('=')]),
  );
  return {
    room: url.searchParams.get('room') ?? '',
    token: url.searchParams.get('token') ?? '',
    roomKey: keys.get('k') ?? '',
    hostKey: keys.get('h') ?? '',
    origin: url.origin,
  };
}

test('the extension hosts a version-2 room a second peer can verify and edit in', async (t) => {
  const server = await RealServer.start();
  t.after(async () => {
    await server.stop();
  });
  const { bundle } = activated(t);
  // The working copy the host shares: one file, which the mint state seals the name of.
  bundle.stub.put(PATH, SEED);
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  const link = await copiedInvite(bundle);
  const room = parts(link);
  assert.match(link, /#[k]=[A-Za-z0-9_-]{43}&h=[A-Za-z0-9_-]{43}$/, `no fragment in ${link}`);

  // The second peer, a real version-2 session: it joins with the page link the host copied, so
  // what it verifies is the state the extension's own host key signed.
  const guest = await RelaySession.join({ invite: link, displayName: 'Bob' });
  t.after(() => {
    guest.disconnect();
  });
  const listed = await waitFor(
    "the guest to verify the host's sealed listing",
    () => {
      const paths = [...guest.listing()];
      return paths.length > 0 ? paths : false;
    },
    { describe: () => guest.sessionInfo().roomId },
  );
  assert.deepEqual(listed, [PATH]);
  assert.equal(guest.sessionInfo().roomId, room.room, 'the guest landed in another room');

  // The guest's own key has to be one the host's state commits (`§13.1`): until the host
  // published a state carrying it, this connection could not publish anything at all, and the
  // role the state gives its own key is where that shows.
  await waitFor(
    "the host's state to commit the guest's key",
    () => guest.appliedRole() ?? false,
    { timeoutMs: 15_000, describe: () => guest.sessionInfo().peers },
  );

  // The room's open-document set is `§13.7`'s holds in this version, and the hold is the frame a
  // version-1 room called `doc.opened`. The host serves a path that set names exactly as it does
  // in a version-1 room: the bridge reads this window's own working copy for a peer. The seed
  // text arriving here is the extension having read its own folder for a guest, over a version
  // with no `doc.open` in it at all. What drives that read is the relay's own report of the
  // open set, which `§13.7`'s holds now raise (see `src/engine/relay.ts`).
  guest.open(PATH);
  assert.deepEqual(guest.heldPaths(), [PATH], 'the hold was not taken');
  const served = await waitFor(
    'the host to serve the path the guest holds',
    () => {
      const text = guest.text(PATH);
      return text === SEED ? text : false;
    },
    { timeoutMs: 15_000, describe: () => guest.text(PATH) },
  );
  assert.equal(served, SEED);

  // And the guest's caret reaches the extension's own participant list: a row for Bob with the
  // path he is in, which is a frame the extension attributed to a key its state commits.
  guest.setSelection(PATH, { anchor: 0, head: 0 });
  const row = await waitFor(
    "the guest's caret in the extension's participant list",
    () => {
      const rows = viewNodes(bundle);
      return rows.find((node) => node.description === PATH) ?? false;
    },
    { timeoutMs: 15_000, describe: () => viewNodes(bundle) },
  );
  assert.match(String(row.label), /Bob/);
});

test('the extension joins a version-2 room its page link names, and its mirror fills', async (t) => {
  const server = await RealServer.start();
  t.after(async () => {
    await server.stop();
  });
  const { buildPageLink } = adapterExports();
  // The host is a plain version-2 session: the page link the extension is handed is the one its
  // own builder would write from this room's wire invite, keys and all.
  const host = await PeerEngine.host({
    baseUrl: server.wsBase,
    displayName: 'Ada',
    listing: { current: () => [PATH, 'src/main.rs'], replace: () => undefined },
  });
  t.after(() => {
    host.disconnect();
  });
  const wire = host.inviteUrl();
  assert.ok(wire !== undefined, 'the host holds no invite');
  const at = wire.indexOf('#');
  const query = new URL(wire.slice(0, at));
  const keys = new URLSearchParams(wire.slice(at + 1));
  const link = buildPageLink(
    server.wsBase,
    query.searchParams.get('room') ?? '',
    query.searchParams.get('token') ?? '',
    { roomKey: keys.get('k') ?? '', hostKey: keys.get('h') ?? '' },
  );
  const room = parts(link).room;
  assert.equal(new URL(link).origin, server.wsBase.replace(/^ws/, 'http'));
  assert.equal(parts(link).hostKey, keys.get('h'));

  const { bundle, storage } = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite: link, displayName: 'Bob' });
  await landStashedJoin(bundle, storage, room, 'Bob');
  // The listing the mirror fills with is the host's sealed one, so a join that got there is a
  // fragment that reached the engine and a state that verified.
  await waitForMirrorFiles(storage, room, [PATH, 'src/main.rs']);
  const joined = bundle.stub.registered.information.find((message) =>
    message.includes('joined the room'),
  );
  assert.ok(
    joined !== undefined,
    `the join said nothing: ${JSON.stringify(bundle.stub.registered.errors)}`,
  );
});

test('a fragment-less link to a version-2 room is refused by the server', async (t) => {
  const server = await RealServer.start();
  t.after(async () => {
    await server.stop();
  });
  // The same room the fragment names, reached as a version-1 invite: the server pins a room
  // to the version that minted it, so that hello names a room which is not this connection's
  // and `§10` refuses it rather than seating it. Against the real server, the rule the stub
  // models in `test/selvage2-adapter.test.ts`.
  const host = await PeerEngine.host({
    baseUrl: server.wsBase,
    displayName: 'Ada',
    listing: { current: () => [PATH], replace: () => undefined },
  });
  t.after(() => {
    host.disconnect();
  });
  const wire = host.inviteUrl();
  assert.ok(wire !== undefined, 'the host holds no invite');
  const query = new URL(wire.slice(0, wire.indexOf('#')));
  const fragmentless = sessionUrl(
    server.wsBase,
    query.searchParams.get('room') ?? '',
    query.searchParams.get('token') ?? '',
  );
  await assert.rejects(
    SelvageEngine.join(fragmentless, 'Bob'),
    (error: unknown) => isProtocolError(error, 'unsupported_version'),
  );
});
