/**
 * The session envelope: the JSON shapes, the name vocabulary and the refusal codes of
 * `PROTOCOL.md` §4–§6 and §11
 * (https://github.com/selvage-protocol/specification).
 *
 * Unknown fields and unknown event names are ignored, so every shape here is
 * deliberately permissive: a peer that adds a field must never break this client.
 */

/** The wire version every session envelope carries. */
export const WIRE_VERSION = 'selvage/2';

/** WebSocket endpoint path. */
export const ENDPOINT_PATH = '/session';

/** Negotiation endpoint path, served over plain HTTP on the same listener. */
export const META_PATH = '/meta';

/** Capabilities this client believes it has. The server ignores ones it does not know. */
export const CLIENT_CAPABILITIES: readonly string[] = ['y-protocols/1', 'awareness'];

/** Server → client event names (§6). */
export const event = {
  roomCreated: 'room.created',
  roomJoined: 'room.joined',
  peerJoined: 'peer.joined',
  peerLeft: 'peer.left',
  peerRenamed: 'peer.renamed',
  roomGone: 'room.gone',
  sessionError: 'session.error',
} as const;

/** Machine-readable codes for `error.code` (§11). */
export const code = {
  unknownMethod: 'unknown_method',
  badMessage: 'bad_message',
  badParams: 'bad_params',
  helloRequired: 'hello_required',
  roomUnknown: 'room_unknown',
  tokenInvalid: 'token_invalid',
  roomGone: 'room_gone',
  hostPresent: 'host_present',
  alreadySeated: 'already_seated',
  docNotOpen: 'doc_not_open',
} as const;

/** WebSocket close codes, in the private-use range (§11). */
export const close = {
  protocolError: 4000,
  roomUnknown: 4001,
  tokenInvalid: 4002,
  roomGone: 4003,
  hostPresent: 4004,
} as const;

/**
 * The reserved namespace for a code an implementation defines for itself (§10.1, §11). A
 * handshake refused with one of these is as final as the bare codes below: §9.1 says it MUST
 * NOT be re-helloed automatically, whatever it means.
 */
const RESERVED_CODE_PREFIX = 'x.';

/** Refusals after which retrying the same URL cannot help (§9.1, §11). */
export const TERMINAL_CODES: readonly string[] = [
  code.roomUnknown,
  code.tokenInvalid,
  code.hostPresent,
  code.roomGone,
];

/**
 * A participant's role: `host` minted the room and signs its states, `guest` edits, and `viewer`
 * edits its own screen and publishes none of it (§13.4, §13.9).
 */
export type Role = 'host' | 'guest' | 'viewer';

/**
 * The protocol's bound on a display name: at most this many UTF-16 code units (§5). A name
 * over it is refused, never truncated: the server refuses the `session.hello` one would
 * arrive in, and receipt enforces the same bound, so a name past it never reaches the room.
 * Counting is `String.prototype.length`, which *is* UTF-16 code units — an astral character
 * costs two, where a code-point count would charge one.
 */
export const MAX_DISPLAY_NAME_UNITS = 32;

/** A participant as seen by the session layer. `awareness_client_id` is how a cursor is attributed. */
export interface PeerInfo {
  peer_id: string;
  display_name: string;
  role: Role;
  awareness_client_id?: number;
}

/** The session's awareness clock, advertised by the server (§8.2). */
export interface Keepalive {
  ping_interval_ms: number;
  awareness_renew_ms: number;
  awareness_expire_ms: number;
}

/**
 * The `keepalive` object of `GET /meta` (§2): the session's clocks, plus the room's grace
 * period, which the handshake reply has no place for. A host that has been detached is the
 * one connection that needs the grace and the one that is no longer there to be told, so it
 * is advertised before a session exists.
 */
export interface MetaKeepalive extends Keepalive {
  /** How long a room survives its host's connection ending (§9, §9.1). */
  room_grace_ms?: number;
}

export interface ErrorObject {
  code: string;
  message: string;
}

/** A server → client response or event (§4.2, §4.3). */
export interface ServerMessage {
  v?: string;
  id?: number;
  event?: string;
  params?: unknown;
  result?: unknown;
  error?: ErrorObject;
}

/** `GET /meta` response body (§2). */
export interface Meta {
  server?: string;
  wire_versions?: string[];
  capabilities?: string[];
  keepalive?: Partial<MetaKeepalive>;
  roles?: string[];
}

/** The keepalive a client runs on before the server has spoken. */
export const DEFAULT_KEEPALIVE: Keepalive = {
  ping_interval_ms: 30_000,
  awareness_renew_ms: 15_000,
  awareness_expire_ms: 30_000,
};

/**
 * True when a refusal or close code means the session cannot be resumed. Every code in the
 * reserved `x.` namespace is terminal, known or not, exactly as the Rust reference client
 * treats it: the namespace exists so an implementation can refuse without teaching every
 * client its word first, and §9.1 forbids re-helloeing any such refusal.
 */
export function isTerminalCode(codeName: string | undefined): boolean {
  return (
    codeName !== undefined &&
    (codeName.startsWith(RESERVED_CODE_PREFIX) || TERMINAL_CODES.includes(codeName))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads a string field, tolerating a missing or mistyped one. */
export function textField(
  value: unknown,
  key: string,
): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

/** Reads a numeric field, tolerating a missing or mistyped one. */
export function numberField(
  value: unknown,
  key: string,
): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field)
    ? field
    : undefined;
}

/**
 * Parses a text frame into a server message, or `undefined` when the frame is not a
 * JSON object. A peer that sends something else is told nothing and the session goes on:
 * an envelope this client cannot read is not a reason to drop a working connection.
 */
export function parseServerMessage(text: string): ServerMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const id = numberField(value, 'id');
  const error = value.error;
  return {
    v: textField(value, 'v'),
    id: id === undefined ? undefined : Math.trunc(id),
    event: textField(value, 'event'),
    params: value.params,
    result: value.result,
    error: isRecord(error)
      ? {
          code: textField(error, 'code') ?? 'error',
          message: textField(error, 'message') ?? 'the server reported a fault',
        }
      : undefined,
  };
}
