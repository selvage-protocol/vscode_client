/**
 * The `selvage/1` session envelope: the JSON shapes, the name vocabulary and the
 * compatibility rules of `PROTOCOL.md` §4–§6, §10 and §11
 * (https://github.com/selvage-protocol/specification).
 *
 * Unknown fields and unknown event names are ignored, so every shape here is
 * deliberately permissive: a peer that adds a field must never break this client.
 */

/** Wire version carried in every session envelope. */
export const WIRE_VERSION = 'selvage/1';

/** WebSocket endpoint path. */
export const ENDPOINT_PATH = '/session';

/** Negotiation endpoint path, served over plain HTTP on the same listener. */
export const META_PATH = '/meta';

/** Capabilities this client believes it has. The server ignores ones it does not know. */
export const CLIENT_CAPABILITIES: readonly string[] = ['y-protocols/1', 'awareness'];

/** Client → server method names (§5). */
export const method = {
  sessionHello: 'session.hello',
  rename: 'session.rename',
  docOpen: 'doc.open',
  docClose: 'doc.close',
  docGrant: 'doc.grant',
} as const;

/** Server → client event names (§6). */
export const event = {
  roomCreated: 'room.created',
  roomJoined: 'room.joined',
  peerJoined: 'peer.joined',
  peerLeft: 'peer.left',
  peerRenamed: 'peer.renamed',
  docOpened: 'doc.opened',
  docClosed: 'doc.closed',
  docGranted: 'doc.granted',
  hostDetached: 'host.detached',
  hostAttached: 'host.attached',
  roomGone: 'room.gone',
  sessionError: 'session.error',
} as const;

/** Machine-readable codes for `error.code` (§11). */
export const code = {
  unknownMethod: 'unknown_method',
  badMessage: 'bad_message',
  badParams: 'bad_params',
  helloRequired: 'hello_required',
  unsupportedVersion: 'unsupported_version',
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
  unsupportedVersion: 4005,
} as const;

/** Refusals after which retrying the same URL cannot help (§9.1, §11). */
export const TERMINAL_CODES: readonly string[] = [
  code.roomUnknown,
  code.tokenInvalid,
  code.hostPresent,
  code.unsupportedVersion,
  code.roomGone,
];

export type Role = 'host' | 'guest';

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

export interface ErrorObject {
  code: string;
  message: string;
}

/** A client → server request (§4.1). */
export interface ClientMessage {
  v: string;
  id: number;
  method: string;
  params?: unknown;
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

/** The reply to `session.hello` (§6.1, §6.2). */
export interface SessionParams {
  room_id: string;
  token?: string;
  self: PeerInfo;
  peers?: PeerInfo[];
  documents?: string[];
  capabilities?: string[];
  keepalive?: Partial<Keepalive>;
}

/** The result of `doc.open` / `doc.close` (§5). */
export interface DocSet {
  documents?: string[];
}

/** `doc.opened` / `doc.closed` params (§6). */
export interface DocEvent {
  peer_id: string;
  path: string;
  documents?: string[];
}

/** `session.rename` params (§5). */
export interface RenameParams {
  display_name: string;
}

/**
 * `doc.grant` / `doc.granted` params (§5, §6.3): the whole listing, replacing whatever the
 * room or this replica held. The order is the publisher's claim and is carried unchanged.
 */
export interface GrantParams {
  paths: string[];
}

/** `peer.renamed` params (§6): the peer whose name changed, and the name now in force. */
export interface PeerRenamed {
  peer_id: string;
  display_name: string;
}

/** `GET /meta` response body (§2). */
export interface Meta {
  server?: string;
  wire_versions?: string[];
  capabilities?: string[];
  keepalive?: Partial<Keepalive>;
  roles?: string[];
}

/** The keepalive a client runs on before the server has spoken. */
export const DEFAULT_KEEPALIVE: Keepalive = {
  ping_interval_ms: 30_000,
  awareness_renew_ms: 15_000,
  awareness_expire_ms: 30_000,
};

/**
 * The wire version grammar §10 and `schema/negotiation.json` fix:
 * `selvage/` major [ "." minor ], with both numbers written as §2.4 does, so neither
 * carries a leading zero (CANONICAL.md §2.5).
 */
const WIRE_VERSION_GRAMMAR = /^selvage\/(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*))?$/;

/** Parses `selvage/<major>[.<minor>]`, with the minor defaulting to 0. */
export function parseVersion(version: string): [number, number] | undefined {
  const grammar = WIRE_VERSION_GRAMMAR.exec(version);
  if (grammar === null) {
    return undefined;
  }
  const major = grammar[1];
  const minor = grammar[2];
  return [Number(major), minor === undefined ? 0 : Number(minor)];
}

/**
 * True when `version` can be spoken with this implementation: same major, and while at
 * 0.x also the same minor (§10). A malformed version is never compatible.
 */
export function isCompatible(version: string): boolean {
  const parsed = parseVersion(version);
  const ours = parseVersion(WIRE_VERSION);
  if (parsed === undefined || ours === undefined) {
    return false;
  }
  const [major, minor] = parsed;
  const [ourMajor, ourMinor] = ours;
  if (major !== ourMajor) {
    return false;
  }
  return ourMajor !== 0 || minor === ourMinor;
}

/** The close code the server pairs with a fatal session error code. */
export function closeCodeFor(codeName: string): number {
  switch (codeName) {
    case code.roomUnknown:
      return close.roomUnknown;
    case code.tokenInvalid:
      return close.tokenInvalid;
    case code.roomGone:
      return close.roomGone;
    case code.hostPresent:
      return close.hostPresent;
    case code.unsupportedVersion:
      return close.unsupportedVersion;
    default:
      return close.protocolError;
  }
}

/** True when a refusal or close code means the session cannot be resumed. */
export function isTerminalCode(codeName: string | undefined): boolean {
  return codeName !== undefined && TERMINAL_CODES.includes(codeName);
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

/** A peer record, validated as far as the session layer depends on it. */
export function parsePeer(value: unknown): PeerInfo | undefined {
  const peerId = textField(value, 'peer_id');
  const displayName = textField(value, 'display_name');
  if (peerId === undefined || displayName === undefined) {
    return undefined;
  }
  const role = textField(value, 'role');
  const awareness = numberField(value, 'awareness_client_id');
  return {
    peer_id: peerId,
    display_name: displayName,
    role: role === 'host' ? 'host' : 'guest',
    ...(awareness === undefined
      ? {}
      : { awareness_client_id: Math.trunc(awareness) }),
  };
}

/** A `peer.joined` / `host.attached` params object, with or without its `peer` key. */
export function parsePeerEvent(params: unknown): PeerInfo | undefined {
  if (params === undefined) {
    return undefined;
  }
  const wrapped = isRecord(params) ? params.peer : undefined;
  return parsePeer(wrapped ?? params);
}

/**
 * A `peer.renamed` params object (§6). The minimal pair is the whole event, so both fields
 * are required: a frame missing either is not a rename this client acts on.
 */
export function parsePeerRenamed(params: unknown): PeerRenamed | undefined {
  const peerId = textField(params, 'peer_id');
  const displayName = textField(params, 'display_name');
  if (peerId === undefined || displayName === undefined) {
    return undefined;
  }
  return { peer_id: peerId, display_name: displayName };
}

/** `session.hello` params for this connection. */
export function helloParams(input: {
  displayName: string;
  role?: Role;
  awarenessClientId: number;
  capabilities?: readonly string[];
  client?: string;
}): Record<string, unknown> {
  return {
    display_name: input.displayName,
    ...(input.role === undefined ? {} : { role: input.role }),
    awareness_client_id: input.awarenessClientId,
    capabilities: [...(input.capabilities ?? CLIENT_CAPABILITIES)],
    ...(input.client === undefined ? {} : { client: input.client }),
  };
}

/** `session.rename` params: the name this connection is changing to (§5). */
export function renameParams(input: { displayName: string }): RenameParams {
  return { display_name: input.displayName };
}

/** `doc.grant` params: the listing this host is publishing (§5). */
export function grantParams(input: { paths: string[] }): GrantParams {
  return { paths: [...input.paths] };
}
