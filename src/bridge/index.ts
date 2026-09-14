/**
 * The bridge between the sync engine and an editor: every rule an editor adapter needs and
 * no import that knows about an editor. Import from here rather than from the modules.
 */

export { DEFAULT_SAVE_SETTLE_MS, SessionBridge, realTimers } from './bridge.ts';
export type { BridgeOptions, EditorHost, Engine, Report, Timers } from './bridge.ts';
export { applyChange, diff, matchesReplica, render, toCrdt } from './editing.ts';
export type { LineEnding, TextChange } from './editing.ts';
export { cursorFor, peerColour, translucent } from './cursors.ts';
export type { Cursor, CursorPeer, ResolvedCursor } from './cursors.ts';
export { SCHEME, isVirtual, parseVirtualUri, virtualUri } from './virtual.ts';
export type { VirtualUri } from './virtual.ts';
