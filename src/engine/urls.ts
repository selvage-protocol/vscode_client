/**
 * Room and token in the connection URL (spec §5.1). The invite URL *is* the WebSocket
 * URL, so this is what makes "share a link" literal — and why a client can connect with
 * the link alone, without being told a room id and token separately.
 *
 * A *base* is the server half: what `sessionUrl` appends the endpoint to and `metaUrl`
 * derives the `/meta` read from. `sessionBase` is the one reading of it, and `SessionBase`
 * is the type that says a value has been through it.
 */

import { ENDPOINT_PATH, META_PATH } from './envelope.ts';

/** The room/token part of a join URL. `room` absent means "mint a new room". */
export interface JoinQuery {
  room?: string;
  token?: string;
}

declare const sessionBaseBrand: unique symbol;

/**
 * A server base in the one spelling the engine reads: a `ws://`/`wss://` URL with an
 * authority, at most a path prefix, the scheme always written with `//`, and no
 * credentials, query, fragment or endpoint path. `sessionBase` is the only thing that
 * produces one, and every component that reads a base — `sessionUrl`, `metaUrl`,
 * `inviteUrl`, `SessionUrl.base`, `SessionInfo.baseUrl` — takes this type rather than a
 * `string`, so a component cannot be handed an un-normalised value and read a different
 * server out of it than the component that produced it. A `ws:` URL needs no `//`
 * (RFC 3986 §3), so the spelling is part of what has to be normalised rather than
 * something a caller can be trusted to have written.
 */
export type SessionBase = string & { readonly [sessionBaseBrand]: true };

/** A connection URL split into the server base and the room/token it carries. */
export interface SessionUrl {
  /** Scheme, authority and any path prefix — but not the endpoint path. */
  base: SessionBase;
  join: JoinQuery;
}

/** True for the characters RFC 3986 leaves unescaped. */
function isUnreserved(byte: number): boolean {
  return (
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    (byte >= 0x30 && byte <= 0x39) ||
    byte === 0x2d ||
    byte === 0x2e ||
    byte === 0x5f ||
    byte === 0x7e
  );
}

const decoder = new TextDecoder('utf-8', { fatal: false });
const encoder = new TextEncoder();

export function percentEncode(text: string): string {
  let out = '';
  for (const byte of encoder.encode(text)) {
    out = isUnreserved(byte)
      ? `${out}${String.fromCharCode(byte)}`
      : `${out}%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

export function percentDecode(text: string): string {
  const bytes: number[] = [];
  let literal = '';
  // What is not escaped is still bytes: a run of literal characters is encoded as UTF-8
  // as a whole, so a surrogate pair is not read as two code units and lost.
  const flush = (): void => {
    if (literal !== '') {
      bytes.push(...encoder.encode(literal));
      literal = '';
    }
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (
      char === '%' &&
      index + 3 <= text.length &&
      /^[0-9a-fA-F]{2}$/.test(text.slice(index + 1, index + 3))
    ) {
      flush();
      bytes.push(parseInt(text.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    literal += char;
  }
  flush();
  return decoder.decode(new Uint8Array(bytes));
}

export function parseJoinQuery(query: string): JoinQuery {
  const join: JoinQuery = {};
  for (const pair of query.split('&')) {
    if (pair === '') {
      continue;
    }
    const at = pair.indexOf('=');
    const key = at === -1 ? pair : pair.slice(0, at);
    const value = at === -1 ? '' : pair.slice(at + 1);
    if (key === 'room') {
      join.room = percentDecode(value);
    } else if (key === 'token') {
      join.token = percentDecode(value);
    }
  }
  return join;
}

/**
 * The socket scheme each spelling of a server address names: the scheme a socket is dialled
 * with, or the http(s) form a person and a page write the same server in. A base is never
 * handed on as `http(s)` — the engine's `/meta` read derives that spelling itself.
 */
const SOCKET_SCHEME: ReadonlyMap<string, string> = new Map([
  ['ws:', 'ws:'],
  ['wss:', 'wss:'],
  ['http:', 'ws:'],
  ['https:', 'wss:'],
]);

/**
 * The path a base may carry: any prefix a server is addressed under, without the endpoint
 * path the engine appends and without a trailing slash the URL builders would double.
 */
function basePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, '');
  if (!trimmed.endsWith(ENDPOINT_PATH)) {
    return trimmed;
  }
  return trimmed.slice(0, trimmed.length - ENDPOINT_PATH.length).replace(/\/+$/, '');
}

/**
 * Reads a server address in the one way this engine reads a base, or `undefined` when the
 * text names no server it can dial.
 *
 * The text may be spelled the way a link or a person writes it: either scheme, the
 * endpoint path or a trailing slash left on, the authority written out or — for a special
 * scheme, which needs no `//` — not. The base returned is always `scheme://authority`
 * plus any path prefix, because every consumer of a base decides by that spelling: the
 * scheme is matched as a prefix (`^ws://`, `^ws(s?)://`) and the endpoint is appended to
 * it. What it may not name is refused here instead: no authority (a `ws://` or a bare
 * `host:8080`, which parses as the scheme `host`), no `ws`/`wss`/`http`/`https` scheme,
 * and nothing that would put a different address in the request than the base reads as
 * naming — credentials, a query or a fragment.
 */
export function sessionBase(text: string): SessionBase | undefined {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return undefined;
  }
  const scheme = SOCKET_SCHEME.get(url.protocol);
  if (scheme === undefined || url.hostname === '') {
    return undefined;
  }
  if (url.username !== '' || url.password !== '') {
    return undefined;
  }
  if (url.search !== '' || url.hash !== '') {
    return undefined;
  }
  // The one place the brand is established, from what the URL parser read rather than from
  // the text as written.
  return `${scheme}//${url.host}${basePath(url.pathname)}` as SessionBase;
}

/**
 * Takes a full connection URL — in particular the invite URL a host publishes — apart
 * into the server base and the join query. Returns `undefined` when the URL does not
 * address the session endpoint, or when the base it names is not one this engine can
 * dial.
 */
export function parseSessionUrl(url: string): SessionUrl | undefined {
  const at = url.indexOf('?');
  const endpoint = at === -1 ? url : url.slice(0, at);
  const query = at === -1 ? '' : url.slice(at + 1);
  if (!endpoint.endsWith(ENDPOINT_PATH)) {
    return undefined;
  }
  const base = sessionBase(endpoint.slice(0, endpoint.length - ENDPOINT_PATH.length));
  if (base === undefined) {
    return undefined;
  }
  return { base, join: parseJoinQuery(query) };
}

/**
 * Builds the WebSocket URL for a connection. A host connection omits room and token.
 * Empty strings are treated as absent, so an invite cannot half-exist.
 */
export function sessionUrl(
  base: SessionBase,
  room?: string,
  token?: string,
): string {
  let url = `${base}${ENDPOINT_PATH}`;
  let separator = '?';
  for (const [key, part] of [
    ['room', room],
    ['token', token],
  ] as const) {
    if (part === undefined || part === '') {
      continue;
    }
    url = `${url}${separator}${key}=${percentEncode(part)}`;
    separator = '&';
  }
  return url;
}

/** The `GET /meta` URL for a session base URL. */
export function metaUrl(base: SessionBase): string {
  return `${base.replace(/^ws(s?):\/\//, 'http$1://')}${META_PATH}`;
}

/**
 * The invite URL for a session: the server, the room and the token. `undefined` when
 * there is no token to share — only the connection that minted the room has one.
 */
export function inviteUrl(session: {
  baseUrl: SessionBase;
  roomId: string;
  token?: string;
}): string | undefined {
  const { token } = session;
  if (token === undefined || token === '') {
    return undefined;
  }
  return sessionUrl(session.baseUrl, session.roomId, token);
}
