/**
 * A `selvage/2` session over a socket: the wiring `PeerSession` (`PROTOCOL.md` §13) and the
 * host's producer half (`§7.1`) were written to be handed.
 *
 * {@link PeerSession} decides; this module moves the bytes. It opens the WebSocket, sends
 * `session.hello` at `selvage/2`, seats the connection from `room.created`/`room.joined`, then
 * hands every binary frame to the session and every frame the session produced to the socket.
 * It runs the session's clocks on a timer of its own (`§13.8`), because a session renews nothing
 * if only the caller moves it.
 *
 * It lives in the engine because the three clients drive the same wiring: the socket is a seam
 * ({@link WebSocketFactory}, whose default is the `ws` package the page's build stubs out), the
 * crypto is a seam ({@link FrameCrypto}, whose default is WebCrypto), and what is left is
 * `PROTOCOL.md` §5's handshake, which is the same for a page, a companion and an extension host.
 * A client that carries this copy supplies its own transport and seam where it differs from the
 * defaults, rather than writing the wiring again.
 *
 * **What it is not.** It is the relay and nothing above it: it says nothing to an editor. What
 * an editor-facing engine has to add is `src/bridge/peer-engine.ts`, which reads this and the
 * session's observables into the bridge's own vocabulary.
 */

import WebSocket from 'ws';

import { CLIENT_CAPABILITIES, DEFAULT_KEEPALIVE, event as eventName, isTerminalCode, numberField, parseServerMessage } from './envelope.ts';
import type { Keepalive } from './envelope.ts';
import { endingReason, parseInvite, PeerSession, unrefTimer } from './peer.ts';
import type { Ending, PeerInvite, PeerOptions } from './peer.ts';
import type { HostStore } from './host.ts';
import { encodeKey, mintSessionKey } from './sealed.ts';
import type { FrameCrypto } from './crypto.ts';
import { webCrypto } from './crypto-web.ts';
import { openSocket } from './transport.ts';
import type { OpenSocket, WebSocketFactory, WebSocketLike } from './transport.ts';
import { ProtocolError } from './errors.ts';
import { DEFAULT_RECONNECT, attemptsForGrace } from './reconnect.ts';
import type { ReconnectPolicy } from './reconnect.ts';
import { fetchMeta } from './meta.ts';
import { sessionBase, parseSessionUrl, sessionUrl } from './urls.ts';
import type { SessionBase } from './urls.ts';
import type { AwarenessState, OffsetSelection, Presence, Selection } from './presence.ts';
import type { PeerInfo, Role } from './envelope.ts';

/** The version this module speaks. `selvage/1` is the engine's, and stays where it is. */
export const WIRE_VERSION_V2 = 'selvage/2';

/** How long the upgrade and the handshake may take together before the connection is abandoned. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/** A peer as `selvage/2` records it: `PROTOCOL.md` §6.1's `PeerInfo` without `role`. */
export interface RelayPeer {
  peer_id: string;
  display_name: string;
  awareness_client_id?: number;
}

/** What the server said at the end of the `selvage/2` handshake. */
export interface RelaySessionInfo {
  roomId: string;
  /** Present only for the connection that minted the room, and never echoed after. */
  token?: string;
  /** This connection's seat: the `peer_id` the relay showed it under. */
  seat: string;
  /** The seats already in the room, without this connection. */
  peers: RelayPeer[];
  capabilities: string[];
  keepalive: Keepalive;
  baseUrl: SessionBase;
}

/**
 * Why a `selvage/2` session is over. `§13.10`'s three are `PeerSession`'s own; `room-gone` is
 * the relay's, which no peer can sign because the room is not a key.
 */
export type RelayEnding = Ending | 'room-gone';

/** What a relay reports after it moved something. */
export type RelayEvent =
  | { type: 'seated' }
  /**
   * §9.1's bounded retry is running: the socket dropped and a fresh `session.hello` on a new
   * socket is being attempted. A `seated` follows when it lands, and an `ended` when it gives
   * up — an adapter shows the retry instead of inferring it from silence.
   */
  | { type: 'reconnecting' }
  | { type: 'peers'; peers: RelayPeer[] }
  | { type: 'listing'; listing: readonly string[] }
  | { type: 'content'; documents: string[] }
  /** A content frame was applied: the replica's text for some path is not what it was. */
  | { type: 'text' }
  | { type: 'ended'; ending: RelayEnding }
  /** A fault the server reported: its code (§11) is the caller's to read, not only its words. */
  | { type: 'failed'; code: string; reason: string };

export type RelayEventListener = (event: RelayEvent) => void;

/** What both a mint and a join are given. */
export interface RelayOptions {
  crypto?: FrameCrypto;
  webSocketFactory?: WebSocketFactory;
  /** Free-form client identifier, for diagnostics (`PROTOCOL.md` §5). */
  client?: string;
  /** Overrides the clock the server advertises. The server's numbers are the session's. */
  keepalive?: Partial<Keepalive>;
  handshakeTimeoutMs?: number;
  /**
   * §9.1's bounded reconnect for a guest whose socket drops. `false` turns it off; the fields
   * override the defaults, and the attempt budget is raised from the room's advertised grace
   * (see {@link RelayOptions.fetchImpl}) exactly as the version-1 engine raises its own.
   */
  reconnect?: false | Partial<ReconnectPolicy>;
  /** `GET /meta`, over which the room's grace is read; a seam for a caller with its own fetch. */
  fetchImpl?: typeof fetch;
}

/** Minting a room (`PROTOCOL.md` §5.1, §7.1). */
export interface RelayHostOptions extends RelayOptions {
  baseUrl: string;
  displayName: string;
  /** The room's working tree as this host enumerates it: names, and no content (`§7.1`). */
  listing(): readonly string[];
  /** The room key, persisted with the host key so a returning host re-derives the same frame key. */
  roomKey?: Uint8Array;
  /** The host key's 32-byte seed, persisted so a returning host can still sign a state. */
  hostSeed?: Uint8Array;
  /** Where the host key and its `issued` are kept (`§7.1`); omitted is an in-memory host. */
  store?: HostStore;
}

/** The two keys and the address, when a caller holds them apart from a link (`§5.1`). */
export interface RelayHandover {
  socketUrl: string;
  room: string;
  token: string;
  roomKey: Uint8Array;
  hostKey: Uint8Array;
}

/** Joining the room a link names (`PROTOCOL.md` §5.1, §13.1). */
export interface RelayJoinOptions extends RelayOptions {
  /** The invite link, either form, with its fragment: the wire URL or the page link. */
  invite: string;
  displayName: string;
  /** The role this connection declares in its announcement; the state is what assigns it. */
  declaredRole?: 'guest' | 'viewer';
  /** The connection URL and the two keys, when a caller holds them apart from a link. */
  handover?: RelayHandover;
}

interface QueuedFrame {
  text?: string;
  binary?: Uint8Array;
}

/**
 * One `selvage/2` connection: a socket, a {@link PeerSession} and the clocks between them.
 *
 * Every method that changes the session is async, because the crypto seam is
 * (`src/engine/crypto.ts`), and the relay serializes nothing itself: `PeerSession` already decides
 * one thing at a time, and `takeOutbound` hands frames back in the order it produced them.
 */
export class RelaySession {
  private readonly crypto: FrameCrypto;
  private readonly factory: WebSocketFactory;
  private readonly listeners = new Set<RelayEventListener>();

  private socket: OpenSocket | undefined;
  private session: PeerSession | undefined;
  private info: RelaySessionInfo | undefined;
  private start = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pendingInvite: string | undefined;
  private ending: RelayEnding | undefined;
  private fault: string | undefined;
  private destroyed = false;

  /** §9.1's bounded reconnect: the policy, its grace-sized budget, and the retry in flight. */
  private readonly reconnect: ReconnectPolicy;
  private retryBudget: number;
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Whether this relay reconnects. A guest may — §9.1's rejoin is a fresh `session.hello` — and
   * a host may not: this client writes no host store and this wire has no resume for a hosting
   * session, so a host's drop ends the session honestly rather than claiming a retry it cannot
   * make.
   */
  private readonly canReconnect: boolean;
  /** What a re-dial repeats: the seam options, the wire URL and the display name. */
  private dialOptions: RelayOptions | undefined;
  private dialUrl: string | undefined;
  /** The invite's room and two keys, which a re-seat reuses (§13.1's steps 1–2). */
  private invitePair: { roomId: string; roomKey: Uint8Array; hostKey: Uint8Array } | undefined;
  /** Which attempt's socket is still this relay's; a superseded socket's close is ignored. */
  private generation = 0;
  /**
   * Whether the socket now open is still in its `session.hello` exchange. A handshake refusal is
   * a refusal of *this* attempt, which on a reconnect is a re-dial and not the live session, so
   * the relay cannot tell them apart by whether a session exists — the session it already holds
   * is the one being re-seated.
   */
  private handshaking = false;

  /** The frames that arrived before the session existed, in arrival order. */
  private readonly inbox: QueuedFrame[] = [];
  private draining = false;

  /** The awareness client id this connection announced, which its session publishes under. */
  private awarenessId: number | undefined;
  /** The display name this connection seated with, which the room's own reply never names. */
  private ownName = '';
  /** The next `id` a text request carries: the hello is 1, and a rename follows it. */
  private requestId = 1;

  /** The server base this connection dialled, which a reply cannot name itself. */
  private dialled: SessionBase | undefined;
  /** The role this connection declared, which the applied state is what assigns. */
  private readonly ownRole: 'guest' | 'viewer' | undefined;
  /**
   * The peers the relay showed, and the last listing, room open set and peer list that were
   * reported, with the replica's own text paths — {@link documents}'s answer once no session
   * is left to read.
   */
  private peerList: RelayPeer[] = [];
  private lastListing: readonly string[] = [];
  private lastDocuments: string[] = [];
  private lastOpen: string[] = [];
  private lastPeers: RelayPeer[] = [];

  private constructor(
    crypto: FrameCrypto,
    factory: WebSocketFactory,
    ownRole: 'guest' | 'viewer' | undefined,
    options: RelayOptions,
    canReconnect: boolean,
  ) {
    this.crypto = crypto;
    this.factory = factory;
    this.ownRole = ownRole;
    this.canReconnect = canReconnect;
    this.reconnect =
      options.reconnect === false
        ? { ...DEFAULT_RECONNECT, enabled: false }
        : { ...DEFAULT_RECONNECT, ...options.reconnect };
    this.retryBudget = this.reconnect.maxAttempts;
  }

  // --- opening a session -----------------------------------------------------

  /** Mints a room; this connection is its host by holding the host key's private half. */
  static async host(options: RelayHostOptions): Promise<RelaySession> {
    const relay = new RelaySession(
      options.crypto ?? webCrypto,
      options.webSocketFactory ?? defaultFactory,
      undefined,
      options,
      false,
    );
    await relay.mint(options);
    return relay;
  }

  /** Joins the room an invite names; the fragment is read here and never reaches the socket. */
  static async join(options: RelayJoinOptions): Promise<RelaySession> {
    const read = readInvite(options);
    if (!read.ok) {
      throw new Error(read.reason);
    }
    const relay = new RelaySession(
      options.crypto ?? webCrypto,
      options.webSocketFactory ?? defaultFactory,
      options.declaredRole,
      options,
      true,
    );
    await relay.admit(options, read.invite);
    return relay;
  }

  private async mint(options: RelayHostOptions): Promise<void> {
    const base = sessionBase(options.baseUrl);
    if (base === undefined) {
      throw new Error(`not a session address: ${options.baseUrl}`);
    }
    const roomKey = options.roomKey ?? this.random(32, 'the room key');
    if (roomKey.length !== 32) {
      throw new Error('a room key is 32 bytes');
    }
    const hostSeed = options.hostSeed ?? this.random(32, 'the host key');
    const host = await mintSessionKey(this.crypto, hostSeed);
    if (host === undefined) {
      throw new Error('the host key could not be derived from its seed');
    }
    const info = await this.dial(options, base, sessionUrl(base), options.displayName);
    this.info = info;
    // §7.1: the host signs states with the key the invite's `h` carries, and publishes its first
    // one at mint, which is what brings the listing into existence for the first joiner.
    await this.seat(options, {
      roomId: info.roomId,
      roomKey,
      hostKey: host.public,
      seat: info.seat,
      roster: info.peers.map((peer) => peer.peer_id),
      host: {
        hostSeed,
        listing: options.listing,
        ...(options.store === undefined ? {} : { store: options.store }),
      },
    });
    // The invite is the room key and the host's public key in the fragment, `§5.1`'s order.
    if (info.token !== undefined) {
      this.pendingInvite = `${sessionUrl(base, info.roomId, info.token)}#k=${encodeKey(roomKey)}&h=${encodeKey(host.public)}`;
    }
  }

  private async admit(options: RelayJoinOptions, invite: PeerInvite): Promise<void> {
    const parsed = parseSessionUrl(invite.socketUrl);
    if (parsed === undefined) {
      throw new Error('the invite does not address a session endpoint');
    }
    this.invitePair = { roomId: invite.room, roomKey: invite.roomKey, hostKey: invite.hostKey };
    // §9.1: the room's own grace is what the retry budget has to span, read the way the
    // version-1 engine reads it. Best effort — an unreachable `/meta` decides nothing — and it
    // is awaited so a drop immediately after the join still finds the budget in place.
    await this.applyGrace(parsed.base, options);
    const info = await this.dial(options, parsed.base, invite.socketUrl, options.displayName);
    this.info = info;
    await this.seat(options, {
      roomId: invite.room,
      roomKey: invite.roomKey,
      hostKey: invite.hostKey,
      seat: info.seat,
      roster: info.peers.map((peer) => peer.peer_id),
      ...(options.declaredRole === undefined ? {} : { declaredRole: options.declaredRole }),
    });
  }

  /**
   * Sizes the retry budget from `/meta`'s advertised grace, the number §9.1 says a client that
   * knows the room's grace keeps retrying through. It only ever grows, so a room the server has
   * reaped answers `room_unknown` — terminal — while a budget that gave up early would lose a
   * room that was still joinable.
   */
  private async applyGrace(base: SessionBase, options: RelayOptions): Promise<void> {
    if (!this.reconnect.enabled) {
      return;
    }
    let meta;
    try {
      meta = await fetchMeta(
        base,
        options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
      );
    } catch {
      // Unreachable or not JSON: not an answer about the room's grace.
      return;
    }
    const graceMs = numberField(meta.keepalive, 'room_grace_ms');
    if (graceMs === undefined || graceMs <= 0) {
      return;
    }
    this.retryBudget = Math.max(this.retryBudget, attemptsForGrace(graceMs, this.reconnect));
  }

  /** Opens the socket, says `session.hello` at `selvage/2`, and waits to be seated. */
  private async dial(
    options: RelayOptions,
    base: SessionBase,
    url: string,
    displayName: string,
  ): Promise<RelaySessionInfo> {
    this.dialled = base;
    this.ownName = displayName;
    // Every dial is its own attempt: a socket a later dial has superseded must not end the
    // session when it closes.
    const generation = (this.generation += 1);
    this.dialOptions = options;
    this.dialUrl = url;
    const timeout = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    const attempt = new AbortController();
    this.handshaking = true;
    let seating: (answer: RelaySessionInfo) => void = () => undefined;
    let refusing: (error: Error) => void = () => undefined;
    const seated = new Promise<RelaySessionInfo>((resolve, reject) => {
      seating = (answer) => {
        this.handshaking = false;
        resolve(answer);
      };
      refusing = reject;
    });
    void seated.catch(() => undefined);
    const deadline = setTimeout(() => {
      const error = new Error('the server did not answer session.hello in time');
      refusing(error);
      attempt.abort(error);
    }, timeout);
    try {
      const socket = await openSocket(
        url,
        {
          onText: (text) => {
            if (generation === this.generation) {
              this.onText(text, seating, refusing);
            }
          },
          onBinary: (bytes) => {
            if (generation === this.generation) {
              this.enqueue({ binary: bytes });
            }
          },
          onClose: (code, reason) => {
            if (generation !== this.generation) {
              // A superseded attempt: its close is not this session's, and the attempt that
              // replaced it owns the socket now.
              return;
            }
            if (this.handshaking) {
              // Closed before it was seated: the handshake will never finish.
              refusing(new Error(`the socket closed before the session was seated: ${code} ${reason}`));
              return;
            }
            this.onClose(code, reason);
          },
          onError: () => {
            // The close handler reports it; an error alone does not end a session.
          },
        },
        this.factory,
        attempt.signal,
      );
      if (generation !== this.generation) {
        socket.close();
        throw new Error('the connection attempt was superseded');
      }
      this.socket = socket;
      // §8.4: the id the server records for this connection is the id this session's
      // awareness states carry, so a peer's caret is attributed to the seat that published it.
      // A reconnect mints a fresh one (§9.1): an id a peer has already tombstoned would have
      // its first republish dropped, and the rejoined peer would look like one with no cursor.
      this.awarenessId = awarenessClientId(this.crypto);
      socket.sendText(
        JSON.stringify(helloEnvelope(displayName, options, this.awarenessId)),
      );
      const info = await seated;
      if (generation !== this.generation) {
        this.socket?.close();
        this.socket = undefined;
        throw new Error('the connection attempt was superseded');
      }
      // §13.8 reads this session's clocks as elapsed time from its seat, so the clock keeps
      // running across a reconnect instead of restarting under the marks it already holds.
      if (this.start === 0) {
        this.start = performance.now();
      }
      this.peerList = [...info.peers];
      return info;
    } catch (error) {
      if (generation === this.generation) {
        this.socket?.close();
        this.socket = undefined;
      }
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(deadline);
    }
  }

  private async seat(options: RelayOptions, peer: Omit<PeerOptions, 'keepalive' | 'crypto'>): Promise<void> {
    const keepalive = keepaliveOf(this.info?.keepalive, options.keepalive);
    const session = await PeerSession.create({
      ...peer,
      crypto: this.crypto,
      keepalive,
      ...(this.awarenessId === undefined ? {} : { awarenessClientId: this.awarenessId }),
    });
    if (session === undefined) {
      throw new Error('the session could not be built from the invite');
    }
    this.session = session;
    this.fault ??= session.failure;
    this.timer = setInterval(() => {
      void this.pump();
    }, keepalive.awareness_renew_ms);
    // The session's clock is the relay's own interval, and `disconnect` clears it; a caller that
    // never disconnects would otherwise hold its process open for as long as the session lives.
    unrefTimer(this.timer);
    this.emit({ type: 'seated' });
    // §13.1's step 4: a guest's announcement belongs at the join, and a host's first state is
    // already in the outbound queue, so both go out on this tick rather than on a timer the
    // caller would wait a whole renewal window for.
    await this.drain();
    await this.pump();
  }

  private random(length: number, what: string): Uint8Array {
    try {
      return this.crypto.randomBytes(length);
    } catch {
      throw new Error(`${what} could not be minted from the platform's CSPRNG`);
    }
  }

  // --- what a caller reads ---------------------------------------------------

  /** The connection's session description. Throws before it is seated. */
  sessionInfo(): RelaySessionInfo {
    if (this.info === undefined) {
      throw new Error('the relay is not seated');
    }
    return this.info;
  }

  /** The invite this connection can hand on: the wire URL, its fragment carrying both keys. */
  invite(): string | undefined {
    return this.pendingInvite;
  }

  /** The role this connection declared; the applied state is what assigns one (`§13.4`). */
  get declaredRole(): 'guest' | 'viewer' | undefined {
    return this.ownRole;
  }

  get isHost(): boolean {
    return this.session?.isHost ?? false;
  }

  /** §13.10's ending, or `room-gone` when the relay said the room is over. */
  get end(): RelayEnding | undefined {
    return this.ending ?? this.session?.end;
  }

  /** A sentence for the three endings `§13.10` has; `room-gone` is the relay's own and has none. */
  endingSentence(): string | undefined {
    const end = this.ending ?? this.session?.end;
    return end === undefined || end === 'room-gone' ? undefined : endingReason(end);
  }

  get failure(): string | undefined {
    return this.fault ?? this.session?.failure;
  }

  peers(): RelayPeer[] {
    return [...this.peerList];
  }

  listing(): readonly string[] {
    return this.session?.listing ?? this.lastListing;
  }

  /** The paths this replica holds text for, which is what a content frame's scan reads. */
  documents(): string[] {
    return this.session?.documents() ?? this.lastDocuments;
  }

  text(path: string): string {
    return this.session?.text(path) ?? '';
  }

  heldPaths(): string[] {
    return this.session?.heldPaths() ?? [];
  }

  /** What each peer is held to, by key or seat (`§13.7`, `§13.4`). */
  peerHolds(): Map<string, string[]> {
    return this.session?.peerHolds() ?? new Map();
  }

  /** Subscribes to relay events. Returns the unsubscribe function. */
  on(listener: RelayEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // --- what the caller hands in ----------------------------------------------

  /** §13.1's join order: a hold is taken once the state is held, not before. */
  open(path: string): void {
    this.session?.open(path);
    // §13.7 asks for the whole held set when it changes rather than at the next renewal, so the
    // hold goes out on the session's own clocks now instead of waiting a whole window.
    void this.pump();
  }

  /** Releases a path, or every path when given none (`§13.7`). */
  release(path?: string): void {
    this.session?.release(path);
    void this.pump();
  }

  /** One local insert. Returns whether it was published — a `viewer`'s is not (`§13.9`). */
  async insert(path: string, index: number, text: string): Promise<boolean> {
    const session = this.session;
    if (session === undefined) {
      return false;
    }
    const published = await session.insert(path, index, text);
    this.drainOutbound();
    return published;
  }

  /** One local deletion. Returns whether it was published, by the same rule as `insert`. */
  async remove(path: string, index: number, length: number): Promise<boolean> {
    const session = this.session;
    if (session === undefined) {
      return false;
    }
    const published = await session.remove(path, index, length);
    this.drainOutbound();
    return published;
  }

  /** Publishes this connection's presence: a path and a selection in offsets (`§8.1`). */
  setSelection(path: string, selection: OffsetSelection): void {
    this.session?.setSelection(path, selection);
    this.whenPublished();
  }

  /** Publishes this connection's awareness state (`§8.1`), or `null` to clear it. */
  setAwareness(state: AwarenessState | null): void {
    this.session?.setAwareness(state);
    this.whenPublished();
  }

  /**
   * Writes what the session published once the decision behind it has settled: an awareness
   * state is sealed asynchronously, so a caret that was handed in now is a frame a moment
   * later, and the socket is what has to wait for it rather than the renewal clock.
   */
  private whenPublished(): void {
    const session = this.session;
    if (session === undefined) {
      return;
    }
    void session.whenIdle().then(() => {
      this.drainOutbound();
    });
  }

  /**
   * Every awareness state this connection holds, attributed to the seats the relay knows
   * (`§8.4`). The names come from the handshake and the seam; the anchors come from the session.
   */
  presence(): Presence[] {
    const session = this.session;
    if (session === undefined) {
      return [];
    }
    const local = this.selfInfo();
    return session.presence(this.peerInfos(), local);
  }

  /** The role the applied state gives this connection's own key (`§13.4`). */
  appliedRole(): string | undefined {
    return this.session?.ownRole();
  }

  /** The roles the applied state assigns, by the seat each committed key is labelled (`§7.1`). */
  rolesBySeat(): Map<string, string> {
    return this.session?.rolesBySeat() ?? new Map();
  }

  /** §13.8's host-away clock: what is left of the window, or `undefined` while none is running. */
  hostAwayGraceMs(): number | undefined {
    return this.session?.hostAwayGraceMs(this.clock());
  }

  /** The seat the applied state names as the host connection, if any (`§13.4`). */
  namedHostSeat(): string | undefined {
    return this.session?.namedHostSeat();
  }

  /** The monotone elapsed time from this connection's seat, in milliseconds (`§13.8`). */
  elapsedMs(): number {
    return this.clock();
  }

  /**
   * The awareness client id this connection announced (`§8.4`): the id the room records for this
   * seat, and the one the states it publishes carry, so a peer can attribute a caret to a seat.
   */
  awarenessClientId(): number | undefined {
    return this.awarenessId;
  }

  /** Resolves a peer's selection to offsets in this replica (`§8.1`). */
  resolveSelection(path: string, selection: Selection): OffsetSelection | undefined {
    return this.session?.resolveSelection(path, selection);
  }

  /** Whether this replica holds text for a path. */
  has(path: string): boolean {
    return this.session?.has(path) ?? false;
  }

  /** The length of a document's text in UTF-16 code units, the unit every editor counts in. */
  length(path: string): number {
    return this.session?.length(path) ?? 0;
  }

  /** The seats and names the relay knows, with the roles the applied state assigns (`§8.4`). */
  peerInfos(): PeerInfo[] {
    const roles = this.rolesBySeat();
    const infos: PeerInfo[] = [];
    for (const peer of this.peerList) {
      const role = roles.get(peer.peer_id);
      infos.push({
        peer_id: peer.peer_id,
        display_name: peer.display_name,
        role: (role ?? 'guest') as Role,
        ...(peer.awareness_client_id === undefined
          ? {}
          : { awareness_client_id: peer.awareness_client_id }),
      });
    }
    return infos;
  }

  /** This connection's own record, as the handshake seated it. */
  selfInfo(): PeerInfo {
    return {
      peer_id: this.info?.seat ?? '',
      display_name: this.ownName,
      role: (this.appliedRole() ?? 'guest') as Role,
      ...(this.awarenessId === undefined ? {} : { awareness_client_id: this.awarenessId }),
    };
  }

  /**
   * Changes this connection's display name (`PROTOCOL.md` §5). The server answers the mover and
   * the rest of the room with `peer.renamed`; every other client's roster follows that event,
   * and a seat the room does not list — this connection's own — has nothing to re-label.
   */
  async rename(displayName: string): Promise<void> {
    const socket = this.socket;
    if (socket === undefined || !socket.isOpen) {
      throw new Error('the session is not connected');
    }
    this.requestId += 1;
    socket.sendText(
      JSON.stringify({
        v: WIRE_VERSION_V2,
        id: this.requestId,
        method: 'session.rename',
        params: { display_name: displayName },
      }),
    );
  }

  /** The host's listing changed: the whole tree as it now is (`§7.1`). */
  async listingChanged(): Promise<void> {
    const session = this.session;
    if (session === undefined) {
      return;
    }
    await session.listingChanged(this.clock());
    this.report();
    this.drainOutbound();
  }

  /** §7.1's closing: the host's statement that the room is over. */
  async closeRoom(): Promise<boolean> {
    const session = this.session;
    if (session === undefined) {
      return false;
    }
    const closed = await session.closeRoom();
    this.drainOutbound();
    return closed;
  }

  /** Runs the session's clocks once, which is what a caller with its own timer calls. */
  async tick(): Promise<void> {
    await this.pump();
  }

  /** Ends the session: the socket closed, the clock stopped, the document released. */
  disconnect(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.clearRetry();
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    // A dial in flight is this connection's own; superseding it keeps its socket from being
    // read as a live session's when it lands after the caller has left.
    this.generation += 1;
    this.socket?.close();
    this.socket = undefined;
    this.session?.destroy();
  }

  // --- the frame path --------------------------------------------------------

  private onText(
    text: string,
    seating: (answer: RelaySessionInfo) => void,
    refusing: (error: Error) => void,
  ): void {
    const message = parseServerMessage(text);
    if (message === undefined) {
      return;
    }
    if (message.event === eventName.roomCreated || message.event === eventName.roomJoined) {
      const info = this.infoOf(message.params);
      if (info === undefined) {
        refusing(new Error('the handshake reply was not a room description'));
        return;
      }
      seating(info);
      return;
    }
    if (message.event === eventName.sessionError && this.handshaking) {
      refusing(this.sessionFault(message.params));
      return;
    }
    this.enqueue({ text });
  }

  /**
   * A `session.error` event as the refusal it is. `§6.3` carries the code and the sentence in
   * the event's `params` — `src/engine/engine.ts` reads them from there for `selvage/1`, and the
   * server's own frame is `{"event":"session.error","params":{"code":…,"message":…}}`.
   * `ServerMessage.error` is the shape of a refused *request*, so reading it here turned every
   * handshake refusal and every mid-session fault into one generic sentence with its code lost,
   * which is what left `§11`'s terminal codes unreadable to a caller.
   */
  private sessionFault(params: unknown): ProtocolError {
    return new ProtocolError(
      textOf(params, 'code') ?? 'error',
      textOf(params, 'message') ?? 'the server reported a fault',
    );
  }

  /** The `room.created`/`room.joined` params, with the base the caller dialled. */
  private infoOf(params: unknown): RelaySessionInfo | undefined {
    if (!isRecord(params)) {
      return undefined;
    }
    const roomId = typeof params['room_id'] === 'string' ? params['room_id'] : undefined;
    const self = peerOf(params['self']);
    if (roomId === undefined || self === undefined || this.dialled === undefined) {
      return undefined;
    }
    const peers: RelayPeer[] = [];
    if (Array.isArray(params['peers'])) {
      for (const entry of params['peers']) {
        const peer = peerOf(entry);
        if (peer !== undefined) {
          peers.push(peer);
        }
      }
    }
    const keepalive = isRecord(params['keepalive']) ? params['keepalive'] : {};
    return {
      roomId,
      ...(typeof params['token'] === 'string' ? { token: params['token'] } : {}),
      seat: self.peer_id,
      peers,
      capabilities: Array.isArray(params['capabilities'])
        ? params['capabilities'].filter((name): name is string => typeof name === 'string')
        : [],
      keepalive: {
        ping_interval_ms: numberOr(keepalive['ping_interval_ms'], DEFAULT_KEEPALIVE.ping_interval_ms),
        awareness_renew_ms: numberOr(keepalive['awareness_renew_ms'], DEFAULT_KEEPALIVE.awareness_renew_ms),
        awareness_expire_ms: numberOr(keepalive['awareness_expire_ms'], DEFAULT_KEEPALIVE.awareness_expire_ms),
      },
      baseUrl: this.dialled,
    };
  }

  private onClose(code: number, reason: string): void {
    // A disconnect this client asked for is not the room ending: the relay is already gone.
    if (this.destroyed || this.ending !== undefined) {
      return;
    }
    const said = `the connection ended (${code}${reason === '' ? '' : ` ${reason}`})`;
    this.socket = undefined;
    // A host has no resume on this wire (no host store; §9.1's host return is unwired), so its
    // drop is the end of the session and is said as one. A guest's is recoverable (§9.1).
    if (!this.canReconnect || !this.reconnect.enabled || this.session === undefined) {
      this.fault ??= said;
      this.endWith('room-gone');
      return;
    }
    this.fault ??= said;
    this.scheduleReconnect();
  }

  /**
   * §9.1's bounded reconnect: a dropped guest socket is re-helloed on a new socket, with
   * exponential backoff. The retry is said out loud first — an adapter cannot tell a quiet
   * socket from a slow room — and it is bounded by the attempt budget, which the room's own
   * advertised grace raised (see {@link applyGrace}).
   */
  private scheduleReconnect(): void {
    if (this.destroyed || this.ending !== undefined) {
      return;
    }
    if (this.attempts >= this.retryBudget) {
      this.endWith('room-gone');
      return;
    }
    const delay = Math.min(
      this.reconnect.initialDelayMs * 2 ** this.attempts,
      this.reconnect.maxDelayMs,
    );
    this.attempts += 1;
    this.emit({ type: 'reconnecting' });
    // A listener may have ended the session from the event above; scheduling the retry after
    // it would reopen a destroyed relay.
    if (this.destroyed || this.ending !== undefined) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      void this.retry();
    }, delay);
    unrefTimer(this.retryTimer);
  }

  /** One re-dial: the same invite, a fresh `session.hello`, and the same session reseated. */
  private async retry(): Promise<void> {
    this.retryTimer = undefined;
    if (this.destroyed || this.ending !== undefined) {
      return;
    }
    const options = this.dialOptions;
    const url = this.dialUrl;
    const pair = this.invitePair;
    const base = this.dialled;
    if (options === undefined || url === undefined || pair === undefined || base === undefined) {
      this.endWith('room-gone');
      return;
    }
    let info: RelaySessionInfo;
    try {
      info = await this.dial(options, base, url, this.ownName);
    } catch (error) {
      const code = error instanceof ProtocolError ? error.code : undefined;
      // §9.1: a refusal a retry cannot change — `room_unknown`, `token_invalid`, and a fault in
      // the reserved `x.` namespace — is a stop, not another attempt. The reason is reported as
      // the fault it is before the session ends, so the person is told why.
      if (code !== undefined && terminalForRetry(code)) {
        this.fault = error instanceof Error ? error.message : String(error);
        this.emit({ type: 'failed', code, reason: this.fault });
        this.endWith('room-gone');
        return;
      }
      this.scheduleReconnect();
      return;
    }
    if (this.destroyed || this.ending !== undefined) {
      return;
    }
    this.info = info;
    this.attempts = 0;
    // The drop's own sentence is over once the room is back; a real session fault, if any,
    // is still read from the session below.
    this.fault = this.session?.failure;
    const session = this.session;
    if (session === undefined) {
      this.endWith('room-gone');
      return;
    }
    try {
      // §9.1: the rejoin is a new peer — a new session keypair, the new seat — over the same
      // replica, whose marks and holds survive. §13.1's steps 4 and 6 replay the announcement
      // and the sync handshake, and the room's own state re-send restores the rest.
      await session.reseat(
        info.seat,
        info.peers.map((peer) => peer.peer_id),
        this.awarenessId ?? 0,
      );
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.emit({ type: 'seated' });
    await this.drain();
    await this.pump();
  }

  /** Sets this session's ending, once, and reports it. */
  private endWith(ending: RelayEnding): void {
    if (this.ending !== undefined) {
      return;
    }
    this.ending = ending;
    this.clearRetry();
    this.emit({ type: 'ended', ending });
  }

  private clearRetry(): void {
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private enqueue(frame: QueuedFrame): void {
    this.inbox.push(frame);
    void this.drain();
  }

  /** One frame at a time, in the order it arrived, whichever side of the seat it came from. */
  private async drain(): Promise<void> {
    if (this.draining || this.session === undefined) {
      return;
    }
    this.draining = true;
    try {
      while (this.inbox.length > 0) {
        const frame = this.inbox.shift();
        if (frame === undefined) {
          break;
        }
        await this.process(frame);
      }
    } finally {
      this.draining = false;
    }
    this.report();
    this.drainOutbound();
  }

  private async process(frame: QueuedFrame): Promise<void> {
    const session = this.session;
    if (session === undefined) {
      return;
    }
    if (frame.binary !== undefined) {
      const outcome = await session.deliver(this.clock(), frame.binary);
      // §13.5's content, and only content: a state, a holds set and a closing change no text.
      if (outcome.status === 'applied' && outcome.kind === 0) {
        this.emit({ type: 'text' });
      }
      return;
    }
    if (frame.text === undefined) {
      return;
    }
    const message = parseServerMessage(frame.text);
    if (message === undefined) {
      return;
    }
    switch (message.event) {
      case eventName.peerJoined: {
        const peer = peerOf(message.params);
        if (peer !== undefined) {
          this.peerList = mergePeer(this.peerList, peer);
          await session.seatJoined(this.clock(), peer.peer_id);
        }
        break;
      }
      case eventName.peerLeft: {
        const peerId = textOf(message.params, 'peer_id');
        if (peerId !== undefined) {
          this.peerList = this.peerList.filter((peer) => peer.peer_id !== peerId);
          await session.seatLeft(this.clock(), peerId);
        }
        break;
      }
      case eventName.peerRenamed: {
        const peerId = textOf(message.params, 'peer_id');
        const name = textOf(message.params, 'display_name');
        if (peerId !== undefined && name !== undefined) {
          this.peerList = this.peerList.map((peer) =>
            peer.peer_id === peerId ? { ...peer, display_name: name } : peer,
          );
        }
        break;
      }
      case eventName.roomGone: {
        // §9.1: a room destroyed under a seated connection is an ending and not a retry, and
        // the wire has announced it, so no re-dial is attempted.
        this.endWith('room-gone');
        break;
      }
      case eventName.sessionError: {
        const fault = this.sessionFault(message.params);
        this.fault = fault.message;
        this.emit({ type: 'failed', code: fault.code, reason: fault.message });
        break;
      }
      default:
        break;
    }
  }

  /** One tick of the session's own clocks, then whatever it published. */
  private async pump(): Promise<void> {
    const session = this.session;
    if (session === undefined || this.ending !== undefined) {
      return;
    }
    await session.tick(this.clock());
    this.fault ??= session.failure;
    this.report();
    this.drainOutbound();
  }

  private drainOutbound(): void {
    const session = this.session;
    if (session === undefined || this.socket === undefined) {
      return;
    }
    for (const frame of session.takeOutbound()) {
      if (this.socket.isOpen) {
        this.socket.sendBinary(frame);
      }
    }
    this.fault ??= session.failure;
  }

  private report(): void {
    const session = this.session;
    if (session === undefined) {
      return;
    }
    const listing = session.listing;
    if (!sameStrings(listing, this.lastListing)) {
      this.lastListing = [...listing];
      this.emit({ type: 'listing', listing: this.lastListing });
    }
    // The replica's own documents are what {@link documents} falls back to once the session is
    // gone; what is compared below is the room's open set (see {@link openSet}).
    this.lastDocuments = session.documents();
    const documents = this.openSet();
    if (!sameStrings(documents, this.lastOpen)) {
      this.lastOpen = documents;
      this.emit({ type: 'content', documents });
    }
    const end = session.end;
    if (end !== undefined && this.ending === undefined) {
      this.ending = end;
      this.emit({ type: 'ended', ending: end });
    }
    const peers = this.peers();
    if (peers.length !== this.lastPeers.length || peers.some((peer, at) => peerLabel(peer) !== peerLabel(this.lastPeers[at]))) {
      this.lastPeers = peers;
      this.emit({ type: 'peers', peers });
    }
  }

  /**
   * The room's open set: the paths this connection holds together with every path a peer is
   * held to (`§13.7`).
   *
   * `selvage/2`'s server keeps membership only, so no `doc.opened` names the room's documents:
   * a hold does, and a hold arrives in a frame that changes nothing of this replica's text. A
   * report comparing the replica alone stays silent for a path this connection holds no text
   * for, and a host never hears that a peer asked for a file it has not opened.
   */
  private openSet(): string[] {
    const paths = new Set(this.heldPaths());
    for (const holds of this.peerHolds().values()) {
      for (const path of holds) {
        paths.add(path);
      }
    }
    return [...paths].sort();
  }

  private emit(event: RelayEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  /** §13.8's clock: this client's own monotone elapsed time from its seat. */
  private clock(): number {
    return performance.now() - this.start;
  }
}

// --- the invite -------------------------------------------------------------

type InviteRead = { ok: true; invite: PeerInvite } | { ok: false; reason: string };

/** Reads a link, or the two keys handed over apart from one (`§5.1`'s escape hatch). */
function readInvite(options: RelayJoinOptions): InviteRead {
  if (options.handover !== undefined) {
    const { socketUrl, room, token, roomKey, hostKey } = options.handover;
    if (roomKey.length !== 32 || hostKey.length !== 32) {
      return { ok: false, reason: 'the handover carries no 32-byte room key or host key' };
    }
    return { ok: true, invite: { socketUrl, room, token, roomKey, hostKey } };
  }
  return parseInvite(wireInvite(options.invite));
}

/**
 * A link read back as the wire form `parseInvite` reads. The page form names the same room,
 * token and fragment over the scheme a browser speaks; `parseInvite` takes the endpoint form,
 * so the page is resolved to the connection URL first and the fragment is carried across
 * unchanged.
 */
export function wireInvite(link: string): string {
  const hash = link.indexOf('#');
  const address = hash === -1 ? link : link.slice(0, hash);
  const fragment = hash === -1 ? '' : link.slice(hash);
  if (address.endsWith('/session')) {
    return link;
  }
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return link;
  }
  const scheme = url.protocol === 'http:' ? 'ws:' : url.protocol === 'https:' ? 'wss:' : undefined;
  if (scheme === undefined) {
    return link;
  }
  const room = url.searchParams.get('room');
  const token = url.searchParams.get('token');
  if (room === null || room === '' || token === null || token === '') {
    return link;
  }
  const base = sessionBase(`${scheme}//${url.host}${url.pathname.replace(/\/+$/, '')}`);
  if (base === undefined) {
    return link;
  }
  return `${sessionUrl(base, room, token)}${fragment}`;
}

// --- the handshake envelopes ------------------------------------------------

/** The clocks the session runs on: the server's, overridden by the caller's (`§8.2`). */
function keepaliveOf(advertised: Keepalive | undefined, given: Partial<Keepalive> | undefined): Keepalive {
  return {
    ping_interval_ms: given?.ping_interval_ms ?? advertised?.ping_interval_ms ?? DEFAULT_KEEPALIVE.ping_interval_ms,
    awareness_renew_ms:
      given?.awareness_renew_ms ?? advertised?.awareness_renew_ms ?? DEFAULT_KEEPALIVE.awareness_renew_ms,
    awareness_expire_ms:
      given?.awareness_expire_ms ?? advertised?.awareness_expire_ms ?? DEFAULT_KEEPALIVE.awareness_expire_ms,
  };
}

/** `session.hello` at `selvage/2`: no `role`, because the version seats nobody as anything. */
function helloEnvelope(
  displayName: string,
  options: RelayOptions,
  awarenessId: number,
): Record<string, unknown> {
  return {
    v: WIRE_VERSION_V2,
    id: 1,
    method: 'session.hello',
    params: {
      display_name: displayName,
      awareness_client_id: awarenessId,
      capabilities: [...CLIENT_CAPABILITIES],
      ...(options.client === undefined ? {} : { client: options.client }),
    },
  };
}

/** The awareness client id this connection announces, which is the one its session publishes under. */
function awarenessClientId(crypto: FrameCrypto): number {
  let bytes: Uint8Array;
  try {
    bytes = crypto.randomBytes(4);
  } catch {
    return 0;
  }
  return (((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)) >>> 0;
}

function defaultFactory(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

/**
 * One `PeerInfo` from an event's params, in either shape the version's events use: a
 * `peer.joined` wraps its record under `peer`, and a handshake reply names its own seat and the
 * seats already in the room inline. `role` is not read here: `selvage/2`'s server seats nobody
 * as anything, so the role comes from the room state (§13.4).
 */
function peerOf(value: unknown): RelayPeer | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const record = isRecord(value['peer']) ? value['peer'] : value;
  const peerId = typeof record['peer_id'] === 'string' ? record['peer_id'] : undefined;
  const displayName =
    typeof record['display_name'] === 'string' ? record['display_name'] : undefined;
  if (peerId === undefined || displayName === undefined) {
    return undefined;
  }
  const awareness =
    typeof record['awareness_client_id'] === 'number' ? record['awareness_client_id'] : undefined;
  return {
    peer_id: peerId,
    display_name: displayName,
    ...(awareness === undefined ? {} : { awareness_client_id: Math.trunc(awareness) }),
  };
}

function textOf(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value[key] === 'string' ? value[key] : undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A peer's seat, name and awareness id as one string, so a change is one comparison. */
function peerLabel(peer: RelayPeer | undefined): string {
  return peer === undefined
    ? ''
    : `${peer.peer_id}\u0000${peer.display_name}\u0000${peer.awareness_client_id ?? ''}`;
}

function mergePeer(peers: RelayPeer[], peer: RelayPeer): RelayPeer[] {
  const without = peers.filter((existing) => existing.peer_id !== peer.peer_id);
  return [...without, peer];
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, at) => value === right[at]);
}

/**
 * §9.1: a refusal a retry cannot change. The four named codes are terminal (§11, `isTerminalCode`),
 * and so is a fault in the reserved `x.` namespace — capacity, in this slice — which a handshake
 * refused with **MUST NOT** have re-helloed automatically.
 */
function terminalForRetry(code: string): boolean {
  return code.startsWith('x.') || isTerminalCode(code);
}
