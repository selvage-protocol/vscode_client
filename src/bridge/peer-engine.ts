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
import { RelaySession } from '../engine/relay.ts';
import type { RelayEvent, RelayHostOptions, RelayJoinOptions } from '../engine/relay.ts';
import type { HostStore } from '../engine/host.ts';
import type { ReconnectPolicy } from '../engine/reconnect.ts';
import type { FrameCrypto } from '../engine/crypto.ts';
import type { Keepalive } from '../engine/envelope.ts';
import type { WebSocketFactory } from '../engine/transport.ts';

import type { Engine } from './bridge.ts';

export interface PeerEngineOptions {
  /** The seated relay: a `selvage/2` session with a socket under it. */
  relay: RelaySession;
  /** The display name this connection seated with, which the relay labels its own record with. */
  displayName: string;
}

/**
 * The working tree a host shares (`§7.1`), as the adapter that watches it sees it.
 *
 * A listing is read when a state is published and replaced wholesale by the state that follows,
 * so the adapter hands in one place to read it and one to say it changed — the same shape the
 * companion's own folder watcher has.
 */
export interface PeerListing {
  current(): readonly string[];
  replace(paths: readonly string[]): void;
}

/** What opening a room needs, beyond what the relay is handed. */
export interface PeerTransportOptions {
  crypto?: FrameCrypto;
  webSocketFactory?: WebSocketFactory;
  /** Free-form client identifier, for diagnostics (`PROTOCOL.md` §5). */
  client?: string;
  /** Overrides the clocks the server advertises (`§8.2`). The server's numbers are the room's. */
  keepalive?: Partial<Keepalive>;
  /** How long the upgrade and the handshake may take together. */
  handshakeTimeoutMs?: number;
  /**
   * §9.1's bounded reconnect for a guest whose socket drops: `false` turns it off, and the
   * fields override the defaults. The attempt budget is raised from the room's advertised
   * grace, which the relay reads from `/meta`.
   */
  reconnect?: false | Partial<ReconnectPolicy>;
  /** `GET /meta`, over which the grace is read; a seam for a caller with its own fetch. */
  fetchImpl?: typeof fetch;
}

export interface PeerHostOptions extends PeerTransportOptions {
  baseUrl: string;
  displayName: string;
  listing: PeerListing;
  /** The room key and the host key's seed, for a host that holds them from an earlier session. */
  roomKey?: Uint8Array;
  hostSeed?: Uint8Array;
  /** Where the host key and its `issued` are kept (`§7.1`); omitted is an in-memory host. */
  store?: HostStore;
}

export interface PeerJoinOptions extends PeerTransportOptions {
  /** The invite link, either form, with its fragment: the wire URL or the page link. */
  invite: string;
  displayName: string;
  /** The role this connection declares in its announcement; the state is what assigns it. */
  declaredRole?: 'guest' | 'viewer';
}

export class PeerEngine implements Engine {
  private readonly relay: RelaySession;
  private readonly listeners = new Set<EngineEventListener>();
  private readonly stopRelay: () => void;

  /** The last thing this facade told its listeners, so a report is a change and not a repeat. */
  private peerList: PeerInfo[];
  /**
   * The role the applied state gave this connection at the last report, which is compared on
   * every refresh: this connection is not in `peerInfos()`, so a state that gives it a role
   * changes nothing else a report is compared by (`§13.4`).
   */
  private ownRole: Role | undefined;
  private listing: readonly string[];
  private openDocuments: string[];
  private presenceList: Presence[];
  private hostGrace: number | undefined;
  /** The replica's text per path, which is how a content frame becomes a `documentChanged`. */
  private readonly texts = new Map<string, string>();

  /**
   * Mints a room and hands back the engine an adapter drives.
   *
   * The listing lives here rather than at the call site because §7.1's state is sealed from it:
   * `grant` replaces it and publishes the state that follows in one step, so an adapter cannot
   * say the tree changed and have the room hear the previous one.
   */
  static async host(options: PeerHostOptions): Promise<PeerEngine> {
    const listing = options.listing;
    const relayOptions: RelayHostOptions = {
      baseUrl: options.baseUrl,
      displayName: options.displayName,
      listing: () => listing.current(),
      ...(options.crypto === undefined ? {} : { crypto: options.crypto }),
      ...(options.webSocketFactory === undefined
        ? {}
        : { webSocketFactory: options.webSocketFactory }),
      ...(options.client === undefined ? {} : { client: options.client }),
      ...(options.roomKey === undefined ? {} : { roomKey: options.roomKey }),
      ...(options.hostSeed === undefined ? {} : { hostSeed: options.hostSeed }),
      ...(options.store === undefined ? {} : { store: options.store }),
      ...(options.keepalive === undefined ? {} : { keepalive: options.keepalive }),
      ...(options.handshakeTimeoutMs === undefined
        ? {}
        : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
      ...(options.reconnect === undefined ? {} : { reconnect: options.reconnect }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    };
    const engine = new PeerEngine({
      relay: await RelaySession.host(relayOptions),
      displayName: options.displayName,
    });
    engine.listingSource = listing;
    return engine;
  }

  /** Joins the room an invite names, from either form of the link. */
  static async join(options: PeerJoinOptions): Promise<PeerEngine> {
    const relayOptions: RelayJoinOptions = {
      invite: options.invite,
      displayName: options.displayName,
      ...(options.crypto === undefined ? {} : { crypto: options.crypto }),
      ...(options.webSocketFactory === undefined
        ? {}
        : { webSocketFactory: options.webSocketFactory }),
      ...(options.client === undefined ? {} : { client: options.client }),
      ...(options.declaredRole === undefined ? {} : { declaredRole: options.declaredRole }),
      ...(options.keepalive === undefined ? {} : { keepalive: options.keepalive }),
      ...(options.handshakeTimeoutMs === undefined
        ? {}
        : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
      ...(options.reconnect === undefined ? {} : { reconnect: options.reconnect }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    };
    return new PeerEngine({
      relay: await RelaySession.join(relayOptions),
      displayName: options.displayName,
    });
  }

  constructor(options: PeerEngineOptions) {
    this.relay = options.relay;
    this.peerList = this.relay.peerInfos();
    this.ownRole = this.relay.appliedRole() as Role | undefined;
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

  /**
   * The role the applied state gives this connection's own key, or `undefined` before one does
   * (`§13.4`, `§13.9`). An adapter that shows the role has to tell that window from a `guest`:
   * a connection no state commits yet has no role at all.
   */
  appliedRole(): Role | undefined {
    return this.relay.appliedRole() as Role | undefined;
  }

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
    this.listingSource?.replace(paths);
    await this.relay.listingChanged();
  }

  /** The room's listing as this replica holds it, which is what the room shares. */
  grantedPaths(): string[] {
    return [...this.relay.listing()];
  }

  /** Ends the connection. The socket closes, the clock stops and the session is released. */
  async disconnect(): Promise<void> {
    this.dispose();
    this.relay.disconnect();
  }

  /** Where a host's listing is read and written; a joiner has none and grants nothing. */
  private listingSource: PeerListing | undefined;

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
      case 'reconnecting': {
        // §9.1: the bounded retry is running, said as its own event so an adapter shows it
        // rather than inferring it from silence.
        this.emit({ type: 'reconnecting' });
        return;
      }
      case 'seated': {
        // The first seat happens before this facade exists, so a `seated` it sees is a re-seat
        // (§9.1). The reports are forced rather than compared: the adapter reads the document
        // set as the all-clear that ends its `reconnecting` state, and the set can be exactly
        // what it was before the blip. The role is compared rather than forced, because a
        // re-seat commits no key at all — the state the room answers with is what gives the
        // connection a role, and the report for it is the `state` event below.
        this.peerList = this.relay.peerInfos();
        this.ownRole = this.appliedRole();
        this.openDocuments = this.roomDocuments();
        this.emit({ type: 'documentsChanged', documents: [...this.openDocuments] });
        this.emit({ type: 'peersChanged', peers: this.relay.peerInfos() });
        return;
      }
      case 'state': {
        // §13.4: the roles are the applied state's word, this connection's own included.
        this.refresh();
        return;
      }
      case 'failed': {
        this.emit({ type: 'sessionError', code: event.code, message: event.reason });
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
    const role = this.appliedRole();
    if (!samePeers(peers, this.peerList) || role !== this.ownRole) {
      this.ownRole = role;
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
