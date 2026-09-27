/** Roster display names: plain while unique, with a short peer id while taken. */
export interface NamedPeer {
  displayName: string;
  peerId: string;
}

/** How many trailing characters of a peer id a shared name is told apart by, at least. */
const SHORT_TAIL = 4;

/**
 * The row text for one peer: suffixed only when another row shares the name.
 *
 * The suffix is the last four characters of the peer id, and longer only when another peer with
 * the same name has the same four, so two rows never read the same.
 */
export function rosterLabel(peer: NamedPeer, all: readonly NamedPeer[]): string {
  const namesakes = all.filter((other) => other.peerId !== peer.peerId && other.displayName === peer.displayName);
  if (namesakes.length === 0) {
    return peer.displayName;
  }
  let length = SHORT_TAIL;
  while (
    length < peer.peerId.length &&
    namesakes.some((other) => other.peerId.slice(-length) === peer.peerId.slice(-length))
  ) {
    length += 1;
  }
  return `${peer.displayName} · ${peer.peerId.slice(-length)}`;
}
