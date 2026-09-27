/**
 * The bridge between the sync engine and an editor: every rule an editor adapter needs and
 * no import that knows about an editor. Import from here rather than from the modules.
 */

export {
  DEFAULT_MAX_APPLY_ATTEMPTS,
  DEFAULT_RECONCILE_SETTLE_MS,
  DEFAULT_SAVE_SETTLE_MS,
  SessionBridge,
  realTimers,
} from './bridge.ts';
export type {
  BridgeOptions,
  EditorHost,
  Engine,
  GrantRefusal,
  GrantedRead,
  Report,
  Timers,
} from './bridge.ts';
export {
  applyChange,
  diff,
  matchesReplica,
  render,
  toBufferOffset,
  toCrdt,
  toReplicaOffset,
} from './editing.ts';
export type { LineEnding, TextChange } from './editing.ts';
export { cursorFor, PEER_PALETTE, peerColour, peerColourIndex, translucent } from './cursors.ts';
export { ANONYMOUS_INITIALS, INITIALS_LIMIT, initials } from './initials.ts';
export type { Cursor, CursorPeer, ResolvedCursor } from './cursors.ts';
export {
  badgeFiles,
  describeParticipants,
  participantLabel,
  peerColourId,
  peerName,
  viewRows,
} from './participants.ts';
export type {
  FileBadge,
  FilePeer,
  FilePresence,
  ParticipantEntry,
  ParticipantRow,
  RosterRow,
} from './participants.ts';
export {
  GRANT_BINARY_SUFFIXES,
  GRANT_EXCLUDED_DIRS,
  MAX_GRANT_FILE_BYTES,
  MAX_GRANT_PATHS,
  MAX_GRANT_PATH_BYTES,
  grantUnion,
  isBinaryNamedPath,
  isGrantedPath,
  sortGrant,
} from './grant.ts';
export { PeerEngine } from './peer-engine.ts';
export type { PeerEngineOptions } from './peer-engine.ts';
export { SEAT_LIMIT, SEAT_PALETTE, seatColours } from './seats.ts';
export type { Seat } from './seats.ts';
export { rosterLabel } from './names.ts';
export type { NamedPeer } from './names.ts';
export {
  COPIED_LABEL,
  COPIED_STAND_MS,
  COPY_INVITE_LABEL,
  HOST_LEAVE_QUESTION,
  LEAVE_ASKING_LABEL,
  LEAVE_CANCEL_LABEL,
  LEAVE_HOST_LABEL,
  RECONNECTING_NOTE,
  SESSION_ENDED_MESSAGE,
  SHARED_SESSION_IDENTITY,
  disconnectingReading,
  followEndedByFileGone,
  followEndedByLeaving,
  followEndedByMoving,
  followEndedByTyping,
  graceWording,
  guestIdentity,
  hostAwaySentence,
  hostBackSentence,
  hostLeftSentence,
  hostingIdentity,
  roomGoneSentence,
} from './words.ts';
