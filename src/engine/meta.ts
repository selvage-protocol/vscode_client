/**
 * `GET /meta` negotiation (spec §2, §10).
 *
 * The spec says a client *should* read `/meta` before connecting to fail fast on an
 * incompatible server. That is what the engine does by default, with two deliberate
 * rules: an unreachable `/meta` is not a reason to refuse to connect (the endpoint is
 * advisory, and the handshake reports the truth anyway), but a `/meta` that answers with
 * no compatible `wire_versions` is a refusal before a socket is opened.
 */

import { isCompatible } from './envelope.ts';
import type { Meta } from './envelope.ts';
import { metaUrl } from './urls.ts';

export interface MetaOptions {
  /** How long to wait for `/meta` before treating it as unreachable. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Reads and parses `/meta`. Throws when it is unreachable or not JSON. */
export async function fetchMeta(
  baseUrl: string,
  options: MetaOptions = {},
): Promise<Meta> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (fetchImpl === undefined) {
    throw new Error('no fetch implementation is available');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs ?? 2000);
  try {
    const response = await fetchImpl(metaUrl(baseUrl), {
      signal: controller.signal,
    });
    return (await response.json()) as Meta;
  } finally {
    clearTimeout(timer);
  }
}

/** True when `/meta` advertises a wire version this client can speak. */
export function metaAccepts(meta: Meta): boolean {
  const versions = meta.wire_versions;
  if (!Array.isArray(versions) || versions.length === 0) {
    // An implementation that says nothing about versions is not one that has said
    // something incompatible; the handshake decides.
    return true;
  }
  return versions.some(
    (offered) => typeof offered === 'string' && isCompatible(offered),
  );
}
