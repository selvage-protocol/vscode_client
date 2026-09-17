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

import { peerColour } from './cursors.ts';

/** One peer, as the view needs them: who the room says they are, and where. */
export interface ParticipantEntry {
  peerId: string;
  displayName: string;
  role: string;
  /** The document the peer says it is in, when this client knows of one. */
  path?: string;
}

/** What one roster row shows: name + state + actions only, never a path as text. */
export interface ParticipantRow {
  kind: 'peer';
  peerId: string;
  label: string;
  /** `Following`, `No open document`, or nothing — the state, not the file. */
  description: string;
  contextValue:
    | 'selvageParticipant'
    | 'selvageParticipantFollowing'
    | 'selvageParticipantAway';
  /** The peer's marker colour: the mapping the caret wears. */
  colour: string;
  /** The hover, where the full detail — including the file — lives instead. */
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
 * the rule the caret's own label and the picker follow — and the followed peer reads
 * `Following` instead of offering follow again.
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
      description: following ? 'Following' : navigable ? '' : 'No open document',
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

/** One room file peers are in, by URI string, with the names presence attributes to it. */
export interface FilePresence {
  uri: string;
  names: string[];
}

/** The marker a file row wears: a neutral dot, or the headcount when several share it. */
export interface FileBadge {
  uri: string;
  badge: string;
  tooltip: string;
}

/**
 * The badge per file peers are in. The marker is deliberately not the peer colour —
 * a file decoration's colour takes only a theme colour, never an arbitrary hex — so
 * one peer reads as a dot and several as their count, with the names in the hover.
 * Names sort, so two clients seeing the same file badge it the same way.
 */
export function badgeFiles(files: readonly FilePresence[]): FileBadge[] {
  const badges: FileBadge[] = [];
  for (const file of files) {
    const names = [...new Set(file.names)].sort();
    if (names.length === 0) {
      continue;
    }
    const [first] = names;
    badges.push({
      uri: file.uri,
      badge: names.length === 1 ? '●' : `${names.length}`,
      tooltip:
        names.length === 1 ? `${first} is here` : `${names.join(', ')} are here`,
    });
  }
  return badges;
}
