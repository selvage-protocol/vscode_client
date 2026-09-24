/**
 * A typed server address is completed, not refused, and reaching for the invite says what
 * happened.
 *
 * A person types a host, not a URL: `selvage.dontblameme.dev` is the published shape, which is
 * TLS and the engine's own `/session`. The completion happens in one place, which is what keeps
 * the argument, the setting, the remembered address and `selvage.changeServer` from disagreeing
 * about what a hostname means. The second half is the invite: a clipboard the editor refuses and
 * a room this connection was given no link for are different faults, and a window in a room that
 * is open must not be told to host or join one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUNDLE as BUNDLE_PATH, loadBundle, testStoragePath } from './helpers/bundle.ts';
import type { LoadedExtension } from './helpers/bundle.ts';
import { FakeServer } from './helpers/fake-server.ts';
import { waitFor } from './helpers/wait.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(here, '..');
const BUNDLE = resolve(ROOT, 'dist', 'extension.js');
const STUB = resolve(ROOT, 'test', 'helpers', 'vscode-stub.cjs');

const require = createRequire(import.meta.url);

/** The bundle's pure address helpers, without an editor. */
function addressHelpers(): {
  normaliseServerUrl: (text: string) => string;
  pageOriginOf: (serverBase: string) => string;
  serverBaseOf: (page: string) => string;
} {
  const Module = require('node:module') as {
    _resolveFilename: (...args: unknown[]) => string;
  };
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = (...args: unknown[]): string =>
    args[0] === 'vscode' ? STUB : resolveFilename(...args);
  try {
    const bundle = require(BUNDLE) as {
      normaliseServerUrl: (text: string) => string;
      pageOriginOf: (serverBase: string) => string;
      serverBaseOf: (page: string) => string;
    };
    assert.equal(
      typeof bundle.normaliseServerUrl,
      'function',
      'the bundle exports no server-address helper',
    );
    assert.equal(typeof bundle.pageOriginOf, 'function', 'the bundle exports no page-origin helper');
    assert.equal(typeof bundle.serverBaseOf, 'function', 'the bundle exports no server-base helper');
    return bundle;
  } finally {
    Module._resolveFilename = resolveFilename;
  }
}

function activated(t: TestContext): LoadedExtension {
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
  return bundle;
}

/** A second live window: a new module, so its session state starts empty. */
function freshActivated(t: TestContext): LoadedExtension {
  delete require.cache[require.resolve(BUNDLE_PATH)];
  return activated(t);
}

test('a bare server host means the TLS server, with the endpoint the engine adds', () => {
  const { normaliseServerUrl } = addressHelpers();
  assert.equal(normaliseServerUrl('selvage.dontblameme.dev'), 'wss://selvage.dontblameme.dev');
  assert.equal(normaliseServerUrl('  selvage.dontblameme.dev  '), 'wss://selvage.dontblameme.dev');
  assert.equal(normaliseServerUrl('selvage.dontblameme.dev/'), 'wss://selvage.dontblameme.dev');
});

test('an address that names the endpoint loses it, and one with a path keeps it', () => {
  const { normaliseServerUrl } = addressHelpers();
  // The engine appends `/session` to the base it is given, so keeping it would dial it twice.
  assert.equal(normaliseServerUrl('wss://selvage.dontblameme.dev/session'), 'wss://selvage.dontblameme.dev');
  assert.equal(normaliseServerUrl('ws://127.0.0.1:8080/session/'), 'ws://127.0.0.1:8080');
  // A server behind a prefix was addressed deliberately, not mistyped.
  assert.equal(normaliseServerUrl('wss://selvage.dontblameme.dev/prefix'), 'wss://selvage.dontblameme.dev/prefix');
  assert.equal(normaliseServerUrl('ws://127.0.0.1:8080'), 'ws://127.0.0.1:8080');
});

test('a page origin is the server over the scheme a browser speaks, and the way back too', () => {
  const { pageOriginOf, serverBaseOf } = addressHelpers();
  assert.equal(pageOriginOf('wss://selvage.dontblameme.dev'), 'https://selvage.dontblameme.dev');
  assert.equal(pageOriginOf('ws://127.0.0.1:8080/'), 'http://127.0.0.1:8080');
  // A server behind a prefix is served there, so its page is linked there.
  assert.equal(pageOriginOf('wss://selvage.example/prefix'), 'https://selvage.example/prefix');
  assert.equal(serverBaseOf('https://selvage.dontblameme.dev'), 'wss://selvage.dontblameme.dev');
  assert.equal(serverBaseOf('http://127.0.0.1:8080'), 'ws://127.0.0.1:8080');
  assert.equal(serverBaseOf('https://selvage.example/prefix/'), 'wss://selvage.example/prefix');
  // One address, both halves: what a page is linked at is what a guest dials back.
  for (const base of ['wss://host', 'ws://127.0.0.1:8080', 'wss://host/prefix']) {
    assert.equal(serverBaseOf(pageOriginOf(base)), base);
  }
});

test('the change-server command completes a bare host and remembers the completion', async (t) => {
  const bundle = activated(t);
  await bundle.stub.commands.executeCommand('selvage.changeServer', {
    serverUrl: 'selvage.dontblameme.dev',
  });
  const confirmation = await waitFor(
    'the completion to be confirmed',
    () =>
      bundle.stub.registered.information.find((message: string) =>
        message.includes('will host on'),
      ) ?? false,
  );
  assert.equal(
    confirmation,
    'Selvage: will host on wss://selvage.dontblameme.dev next. Leave this session and host again to move there.',
  );
  assert.equal(bundle.stub.globalState.get('selvage.lastServer'), 'wss://selvage.dontblameme.dev');
});

test('hosting on a bare host dials the completed address', async (t) => {
  const bundle = activated(t);
  // A port nothing listens on: the address is completed and dialled, and the failure names
  // what was dialled. No server is contacted, so this says only what the client did with the
  // address it was typed.
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: '127.0.0.1:1',
    displayName: 'Ada',
  });
  const failure = await waitFor(
    'the host to fail on the completed address',
    () => bundle.stub.registered.errors.find((line: string) => line.includes('could not host')) ?? false,
  );
  assert.ok(
    failure.includes('could not host on wss://127.0.0.1:1.'),
    `the dialled address was not the completed one: ${failure}`,
  );
});

test('a clipboard the editor refuses is reported rather than claimed', async (t) => {
  const server = await FakeServer.start();
  t.after(() => server.stop());
  const bundle = activated(t);
  bundle.stub.registered.clipboardWriteThrows = 'the clipboard is not available';
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  const notice = await waitFor(
    'the failed copy to be reported',
    () =>
      bundle.stub.registered.warnings.find((line: string) =>
        line.includes('the room is open, but the invite link could not be copied'),
      ) ?? false,
  );
  assert.ok(notice.includes('the clipboard is not available'), `the cause was dropped: ${notice}`);
  assert.equal(
    bundle.stub.registered.information.some((line: string) => line.includes('it is on the clipboard')),
    false,
    'the clipboard refused the link and the notice claimed it anyway',
  );
  // The room still stands, which is the half of the sentence that says so.
  await bundle.stub.commands.executeCommand('selvage.copyInvite');
  assert.ok(
    bundle.stub.registered.warnings.some((line: string) =>
      line.includes('the invite link could not be copied (the clipboard is not available).'),
    ),
    `the copy command claimed the copy too: ${JSON.stringify(bundle.stub.registered.warnings)}`,
  );
});

test('a room this connection was given no link for is not "host or join a room first"', async (t) => {
  // A server that mints the room and hands the host no token: the one way a live room reaches
  // a client with nothing to hand on.
  const server = await FakeServer.start({ omitHostToken: true });
  t.after(() => server.stop());
  const bundle = activated(t);
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  const notice = await waitFor(
    'the room to open with no invite in hand',
    () =>
      bundle.stub.registered.warnings.find((line: string) =>
        line.includes('the room is open, but this connection holds no invite link to send.'),
      ) ?? false,
  );
  assert.ok(notice, 'the room opened with nothing to hand on and said nothing about it');
  await bundle.stub.commands.executeCommand('selvage.copyInvite');
  assert.ok(
    bundle.stub.registered.warnings.some((line: string) =>
      line.includes('this session holds no invite link to copy.'),
    ),
    `copying from a live room did not say what was missing: ${JSON.stringify(bundle.stub.registered.warnings)}`,
  );
  assert.equal(
    bundle.stub.registered.warnings.some((line: string) => line.includes('host or join a room first')),
    false,
    'a room that is open was reported as no room at all',
  );
});

test('hosting again on a room with nothing to hand on says so', async (t) => {
  const server = await FakeServer.start({ omitHostToken: true });
  t.after(() => server.stop());
  const bundle = activated(t);
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  await waitFor(
    'the room to open with no invite in hand',
    () =>
      bundle.stub.registered.warnings.find((line: string) =>
        line.includes('the room is open, but this connection holds no invite link to send.'),
      ) ?? false,
  );
  await bundle.stub.commands.executeCommand('selvage.host', { serverUrl: server.wsBase });
  assert.ok(
    bundle.stub.registered.warnings.some((line: string) =>
      line.includes(
        'you are already hosting this session, but this connection holds no invite link to send.',
      ),
    ),
    `hosting again went unsaid: ${JSON.stringify(bundle.stub.registered.warnings)}`,
  );
});

test('a window in no session still gets the sentence for that', async (t) => {
  const bundle = freshActivated(t);
  await bundle.stub.commands.executeCommand('selvage.copyInvite');
  assert.ok(
    bundle.stub.registered.warnings.some((line: string) =>
      line.includes('there is no invite link; host or join a room first.'),
    ),
    `the no-session sentence went missing: ${JSON.stringify(bundle.stub.registered.warnings)}`,
  );
});
