/**
 * Presence: the session layer's peers joined to y-protocols awareness (spec §8).
 *
 * y-protocols leaves the awareness state opaque and keys it by a client id that carries
 * no identity. Identity travels in the session layer, so a cursor is attributed by
 * joining `PeerInfo.awareness_client_id` to the awareness state (§8.4).
 */

import type { Awareness } from 'y-protocols/awareness';

import type { PeerInfo } from './envelope.ts';

/**
 * The awareness state this client publishes. Both fields are optional, and a state
 * carrying neither is still a state: this implementation's shape is an implementation
 * choice, not a y-protocols requirement (§8.1).
 */
export interface AwarenessState {
  path?: string;
  selection?: Selection;
}

/**
 * A selection as character offsets into the document text.
 *
 * The unit is UTF-16 code units, because that is what `Y.Text` indices and VS Code
 * offsets both are. Offsets are not CRDT-relative positions: `DESIGN.md` §4.3 asks for
 * those and `spec/PROTOCOL.md` §12.4 records the gap — see `SPIKES.md`.
 */
export interface Selection {
  anchor: number;
  head: number;
}

export function caret(at: number): Selection {
  return { anchor: at, head: at };
}

/** A remote participant's awareness, attributed to a session peer where possible. */
export interface Presence {
  /** y-protocols awareness client id. */
  clientId: number;
  /** The session peer speaking with that awareness client id, if it is known. */
  peer?: PeerInfo;
  state?: AwarenessState;
}

export function displayName(presence: Presence): string | undefined {
  return presence.peer?.display_name;
}

export function path(presence: Presence): string | undefined {
  return presence.state?.path;
}

export function selection(presence: Presence): Selection | undefined {
  return presence.state?.selection;
}

/** Reads the JSON state a peer published, tolerating a shape this client does not know. */
export function parseAwarenessState(raw: unknown): AwarenessState | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const state: AwarenessState = {};
  if (typeof record.path === 'string') {
    state.path = record.path;
  }
  const rawSelection = record.selection;
  if (typeof rawSelection === 'object' && rawSelection !== null) {
    const { anchor, head } = rawSelection as Record<string, unknown>;
    if (typeof anchor === 'number' && typeof head === 'number') {
      state.selection = { anchor: Math.trunc(anchor), head: Math.trunc(head) };
    }
  }
  return state;
}

/**
 * Every presence record this client holds, including its own, ordered by awareness client
 * id so two clients that see the same peers list them the same way.
 */
export function buildPresence(
  awareness: Awareness,
  peers: Iterable<PeerInfo>,
  local: PeerInfo,
): Presence[] {
  const byClientId = new Map<number, PeerInfo>();
  for (const peer of peers) {
    if (peer.awareness_client_id !== undefined) {
      byClientId.set(peer.awareness_client_id, peer);
    }
  }
  byClientId.set(awareness.clientID, local);

  const presence: Presence[] = [];
  for (const [clientId, state] of awareness.getStates()) {
    const presence_ = {
      clientId,
      peer: byClientId.get(clientId),
      state: parseAwarenessState(state),
    };
    presence.push(presence_);
  }
  return presence.sort((a, b) => a.clientId - b.clientId);
}
