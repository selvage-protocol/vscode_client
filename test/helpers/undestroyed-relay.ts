/**
 * A process that opens a `selvage/2` relay, seats it, and ends — destroying nothing.
 *
 * `test/helpers/undestroyed-session.ts` is the session's own clock; this is the relay's.
 * `RelaySession` runs the session's clocks on an interval of its own (`§13.8`), armed when the
 * connection is seated, and a caller that never disconnects used to be a process that never
 * ended. The socket is a stub and no server is involved: what is under test is the timer the
 * relay arms on its own account, and nothing else here holds the event loop.
 */

import { nodeCrypto } from '../../src/node/crypto.ts';
import { RelaySession } from '../../src/engine/relay.ts';
import { ControlledSocket } from './controlled-socket.ts';
import type { WebSocketFactory } from '../../src/engine/transport.ts';

const KEEPALIVE = {
  ping_interval_ms: 30_000,
  awareness_renew_ms: 300,
  awareness_expire_ms: 900,
};

const socket = new ControlledSocket();

/** The server's side of the handshake, played by hand: the mint is answered at once. */
const MINT_REPLY = JSON.stringify({
  v: 'selvage/2',
  id: 1,
  event: 'room.created',
  params: {
    room_id: 'Rt1m2e3r4',
    token: 'tok',
    self: { peer_id: 'p-host', display_name: 'Ada' },
    peers: [],
    capabilities: [],
    keepalive: KEEPALIVE,
  },
});

/**
 * The stub, upgraded as soon as the relay has handlers on it: the upgrade and the reply are
 * deferred one turn because the relay mints its keys before it dials.
 */
const webSocketFactory: WebSocketFactory = () => {
  setImmediate(() => {
    socket.open();
    socket.deliver(MINT_REPLY);
  });
  return socket;
};

const relay = await RelaySession.host({
  baseUrl: 'ws://127.0.0.1:9',
  displayName: 'Ada',
  listing: () => ['notes.txt'],
  webSocketFactory,
  crypto: nodeCrypto,
  keepalive: KEEPALIVE,
});

if (relay.sessionInfo().roomId !== 'Rt1m2e3r4') {
  process.stderr.write('the fixture was not seated in the room it was handed\n');
  process.exit(2);
}

// The relay is seated, so its interval has started, and it is never disconnected, which is the
// whole point of the fixture.
process.stdout.write('ready\n');
