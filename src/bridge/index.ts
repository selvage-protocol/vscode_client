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
export type { BridgeOptions, EditorHost, Engine, Report, Timers } from './bridge.ts';
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
export { cursorFor, peerColour, translucent } from './cursors.ts';
export type { Cursor, CursorPeer, ResolvedCursor } from './cursors.ts';
export {
  GRANT_EXCLUDED_DIRS,
  MAX_GRANT_FILE_BYTES,
  MAX_GRANT_PATHS,
  MAX_GRANT_PATH_BYTES,
  grantChildren,
  grantUnion,
  isGrantedPath,
  sortGrant,
} from './grant.ts';
export type { GrantChild } from './grant.ts';
export { SCHEME, roomFromQuery, virtualDocument, virtualUri } from './virtual.ts';
export type { VirtualDocument } from './virtual.ts';
