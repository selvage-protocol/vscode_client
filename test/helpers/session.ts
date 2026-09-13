/** A running server, and a host plus a guest connected to it. */

import type { ConnectOptions, SelvageEngine } from '../../src/engine/engine.ts';
import { SelvageEngine as Engine } from '../../src/engine/engine.ts';
import { FakeServer } from './fake-server.ts';
import type { FakeServerOptions } from './fake-server.ts';

export interface FakeSession {
  server: FakeServer;
  host: SelvageEngine;
  guest: SelvageEngine;
  invite: string;
}

/** Per-client options; `meta` is skipped unless a test is about `/meta`. */
export const TEST_OPTIONS: ConnectOptions = {
  baseUrl: '',
  displayName: '',
  meta: 'skip',
  client: 'selvage-test/0.1.0',
};

export function options(
  overrides: Partial<ConnectOptions> & { baseUrl: string; displayName: string },
): ConnectOptions {
  return { ...TEST_OPTIONS, ...overrides };
}

/** Starts a fake server with a host that minted a room, and a guest joined by invite URL. */
export async function fakeSession(
  serverOptions: FakeServerOptions = {},
  connectOptions: Partial<ConnectOptions> = {},
): Promise<FakeSession> {
  const server = await FakeServer.start(serverOptions);
  const host = await Engine.host(
    server.wsBase,
    'Ada',
    options({ baseUrl: server.wsBase, displayName: 'Ada', ...connectOptions }),
  );
  const invite = host.inviteUrl();
  if (invite === undefined) {
    throw new Error('the host was not given an invite URL');
  }
  const guest = await Engine.join(
    invite,
    'Bob',
    options({ baseUrl: server.wsBase, displayName: 'Bob', ...connectOptions }),
  );
  return { server, host, guest, invite };
}
