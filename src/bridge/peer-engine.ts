/**
 * The bridge's `Engine` over a `selvage/2` relay: the splice between a session that decides
 * and an adapter that draws.
 *
 * `bridge.ts` asks an engine for the room's facts (`session`, `text`, `has`, `presence`) and
 * hands it the editor's (`open`, `close`, `insert`, `delete`, `setSelection`, `setAwareness`),
 * and it listens for one vocabulary of events. `PeerSession` (`PROTOCOL.md` §13) has its own:
 * a state's listing and roles, the holds of §13.7, the awareness of §8, and the endings of
 * §13.10. This module is the translation, and it is here — in the bridge, which the three
 * clients carry — because it says nothing about an editor: the same rules read the same way to
 * Neovim, to a page and to an extension host.
 *
 * **What it is not.** It is not a socket (that is `engine/relay.ts`) and it is not an adapter
 * (`nvim_client`'s companion, `web_client`'s page, `vscode_client`'s extension host). It is
 * also not a version-1 engine: a client that has one leaves it where it is and points this at a
 * relay only when it is talking to a `selvage/2` room.
 *
 * **The room's open set.** `selvage/1`'s server kept the set of documents a room had open and
 * told every client about it. `selvage/2`'s server keeps membership only, so the set here is
 * §13.7's: the paths this connection holds together with the paths every peer is held to — the
 * documents somebody has open, which is what the adapter's own words are about.
 */

import type { PeerInfo, Role } from '../engine/envelope.ts';
import type { SessionInfo } from '../engine/engine.ts';
import type { EngineEvent, EngineEventListener } from '../engine/events.ts';
import { endingReason } from '../engine/peer.ts';
import type { AwarenessState, OffsetSelection, Presence, Selection } from '../engine/presence.ts';
import type { RelayEvent, RelaySession } from '../engine/relay.ts';

import type { Engine } from './bridge.ts';

export interface PeerEngineOptions {
  /** The seated relay: a `selvage/2` session with a socket under it. */
  relay: RelaySession;
  /** The display name this connection seated with, which the relay labels its own record with. */
  displayName: string;
}

export class PeerEngine implements Engine {
  private readonly relay: RelaySession;
  private readonly listeners = new Set<EngineEventListener>();
  private readonly stopRelay: () => void;

  /** The last thing this facade told its listeners, so a report is a change and not a repeat. */
  private peerList: PeerInfo[];
  private listing: readonly string[];
  private openDocuments: string[];
  private presenceList: Presence[];
  private hostGrace: number | undefined;
  /** The replica's text per path, which is how a content frame becomes a `documentChanged`. */
  private readonly texts = new Map<string, string>();

  constructor(options: PeerEngineOptions) {
    this.relay = options.relay;
    this.peerList = this.relay.peerInfos();
    this.listing = [...this.relay.listing()];
    this.openDocuments = this.roomDocuments();
    this.presenceList = this.relay.presence();
    for (const path of this.relay.documents()) {
      this.texts.set(path, this.relay.text(path));
    }
    this.hostGrace = this.relay.hostAwayGraceMs();
    this.stopRelay = this.relay.on((event) => {
      this.onRelayEvent(event);
    });
  }

  /** Ends the facade's subscription. The relay's own connection is not this call's to close. */
  dispose(): void {
    this.stopRelay();
    this.listeners.clear();
  }

  // --- what the bridge reads --------------------------------------------------

  session(): SessionInfo {
    const info = this.relay.sessionInfo();
    const role = (this.relay.appliedRole() ?? 'guest') as Role;
    return {
      roomId: info.roomId,
      ...(info.token === undefined ? {} : { token: info.token }),
      role,
      peer: this.relay.selfInfo(),
      peers: this.relay.peerInfos(),
      documents: this.roomDocuments(),
      capabilities: info.capabilities,
      keepalive: info.keepalive,
      baseUrl: info.baseUrl,
    };
  }

  text(path: string): string {
    return this.relay.text(path);
  }

  has(path: string): boolean {
    return this.relay.has(path);
  }

  presence(): Presence[] {
    return this.relay.presence();
  }

  resolveSelection(path: string, selection: Selection): OffsetSelection | undefined {
    return this.relay.resolveSelection(path, selection);
  }

  // --- what the bridge hands in -----------------------------------------------

  /** Takes a hold on `path` (`§13.7`) and lets the room hear of the change at once. */
  async open(path: string): Promise<void> {
    this.relay.open(path);
    await this.relay.tick();
  }

  /** Gives up this connection's hold on `path`, which is the whole of what a close owes. */
  async close(path: string): Promise<void> {
    this.relay.release(path);
    await this.relay.tick();
  }

  /**
   * One local insertion. The bridge computes the range from this replica's own text, so a
   * refusal here is a caller bug and not a room refusal; it is reported through the same
   * `sessionError` channel the rest of the session's faults use rather than left as a stray
   * rejection nobody sees.
   */
  insert(path: string, index: number, text: string): void {
    this.publish(() => this.relay.insert(path, index, text));
  }

  /** One local deletion, by the same rule as {@link PeerEngine.insert}. */
  delete(path: string, index: number, length: number): void {
    this.publish(() => this.relay.remove(path, index, length));
  }

  private publish(work: () => Promise<boolean>): void {
    void work().catch((error: unknown) => {
      this.emit({
        type: 'sessionError',
        code: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  setSelection(path: string, selection: OffsetSelection): void {
    this.relay.setSelection(path, selection);
  }

  setAwareness(state: AwarenessState | null): void {
    this.relay.setAwareness(state);
  }

  on(listener: EngineEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // --- what this adapter needs of its own -------------------------------------

  /** The invite this connection can hand on: the wire URL with its fragment (`§5.1`). */
  inviteUrl(): string | undefined {
    return this.relay.invite();
  }

  /** Changes the name the room sees (`PROTOCOL.md` §5). */
  async rename(displayName: string): Promise<void> {
    await this.relay.rename(displayName);
  }

  /** Publishes the working tree this host shares: the room's whole listing (`§7.1`). */
  async grant(paths: readonly string[]): Promise<void> {
    this.granted = [...paths];
    await this.relay.listingChanged();
  }

  /** The room's listing as this replica holds it, which is what the room shares. */
  grantedPaths(): string[] {
    const listing = this.relay.listing();
    return listing.length > 0 ? [...listing] : this.granted;
  }

  /** Ends the connection. The socket closes, the clock stops and the session is released. */
  async disconnect(): Promise<void> {
    this.dispose();
    this.relay.disconnect();
  }

  private granted: string[] = [];

  // --- the events -------------------------------------------------------------

  private onRelayEvent(event: RelayEvent): void {
    switch (event.type) {
      case 'text': {
        // A content frame carries text or awareness, and §13.5 leaves the frame's own paths
        // unsaid: both are re-read from the replica either way.
        this.scanTexts();
        this.refresh();
        return;
      }
      case 'ended': {
        this.emitEnd(event.ending);
        return;
      }
      case 'failed': {
        this.emit({ type: 'sessionError', code: 'error', message: event.reason });
        return;
      }
      default: {
        this.refresh();
      }
    }
  }

  /** Reports whatever the relay's own event did not name, and the clocks this facade runs. */
  private refresh(): void {
    const peers = this.relay.peerInfos();
    if (!samePeers(peers, this.peerList)) {
      this.peerList = peers;
      this.emit({ type: 'peersChanged', peers });
    }
    const listing = this.relay.listing();
    if (!sameStrings(listing, this.listing)) {
      this.listing = [...listing];
      this.emit({ type: 'grantChanged', paths: [...listing] });
    }
    const documents = this.roomDocuments();
    if (!sameStrings(documents, this.openDocuments)) {
      this.openDocuments = documents;
      this.emit({ type: 'documentsChanged', documents });
    }
    const presence = this.relay.presence();
    if (!samePresence(presence, this.presenceList)) {
      this.presenceList = presence;
      this.emit({ type: 'presenceChanged', presence });
    }
    this.reportHostAway();
  }

  /**
   * §13.8's window, as the adapter's own two events: the host's connection is gone and the room
   * has this long to hold together, and it is back. The expiry is not reported here — it ends
   * the session, and the ending is the session's own word for it.
   */
  private reportHostAway(): void {
    const grace = this.relay.hostAwayGraceMs();
    const was = this.hostGrace;
    this.hostGrace = grace;
    if (was === undefined && grace !== undefined) {
      this.emit({ type: 'hostDetached', graceMs: grace });
      return;
    }
    if (was !== undefined && grace === undefined) {
      this.emit({ type: 'hostAttached', peer: this.hostPeer() });
    }
  }

  private hostPeer(): PeerInfo {
    const seat = this.relay.namedHostSeat();
    for (const peer of this.relay.peerInfos()) {
      if (peer.peer_id === seat) {
        return peer;
      }
    }
    return { peer_id: seat ?? '', display_name: '', role: 'host' };
  }

  /**
   * The replica's text after a content frame: the paths whose text is not what it was are the
   * ones an adapter has to reconcile. The whole replica is compared rather than the frame's own
   * paths, because a frame carries y-protocols messages and not a path (`§13.5`).
   */
  private scanTexts(): void {
    for (const path of this.relay.documents()) {
      const text = this.relay.text(path);
      if (this.texts.get(path) === text) {
        continue;
      }
      this.texts.set(path, text);
      this.emit({ type: 'documentChanged', path });
    }
  }

  private roomDocuments(): string[] {
    const paths = new Set<string>(this.relay.heldPaths());
    for (const holds of this.relay.peerHolds().values()) {
      for (const path of holds) {
        paths.add(path);
      }
    }
    return [...paths].sort();
  }

  private emitEnd(ending: string): void {
    if (ending === 'room-gone') {
      // The relay's own: the socket ended and no peer said why, which is what `selvage/1`'s
      // `disconnected` says.
      this.emit({ type: 'disconnected' });
      return;
    }
    const sentence = this.relay.endingSentence();
    this.emit({ type: 'roomGone', reason: sentence ?? endingReason('closing') });
  }

  private emit(event: EngineEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, at) => value === right[at]);
}

function samePeers(left: readonly PeerInfo[], right: readonly PeerInfo[]): boolean {
  return (
    left.length === right.length &&
    left.every((peer, at) => {
      const other = right[at];
      return (
        other !== undefined &&
        peer.peer_id === other.peer_id &&
        peer.display_name === other.display_name &&
        peer.role === other.role &&
        peer.awareness_client_id === other.awareness_client_id
      );
    })
  );
}

/** Presence is compared by what it says, states and all: a changed caret is a changed record. */
function samePresence(left: readonly Presence[], right: readonly Presence[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
