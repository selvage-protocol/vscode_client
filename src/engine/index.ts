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
export type { FrameCrypto } from './crypto.ts';
export {
  HOST_MUTATIONS,
  HostProducer,
  MAX_LISTING_BYTES,
  MAX_LISTING_PATHS,
} from './host.ts';
export type {
  HostMutation,
  HostOptions,
  HostPublication,
  HostReason,
  HostRole,
  HostStore,
  PersistedHost,
} from './host.ts';
export {
  FRAME_BUDGET,
  MISSING_FRAGMENT,
  PEER_MUTATIONS,
  PeerSession,
  endingReason,
  parseInvite,
} from './peer.ts';
export type {
  AppliedFrame,
  DroppedFrame,
  Ending,
  InviteRead,
  Outcome,
  PeerInvite,
  PeerMutation,
  PeerOptions,
  Publication,
} from './peer.ts';
export {
  DROP_REASONS,
  MAX_PATH_BYTES,
  Reader,
  canonicalJson,
  decodeKey,
  encodeKey,
  hex,
  mintSessionKey,
  parseEnvelope,
  seal,
  usablePath,
} from './sealed.ts';
export type {
  Committed,
  DropReason,
  Envelope,
  Payload,
  PeerEntry,
  RoomState,
  SealRecipe,
  SessionKeypair,
  Verdict,
} from './sealed.ts';
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
  MetaKeepalive,
  PeerInfo,
  Role,
} from './envelope.ts';
export { fetchMeta, hostVersion, joinRefusal, metaAccepts } from './meta.ts';
export type { HostDecision, WireVersion } from './meta.ts';
export {
  inviteUrl,
  metaUrl,
  parseSessionUrl,
  sessionBase,
  sessionUrl,
} from './urls.ts';
export type { JoinQuery, SessionBase, SessionUrl } from './urls.ts';
export { openSocket } from './transport.ts';
export type {
  OpenSocket,
  TransportHandlers,
  WebSocketFactory,
  WebSocketLike,
} from './transport.ts';
