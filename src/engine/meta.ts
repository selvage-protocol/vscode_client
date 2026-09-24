/**
 * `GET /meta` (spec §2).
 *
 * The endpoint is advisory: it carries the server's identity, its capabilities and its
 * keepalive/grace values, and a client reads the grace from it to size a retry budget. An
 * endpoint that cannot be read decides nothing — the handshake reports the truth.
 */

import type { Meta } from './envelope.ts';
import { metaUrl, sessionBase } from './urls.ts';

export interface MetaOptions {
  /** How long to wait for `/meta` before treating it as unreachable. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Reads and parses `/meta`. Throws when it is unreachable, not JSON, or addressed at
 * something that is not a session base — the address is read the one way the engine reads
 * a base (`sessionBase`), so `ws:host` and `wss://host/` are read here as they are dialled.
 */
export async function fetchMeta(
  baseUrl: string,
  options: MetaOptions = {},
): Promise<Meta> {
  const base = sessionBase(baseUrl);
  if (base === undefined) {
    throw new Error(`not a session address: ${baseUrl}`);
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (fetchImpl === undefined) {
    throw new Error('no fetch implementation is available');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs ?? 2000);
  try {
    const response = await fetchImpl(metaUrl(base), {
      signal: controller.signal,
    });
    return (await response.json()) as Meta;
  } finally {
    clearTimeout(timer);
  }
}
