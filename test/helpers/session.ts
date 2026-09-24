/**
 * A running server, and a host plus a guest connected to it: the room's own side, for tests
 * that need two seats without driving them through the extension.
 *
 * The clocks are the server's to advertise, and the two below are short on purpose: §13.7
 * renews a held set on the renewal clock, so a test that waits for a hold or a caret needs a
 * sub-second one rather than the fifteen seconds a deployed server would state.
 */

import { LiveSession } from './live-session.ts';
import type { LiveOptions } from './live-session.ts';
import { FakeServer } from './fake-server.ts';
import type { FakeServerOptions } from './fake-server.ts';

/** The server's clocks for a test, fast enough to wait on and slow enough to be real. */
export const TEST_KEEPALIVE = { awareness_renew_ms: 300, awareness_expire_ms: 900 };

export interface FakeSession {
  server: FakeServer;
  host: LiveSession;
  guest: LiveSession;
  invite: string;
}

/** Per-client options. */
export const TEST_OPTIONS: LiveOptions = {
  baseUrl: '',
  displayName: '',
  client: 'selvage-test/0.1.0',
};

export function options(
  overrides: Partial<LiveOptions> & { baseUrl: string; displayName: string },
): LiveOptions {
  return { ...TEST_OPTIONS, ...overrides };
}

/** Starts a fake server with a host that minted a room, and a guest joined by invite URL. */
export async function fakeSession(
  serverOptions: FakeServerOptions = {},
  connectOptions: Partial<LiveOptions> = {},
): Promise<FakeSession> {
  const server = await FakeServer.start({
    keepalive: { ...TEST_KEEPALIVE, ...serverOptions.keepalive },
    ...serverOptions,
  });
  const host = await LiveSession.host(
    server.wsBase,
    'Ada',
    options({ baseUrl: server.wsBase, displayName: 'Ada', ...connectOptions }),
  );
  const invite = host.inviteUrl();
  if (invite === undefined) {
    throw new Error('the host was not given an invite URL');
  }
  const guest = await LiveSession.join(
    invite,
    'Bob',
    options({ baseUrl: server.wsBase, displayName: 'Bob', ...connectOptions }),
  );
  return { server, host, guest, invite };
}
