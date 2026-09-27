/** Roster display names: plain while unique, with a short peer id while taken. */
export interface NamedPeer {
  displayName: string;
  peerId: string;
}

/** The row text for one peer: suffixed only when another row shares the name. */
export function rosterLabel(peer: NamedPeer, all: readonly NamedPeer[]): string {
  const taken = all.some((other) => other.peerId !== peer.peerId && other.displayName === peer.displayName);
  if (!taken) {
    return peer.displayName;
  }
  return `${peer.displayName} · ${peer.peerId.slice(-4)}`;
}
