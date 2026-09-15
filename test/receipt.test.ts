/**
 * Receipt-side validation: a guest that joins a stranger's server treats its listings,
 * documents, names and frames as untrusted input. A hostile `doc.granted`, `doc.opened`,
 * `peer.joined` / `peer.renamed` or over-bound frame is filtered or refused — bounded,
 * silently, with the session going on — never allocated whole and never fanned out into
 * one dialog per path.
 *
 * The peer is a socket the test drives (`ControlledSocket`), so the frames a fake server
 * would never produce on demand can be delivered exactly. Delivery is synchronous — the
 * engine handles a frame in the `onmessage` call — so the assertions below read state
 * directly rather than polling for it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import { SelvageEngine } from '../src/engine/engine.ts';
import { MAX_GRANT_PATHS, MAX_GRANT_PATH_BYTES } from '../src/bridge/grant.ts';
import { MAX_DISPLAY_NAME_UNITS } from '../src/engine/envelope.ts';
import { ControlledSocket } from './helpers/controlled-socket.ts';
import { waitFor } from './helpers/wait.ts';

const KEEPALIVE = {
  ping_interval_ms: 30_000,
  awareness_renew_ms: 15_000,
  awareness_expire_ms: 30_000,
};

/** An engine seated on a socket the test drives. */
async function seated(t: TestContext): Promise<{
  engine: SelvageEngine;
  socket: ControlledSocket;
}> {
  const socket = new ControlledSocket();
  const attempted = SelvageEngine.host('ws://controlled.test', 'Ada', {
    meta: 'skip',
    reconnect: false,
    webSocketFactory: () => socket,
  });
  let engine: SelvageEngine | undefined;
  void attempted.then((seatedEngine) => {
    engine = seatedEngine;
  });
  t.after(async () => {
    await engine?.disconnect();
  });
  await waitFor('the engine to attach its handlers', () => socket.onopen !== null);
  socket.open();
  await waitFor('the engine to send session.hello', () => (socket.sent.length > 0 ? true : false));
  socket.deliver(
    JSON.stringify({
      v: 'selvage/1',
      event: 'room.created',
      params: {
        room_id: 'r-secure1',
        token: 'tok',
        self: { peer_id: 'p-host', display_name: 'Ada', role: 'host' },
        peers: [],
        documents: [],
        capabilities: [],
        keepalive: KEEPALIVE,
      },
    }),
  );
  return {
    engine: await waitFor('the handshake to complete', () => engine ?? false),
    socket,
  };
}

/** A server event frame, as a hostile server would send it. */
function event(name: string, params: unknown): string {
  return JSON.stringify({ v: 'selvage/1', event: name, params });
}

test('a hostile listing is filtered to what the grant would publish', async (t) => {
  const { engine, socket } = await seated(t);
  const overLong = `x/${'y'.repeat(MAX_GRANT_PATH_BYTES)}`;

  socket.deliver(
    event('doc.granted', {
      paths: [
        'src/main.rs',
        '..',
        'src/../../etc/passwd',
        '/etc/passwd',
        '.env',
        'src/.env.local',
        '.GIT/config',
        'NODE_MODULES/dep/index.js',
        'id_rsa',
        'certs/server.pem',
        'a\\b.txt',
        'src//x',
        'src/./x',
        'src/a\u202eb.txt',
        overLong,
        42,
        null,
        'README.md',
      ],
    }),
  );

  assert.deepEqual(
    engine.grantedPaths(),
    ['src/main.rs', 'README.md'],
    'the replica holds only what the grant would publish',
  );

  // The session goes on: a later honest listing still lands whole.
  socket.deliver(event('doc.granted', { paths: ['docs/guide.md'] }));
  assert.deepEqual(engine.grantedPaths(), ['docs/guide.md']);
});

test('an oversized listing is truncated to the listing bound, never allocated whole', async (t) => {
  const { engine, socket } = await seated(t);
  const paths = Array.from({ length: 100_000 }, (_, index) => {
    const padded = String(index).padStart(6, '0');
    return `tree/file-${padded}.txt`;
  });

  socket.deliver(event('doc.granted', { paths }));

  assert.equal(
    engine.grantedPaths().length,
    MAX_GRANT_PATHS,
    'a 100k-path listing is a bounded grant, not a wedged session',
  );
  assert.deepEqual(engine.grantedPaths().slice(0, 2), ['tree/file-000000.txt', 'tree/file-000001.txt']);

  // A frame with no listing at all changes nothing and reports nothing.
  socket.deliver(event('doc.granted', { paths: 'not-a-listing' }));
  assert.equal(engine.grantedPaths().length, MAX_GRANT_PATHS);
  socket.deliver(event('doc.granted', {}));
  assert.equal(engine.grantedPaths().length, MAX_GRANT_PATHS);
});

test('a hostile open-document set is filtered the same way', async (t) => {
  const { engine, socket } = await seated(t);

  socket.deliver(
    event('doc.opened', {
      peer_id: 'p-evil',
      path: 'ok.ts',
      documents: ['ok.ts', '../evil', '.env', '.GIT/x', 7, 'a\\b'],
    }),
  );

  assert.deepEqual(engine.documents(), ['ok.ts']);

  socket.deliver(
    event('doc.closed', {
      peer_id: 'p-evil',
      path: 'ok.ts',
      documents: ['still-open.ts', '..', '.env'],
    }),
  );
  assert.deepEqual(engine.documents(), ['still-open.ts']);

  // Garbage where the set belongs is refused, not emitted as news.
  let emitted = 0;
  const stop = engine.on((incoming) => {
    if (incoming.type === 'documentsChanged') {
      emitted += 1;
    }
  });
  socket.deliver(event('doc.opened', { peer_id: 'p-evil', path: 'x' }));
  assert.equal(emitted, 0, 'a set that says nothing new emits nothing');
  stop();
});

test('a display name past the protocol bound never reaches the room', async (t) => {
  const { engine, socket } = await seated(t);
  assert.equal(MAX_DISPLAY_NAME_UNITS, 32);

  const exact = 'a'.repeat(MAX_DISPLAY_NAME_UNITS);
  socket.deliver(
    event('peer.joined', { peer_id: 'p-ok', display_name: exact, role: 'guest' }),
  );
  assert.ok(
    engine.peers().some((peer) => peer.peer_id === 'p-ok'),
    'a name exactly at the bound is a peer',
  );

  socket.deliver(
    event('peer.joined', {
      peer_id: 'p-long',
      display_name: 'b'.repeat(MAX_DISPLAY_NAME_UNITS + 1),
      role: 'guest',
    }),
  );
  assert.ok(
    !engine.peers().some((peer) => peer.peer_id === 'p-long'),
    'a name one unit over is not a peer',
  );

  // The bound counts UTF-16 code units, not characters: sixteen emoji are a name, seventeen
  // are not.
  socket.deliver(
    event('peer.joined', { peer_id: 'p-emoji', display_name: '😀'.repeat(16), role: 'guest' }),
  );
  assert.ok(engine.peers().some((peer) => peer.peer_id === 'p-emoji'));
  socket.deliver(
    event('peer.joined', {
      peer_id: 'p-emojis',
      display_name: '😀'.repeat(17),
      role: 'guest',
    }),
  );
  assert.ok(!engine.peers().some((peer) => peer.peer_id === 'p-emojis'));

  // A rename past the bound is ignored, and the live name stays the one in force.
  socket.deliver(
    event('peer.renamed', { peer_id: 'p-ok', display_name: 'c'.repeat(40) }),
  );
  assert.equal(
    engine.peers().find((peer) => peer.peer_id === 'p-ok')?.display_name,
    exact,
  );
  socket.deliver(event('peer.renamed', { peer_id: 'p-ok', display_name: 'Cleo' }));
  assert.equal(
    engine.peers().find((peer) => peer.peer_id === 'p-ok')?.display_name,
    'Cleo',
  );
});

test('an over-bound text frame is refused without wedging the session', async (t) => {
  const { engine, socket } = await seated(t);

  // A `doc.granted` over the transport's bound, padded with an unknown field the parser
  // ignores: refused before `JSON.parse` ever sees it.
  const padding = 'x'.repeat(17 * 1024 * 1024);
  socket.deliver(
    JSON.stringify({
      v: 'selvage/1',
      event: 'doc.granted',
      params: { paths: ['big-room-file.txt'], junk: padding },
    }),
  );
  assert.deepEqual(engine.grantedPaths(), [], 'the over-bound frame changed nothing');

  // What follows still arrives: the refusal wedged nothing.
  socket.deliver(event('doc.granted', { paths: ['small-room-file.txt'] }));
  assert.deepEqual(engine.grantedPaths(), ['small-room-file.txt']);
});

test('an over-bound binary frame is refused without wedging the session', async (t) => {
  const { engine, socket } = await seated(t);
  const { encodeUpdate } = await import('../src/engine/sync.ts');
  const Y = await import('yjs');

  // A well-formed update over the transport's bound: seventeen megabytes that would
  // grow the replica on a peer's word. Zeros would prove nothing — the decoder drops
  // what it cannot read with or without the guard — so this one would apply.
  const big = new Y.Doc();
  big.getText('src/main.rs').insert(0, 'a'.repeat(17 * 1024 * 1024));
  socket.deliverBinary(encodeUpdate(Y.encodeStateAsUpdate(big)));
  assert.equal(engine.text('src/main.rs'), '', 'the over-bound update changed nothing');

  // The replica still applies what arrives after it. Applying a frame is synchronous —
  // the update lands in the `deliverBinary` call — so the read below is the assertion.
  const doc = new Y.Doc();
  doc.getText('src/main.rs').insert(0, 'after\n');
  socket.deliverBinary(encodeUpdate(Y.encodeStateAsUpdate(doc)));
  assert.equal(engine.text('src/main.rs'), 'after\n');
});
