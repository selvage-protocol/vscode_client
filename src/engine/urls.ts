/**
 * Room and token in the connection URL (spec §5.1). The invite URL *is* the WebSocket
 * URL, so this is what makes "share a link" literal — and why a client can connect with
 * the link alone, without being told a room id and token separately.
 */

import { ENDPOINT_PATH, META_PATH } from './envelope.ts';

/** The room/token part of a join URL. `room` absent means "mint a new room". */
export interface JoinQuery {
  room?: string;
  token?: string;
}

/** A connection URL split into the server base and the room/token it carries. */
export interface SessionUrl {
  /** Scheme, authority and any path prefix — but not the endpoint path. */
  base: string;
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
    literal += char === '+' ? ' ' : char;
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
 * Takes a full connection URL — in particular the invite URL a host publishes — apart
 * into the server base and the join query. Returns `undefined` when the URL does not
 * address the session endpoint.
 */
export function parseSessionUrl(url: string): SessionUrl | undefined {
  const at = url.indexOf('?');
  const endpoint = at === -1 ? url : url.slice(0, at);
  const query = at === -1 ? '' : url.slice(at + 1);
  if (!endpoint.endsWith(ENDPOINT_PATH)) {
    return undefined;
  }
  return {
    base: endpoint.slice(0, endpoint.length - ENDPOINT_PATH.length),
    join: parseJoinQuery(query),
  };
}

/**
 * Builds the WebSocket URL for a connection. A host connection omits room and token.
 * Empty strings are treated as absent, so an invite cannot half-exist.
 */
export function sessionUrl(
  base: string,
  room?: string,
  token?: string,
): string {
  let url = `${base.replace(/\/+$/, '')}${ENDPOINT_PATH}`;
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
export function metaUrl(base: string): string {
  const http = base.replace(/^ws(s?):\/\//, 'http$1://');
  return `${http.replace(/\/+$/, '')}${META_PATH}`;
}

/**
 * The invite URL for a session: the server, the room and the token. `undefined` when
 * there is no token to share — only the connection that minted the room has one.
 */
export function inviteUrl(session: {
  baseUrl: string;
  roomId: string;
  token?: string;
}): string | undefined {
  const { token } = session;
  if (token === undefined || token === '') {
    return undefined;
  }
  return sessionUrl(session.baseUrl, session.roomId, token);
}
