/**
 * Presence: the session layer's peers joined to y-protocols awareness (spec §8).
 *
 * y-protocols leaves the awareness state opaque and keys it by a client id that carries
 * no identity. Identity travels in the session layer, so a cursor is attributed by
 * joining `PeerInfo.awareness_client_id` to the awareness state (§8.4).
 */

import * as Y from 'yjs';
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

/** The CRDT element an anchor names: a client id and that client's clock (§8.1). */
export interface AnchorId {
  client: number;
  clock: number;
}

/**
 * A selection endpoint, in the format of a yjs `RelativePosition` (§8.1): a scope —
 * `tname` (for Selvage, the document path) or `type` (nested, never produced by this
 * version) — an optional `item` naming an element inside that scope, and `assoc`, `0` for
 * the element after the position and `-1` for the one before. Scope and element are not
 * alternatives: where `item` is present it is authoritative and the scope checks it. No
 * index is ever carried on the wire.
 */
export interface Anchor {
  item?: AnchorId;
  tname?: string;
  type?: AnchorId;
  assoc: number;
}

/**
 * A selection, as the two anchors the wire carries. `head` resolving before `anchor`
 * means the selection was made backwards; a caret is two anchors resolving alike.
 */
export interface Selection {
  anchor: Anchor;
  head: Anchor;
}

/**
 * A selection as offsets into the document text, in UTF-16 code units — what `Y.Text`
 * indices and VS Code's `offsetAt` both count. This shape belongs to the editor-adapter
 * seam; the protocol fixes no offset unit because no offset reaches the wire (§8.1).
 */
export interface OffsetSelection {
  anchor: number;
  head: number;
}

export function caret(at: Anchor): Selection {
  return { anchor: at, head: at };
}

/**
 * `0` (after) or `-1` (before) for any number, normalised by sign (§8.1); `undefined` when the
 * member is not a number at all, which is not an `assoc` and costs the anchor it sits in.
 */
function normaliseAssoc(assoc: unknown): number | undefined {
  if (assoc === undefined) {
    return 0;
  }
  return typeof assoc === 'number' ? (assoc < 0 ? -1 : 0) : undefined;
}

/**
 * The wire form of a relative position: what the library produces, shipped unedited
 * (§8.1). For a root type yjs sets `tname` — the scope — and, where the position has an
 * element to name, `item` as well. A conforming client does not hand-edit that pair
 * apart, because a peer reading the halves as alternatives renders no cursor at all.
 */
export function toAnchor(position: Y.RelativePosition): Anchor {
  const anchor: Anchor = { assoc: normaliseAssoc(position.assoc) ?? 0 };
  if (position.item !== null) {
    anchor.item = { client: position.item.client, clock: position.item.clock };
  }
  if (position.tname !== null) {
    anchor.tname = position.tname;
  }
  if (position.type !== null) {
    anchor.type = { client: position.type.client, clock: position.type.clock };
  }
  return anchor;
}

export function toRelativePosition(anchor: Anchor): Y.RelativePosition {
  return Y.createRelativePositionFromJSON(anchor);
}

function parseAnchorId(raw: unknown): AnchorId | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const { client, clock } = raw as Record<string, unknown>;
  if (typeof client !== 'number' || typeof clock !== 'number') {
    return undefined;
  }
  return { client, clock };
}

/**
 * Reads one endpoint, ignoring keys it does not know.
 *
 * §8.1 and the libraries agree on one rule: at least one of `item`/`tname`/`type`, at most
 * one *scope* (`tname` XOR `type`), and `item` authoritative when present. A `tname` beside
 * an `item` is the ordinary yjs shape; an `item` alone is what `yrs` publishes for a
 * position inside a root type, so neither is malformed. What is malformed is an anchor
 * with no name at all, both scopes at once, or a member in a shape that cannot be read —
 * a receiver that rejects a library's own shape renders no cursor for every peer on it.
 *
 * An unreadable anchor costs only the selection: the state's `path` survives it.
 */
export function parseAnchor(raw: unknown): Anchor | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const assoc = normaliseAssoc(record.assoc);
  if (assoc === undefined) {
    return undefined;
  }
  const anchor: Anchor = { assoc };
  for (const key of ['item', 'type'] as const) {
    const value = record[key];
    if (value === undefined || value === null) {
      continue;
    }
    const id = parseAnchorId(value);
    if (id === undefined) {
      return undefined;
    }
    anchor[key] = id;
  }
  if (record.tname !== undefined && record.tname !== null) {
    if (typeof record.tname !== 'string') {
      return undefined;
    }
    anchor.tname = record.tname;
  }
  const named =
    anchor.item !== undefined ||
    anchor.tname !== undefined ||
    anchor.type !== undefined;
  if (!named || (anchor.tname !== undefined && anchor.type !== undefined)) {
    return undefined;
  }
  return anchor;
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
    const parsedAnchor = parseAnchor(anchor);
    const parsedHead = parseAnchor(head);
    if (parsedAnchor !== undefined && parsedHead !== undefined) {
      state.selection = { anchor: parsedAnchor, head: parsedHead };
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
