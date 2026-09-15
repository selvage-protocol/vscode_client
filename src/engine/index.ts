/**
 * The Selvage engine: everything an editor adapter needs, and nothing that knows about
 * an editor. Import from here rather than from the individual modules.
 */

export { SelvageEngine } from './engine.ts';
export type {
  ConnectOptions,
  JoinOptions,
  KeepaliveClock,
  ReconnectPolicy,
  SessionInfo,
} from './engine.ts';
export type { EngineEvent, EngineEventListener } from './events.ts';
export type {
  Anchor,
  AnchorId,
  AwarenessState,
  OffsetSelection,
  Presence,
  Selection,
} from './presence.ts';
export { caret } from './presence.ts';
export { EngineClosedError, ProtocolError, isProtocolError } from './errors.ts';
export {
  CLIENT_CAPABILITIES,
  DEFAULT_KEEPALIVE,
  MAX_DISPLAY_NAME_UNITS,
  WIRE_VERSION,
  close,
  closeCodeFor,
  code,
  event,
  isCompatible,
  isTerminalCode,
  method,
  parseVersion,
} from './envelope.ts';
export type {
  ErrorObject,
  Keepalive,
  Meta,
  PeerInfo,
  Role,
} from './envelope.ts';
export { fetchMeta, metaAccepts } from './meta.ts';
export {
  inviteUrl,
  metaUrl,
  parseSessionUrl,
  sessionUrl,
} from './urls.ts';
export type { JoinQuery, SessionUrl } from './urls.ts';
export { openSocket } from './transport.ts';
export type {
  OpenSocket,
  TransportHandlers,
  WebSocketFactory,
  WebSocketLike,
} from './transport.ts';
