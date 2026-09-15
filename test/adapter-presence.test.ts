/**
 * Presence through the built extension, with the editor API stubbed and a fake `selvaged` in
 * the room: a burst of caret events reaches the room as one frame rather than one per event,
 * the last position is never lost, and leaving the shared document clears the cursor.
 *
 * The frames are counted at a second engine in the room, whose socket tallies what the server
 * relays to it. A peer's own view cannot count them: a repeated identical state is deliberately
 * invisible to the peer (y-protocols guards its `change` event), so only the wire knows.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import { SelvageEngine } from '../src/engine/engine.ts';
import { virtualUri } from '../src/bridge/virtual.ts';
import { loadBundle } from './helpers/bundle.ts';
import type { LoadedExtension } from './helpers/bundle.ts';
import { FakeServer } from './helpers/fake-server.ts';
import { counting } from './helpers/counting-socket.ts';
import type { Counting } from './helpers/counting-socket.ts';
import { options } from './helpers/session.ts';
import { record, waitFor, waitForSelection } from './helpers/wait.ts';

const PATH = 'src/main.rs';
const TEXT = 'hello world\n';

interface Adapter {
  bundle: LoadedExtension;
  /** The other end of the room: what it receives is what the adapter published. */
  host: SelvageEngine;
  tap: Counting;
  /** The window's caret moved into the shared document, as an editor event. */
  move(at: number): void;
  /** The window left the shared document. */
  clear(): void;
}

/** A guest adapter joined to a room with one shared document, seated and counting frames. */
async function seat(t: TestContext): Promise<Adapter> {
  const tap = counting();
  const server = await FakeServer.start();
  const host = await SelvageEngine.host(
    server.wsBase,
    'Ada',
    options({
      baseUrl: server.wsBase,
      displayName: 'Ada',
      reconnect: false,
      webSocketFactory: tap.factory,
    }),
  );
  const invite = host.inviteUrl();
  assert.ok(invite !== undefined, 'the host was given no invite URL');
  await host.open(PATH);
  host.insert(PATH, 0, TEXT);

  const bundle = loadBundle();
  bundle.stub.reset();
  bundle.activate({ subscriptions: [] });
  t.after(async () => {
    bundle.deactivate();
    await host.disconnect();
    await server.stop();
  });

  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room')),
  );

  const uriString = virtualUri(host.session().roomId, PATH);
  const question = uriString.indexOf('?');
  const document = {
    uri: {
      scheme: 'selvage',
      path: uriString.slice(uriString.indexOf('/'), question),
      query: uriString.slice(question + 1),
      toString: () => uriString,
    },
    eol: 1,
    isDirty: false,
    getText: () => TEXT,
    positionAt: (offset: number) => offset,
    offsetAt: (position: number) => position,
    save: () => Promise.resolve(true),
  };
  const editor = {
    document,
    selection: { anchor: 0, active: 0 },
    setDecorations: () => undefined,
  };
  bundle.stub.fire('openTextDocument', document);
  bundle.stub.window.activeTextEditor = editor;
  // The replica has to hold the room's text before an offset in it means anything.
  await waitFor('the guest replica to hold the room text', () => {
    const files = bundle.registered.files;
    if (files === undefined) {
      return false;
    }
    try {
      const bytes = files.readFile(document.uri);
      // A read of a path the replica has not received answers with a promise, which is not
      // yet the room's text: the wait polls until the synchronous answer holds it.
      return bytes instanceof Uint8Array && new TextDecoder().decode(bytes) === TEXT;
    } catch {
      return false;
    }
  });
  // Counted from here: seating published its own presence before the room had a caret in it.
  tap.reset();

  return {
    bundle,
    host,
    tap,
    move(at: number): void {
      editor.selection = { anchor: at, active: at };
      bundle.stub.window.activeTextEditor = editor;
      bundle.stub.fire('selection');
    },
    clear(): void {
      bundle.stub.window.activeTextEditor = undefined;
      bundle.stub.fire('selection');
    },
  };
}

test('a burst of caret moves publishes one presence frame, at the last position', async (t) => {
  const adapter = await seat(t);
  const last = TEXT.length - 1;
  const started = performance.now();
  for (let i = 0; i < 200; i += 1) {
    adapter.move((i % last) + 1);
  }
  adapter.move(last);
  const elapsed = performance.now() - started;

  const seen = await waitForSelection(adapter.host, 'Bob', PATH, (selection) => selection.anchor === last);
  assert.deepEqual(seen.selection, { anchor: last, head: last });
  // The throttle flushes at most once per 100 ms, so a burst's cursor frames are a function of
  // how long the burst took, not of how many events it held. Bound it by that time — a loaded
  // machine must not turn correct coalescing into a failure — which still catches the defect this
  // pins: one frame per event would be 200.
  const allowed = Math.ceil(elapsed / 100) + 1;
  assert.ok(
    adapter.tap.tally.received.awarenessSelection <= allowed,
    `200 caret events over ${elapsed.toFixed(1)}ms sent ${adapter.tap.tally.received.awarenessSelection} cursor frames (allowed ${allowed})`,
  );
});

test('a caret that has not moved adds no frame', async (t) => {
  const adapter = await seat(t);
  adapter.move(3);
  await waitForSelection(adapter.host, 'Bob', PATH, (selection) => selection.anchor === 3);

  adapter.tap.reset();
  for (let i = 0; i < 50; i += 1) {
    adapter.move(3);
  }
  // A later, different position is how the flush's own frame is known to have gone: it is
  // one frame whether the fifty identical events were coalesced or silently deduped.
  adapter.move(4);
  await waitForSelection(adapter.host, 'Bob', PATH, (selection) => selection.anchor === 4);
  assert.equal(
    adapter.tap.tally.received.awarenessSelection,
    1,
    'an unmoved caret was published again',
  );
});

test('a session that ends inside the interval still publishes the last position', async (t) => {
  const adapter = await seat(t);
  const events = record(adapter.host);
  const last = TEXT.length - 1;
  adapter.move(last);
  // No interval elapses first: the position is still in the adapter's timer when the
  // session ends, and losing it there is the failure this pins.
  adapter.bundle.deactivate();

  await waitFor('the final caret to reach the room', () => {
    for (const event of events.events) {
      if (event.type !== 'presenceChanged') {
        continue;
      }
      for (const presence of event.presence) {
        if (presence.peer?.display_name !== 'Bob' || presence.state?.path !== PATH) {
          continue;
        }
        const published = presence.state.selection;
        if (published === undefined) {
          continue;
        }
        const resolved = adapter.host.resolveSelection(PATH, published);
        if (resolved !== undefined && resolved.anchor === last) {
          return true;
        }
      }
    }
    return false;
  }, { describe: () => ({ events: events.types(), hostText: adapter.host.text(PATH) }) });
});

test('leaving the shared document clears the cursor rather than dropping the event', async (t) => {
  const adapter = await seat(t);
  adapter.move(3);
  await waitForSelection(adapter.host, 'Bob', PATH, (selection) => selection.anchor === 3);

  adapter.clear();
  await waitFor(
    "Bob's cursor to be gone",
    () =>
      adapter.host
        .presence()
        .some((presence) => presence.peer?.display_name === 'Bob' && presence.state?.path !== undefined) ===
      false,
    { describe: () => adapter.host.presence() },
  );
});
