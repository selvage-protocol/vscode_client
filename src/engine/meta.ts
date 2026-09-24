/**
 * `GET /meta` negotiation (spec §2, §10).
 *
 * The spec says a client *should* read `/meta` before connecting to fail fast on an
 * incompatible server. That is what the engine does by default, with two deliberate
 * rules: an unreachable `/meta` is not a reason to refuse to connect (the endpoint is
 * advisory, and the handshake reports the truth anyway), but a `/meta` that answers with
 * no compatible `wire_versions` is a refusal before a socket is opened.
 *
 * The same body settles which version a *hosting* client mints at, which §2 states with the
 * list: a client that can speak `selvage/2` mints it, a pin says otherwise, and a `/meta` that
 * answered without it is a refusal before a socket is opened. {@link hostVersion} is that rule.
 * A join never consults it — a join speaks the version its invite names (§5.1).
 */

import { isCompatible, parseVersion } from './envelope.ts';
import type { Meta } from './envelope.ts';
import { metaUrl, sessionBase } from './urls.ts';

/**
 * The encrypted wire's spelling, the same one `relay.ts` exports.
 *
 * It is written again here rather than imported, because `relay.ts` opens with `import WebSocket
 * from 'ws'` and the page's build refuses a bundle that mentions it: a module the negotiation
 * endpoint needs must not drag the socket implementation in behind it.
 */
const WIRE_VERSION_V2 = 'selvage/2';

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

/**
 * A version this client can put on a wire, spelled as §10 and an invite's URL spell it.
 */
export type WireVersion = 'selvage/1' | 'selvage/2';

/**
 * What a hosting client should do: mint at a version, or refuse with the reason to word and what to
 * word it from. A refusal is a decision of its own — never `selvage/1` in disguise — so a caller
 * cannot mistake a server that seats no encrypted wire for one to fall back to.
 */
export type HostDecision =
  | { readonly outcome: 'mint'; readonly version: WireVersion }
  | {
      readonly outcome: 'refuse';
      /** `/meta` answered and seats no version this client can speak at the encrypted wire's major. */
      readonly reason: 'not-seated';
      /** What `/meta` offered, as it wrote it: the versions a refusal names back. */
      readonly offered: readonly string[];
    }
  | {
      readonly outcome: 'refuse';
      readonly reason: 'pin-not-seated';
      readonly offered: readonly string[];
      /** The version the client is pinned to, which is the half a refusal has to name. */
      readonly pin: WireVersion;
    };

/** The versions a `/meta` body writes, ignoring a membership that is not a string. */
function offeredVersions(meta: Meta | undefined): string[] {
  const versions = meta?.wire_versions;
  return Array.isArray(versions) ? versions.filter((one) => typeof one === 'string') : [];
}

/**
 * True when `offered` holds a version at `version`'s major, which is §10's compatibility rule for
 * both versions here: the minor binds only while the major is 0, and neither spelling a pin uses
 * carries one.
 */
function offersMajor(offered: readonly string[], version: WireVersion): boolean {
  const wanted = parseVersion(version);
  if (wanted === undefined) {
    return false;
  }
  return offered.some((candidate) => {
    const parsed = parseVersion(candidate);
    return parsed !== undefined && parsed[0] === wanted[0];
  });
}

/**
 * Which wire version a client that can speak `selvage/2` hosts a room at, or the refusal that
 * stands where it would (`PROTOCOL.md` §2, §10). Pure, so every client can decide the same way.
 *
 * `meta` is what `fetchMeta` answered, and `undefined` is a `/meta` that could not be read at
 * all — unreachable, not JSON, no fetch. `pin` is a version the client's own setting names, and
 * `undefined` is a client that has not pinned anything.
 *
 * The rule is §2's, and the three cases are told apart deliberately:
 *
 * - **Unpinned, and the server seats the encrypted wire** — or said nothing about versions, or
 *   could not be read: mint `selvage/2`. A client that can speak it mints it, so a server
 *   advertising both moves a host onto the encrypted wire and never off it.
 * - **Unpinned, and `/meta` answered without it**: refuse. That is the one answer that says the
 *   server does not seat this version, and falling back to `selvage/1` would mint a room whose
 *   contents the server reads — the room the version exists to make impossible.
 * - **Pinned**: mint the pin, unless `/meta` answered and does not seat it, which §10 refuses
 *   rather than falling back from. A pin to `selvage/1` is the deliberate way to host a room the
 *   server can read.
 *
 * A `/meta` that could not be read is *not* the second case: it is no answer, the endpoint is
 * advisory, and the handshake reports the truth — a server that seats only `selvage/1` refuses a
 * `selvage/2` hello with `unsupported_version` (§11), which is loud.
 */
export function hostVersion(meta: Meta | undefined, pin?: WireVersion): HostDecision {
  const offered = offeredVersions(meta);
  // A body that says nothing about versions is not one that has said something incompatible,
  // the same reading `metaAccepts` takes of it.
  const answered = meta !== undefined && offered.length > 0;
  if (pin !== undefined) {
    if (answered && !offersMajor(offered, pin)) {
      return { outcome: 'refuse', reason: 'pin-not-seated', offered, pin };
    }
    return { outcome: 'mint', version: pin };
  }
  if (!answered || offersMajor(offered, WIRE_VERSION_V2)) {
    return { outcome: 'mint', version: WIRE_VERSION_V2 };
  }
  return { outcome: 'refuse', reason: 'not-seated', offered };
}

/**
 * Why a `selvage/2` join must not open a socket to this server, or `undefined` when it may
 * (`PROTOCOL.md` §2, §10).
 *
 * A join speaks the version its invite names, and an invite that carries §5.1's two keys names
 * `selvage/2`. A client that can speak it **MUST NOT** connect to a server whose reachable
 * `/meta` names no version at major 2, and **MUST NOT** fall back to `selvage/1` instead: that
 * would be a room the server reads, entered on the server's own word. The refusal is local,
 * before a socket, and names the version the client would need.
 *
 * `meta` is what `fetchMeta` answered, and `undefined` is a `/meta` that could not be read. That
 * is no answer, exactly as {@link hostVersion} reads it: the join is attempted and the handshake
 * decides, where a server that seats only `selvage/1` answers `unsupported_version`, loudly. A
 * body that names no versions at all has said nothing incompatible either.
 */
export function joinRefusal(meta: Meta | undefined, server?: string): string | undefined {
  const offered = offeredVersions(meta);
  if (meta === undefined || offered.length === 0 || offersMajor(offered, WIRE_VERSION_V2)) {
    return undefined;
  }
  const where = server === undefined ? 'this server' : server;
  return `${where} offers ${offered.join(', ')} and not ${WIRE_VERSION_V2}, which this invite needs: its room is encrypted, so it was not joined, and it is not joined in the clear instead`;
}
