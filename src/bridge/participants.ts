/**
 * The roster model: membership joined with presence, as rows and file badges.
 *
 * Membership comes from the `peers` report, each peer's document from presence — the
 * same two sources the participant picker joins — so a row is as fresh as the
 * presence behind it. Everything here is pure and editor-independent: the TreeView
 * and the file decorations in `src/adapter/` are thin holders over these values.
 * Words live with the holders, not here: `viewRows` answers *what* to list — peers,
 * or that the room or the session is missing — and the adapter says it.
 */

import { peerColour, peerColourIndex } from './cursors.ts';
import { initials } from './initials.ts';

/** One peer, as the view needs them: who the room says they are, and where. */
export interface ParticipantEntry {
  peerId: string;
  displayName: string;
  role: string;
  /** The document the peer says it is in, when this client knows of one. */
  path?: string;
}

/** What one roster row shows: who the peer is, the file they are in, and their actions. */
export interface ParticipantRow {
  kind: 'peer';
  peerId: string;
  label: string;
  /** The file the peer is in, or `No open document` — where they are, never whether followed. */
  description: string;
  contextValue:
    | 'selvageParticipant'
    | 'selvageParticipantFollowing'
    | 'selvageParticipantAway';
  /** The peer's marker colour: the mapping the caret wears. */
  colour: string;
  /** The hover: name, role, file, and whether this window follows them. */
  tooltip: string;
  /** False for a peer in no document: there is nowhere to go to or follow. */
  canNavigate: boolean;
}

/** What the view lists: one row per peer, or which note stands in for them. */
export type RosterRow = ParticipantRow | { kind: 'empty' } | { kind: 'nosession' };

/**
 * The name a row says: the display name, or the id when the room left the name blank —
 * the rule the caret's own label follows (`cursors.ts`). Shared with the picker, so the
 * two lists cannot disagree on what a peer is called.
 */
export function peerName(displayName: string, peerId: string): string {
  return displayName === '' ? peerId : displayName;
}

/**
 * One row per peer, in membership order. The label disambiguates only when it must —
 * the rule the caret's own label and the picker follow — and the row says *where* the peer
 * is, beside the badge their file wears. The follow state is a row's actions and the hover
 * rather than the description: the file is what the row is for, and the followed peer's
 * row offers the stop in its place (`src/adapter/participants.ts`).
 */
export function describeParticipants(
  entries: readonly ParticipantEntry[],
  followingPeerId: string | undefined,
): ParticipantRow[] {
  return entries.map((entry) => {
    const following = followingPeerId === entry.peerId;
    const navigable = entry.path !== undefined;
    return {
      kind: 'peer' as const,
      peerId: entry.peerId,
      label: participantLabel(entry, entries),
      description: entry.path ?? 'No open document',
      contextValue: following
        ? 'selvageParticipantFollowing'
        : navigable
          ? 'selvageParticipant'
          : 'selvageParticipantAway',
      colour: peerColour(entry.peerId),
      tooltip: participantTooltip(entry, following),
      canNavigate: navigable,
    };
  });
}

/**
 * What the view lists for a session — peers, in membership order — or which note: the
 * invite copy when the room holds nobody else, the join-first sentence when no session
 * is live. The adapter turns the note into words; this layer only says which one.
 */
export function viewRows(
  snapshot: { entries: readonly ParticipantEntry[]; followingPeerId: string | undefined } | undefined,
): RosterRow[] {
  if (snapshot === undefined) {
    return [{ kind: 'nosession' }];
  }
  if (snapshot.entries.length === 0) {
    return [{ kind: 'empty' }];
  }
  return describeParticipants(snapshot.entries, snapshot.followingPeerId);
}

/**
 * The name a row says: the display name, or the id when the room left the name blank.
 * A name two peers share gains the shortest peer-id prefix that tells them apart; the
 * prefix is a label only, the row carries the full id, which is what the actions land
 * on.
 */
export function participantLabel(
  entry: { displayName: string; peerId: string },
  all: readonly { displayName: string; peerId: string }[],
): string {
  const name = peerName(entry.displayName, entry.peerId);
  if (entry.displayName === '') {
    return name;
  }
  const shared = all.filter(
    (other) => other.peerId !== entry.peerId && other.displayName === entry.displayName,
  );
  if (shared.length === 0) {
    return name;
  }
  const ids = new Set([entry.peerId, ...shared.map((other) => other.peerId)]);
  for (let length = 1; length <= entry.peerId.length; length += 1) {
    const prefix = entry.peerId.slice(0, length);
    if ([...ids].every((id) => id === entry.peerId || !id.startsWith(prefix))) {
      return `${name} (${prefix})`;
    }
  }
  return `${name} (${entry.peerId})`;
}

/** The hover: name, role, file when one is known, and whether this window follows. */
function participantTooltip(entry: ParticipantEntry, following: boolean): string {
  const name = peerName(entry.displayName, entry.peerId);
  const parts = [`${name} — ${entry.role}`];
  if (entry.path !== undefined) {
    parts.push(`in ${entry.path}`);
  } else {
    parts.push('in no document');
  }
  if (following) {
    parts.push('following');
  }
  return parts.join(' — ');
}

/** One peer in one room file: who they are, and the label the roster says for them. */
export interface FilePeer {
  peerId: string;
  /** The roster's name for them, duplicate names disambiguated as the rows disambiguate them. */
  label: string;
}

/** One room file peers are in, by URI string. */
export interface FilePresence {
  uri: string;
  peers: readonly FilePeer[];
}

/** The marker a file row wears: one peer's initials in their colour, or the headcount. */
export interface FileBadge {
  uri: string;
  badge: string;
  /**
   * The theme colour the badge is drawn in, when the file holds exactly one peer: the palette
   * entry `peerColour` gives them, contributed by the manifest as `selvage.peer.<index>`. A
   * decoration's colour takes a theme colour's id and never a hex, which is why the palette is
   * contributed. Absent when several peers share the file: one peer's colour would claim the
   * file for them.
   */
  colourId?: string;
  tooltip: string;
}

/** The theme colour a peer's badge is drawn in, as the manifest contributes it. */
export function peerColourId(peerId: string): string {
  return `selvage.peer.${peerColourIndex(peerId)}`;
}

/**
 * The badge per file peers are in. One peer is their own initials in their own colour — the very
 * letters and colour the glyph margin draws for them, so the file row and the caret name each
 * other — and several peers are their count with no colour, because a file decoration carries one
 * badge and one colour and picking one of them would claim the file for that peer. The names are
 * in the hover either way, and sorted, so two clients seeing the same file badge it alike.
 */
export function badgeFiles(files: readonly FilePresence[]): FileBadge[] {
  const badges: FileBadge[] = [];
  for (const file of files) {
    const peers = [...new Map(file.peers.map((peer) => [peer.label, peer])).values()].sort(
      (left, right) => (left.label < right.label ? -1 : left.label > right.label ? 1 : 0),
    );
    const only = peers.length === 1 ? peers[0] : undefined;
    if (peers.length === 0) {
      continue;
    }
    const names = peers.map((peer) => peer.label);
    badges.push({
      uri: file.uri,
      badge: only === undefined ? String(peers.length) : initials(only.label),
      ...(only === undefined ? {} : { colourId: peerColourId(only.peerId) }),
      tooltip: peers.length === 1 ? `${names[0]} is here` : `${names.join(', ')} are here`,
    });
  }
  return badges;
}
