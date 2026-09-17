/**
 * The open path's gates: a host that opens a file shares it only when the room can carry
 * it — the grant's shape rule and the session's size bound, the same gates a peer's
 * request passes through. Opening an excluded, escaping or oversize file shares nothing
 * and says so once; a granted file still seeds, including one the window never saved;
 * a guest's opens never seed and never report.
 *
 * A bogus open-document set is one dialog however many paths failed it: the aggregation
 * half is pinned here against a stub engine, because the fake server only ever emits one
 * path per event.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import { SessionBridge } from '../src/bridge/bridge.ts';
import type { BridgeOptions, Engine } from '../src/bridge/bridge.ts';
import { MAX_GRANT_FILE_BYTES } from '../src/bridge/grant.ts';
import type { SessionInfo } from '../src/engine/engine.ts';
import type { EngineEvent, EngineEventListener } from '../src/engine/events.ts';
import { FakeEditor } from './helpers/fake-editor.ts';
import type { FakeServerOptions } from './helpers/fake-server.ts';
import { fakeSession } from './helpers/session.ts';
import { waitFor } from './helpers/wait.ts';

/** A host window and a guest window on one room, each with an editor of its own. */
async function twoWindows(
  t: TestContext,
  serverOptions: FakeServerOptions = {},
  bridgeOptions: Partial<Omit<BridgeOptions, 'engine' | 'host'>> = {},
): Promise<{
  session: Awaited<ReturnType<typeof fakeSession>>;
  host: { editor: FakeEditor; bridge: SessionBridge };
  guest: { editor: FakeEditor; bridge: SessionBridge };
}> {
  const session = await fakeSession(serverOptions);
  const hostEditor = new FakeEditor();
  const guestEditor = new FakeEditor();
  const hostBridge = new SessionBridge({
    ...bridgeOptions,
    engine: session.host as unknown as Engine,
    host: hostEditor,
  });
  const guestBridge = new SessionBridge({
    ...bridgeOptions,
    engine: session.guest as unknown as Engine,
    host: guestEditor,
  });
  hostEditor.attach(hostBridge);
  guestEditor.attach(guestBridge);
  t.after(async () => {
    hostBridge.dispose();
    guestBridge.dispose();
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  return {
    session,
    host: { editor: hostEditor, bridge: hostBridge },
    guest: { editor: guestEditor, bridge: guestBridge },
  };
}

test('opening an excluded file shares nothing and says so once', async (t) => {
  const { session, host } = await twoWindows(t);
  for (const path of ['.env', 'src/.env.local', '.git/config', 'id_rsa', 'certs/server.pem']) {
    host.editor.open(path, 'SECRET=1\n');
    host.bridge.documentOpened(path);
  }

  const refusals = await waitFor('the refusals to be reported', () =>
    host.editor.reportsOf('sessionError').length === 5
      ? host.editor.reportsOf('sessionError')
      : false,
  );
  for (const refusal of refusals) {
    assert.match(refusal.message, /will not share .* with the room/);
    assert.match(refusal.message, /nothing was shared for it/);
  }
  // Reopening a refused file re-fires the open event (focus, split) but reports nothing
  // new: one refusal per path per session.
  host.editor.open('.env', 'SECRET=1\n');
  host.bridge.documentOpened('.env');
  await host.editor.settle();
  assert.equal(host.editor.reportsOf('sessionError').length, 5);
  for (const path of ['.env', 'src/.env.local', '.git/config', 'id_rsa', 'certs/server.pem']) {
    assert.equal(session.host.has(path), false, `${path} entered the replica`);
  }

  // The replica was never seeded, so there is nothing for the room to converge on.
  await host.editor.settle();
  assert.equal(session.guest.text('.env'), '', 'an excluded file reached the guest');
});

test('opening an oversize file shares nothing, however the bytes count', async (t) => {
  const { session, host } = await twoWindows(t);

  // Over by one code unit: refused without encoding the buffer to count it.
  host.editor.open('big.log', 'a'.repeat(MAX_GRANT_FILE_BYTES + 1));
  host.bridge.documentOpened('big.log');
  // Under in code units but over in bytes: the exact count refuses it.
  host.editor.open('wide.log', 'é'.repeat(MAX_GRANT_FILE_BYTES / 2 + 1));
  host.bridge.documentOpened('wide.log');

  const refusals = await waitFor('the refusals to be reported', () =>
    host.editor.reportsOf('sessionError').length === 2
      ? host.editor.reportsOf('sessionError')
      : false,
  );
  for (const refusal of refusals) {
    assert.match(refusal.message, new RegExp(`over the ${MAX_GRANT_FILE_BYTES} bytes`));
  }
  assert.equal(session.host.has('big.log'), false);
  assert.equal(session.host.has('wide.log'), false);

  // Exactly the bound still seeds: the bound refuses over, not at.
  host.editor.open('full.log', 'a'.repeat(MAX_GRANT_FILE_BYTES));
  host.bridge.documentOpened('full.log');
  assert.equal(session.host.text('full.log').length, MAX_GRANT_FILE_BYTES);
});

test('typing a document past the size bound refuses the edit and publishes nothing', async (t) => {
  const { session, host } = await twoWindows(t);
  const path = 'notes.txt';
  const base = `${'a'.repeat(MAX_GRANT_FILE_BYTES - 64)}\n`;
  host.editor.open(path, base);
  host.bridge.documentOpened(path);
  await waitFor('the seed to reach the replica', () => session.host.text(path) === base);

  // Opened under the bound, typed past it: the keystroke is refused, not published.
  host.editor.type(path, `${base}${'b'.repeat(128)}`);
  await host.editor.settle();
  const refusal = await waitFor('the refusal to be reported', () =>
    host.editor.reportsOf('sessionError').length === 1
      ? host.editor.reportsOf('sessionError')[0]
      : false,
  );
  assert.match(refusal.message, /will not share notes\.txt with the room/);
  assert.match(refusal.message, new RegExp(`over the ${MAX_GRANT_FILE_BYTES} bytes`));
  assert.match(refusal.message, /nothing was shared for it/);
  assert.equal(session.host.text(path), base, 'the over-bound edit reached the replica');
  assert.equal(session.guest.text(path), base, 'the over-bound edit reached the guest');

  // Refused once per path: further keystrokes stay out without another dialog.
  host.editor.type(path, `${base}${'c'.repeat(128)}`);
  await host.editor.settle();
  assert.equal(host.editor.reportsOf('sessionError').length, 1, 'the refusal nagged again');
  assert.equal(session.host.text(path), base);
});

test('opening a path the grant could never carry shares nothing', async (t) => {
  const { session, host } = await twoWindows(t);

  const hostile = ['../evil', `src/${'x'.repeat(4096)}`, 'a\\b'];
  for (const path of hostile) {
    host.editor.open(path, 'hostile\n');
    host.bridge.documentOpened(path);
  }

  await waitFor('the refusals to be reported', () =>
    host.editor.reportsOf('sessionError').length === hostile.length ? true : false,
  );
  for (const path of hostile) {
    assert.equal(session.host.has(path), false, `${path} entered the replica`);
  }
});

test('a granted file still seeds, including one the window never saved', async (t) => {
  const { session, host } = await twoWindows(t);

  // Absent from the working copy: seeding an opened file reads no disk, so a new file
  // shares on open rather than waiting for its first save.
  host.editor.open('notes/new.md', 'new\n');
  host.bridge.documentOpened('notes/new.md');
  assert.equal(session.host.text('notes/new.md'), 'new\n');
  assert.deepEqual(host.editor.reads, [], 'seeding an opened file read the disk');
  await waitFor('the guest to see the new file', () =>
    session.guest.text('notes/new.md') === 'new\n' ? true : false,
  );
});

test('a guest opening anything seeds nothing and reports nothing', async (t) => {
  const { session, guest } = await twoWindows(t);

  guest.editor.open('.env', 'SECRET=1\n');
  guest.bridge.documentOpened('.env');

  await guest.editor.settle();
  assert.equal(session.guest.has('.env'), false, 'the guest seeded the room');
  assert.deepEqual(
    guest.editor.reportsOf('sessionError'),
    [],
    'the guest reported an open that seeds nothing anywhere',
  );
});

/** A stub engine holding no documents, so the bridge's requests all fail shut. */
function stubEngine(): { engine: Engine; emit(event: EngineEvent): void } {
  const listeners = new Set<EngineEventListener>();
  const engine = {
    session: (): SessionInfo => ({
      roomId: 'r-stub',
      role: 'host',
      peer: { peer_id: 'p-host', display_name: 'Ada', role: 'host' },
      peers: [],
      documents: [],
      capabilities: [],
      keepalive: {
        ping_interval_ms: 30_000,
        awareness_renew_ms: 15_000,
        awareness_expire_ms: 30_000,
      },
      baseUrl: '',
    }),
    text: () => '',
    has: () => false,
    open: () => Promise.resolve(),
    close: () => Promise.resolve(),
    insert: () => undefined,
    delete: () => undefined,
    setSelection: () => undefined,
    setAwareness: () => undefined,
    presence: () => [],
    resolveSelection: () => undefined,
    on: (listener: EngineEventListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    engine: engine as unknown as Engine,
    emit: (event: EngineEvent) => {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
  };
}

test('one bogus listing is one dialog, never one per path', async (t) => {
  const { engine, emit } = stubEngine();
  const editor = new FakeEditor();
  const bridge = new SessionBridge({ engine, host: editor, autoSave: false });
  t.after(() => {
    bridge.dispose();
  });

  emit({
    type: 'documentsChanged',
    documents: ['gone-1.txt', 'gone-2.txt', 'gone-3.txt', '../evil', '.env'],
  });

  const refusal = await waitFor('the aggregated refusal', () =>
    editor.reportsOf('sessionError')[0] ?? false,
  );
  assert.match(refusal.message, /could not share 3 paths the room asked for/);
  assert.match(refusal.message, /nothing was shared for them/);
  assert.equal(
    editor.reportsOf('sessionError').length,
    1,
    'a five-path listing reported exactly once',
  );
  // The ungrantable two were dropped silently: never read, never reported.
  assert.deepEqual(editor.reads, ['gone-1.txt', 'gone-2.txt', 'gone-3.txt']);

  // One failure on its own still reads as it always did.
  emit({ type: 'documentsChanged', documents: ['gone-4.txt'] });
  const single = await waitFor('the single refusal', () =>
    editor.reportsOf('sessionError').length === 2
      ? editor.reportsOf('sessionError')[1]
      : false,
  );
  assert.match(single.message, /not a readable file in the folder this window shares/);
});

test('a refused open leaves no document, no reconcile and no hold', async (t) => {
  const { session, host } = await twoWindows(t);
  host.editor.open('.env', 'SECRET=1\n');
  host.bridge.documentOpened('.env');

  await waitFor('the refusal to be reported', () =>
    host.editor.reportsOf('sessionError').length === 1 ? true : false,
  );
  assert.deepEqual(host.bridge.openDocuments(), [], 'a refused path stayed in documents');
  assert.equal(host.editor.text('.env'), 'SECRET=1\n', 'reconcile blanked the refused buffer');
  assert.equal(session.host.has('.env'), false, 'a refused file entered the replica');

  host.editor.type('.env', 'SECRET=2\n');
  await host.editor.settle();
  assert.equal(session.host.has('.env'), false, 'a later edit published a refused path');
  assert.equal(session.guest.text('.env'), '', 'a refused file reached the guest');
});
