/**
 * A process that opens `selvage/2` sessions, destroys none of them, and ends.
 *
 * It is the subject of `test/timers.test.ts`: a session holds a clock — `y-protocols`' awareness
 * interval — and one that is never destroyed used to hold the whole process open with it. The
 * test runs this file and requires it to exit on its own, so a timer that keeps the event loop
 * alive is a red test rather than a machine that hangs until someone notices.
 *
 * Both halves are here: a guest session, and a host session with §7.1's producer under it.
 */

import { nodeCrypto } from '../../src/node/crypto.ts';
import { PeerSession } from '../../src/engine/peer.ts';
import { mintSessionKey } from '../../src/engine/sealed.ts';

const KEEPALIVE = {
  ping_interval_ms: 30_000,
  awareness_renew_ms: 300,
  awareness_expire_ms: 900,
};

const hostSeed = new Uint8Array(32).fill(3);
const hostKey = await mintSessionKey(nodeCrypto, hostSeed);
if (hostKey === undefined) {
  process.stderr.write('the fixture could not mint the host key\n');
  process.exit(2);
}

const host = await PeerSession.create({
  roomId: 'Rt1m2e3r4',
  roomKey: new Uint8Array(32).fill(7),
  hostKey: hostKey.public,
  keepalive: KEEPALIVE,
  crypto: nodeCrypto,
  seat: 'p-host',
  host: { hostSeed, listing: () => ['notes.txt'] },
});

const guest = await PeerSession.create({
  roomId: 'Rt1m2e3r4',
  roomKey: new Uint8Array(32).fill(7),
  hostKey: hostKey.public,
  keepalive: KEEPALIVE,
  crypto: nodeCrypto,
  seat: 'p-guest',
  roster: ['p-host', 'p-guest'],
});

if (host === undefined || guest === undefined) {
  process.stderr.write('the fixture could not open its sessions\n');
  process.exit(3);
}

// Both sessions have now started the awareness clock, which is the timer under test; neither
// is destroyed, which is the whole point of the fixture.
process.stdout.write('ready\n');
