/**
 * The room's other side, for adapter tests: a live `selvage/2` peer the built extension shares a
 * room with.
 *
 * A test that drives the extension over a room needs something in the room that is not the
 * extension — a host whose folder a guest joins, a peer whose caret the extension draws, a second
 * seat that opens a document so the room holds it — and this is that seat. It is the production
 * `PeerEngine` over the production `RelaySession`, with the two things a test wants from the
 * room's side: a listing it can replace wholesale, and the handful of readings the adapter tests
 * assert on.
 *
 * It speaks only the sealed wire, so a host mints the keys and its invite carries them in the
 * link's fragment; a peer joins with that link.
 */

import { PeerEngine } from '../../src/bridge/peer-engine.ts';
import type { PeerListing } from '../../src/bridge/peer-engine.ts';
import { RelaySession } from '../../src/engine/relay.ts';
import type {
  AwarenessState,
  EngineEventListener,
  OffsetSelection,
  PeerInfo,
  Presence,
  Role,
  Selection,
  SessionInfo,
} from '../../src/engine/index.ts';
import type { FrameCrypto } from '../../src/engine/crypto.ts';
import type { Keepalive } from '../../src/engine/envelope.ts';
import type { ReconnectPolicy } from '../../src/engine/reconnect.ts';
import type { WebSocketFactory } from '../../src/engine/transport.ts';

/**
 * What a test hands a host or a join. The fields the version-1 engine had that the sealed wire
 * does not are accepted and ignored rather than removed, so a test reads the same whether it
 * describes a host or a join.
 */
export interface LiveOptions {
  baseUrl?: string;
  displayName?: string;
  client?: string;
  reconnect?: false | Partial<ReconnectPolicy>;
  fetchImpl?: typeof fetch;
  keepalive?: Partial<Keepalive>;
  handshakeTimeoutMs?: number;
  crypto?: FrameCrypto;
  webSocketFactory?: WebSocketFactory;
  /** The role a join declares; the room's state is what assigns one. */
  declaredRole?: 'guest' | 'viewer';
}

/** A listing a test replaces wholesale, which is what `§7.1` seals a room's state from. */
function listingOf(paths: string[] = []): PeerListing {
  let listing = [...paths];
  return {
    current: () => listing,
    replace: (next) => {
      listing = [...next];
    },
  };
}

export class LiveSession {
  private readonly relay: RelaySession;
  private readonly engine: PeerEngine;
  /** The listing this host seals its states from, which `grant` and `open` replace. */
  private readonly listing: PeerListing;
  private readonly hosts: boolean;

  private constructor(
    relay: RelaySession,
    engine: PeerEngine,
    listing: PeerListing,
    hosts: boolean,
  ) {
    this.relay = relay;
    this.engine = engine;
    this.listing = listing;
    this.hosts = hosts;
  }

  /** Mints a room, as its host, with the listing the test will publish. */
  static async host(
    baseUrl: string,
    displayName: string,
    options: LiveOptions = {},
    listing: readonly string[] = [],
  ): Promise<LiveSession> {
    const shared = listingOf([...listing]);
    const relay = await RelaySession.host({
      baseUrl,
      displayName,
      listing: () => shared.current(),
      ...(options.client === undefined ? {} : { client: options.client }),
      ...(options.reconnect === undefined ? {} : { reconnect: options.reconnect }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.keepalive === undefined ? {} : { keepalive: options.keepalive }),
      ...(options.handshakeTimeoutMs === undefined
        ? {}
        : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
      ...(options.crypto === undefined ? {} : { crypto: options.crypto }),
      ...(options.webSocketFactory === undefined
        ? {}
        : { webSocketFactory: options.webSocketFactory }),
    });
    return new LiveSession(relay, new PeerEngine({ relay, displayName }), shared, true);
  }

  /** Joins the room an invite names, from either form of the link. */
  static async join(
    invite: string,
    displayName: string,
    options: LiveOptions = {},
  ): Promise<LiveSession> {
    const relay = await RelaySession.join({
      invite,
      displayName,
      ...(options.client === undefined ? {} : { client: options.client }),
      ...(options.declaredRole === undefined ? {} : { declaredRole: options.declaredRole }),
      ...(options.reconnect === undefined ? {} : { reconnect: options.reconnect }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.keepalive === undefined ? {} : { keepalive: options.keepalive }),
      ...(options.handshakeTimeoutMs === undefined
        ? {}
        : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
      ...(options.crypto === undefined ? {} : { crypto: options.crypto }),
      ...(options.webSocketFactory === undefined
        ? {}
        : { webSocketFactory: options.webSocketFactory }),
    });
    return new LiveSession(relay, new PeerEngine({ relay, displayName }), listingOf([]), false);
  }

  // --- what the bridge and an adapter read ------------------------------------

  session(): SessionInfo {
    return this.engine.session();
  }

  text(path: string): string {
    return this.engine.text(path);
  }

  has(path: string): boolean {
    return this.engine.has(path);
  }

  presence(): Presence[] {
    return this.engine.presence();
  }

  resolveSelection(path: string, selection: Selection): OffsetSelection | undefined {
    return this.engine.resolveSelection(path, selection);
  }

  /** The seats the relay showed, with the roles the applied state assigns (`§8.4`). */
  peers(): PeerInfo[] {
    return this.engine.session().peers;
  }

  /** The room's open-document set: the paths somebody holds (`§13.7`). */
  documents(): string[] {
    return [...this.engine.session().documents];
  }

  /** The room's listing as this replica holds it (`§7.1`). */
  grantedPaths(): string[] {
    return this.engine.grantedPaths();
  }

  /** The invite this connection can hand on: the wire URL with its fragment (`§5.1`). */
  inviteUrl(): string | undefined {
    return this.engine.inviteUrl();
  }

  /** The role the applied state gives this connection's own key (`§13.4`). */
  appliedRole(): Role | undefined {
    return this.engine.appliedRole();
  }

  on(listener: EngineEventListener): () => void {
    return this.engine.on(listener);
  }

  // --- what a test drives -----------------------------------------------------

  /**
   * Takes a hold on `path` (`§13.7`). A host also makes it part of the listing it shares, which
   * is what lets a joiner open it: `§7.1` has the listing in the room's state, so a path that
   * joins it is a state the room is told again.
   */
  async open(path: string): Promise<void> {
    await this.engine.open(path);
    if (this.hosts && !this.listing.current().includes(path)) {
      this.listing.replace([...this.listing.current(), path]);
      await this.relay.listingChanged();
    }
  }

  async close(path: string): Promise<void> {
    await this.engine.close(path);
  }

  insert(path: string, index: number, text: string): void {
    this.engine.insert(path, index, text);
  }

  delete(path: string, index: number, length: number): void {
    this.engine.delete(path, index, length);
  }

  setSelection(path: string, selection: OffsetSelection): void {
    this.engine.setSelection(path, selection);
  }

  setAwareness(state: AwarenessState | null): void {
    this.engine.setAwareness(state);
  }

  /** Changes the name the room sees (`PROTOCOL.md` §5). */
  async rename(displayName: string): Promise<void> {
    await this.engine.rename(displayName);
  }

  /**
   * The paths the room's other seats hold (§13.7), which is what a state commits and what the
   * room's document set grows from.
   */
  peerDocuments(): string[] {
    const paths: string[] = [];
    for (const holds of this.relay.peerHolds().values()) {
      for (const path of holds) {
        if (!paths.includes(path)) {
          paths.push(path);
        }
      }
    }
    return paths.sort();
  }

  /** Publishes the whole listing this host shares (`§7.1`). */
  async grant(paths: readonly string[]): Promise<void> {
    this.listing.replace(paths);
    await this.relay.listingChanged();
  }

  /** Ends the connection: the socket closes, the clock stops and the session is released. */
  async disconnect(): Promise<void> {
    await this.engine.disconnect();
  }
}
