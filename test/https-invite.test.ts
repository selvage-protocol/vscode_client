/**
 * The invite is an `https://` page link, never `ws://`.
 *
 * CopyInvite copies exactly one page link, at the origin of the room's own server: the room
 * and token are in the query and nothing else is, because the link *is* the server. A pasted
 * page link joins the same way it loads, resolving the socket from that same origin, while a
 * `ws://` link joins as it stands — a room whose server serves no page is handed on by its wire
 * address. Each test here fails against the old behaviour: the clipboard held the wire URL, the
 * box refused page links, and the engine never saw them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUNDLE as BUNDLE_PATH,
  landStashedJoin,
  loadBundle,
  testStoragePath,
} from './helpers/bundle.ts';
import type { LoadedExtension } from './helpers/bundle.ts';
import { FakeServer } from './helpers/fake-server.ts';
import { waitFor } from './helpers/wait.ts';
import { sessionUrl } from '../src/engine/index.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(here, '..');
const BUNDLE = resolve(ROOT, 'dist', 'extension.js');
const STUB = resolve(ROOT, 'test', 'helpers', 'vscode-stub.cjs');

/** The page the client links to when nothing is configured. */
/** The page a room's own server serves, over the scheme a browser speaks. */
function pageOf(server: FakeServer): string {
  return server.wsBase.replace(/^ws/, 'http');
}

const require = createRequire(import.meta.url);

/** The bundle's pure invite helpers, without an editor. */
function inviteHelpers(): {
  buildPageLink: (serverBase: string, room: string, token: string) => string;
  parsePageLink: (text: string) => { room: string; token: string; origin: string } | undefined;
  sessionAddress: (wire: string) => string;
} {
  const Module = require('node:module') as {
    _resolveFilename: (...args: unknown[]) => string;
  };
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = (...args: unknown[]): string =>
    args[0] === 'vscode' ? STUB : resolveFilename(...args);
  try {
    const bundle = require(BUNDLE) as {
      buildPageLink: (serverBase: string, room: string, token: string) => string;
      parsePageLink: (text: string) => { room: string; token: string; origin: string } | undefined;
      sessionAddress: (wire: string) => string;
    };
    assert.equal(typeof bundle.buildPageLink, 'function', 'the bundle exports no page-link builder');
    assert.equal(typeof bundle.parsePageLink, 'function', 'the bundle exports no page-link parser');
    assert.equal(typeof bundle.sessionAddress, 'function', 'the bundle exports no session-address helper');
    return bundle;
  } finally {
    Module._resolveFilename = resolveFilename;
  }
}

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

/**
 * A second live window: a new module, so its session state starts empty while the
 * first window's does not. Command dispatch reaches the latest registration, so the
 * first window's commands are done being used once this one activates.
 */
function freshActivated(t: TestContext): { bundle: LoadedExtension; storage: string } {
  delete require.cache[require.resolve(BUNDLE_PATH)];
  return activated(t);
}

/** Hosts on `server` through the bundle, and reads the copied link off the clipboard. */
async function copiedInvite(
  bundle: LoadedExtension,
  server: FakeServer,
): Promise<{ link: string; roomId: string }> {
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  await waitFor('the host to be seated', () =>
    bundle.stub.registered.information.find((message) => message.includes('is open')) ?? false,
  );
  // Hosting copies the link itself; the room it names is read back off the link, never
  // off a notice — no user-visible surface names it.
  const link = await waitFor('the invite link', () => {
    const clipboard = bundle.stub.registered.clipboard;
    return /^https?:\/\//.test(clipboard) ? clipboard : false;
  });
  const roomId = new URL(link).searchParams.get('room');
  assert.ok(roomId !== null && roomId !== '', `the copied link names no room: ${link}`);
  return { link, roomId };
}

test('a copied link is the room\'s own server, over the scheme a browser speaks', () => {
  const { buildPageLink } = inviteHelpers();
  assert.equal(buildPageLink('wss://edit.example', 'r-1', 'tok'), 'https://edit.example/?room=r-1&token=tok');
  assert.equal(
    buildPageLink('ws://127.0.0.1:8080', 'r-1', 'tok'),
    'http://127.0.0.1:8080/?room=r-1&token=tok',
  );
  // A server behind a prefix is served there, so its page is linked there too.
  assert.equal(
    buildPageLink('wss://edit.example/prefix', 'r-1', 'tok'),
    'https://edit.example/prefix/?room=r-1&token=tok',
  );
});

test('a pasted page link reads back into the same join, and nothing else does', () => {
  const { buildPageLink, parsePageLink } = inviteHelpers();
  const link = buildPageLink('wss://edit.example', 'r-1', 'tok');
  assert.deepEqual(parsePageLink(link), { room: 'r-1', token: 'tok', origin: 'https://edit.example' });
  // A link written before the format changed carries `server`. Nothing reads it: the format
  // defines `room` and `token` alone, so it is an unknown query parameter and the link's own
  // origin is the server a guest reaches.
  assert.deepEqual(
    parsePageLink('https://edit.example/?room=r-1&token=tok&server=ws%3A%2F%2Fother%3A8080'),
    { room: 'r-1', token: 'tok', origin: 'https://edit.example' },
  );
  assert.equal(parsePageLink('ws://host:8080/session?room=r-1&token=tok'), undefined);
  assert.equal(parsePageLink('https://host/?room=r-1'), undefined);
  assert.equal(parsePageLink('https://host/'), undefined);
  assert.equal(parsePageLink('not a link'), undefined);
});

test('a connect notice names the invite’s address, never the wire URL that carries the token', () => {
  const { sessionAddress } = inviteHelpers();
  const wire = sessionUrl('ws://127.0.0.1:8080', 'r-1', 'super-secret');
  assert.equal(sessionAddress(wire), 'ws://127.0.0.1:8080');
  // The fallback for a URL that will not parse is words, not the URL: the notice is read by a
  // person, and the string it replaces carries the token that joined the room.
  assert.doesNotMatch(sessionAddress('not a session URL: super-secret'), /super-secret/);
});

test('CopyInvite copies exactly the page link, never the wire address', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const { bundle } = activated(t);
  const { link, roomId } = await copiedInvite(bundle, server);

  const parsed = new URL(link);
  const token = parsed.searchParams.get('token');
  assert.ok(token !== null && token !== '', `the link carries no token: ${link}`);
  assert.equal(
    link,
    `${pageOf(server)}/?room=${roomId}&token=${token}`,
    'the clipboard holds anything but the one page link',
  );
  assert.ok(!link.includes('ws://'), 'the wire address reached the clipboard');
  for (const written of bundle.stub.registered.clipboardWrites) {
    assert.ok(/^https?:\/\//.test(written), `a clipboard write was not the page link: ${written}`);
    assert.ok(!written.includes('ws://'), `a clipboard write carried the wire address: ${written}`);
  }
});

test('a remembered non-default server survives host-leave-host into the copied link', async (t) => {
  // The trap's mechanism, pinned at the seam: hosting on an address remembers it,
  // the next host reuses it with no question, and the link it copies
  // names it — the guest then asks that server.
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const { bundle } = activated(t);
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  await waitFor('the first host to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('is open')) ? true : false,
  );
  await bundle.stub.commands.executeCommand('selvage.leave');
  await waitFor('the leave to be said', () =>
    bundle.stub.registered.information.some((message) => message.includes('left the session'))
      ? true
      : false,
  );
  // No address: the remembered one answers without asking, the way the remembered name
  // does. The reset clears what was said so the waits below can only pass on the second
  // host; the remembered address lives in the module, not in the cleared memento, and
  // the reply is cleared with it so a question could only stall the host.
  bundle.stub.reset();
  await bundle.stub.commands.executeCommand('selvage.host', { displayName: 'Ada' });
  await waitFor('the second host to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('is open')) ? true : false,
  );
  assert.equal(
    bundle.stub.registered.inputs.length,
    0,
    'the remembered server was asked for again',
  );
  await bundle.stub.commands.executeCommand('selvage.copyInvite');
  const link = await waitFor('the invite link', () => {
    const clipboard = bundle.stub.registered.clipboard;
    return /^https?:\/\//.test(clipboard) ? clipboard : false;
  });
  assert.equal(
    new URL(link).origin,
    pageOf(server),
    'the copied link does not name the remembered server',
  );
});

test('a pasted page link joins the room it names', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const first = activated(t);
  const { link, roomId } = await copiedInvite(first.bundle, server);

  const second = freshActivated(t);
  await second.bundle.stub.commands.executeCommand('selvage.join', {
    invite: link,
    displayName: 'Bob',
  });
  await landStashedJoin(second.bundle, second.storage, roomId, 'Bob');
  const joined = second.bundle.stub.registered.information.find((message) =>
    message.includes('joined the room'),
  ) ?? false;
  assert.equal(joined, `Selvage: joined the room; the room has no open documents yet.`);
});

test('a ws:// invite still joins, for a room whose server serves no page', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const { bundle } = activated(t);
  const { link } = await copiedInvite(bundle, server);

  const wire = server.wsBase;
  const guest = freshActivated(t);
  const wireRoom = new URL(link).searchParams.get('room');
  assert.ok(wireRoom !== null && wireRoom !== '', `the copied link names no room: ${link}`);
  await guest.bundle.stub.commands.executeCommand('selvage.join', {
    invite: `${wire}/session?room=${wireRoom}&token=${new URL(link).searchParams.get('token')}`,
    displayName: 'Bob',
  });
  await landStashedJoin(guest.bundle, guest.storage, wireRoom, 'Bob');
  const joined = guest.bundle.stub.registered.information.find((message) =>
    message.includes('joined the room'),
  ) ?? 'no join landed';
  assert.match(joined, /Selvage: joined the room/);
});

test('a page address is not a setting any more: the link is the server', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  for (const configured of ['https://custom.example:9443/', 'http://custom.example:9443/', 'not a url']) {
    const fresh = freshActivated(t);
    // The setting is gone. A window that still has it configured — an old settings file — must
    // not be able to send a link to a page that dials another server, which is what a separate
    // page address allowed.
    fresh.bundle.stub.configure({ webOrigin: configured });
    const { link } = await copiedInvite(fresh.bundle, server);
    assert.ok(
      link.startsWith(pageOf(server)),
      `${configured} moved the link off the room's own server: ${link}`,
    );
  }
});
