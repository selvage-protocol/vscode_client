/**
 * Remote cursors, as data.
 *
 * The protocol carries a peer's document and two CRDT anchors and no identity and no
 * colour: identity is the session layer's (`PeerInfo.awareness_client_id`, §8.4) and
 * `DESIGN.md` §4.3 leaves colour to the client. Picking one locally is not the same as
 * picking one *arbitrarily*: a colour derived from the peer id is the same on every client
 * in the room, where one handed out in join order paints the same peer differently in two
 * windows (`docs/studies/vscode-plugin.md` §3).
 */

import type { Role } from '../engine/envelope.ts';

/**
 * Eight mid-tone colours, legible on a light and a dark theme alike. Exported because each
 * entry is also contributed as a theme colour (`package.json`): a file decoration's colour
 * takes a theme colour's id and never an arbitrary hex, so the badge a peer's file wears names
 * the palette entry this peer's colour is. The two are pinned equal by `test/participants.test.ts`.
 */
export const PEER_PALETTE = [
  '#e06c75',
  '#e5c07b',
  '#98c379',
  '#56b6c2',
  '#61afef',
  '#c678dd',
  '#d19a66',
  '#b48ead',
] as const;

/** FNV-1a over the peer id's UTF-16 code units, kept in 32 unsigned bits. */
function peerHash(peerId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < peerId.length; index += 1) {
    hash ^= peerId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** The palette entry a peer's colour comes from: what a theme colour for it is named after. */
export function peerColourIndex(peerId: string): number {
  return peerHash(peerId) % PEER_PALETTE.length;
}

/** The colour a peer is drawn in, the same one in every client that can compute a hash. */
export function peerColour(peerId: string): string {
  return PEER_PALETTE[peerColourIndex(peerId)] ?? PEER_PALETTE[0];
}

/**
 * The same colour at an alpha, for a selection's fill. The palette is opaque `#rrggbb`,
 * which is what a label needs; a caret's selection behind the text needs to be see-through.
 */
export function translucent(colour: string, alpha: number): string {
  const clamped = Math.max(0, Math.min(255, Math.round(alpha * 255)));
  return `${colour}${clamped.toString(16).padStart(2, '0')}`;
}

/** One remote cursor, resolved against this replica and ready to draw. */
export interface Cursor {
  /** The session peer's id, which is also what the colour is derived from. */
  peerId: string;
  /** The peer's display name, or the peer id when the session has no name for it. */
  label: string;
  role: Role;
  /** The document the peer says it is in, as a room path. */
  path: string;
  /** Selection endpoints as offsets into the editor's buffer: UTF-16 code units. */
  anchor: number;
  head: number;
  /** The peer's colour, opaque, for a caret and a name label. */
  colour: string;
  /** The same colour at a quarter alpha, for a selection's fill. */
  fill: string;
}

/**
 * A peer's cursor is drawn only when it resolves *here* (§8.1). An anchor naming an
 * element this replica has never seen — the document has not arrived, or an edit
 * invalidated it — resolves to nothing, and the honest rendering of that is no cursor
 * rather than one at offset 0, which is where a clamp would put it.
 */
export interface ResolvedCursor {
  path: string;
  anchor: number;
  head: number;
}

export interface CursorPeer {
  peerId: string;
  displayName: string;
  role: Role;
}

/** Builds one cursor from a peer and the selection this replica resolved for it. */
export function cursorFor(peer: CursorPeer, resolved: ResolvedCursor): Cursor {
  const colour = peerColour(peer.peerId);
  return {
    peerId: peer.peerId,
    label: peer.displayName === '' ? peer.peerId : peer.displayName,
    role: peer.role,
    path: resolved.path,
    anchor: resolved.anchor,
    head: resolved.head,
    colour,
    fill: translucent(colour, 0.25),
  };
}
