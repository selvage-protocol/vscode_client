/**
 * The event vocabulary an editor adapter consumes. It mirrors the reference server's
 * `crates/client/src/editor.rs` — the same events, so the seam is a project-wide
 * vocabulary rather than a Rust detail. The reference server lives at
 * https://github.com/selvage-protocol/reference_server.
 */

import type { PeerInfo } from './envelope.ts';
import type { Presence } from './presence.ts';

export type EngineEvent =
  /** The text of an open document changed remotely. Reconcile the buffer with `text()`. */
  | { type: 'documentChanged'; path: string }
  /** The room's open-document set changed. */
  | { type: 'documentsChanged'; documents: string[] }
  /** The room's grant changed: the whole listing, replacing whatever the adapter held. */
  | { type: 'grantChanged'; paths: string[] }
  /** Membership changed. */
  | { type: 'peersChanged'; peers: PeerInfo[] }
  /** Awareness changed: remote cursors moved, joined or expired. */
  | { type: 'presenceChanged'; presence: Presence[] }
  /** The host disconnected; the room survives only until the grace period expires. */
  | { type: 'hostDetached'; graceMs: number }
  /** The host came back before the grace period expired. */
  | { type: 'hostAttached'; peer: PeerInfo }
  /** The room is gone. No further traffic will arrive on this session. */
  | { type: 'roomGone'; reason: string }
  /** A fault the server could not attach to a request: `session.error`. */
  | { type: 'sessionError'; code: string; message: string }
  /** The connection ended for another reason, or reconnection gave up. */
  | { type: 'disconnected' };

export type EngineEventListener = (event: EngineEvent) => void;
