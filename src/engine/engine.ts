/**
 * The Selvage sync engine: one `Y.Doc`, one `Y.Text` per open document, y-protocols
 * document sync and awareness, and the `selvage/1` session envelope over a WebSocket.
 *
 * This module deliberately imports no editor API. Everything an editor adapter needs is
 * an event (`on`) or a method on this class, which is the seam `DESIGN.md` §6 draws
 * between a sync engine and an editor adapter.
 */

import * as random from 'lib0/random';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { Awareness, removeAwarenessStates } from 'y-protocols/awareness';

import {
  DEFAULT_KEEPALIVE,
  WIRE_VERSION,
  close,
  code as errCode,
  event as eventName,
  grantParams,
  helloParams,
  isTerminalCode,
  method,
  numberField,
  parsePeer,
  parsePeerEvent,
  parsePeerRenamed,
  parseServerMessage,
  renameParams,
} from './envelope.ts';
import type {
  ClientMessage,
  DocEvent,
  DocSet,
  GrantParams,
  Keepalive,
  PeerInfo,
  Role,
  SessionParams,
} from './envelope.ts';
import { EngineClosedError, ProtocolError } from './errors.ts';
import type { EngineEvent, EngineEventListener } from './events.ts';
import { MAX_GRANT_PATHS, isGrantedPath } from '../bridge/grant.ts';
import { fetchMeta, metaAccepts } from './meta.ts';
import { buildPresence, sameAwareness, toAnchor, toRelativePosition } from './presence.ts';
import type {
  Anchor,
  AwarenessState,
  OffsetSelection,
  Presence,
  Selection,
} from './presence.ts';
import {
  applyFrame,
  encodeAwareness,
  encodeSyncStep1,
  encodeUpdate,
} from './sync.ts';
import { openSocket } from './transport.ts';
import type {
  OpenSocket,
  WebSocketFactory,
  WebSocketLike,
} from './transport.ts';
import { inviteUrl, parseSessionUrl, sessionUrl } from './urls.ts';

/** How long the session handshake may take before the connection is abandoned. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/** How long a request may wait for its answer before the caller is told it will not come. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The largest inbound frame this client will read, in bytes: the transport's own bound
 * (`PROTOCOL.md` §2.1, informative 16 MiB). A frame over it never arrives from a conforming
 * transport — it ends the connection the way a dropped socket does — so refusing one here
 * changes no session that obeys the wire, and bounds what an unbounded `JSON.parse` or
 * yjs update can allocate or do. Refusal is drop-and-continue, never fail: an over-bound
 * frame is ignored and the session goes on with the grant, documents and replica it holds,
 * stale rather than ended, because ending it would hand any sender a kill switch.
 */
const MAX_INBOUND_TEXT_BYTES = 16 * 1024 * 1024;

/** See `MAX_INBOUND_TEXT_BYTES`: the same bound for the binary frames yjs arrives in. */
const MAX_INBOUND_BINARY_BYTES = 16 * 1024 * 1024;

/** Marks a transaction as this client's own edit: an adapter already has it. */
const LOCAL_ORIGIN = Symbol('selvage:local');

/** Marks a remote update this client applied, so it is never echoed back into the room. */
const REMOTE_ORIGIN = Symbol('selvage:remote');

/** Marks a state removal this client made on its own clock rather than on a peer's word. */
const EXPIRY_ORIGIN = Symbol('selvage:expiry');

const defaultFactory: WebSocketFactory = (url) =>
  new WebSocket(url) as unknown as WebSocketLike;

/**
 * The awareness clock this client runs: renew every `renewMs`, forget a remote state
 * after `expireMs` (spec §8.2). The default comes from the server's `keepalive`.
 */
export interface KeepaliveClock {
  renewMs: number;
  expireMs: number;
}

/** Bounded reconnect (spec §9.1): a dropped socket is re-helloed, under a new peer id. */
export interface ReconnectPolicy {
  enabled: boolean;
  initialDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
}

const DEFAULT_RECONNECT: ReconnectPolicy = {
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  maxAttempts: 5,
};

/**
 * The most attempts a grace-derived budget asks for: an hour of the default backoff. A retry
 * loop has to end, and a server that advertises a grace past this one is advertising a window
 * the client does not keep retrying through — the budget is capped rather than unbounded, which
 * is the shape §9.1 fixes for every policy.
 */
const MAX_GRACE_ATTEMPTS = 360;

/**
 * How many attempts a policy needs before the wait in front of them adds up to `graceMs`
 * (§9.1). The grace is the room's own deadline and the backoff is what the policy fixes, so
 * this is the count of delays whose sum first reaches it; the count is capped, so a policy
 * with a tiny delay cannot turn a large advertised grace into an unbounded loop.
 */
function attemptsForGrace(graceMs: number, policy: ReconnectPolicy): number {
  const initial = Math.max(policy.initialDelayMs, 1);
  const ceiling = Math.max(policy.maxDelayMs, 1);
  let waited = 0;
  let attempts = 0;
  while (waited < graceMs && attempts < MAX_GRACE_ATTEMPTS) {
    waited += Math.min(initial * 2 ** attempts, ceiling);
    attempts += 1;
  }
  return attempts;
}

export interface ConnectOptions {
  /** Scheme and authority, without the `/session` path. */
  baseUrl: string;
  displayName: string;
  /** Joining an existing room: its id. */
  room?: string;
  /** Joining an existing room: its invite token. */
  token?: string;
  /** Claimed role. `undefined` lets the server decide: host when minting, guest otherwise. */
  role?: Role;
  /** Capabilities this client believes it has; the server ignores ones it does not know. */
  capabilities?: readonly string[];
  /** Free-form client identifier, for diagnostics. */
  client?: string;
  /** Overrides the clock the server advertises. The server's numbers are the session's. */
  keepalive?: KeepaliveClock;
  /**
   * The awareness state to publish once seated, **verbatim**: its anchors are not checked
   * against this replica and not converted from offsets, which is what resuming a previously
   * published state needs. `setSelection` is the path that anchors offsets and withholds what
   * this replica cannot anchor (§8.1); a caller using this one is responsible for the replica
   * holding the documents the anchors name.
   */
  awareness?: AwarenessState;
  /** Read `GET /meta` first (`'check'`, the default) or skip it (`'skip'`). */
  meta?: 'check' | 'skip';
  /** `false` turns reconnection off; the fields override the defaults. */
  reconnect?: false | Partial<ReconnectPolicy>;
  webSocketFactory?: WebSocketFactory;
  fetchImpl?: typeof fetch;
  handshakeTimeoutMs?: number;
  /**
   * How long `open()` and `close()` wait for the server's answer (10 s by default).
   * The bound belongs to the client, not the wire: a server that holds the socket open
   * and never answers would otherwise leave the caller waiting for ever.
   */
  requestTimeoutMs?: number;
}

/** What the server said at the end of the handshake. */
export interface SessionInfo {
  roomId: string;
  /** Present only for the connection that minted the room. */
  token?: string;
  role: Role;
  /** This connection's own peer record. */
  peer: PeerInfo;
  /** Peers that were already in the room. */
  peers: PeerInfo[];
  /** The room's open-document set at the moment of joining. */
  documents: string[];
  capabilities: string[];
  keepalive: Keepalive;
  /** The server base URL this connection was opened against, without the endpoint path. */
  baseUrl: string;
}

/** Options for a host that mints a room, or a guest joining one by invite URL. */
export type JoinOptions = Omit<
  ConnectOptions,
  'baseUrl' | 'displayName' | 'room' | 'token' | 'role'
>;

interface PendingRequestBase {
  resolve: () => void;
  reject: (error: Error) => void;
  /** The request's own deadline, cleared when its answer arrives. */
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A request waiting for its answer. An `open`/`close` names the document it is about; a
 * `rename` and a `grant` name no document, so their answers touch no document bookkeeping
 * (§5).
 */
type PendingRequest =
  | (PendingRequestBase & { kind: 'open' | 'close'; path: string })
  | (PendingRequestBase & { kind: 'rename' })
  | (PendingRequestBase & { kind: 'grant' });

/** The frame a request is built from, discriminated by the pending kind it will be stored under. */
type RequestFrame =
  | { kind: 'open' | 'close'; path: string; method: string; params: unknown }
  | { kind: 'rename'; method: string; params: unknown }
  | { kind: 'grant'; method: string; params: unknown };

interface SeatWaiter {
  resolve: (info: SessionInfo) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface QueuedFrame {
  text?: string;
  binary?: Uint8Array;
  /** The request this frame carries, so it can be dropped with its connection. */
  requestId?: number;
}

interface Refusal {
  code: string;
  message: string;
}

/**
 * A connected sync engine.
 *
 * Frames are written as they are produced and events are delivered to listeners in the
 * order the frames arrived, so an adapter can react to an event without polling. A
 * session that drops is re-helloed with a bounded backoff unless reconnection is turned
 * off; `room_unknown` and the other terminal refusals are not retried.
 */
export class SelvageEngine {
  readonly doc: Y.Doc;

  private readonly options: ConnectOptions;
  private readonly reconnect: ReconnectPolicy;
  private readonly factory: WebSocketFactory;
  private readonly awareness: Awareness;
  private readonly listeners = new Set<EngineEventListener>();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly texts = new Set<string>();
  private readonly peerMap = new Map<string, PeerInfo>();

  private current?: SessionInfo;
  private room?: string;
  private token?: string;
  private clock: KeepaliveClock;
  private socket?: OpenSocket;
  private queue: QueuedFrame[] = [];
  private paused = false;
  private seated = false;
  private disposed = false;
  private finished = false;
  private terminal = false;
  private refusal?: Refusal;
  private seatWaiter?: SeatWaiter;
  private handshaking = false;
  /**
   * Which connection's events are still this engine's. A socket that a handshake gave up on
   * is closed, and its close event must not be read as the session ending.
   */
  private generation = 0;
  private requestId = 0;
  private localState: AwarenessState | null;
  private roomDocuments: string[] = [];
  /** The room's grant: the host's listing of its working tree. Never content. */
  private granted: string[] = [];
  private heldDocuments: string[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  /**
   * Attempts a reconnect makes before it gives up. The policy's number, raised by
   * `applyGrace()` to cover a grace the room reported — but never lowered, and not touched
   * at all when the caller named the number itself.
   */
  private retryBudget: number;
  /** Whether the caller set `maxAttempts`: an explicit number is the caller's to choose. */
  private readonly maxAttemptsGiven: boolean;

  private constructor(options: ConnectOptions) {
    this.options = options;
    this.reconnect =
      options.reconnect === false
        ? { ...DEFAULT_RECONNECT, enabled: false }
        : { ...DEFAULT_RECONNECT, ...options.reconnect };
    this.retryBudget = this.reconnect.maxAttempts;
    this.maxAttemptsGiven =
      options.reconnect !== false && options.reconnect?.maxAttempts !== undefined;
    this.factory = options.webSocketFactory ?? defaultFactory;
    this.clock = {
      renewMs: options.keepalive?.renewMs ?? DEFAULT_KEEPALIVE.awareness_renew_ms,
      expireMs:
        options.keepalive?.expireMs ?? DEFAULT_KEEPALIVE.awareness_expire_ms,
    };
    this.localState = options.awareness ?? {};
    this.room = options.room;
    this.token = options.token;

    this.doc = new Y.Doc();
    this.awareness = new Awareness(this.doc);
    // y-protocols runs its own 15 s / 30 s tick. The server's `keepalive` is the
    // session's clock (spec §8.2), so that tick is stopped and `tick()` drives renewal
    // and expiry in its place.
    clearInterval(this.awareness._checkInterval);
    this.wireAwareness();
    this.wireDocument();
    this.publishAwareness();
  }

  // -- opening a session -----------------------------------------------------

  /** Connects and completes the handshake. */
  static async connect(options: ConnectOptions): Promise<SelvageEngine> {
    const engine = new SelvageEngine(options);
    await engine.start();
    return engine;
  }

  /** Mints a room; this connection becomes its host. */
  static host(
    baseUrl: string,
    displayName: string,
    options: JoinOptions = {},
  ): Promise<SelvageEngine> {
    return SelvageEngine.connect({
      ...options,
      baseUrl,
      displayName,
      role: 'host',
    });
  }

  /**
   * Joins the room an invite URL names — the link itself, not a room id and token taken
   * out of it. Rejects when the URL does not address the session endpoint or carries no
   * room and token.
   */
  static join(
    invite: string,
    displayName: string,
    options: JoinOptions = {},
  ): Promise<SelvageEngine> {
    const parsed = parseSessionUrl(invite);
    // A truncated paste's error must not echo the paste: the invite carries the room's
    // token, so the refusal names the missing part rather than the link.
    if (parsed === undefined) {
      return Promise.reject(
        new ProtocolError(errCode.badParams, 'not an invite URL: it has no session address'),
      );
    }
    if (parsed.join.room === undefined || parsed.join.token === undefined) {
      return Promise.reject(
        new ProtocolError(errCode.badParams, 'not an invite URL: it names no room to join'),
      );
    }
    return SelvageEngine.connect({
      ...options,
      baseUrl: parsed.base,
      displayName,
      room: parsed.join.room,
      token: parsed.join.token,
      role: 'guest',
    });
  }

  /** Starts the connection and seats it, or throws the reason it could not be seated. */
  private async start(): Promise<void> {
    await this.negotiate();
    const session = await this.hello();
    this.seat(session);
  }

  /**
   * Sizes the retry budget against a grace the room reported, from either place that carries
   * one: `/meta`'s `room_grace_ms` and a `host.detached`'s `grace_ms`. The budget only ever
   * grows, so a number that arrives later — or a larger one — is never a reason to give up
   * sooner; overshooting costs one handshake, because a room the server has reaped answers
   * `room_unknown`, which is terminal, while undershooting loses a room still open.
   */
  private applyGrace(graceMs: number): void {
    if (this.maxAttemptsGiven || graceMs <= 0) {
      return;
    }
    this.retryBudget = Math.max(
      this.retryBudget,
      attemptsForGrace(graceMs, this.reconnect),
    );
  }

  /** Applies `GET /meta`: advisory when unreachable, decisive when incompatible. */
  private async negotiate(): Promise<void> {
    if (this.options.meta === 'skip') {
      return;
    }
    let meta;
    try {
      meta = await fetchMeta(this.options.baseUrl, {
        ...(this.options.fetchImpl === undefined
          ? {}
          : { fetchImpl: this.options.fetchImpl }),
      });
    } catch {
      // `/meta` is a convenience, not the handshake: an unreachable one decides nothing.
      return;
    }
    if (!metaAccepts(meta)) {
      const offered = Array.isArray(meta.wire_versions)
        ? meta.wire_versions.join(', ')
        : 'nothing';
      throw new ProtocolError(
        errCode.unsupportedVersion,
        `${this.options.baseUrl} speaks ${offered}, not ${WIRE_VERSION}`,
      );
    }
    // §9.1: a client that knows the room's grace keeps retrying at least until the window has
    // passed, because a room survives its host's absence for exactly that long. `/meta` is
    // where a host reads it — the one number a host needs and the one its own `host.detached`
    // never reaches it with.
    const graceMs = numberField(meta.keepalive, 'room_grace_ms');
    if (graceMs !== undefined) {
      this.applyGrace(graceMs);
    }
  }

  /** Opens a socket, sends `session.hello`, and waits to be seated or refused. */
  private async hello(): Promise<SessionInfo> {
    this.handshaking = true;
    const generation = (this.generation += 1);
    if (generation > 1) {
      // Spec §9.1: a reconnect is a new peer, not the one it replaces. `yrs` keeps a
      // tombstone for a removed awareness client id, so reusing it here would have the
      // first republish silently dropped and a restarted clock never recover (the gap
      // the Rust reference client avoids by minting a fresh `Y.Doc` per attempt). The
      // document's content carries over regardless — only the identity does not.
      this.rotateIdentity();
    }
    // Request ids are unique per connection, so a new connection starts counting again.
    this.requestId = 0;
    // A refusal belongs to the connection that received it: a close must report the
    // session.error of *this* handshake, not one left over from the socket before.
    this.refusal = undefined;
    const url = sessionUrl(
      this.options.baseUrl,
      this.room,
      this.token,
    );
    // One deadline covers the upgrade and the handshake: a transport that never fires
    // open, error or close must not hold the caller until the OS gives up, so aborting
    // here closes the socket that never came up.
    const attempt = new AbortController();
    const waiting = new Promise<SessionInfo>((resolve, reject) => {
      this.seatWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const error = new ProtocolError(
            errCode.helloRequired,
            'the server did not answer session.hello in time',
          );
          this.rejectSeat(error);
          attempt.abort(error);
        }, this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS),
      };
    });
    // A socket that fails before it opens rejects this too, and that rejection is
    // reported by whichever `await` gets there first.
    void waiting.catch(() => undefined);
    const current = (): boolean => this.generation === generation;
    try {
      this.socket = await openSocket(
        url,
        {
          onText: (text) => {
            if (current()) {
              this.handleText(text);
            }
          },
          onBinary: (bytes) => {
            if (current()) {
              this.handleBinary(bytes);
            }
          },
          onClose: (code, reason) => {
            if (current()) {
              this.onSocketClosed(code, reason);
            }
          },
          onError: () => {
            // The close handler reports it; an error alone does not end a session.
          },
        },
        this.factory,
        attempt.signal,
      );
      const hello: ClientMessage = {
        v: WIRE_VERSION,
        id: (this.requestId += 1),
        method: method.sessionHello,
        params: helloParams({
          displayName: this.options.displayName,
          ...(this.options.role === undefined
            ? {}
            : { role: this.options.role }),
          awarenessClientId: this.doc.clientID,
          ...(this.options.capabilities === undefined
            ? {}
            : { capabilities: this.options.capabilities }),
          ...(this.options.client === undefined
            ? {}
            : { client: this.options.client }),
        }),
      };
      this.socket.sendText(JSON.stringify(hello));
      return await waiting;
    } catch (error) {
      // This socket belongs to a connection attempt that gave up: nothing it says counts
      // any more, and it must not be left open while the next attempt is made.
      this.generation += 1;
      attempt.abort(error);
      this.socket?.close();
      this.socket = undefined;
      throw error;
    } finally {
      this.handshaking = false;
    }
  }

  // -- state an adapter reads ------------------------------------------------

  /** The current session description. It changes on a reconnect: a new peer, same room. */
  session(): SessionInfo {
    const session = this.current;
    if (session === undefined) {
      throw new EngineClosedError('the engine is not seated');
    }
    return session;
  }

  /** The invite URL for this room, if this connection is the one holding the token. */
  inviteUrl(): string | undefined {
    return this.current === undefined ? undefined : inviteUrl(this.current);
  }

  /** Subscribes to engine events. Returns the unsubscribe function. */
  on(listener: EngineEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** True until the session ends. */
  get isOpen(): boolean {
    return !this.finished && !this.disposed;
  }

  // -- documents -------------------------------------------------------------

  /** Asks the server to open a document: a hold of this connection and of the room. */
  open(path: string): Promise<void> {
    return this.request('open', path);
  }

  /** Releases this connection's hold on a document. The text itself stays. */
  close(path: string): Promise<void> {
    return this.request('close', path);
  }

  /**
   * Renames this connection mid-session (§5). The display name is this peer's own, so the
   * request names no document: the answer is `{}` and the room is told with `peer.renamed`.
   * A refusal rejects here and leaves the live name alone; it does not close the session.
   */
  rename(displayName: string): Promise<void> {
    return this.sendRequest({
      kind: 'rename',
      method: method.rename,
      params: renameParams({ displayName }),
    });
  }

  /**
   * Publishes the room's grant: the host's listing of its working tree (§5). The listing is a
   * snapshot replacing the room's whole grant, and only the room's host may publish one — the
   * server refuses any other connection, and a server that does not know the method answers
   * `unknown_method`, which is "this server has no grant" rather than a fault.
   *
   * The order is carried exactly as given: a publisher writes its listing ascending by UTF-16
   * code unit (§5), and this client does not sort, deduplicate or otherwise normalise it.
   */
  grant(paths: readonly string[]): Promise<void> {
    return this.sendRequest({
      kind: 'grant',
      method: method.docGrant,
      params: grantParams({ paths: [...paths] }),
    });
  }

  /**
   * The current text of a document: relayed content if there is any, even for a path this
   * connection never opened. Empty when this replica has received nothing for it.
   */
  text(path: string): string {
    return this.textIfPresent(path)?.toString() ?? '';
  }

  /**
   * Whether this replica has received anything at all for a path. A document that has
   * arrived and been emptied is not the same as one that has never been seen, and a seeder
   * deciding from `text` alone would put a disk copy back over the former.
   */
  has(path: string): boolean {
    return this.textIfPresent(path) !== undefined;
  }

  /**
   * The `Y.Text` behind a path, for an adapter that needs CRDT-relative positions. Creates
   * it when it is not there yet, which only a local edit otherwise does: an anchor taken
   * from a document that has not arrived names nothing but the scope, and a caller that
   * publishes one publishes a position with no element in it (§8.1).
   */
  getText(path: string): Y.Text {
    return this.doc.getText(path);
  }

  /** Applies a local insert and sends exactly the delta it produced. */
  insert(path: string, index: number, text: string): void {
    this.doc.transact(() => {
      this.doc.getText(path).insert(index, text);
    }, LOCAL_ORIGIN);
  }

  /** Applies a local delete and sends exactly the delta it produced. */
  delete(path: string, index: number, length: number): void {
    this.doc.transact(() => {
      this.doc.getText(path).delete(index, length);
    }, LOCAL_ORIGIN);
  }

  /** The room's open-document set, as the server owns it. */
  documents(): string[] {
    return [...this.roomDocuments];
  }

  /**
   * The room's grant, as the server owns it: the host's listing, in the order the host wrote
   * it. Empty for a room whose host has published nothing or a server that has no grant.
   */
  grantedPaths(): string[] {
    return [...this.granted];
  }

  /** The documents this client holds open. */
  openDocuments(): string[] {
    return [...this.heldDocuments];
  }

  /** The CRDT state vector as `[clientId, clock]` pairs, sorted. Synced replicas agree. */
  stateVector(): Array<[number, number]> {
    const vector = Y.decodeStateVector(Y.encodeStateVector(this.doc));
    return [...vector.entries()].sort((a, b) => a[0] - b[0]);
  }

  // -- presence --------------------------------------------------------------

  /** Publishes this client's presence: document path plus selection. `null` clears it. */
  setAwareness(state: AwarenessState | null): void {
    // y-protocols emits an `update` for every `setLocalState`, whether it changed anything or
    // not, and each of those is a frame (§8). A caret that has not moved, and a clear of an
    // already-clear state, are therefore not published at all — a repeated state is not news.
    // The renewal is a different caller (`publishAwareness`), because it is deliberately this
    // same state on a newer clock, which §8.2 requires republishing.
    if (sameAwareness(this.localState, state)) {
      return;
    }
    this.localState = state;
    this.awareness.setLocalState(state);
  }

  /**
   * Publishes a selection given as editor offsets (UTF-16 code units), converting each
   * endpoint to the anchor the wire carries (§8.1). Offsets stop at this seam.
   *
   * A selection this replica cannot anchor is not published: when the text is not here yet, or
   * an endpoint is past its end, the state carries the path and no selection (§8.1). The
   * scope-only fallback would be indistinguishable on the wire from a real caret at the end.
   */
  setSelection(path: string, selection: OffsetSelection): void {
    const text = this.textIfPresent(path);
    if (
      text === undefined ||
      selection.anchor > text.length ||
      selection.head > text.length
    ) {
      this.setAwareness({ path });
      return;
    }
    this.setAwareness({
      path,
      selection: {
        anchor: this.anchorIn(text, selection.anchor),
        head: this.anchorIn(text, selection.head),
      },
    });
  }

  /** The `Y.Text` a path already names, without creating one (§8.1's sender rule). */
  private textIfPresent(path: string): Y.Text | undefined {
    // `share` holds a type for the name as soon as this replica has one — created by a local
    // edit, or arrived in a peer's update — and nothing at all before that. The entry can
    // still be the decoder's placeholder rather than a materialised `Y.Text`, so `getText`
    // returns the type itself and creates nothing new.
    return this.doc.share.has(path) ? this.doc.getText(path) : undefined;
  }

  /**
   * The anchor for an offset into `path`, with `assoc` as §8.1 defines it, or `undefined`
   * when this replica has received nothing for it. Reading a path must not bring a text
   * into being: an anchor for a document that has not arrived names nothing but the scope,
   * and §8.1 forbids publishing one.
   */
  anchorAt(path: string, index: number, assoc = 0): Anchor | undefined {
    const text = this.textIfPresent(path);
    return text === undefined ? undefined : this.anchorIn(text, index, assoc);
  }

  /** The anchor for an offset into a text this replica already has. */
  private anchorIn(text: Y.Text, index: number, assoc = 0): Anchor {
    return toAnchor(Y.createRelativePositionFromTypeIndex(text, index, assoc));
  }

  /**
   * Resolves a peer's selection to offsets in this replica, or `undefined` when either
   * endpoint does not resolve — a document that has not arrived yet resolves later, which
   * is why a caller resolves on demand rather than the parser resolving once (§8.1). A
   * path this replica has received nothing for is one of those refusals: resolving it
   * against an empty text would put the peer's cursor at 0 in a document nobody has seen.
   */
  resolveSelection(path: string, selection: Selection): OffsetSelection | undefined {
    const text = this.textIfPresent(path);
    if (text === undefined) {
      return undefined;
    }
    const anchor = this.resolveAnchor(path, text, selection.anchor);
    const head = this.resolveAnchor(path, text, selection.head);
    if (anchor === undefined || head === undefined) {
      return undefined;
    }
    return { anchor, head };
  }

  /** One endpoint, against the `Y.Text` named by `path` and no other type (§8.1). */
  private resolveAnchor(path: string, text: Y.Text, anchor: Anchor): number | undefined {
    if (anchor.tname !== undefined && anchor.tname !== path) {
      return undefined;
    }
    const absolute = Y.createAbsolutePositionFromRelativePosition(
      toRelativePosition(anchor),
      this.doc,
    );
    if (absolute === null || absolute.type !== text) {
      return undefined;
    }
    return absolute.index;
  }

  /** Every presence record this engine holds, including its own. */
  presence(): Presence[] {
    const local = this.current?.peer;
    if (local === undefined) {
      return [];
    }
    return buildPresence(this.awareness, this.peerMap.values(), local);
  }

  /** Remote participants, excluding this client. */
  peers(): PeerInfo[] {
    return [...this.peerMap.values()].sort((a, b) =>
      a.peer_id < b.peer_id ? -1 : a.peer_id > b.peer_id ? 1 : 0,
    );
  }

  // -- outbound control ------------------------------------------------------

  /**
   * Holds (or releases) outbound frames. While paused, local edits accumulate and are
   * sent on resume, which is the deterministic way to make two edits concurrent.
   */
  pauseOutbound(paused: boolean): void {
    this.paused = paused;
    if (!paused) {
      this.flush();
    }
  }

  /**
   * Ends the session. No `disconnected` event is emitted for a disconnect this client
   * asked for; the reference client behaves the same way.
   */
  async disconnect(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearTimers();
    // Tell peers the cursor is gone, then end the socket (spec §8.2: a peer's state is
    // dropped when it leaves).
    if (this.seated && this.socket?.isOpen === true) {
      this.awareness.setLocalState(null);
      this.flush();
    }
    this.socket?.close(1000, 'client left');
    this.socket = undefined;
    this.seated = false;
    this.rejectSeat(new EngineClosedError());
    this.failPending();
    this.awareness.destroy();
    this.doc.destroy();
  }

  // -- connection lifecycle --------------------------------------------------

  private async reopen(): Promise<void> {
    try {
      const session = await this.hello();
      this.attempts = 0;
      this.seat(session);
    } catch (error) {
      if (error instanceof ProtocolError && isTerminalCode(error.code)) {
        this.emit({
          type: 'sessionError',
          code: error.code,
          message: error.message,
        });
        this.finish();
        return;
      }
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.finished) {
      return;
    }
    if (!this.reconnect.enabled || this.attempts >= this.retryBudget) {
      this.finish();
      return;
    }
    const delay = Math.min(
      this.reconnect.initialDelayMs * 2 ** this.attempts,
      this.reconnect.maxDelayMs,
    );
    this.attempts += 1;
    // Said out loud, so an adapter can show the retry without inferring it from silence.
    this.emit({ type: 'reconnecting' });
    // A listener may have ended the session from the event above; scheduling the retry
    // after it would reopen a destroyed engine.
    if (this.disposed || this.finished) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      void this.reopen();
    }, delay);
  }

  /** Applies a completed handshake: peers, the document set, the sync handshake. */
  private seat(session: SessionInfo): void {
    this.current = session;
    // A host learns the room id and token from the reply it minted the room with. They
    // are what a reconnection has to carry, or it would mint a second room instead of
    // reclaiming this one (spec §9.1).
    this.room = session.roomId;
    this.token = session.token ?? this.token;
    this.clock = {
      renewMs:
        this.options.keepalive?.renewMs ?? session.keepalive.awareness_renew_ms,
      expireMs:
        this.options.keepalive?.expireMs ?? session.keepalive.awareness_expire_ms,
    };
    this.roomDocuments = [...session.documents];
    this.peerMap.clear();
    for (const peer of session.peers) {
      this.peerMap.set(peer.peer_id, peer);
    }
    this.seated = true;
    this.refusal = undefined;
    // §7: immediately after seating, SyncStep1 with our state vector — every peer replies
    // with what we are missing. Then publish our awareness, so a newcomer's presence is
    // complete before anyone moves a cursor.
    this.enqueueBinary(encodeSyncStep1(this.doc));
    this.publishAwareness();
    this.flush();
    this.clearTimers();
    this.timer = setInterval(() => {
      this.tick();
    }, this.clock.renewMs);
    // §9.1: what a dropped socket loses is local, so the documents this client still
    // holds open are re-opened. Content is not replayed: the sync handshake brings it
    // back from the peers. This happens before the events below, so an adapter that
    // re-opens a document in answer to them is ordered after the engine's own re-opens.
    for (const path of [...this.heldDocuments]) {
      void this.open(path).catch((error: unknown) => {
        // A method-level refusal is an error response, not a close: the connection stays
        // up, so this is the only place that can say the document was not re-opened.
        if (error instanceof ProtocolError) {
          this.emit({
            type: 'sessionError',
            code: error.code,
            message: error.message,
          });
        }
      });
    }
    this.emit({ type: 'documentsChanged', documents: this.documents() });
    this.emit({ type: 'peersChanged', peers: this.peers() });
  }

  private onSocketClosed(code: number, reason: string): void {
    this.socket = undefined;
    const wasSeated = this.seated;
    this.seated = false;
    // Every request went out on the socket that just died; no answer can arrive on the
    // next one, and their frames must not be replayed there.
    this.failPending();
    // The grant is not a member of the join reply: the server restates it in a `doc.granted`
    // straight after the next `room.joined`, and only when the room grants something. This
    // replica's view of the listing is therefore local and stale the moment the socket dies,
    // and dropping it here is what keeps a reconnect into a room that now grants nothing from
    // showing the listing this client held before.
    if (this.granted.length > 0) {
      this.granted = [];
      this.emit({ type: 'grantChanged', paths: [] });
    }
    if (this.disposed || this.finished) {
      return;
    }
    if (this.handshaking) {
      // A handshake owns this socket, whether it is the first one or a retry: the
      // rejection carries the reason, and the caller decides whether to retry. Every
      // 4000 close means a different fault (§11), so the code the server named wins
      // over the close code, and an unmapped close is a handshake that did not finish.
      this.rejectSeat(
        new ProtocolError(
          this.refusal?.code ?? closeCodeName(code) ?? errCode.helloRequired,
          reason === '' ? `the connection closed with ${code}` : reason,
        ),
      );
      return;
    }
    if (!wasSeated) {
      this.finish();
      return;
    }
    if (this.refusal !== undefined) {
      this.emit({
        type: 'sessionError',
        code: this.refusal.code,
        message: this.refusal.message,
      });
    }
    if (this.terminal || isTerminalCode(this.refusal?.code)) {
      this.finish();
      return;
    }
    this.scheduleReconnect();
  }

  private finish(): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.generation += 1;
    this.clearTimers();
    this.failPending();
    this.emit({ type: 'disconnected' });
  }

  private clearTimers(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  // -- the awareness clock ---------------------------------------------------

  /**
   * Mints a fresh awareness client id for this replica, ahead of a reconnect's
   * `session.hello`. `doc.clientID` and `awareness.clientID` are ordinary mutable fields —
   * yjs itself reassigns `doc.clientID` this way on an id collision (`Transaction.js`) — so
   * this changes only which id future local operations and awareness updates are attributed
   * to; it does not touch the document content already held under the old id. The old id's
   * own local-state entry is this connection's leftover, not a new peer's, so it is dropped
   * here rather than left to linger until the awareness clock would otherwise expire it.
   */
  private rotateIdentity(): void {
    const previousId = this.awareness.clientID;
    const id = random.uint32();
    this.doc.clientID = id;
    this.awareness.clientID = id;
    this.awareness.states.delete(previousId);
    this.awareness.meta.delete(previousId);
  }

  /** Publishes the local awareness state, unless the adapter cleared it. */
  private publishAwareness(): void {
    // A cleared state stays cleared: publishing `{}` would put a live empty presence —
    // a cursor at nowhere — back on the wire.
    if (this.localState !== null) {
      this.awareness.setLocalState(this.localState);
    }
  }

  /** Renewal and expiry, on the server's clock (spec §8.2). */
  private tick(): void {
    if (!this.seated) {
      return;
    }
    // Renewing means republishing the same state with a newer awareness clock. Remote
    // states are forgotten on this tick, so a state goes at the first tick after
    // `last_updated + awareness_expire_ms` — within one renewal of the advertised value.
    this.publishAwareness();
    const deadline = Date.now() - this.clock.expireMs;
    const stale: number[] = [];
    for (const [clientId, meta] of this.awareness.meta) {
      if (
        clientId !== this.awareness.clientID &&
        meta.lastUpdated <= deadline &&
        this.awareness.states.has(clientId)
      ) {
        stale.push(clientId);
      }
    }
    if (stale.length > 0) {
      removeAwarenessStates(this.awareness, stale, EXPIRY_ORIGIN);
    }
  }

  private wireAwareness(): void {
    this.awareness.on(
      'update',
      (
        changes: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        if (origin !== 'local') {
          // A state applied from a peer's frame is not re-broadcast: awareness converges
          // peer to peer, and the server relays and forgets (spec §8).
          return;
        }
        const clients = [
          ...changes.added,
          ...changes.updated,
          ...changes.removed,
        ];
        if (clients.length === 0 || !this.seated) {
          return;
        }
        this.enqueueBinary(encodeAwareness(this.awareness, clients));
      },
    );
    this.awareness.on('change', () => {
      this.emit({ type: 'presenceChanged', presence: this.presence() });
    });
  }

  private wireDocument(): void {
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      // A held document that has just arrived can now be observed, and its arrival is itself
      // a change an adapter needs to hear about.
      this.observeArrived(origin);
      if (origin === REMOTE_ORIGIN) {
        // Applying a peer's update must not echo it back into the room.
        return;
      }
      this.enqueueBinary(encodeUpdate(update));
    });
  }

  /**
   * Observes a held document, so a remote change reports the path it changed and no other.
   *
   * A document that has not arrived yet has no text to observe, and creating one would make
   * it look like an empty document that had — which is a distinction §8.1 needs a sender to
   * keep. `observeArrived` attaches the observer when the text does appear.
   */
  private observe(path: string): void {
    const text = this.textIfPresent(path);
    if (text !== undefined) {
      this.attach(path, text);
    }
  }

  private attach(path: string, text: Y.Text): void {
    if (this.texts.has(path)) {
      return;
    }
    text.observe((_event: Y.YTextEvent, transaction: Y.Transaction) => {
      if (transaction.origin === LOCAL_ORIGIN) {
        return;
      }
      this.emit({ type: 'documentChanged', path });
    });
    this.texts.add(path);
  }

  /**
   * Attaches the observer to any held document that has now arrived, and reports the
   * arrival. A document this client created with its own edit reports nothing: the adapter
   * already has that change.
   */
  private observeArrived(origin: unknown): void {
    for (const path of this.heldDocuments) {
      if (this.texts.has(path)) {
        continue;
      }
      const text = this.textIfPresent(path);
      if (text === undefined) {
        continue;
      }
      this.attach(path, text);
      if (origin !== LOCAL_ORIGIN) {
        this.emit({ type: 'documentChanged', path });
      }
    }
  }

  // -- requests --------------------------------------------------------------

  private request(kind: 'open' | 'close', path: string): Promise<void> {
    return this.sendRequest({
      kind,
      path,
      method: kind === 'open' ? method.docOpen : method.docClose,
      params: { path },
    });
  }

  private sendRequest(request: RequestFrame): Promise<void> {
    if (this.finished || this.disposed) {
      return Promise.reject(new EngineClosedError());
    }
    // A request is answered on the connection that carries it. With no seated connection
    // there is nowhere to send it, and queueing it for the next one would replay it under
    // an id this client has meanwhile reused (spec §9.1: a reconnect is a new peer).
    if (!this.seated || this.socket === undefined || !this.socket.isOpen) {
      return Promise.reject(new EngineClosedError('the connection is down'));
    }
    const id = (this.requestId += 1);
    const message: ClientMessage = {
      v: WIRE_VERSION,
      id,
      method: request.method,
      params: request.params,
    };
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // The server took the request and did not answer it. Whether it applied it is
        // unknowable and must not be guessed, so nothing moves: the caller is told, and
        // both methods are idempotent, so re-asking is how it is settled.
        if (this.pending.delete(id)) {
          this.dropQueuedRequest(id);
          reject(
            new EngineClosedError(`the server did not answer ${message.method} in time`),
          );
        }
      }, this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
      const pending: PendingRequest =
        request.kind === 'rename'
          ? { kind: 'rename', resolve, reject, timer }
          : request.kind === 'grant'
            ? { kind: 'grant', resolve, reject, timer }
            : { kind: request.kind, path: request.path, resolve, reject, timer };
      this.pending.set(id, pending);
      this.enqueueText(JSON.stringify(message), id);
    });
  }

  private resolveRequest(message: {
    id?: number;
    result?: unknown;
    error?: Refusal;
  }): void {
    const id = message.id;
    if (id === undefined) {
      return;
    }
    const pending = this.pending.get(id);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (message.error !== undefined) {
      pending.reject(
        new ProtocolError(message.error.code, message.error.message),
      );
      return;
    }
    this.accept(pending, message.result);
    pending.resolve();
  }

  /** Moves local state to what the server accepted, then reports the room's set. */
  private accept(pending: PendingRequest, result: unknown): void {
    // A rename's answer is `{}`: it changes this connection's name, which the `peer.renamed`
    // event carries, and it must not move the room's document set (§5). A grant's answer is
    // `{}` for the same reason: the listing is carried by `doc.granted`.
    if (pending.kind === 'rename' || pending.kind === 'grant') {
      return;
    }
    const body = (result ?? {}) as DocSet;
    const documents = receivedListing(body.documents);
    if (documents !== undefined) {
      this.roomDocuments = documents;
    }
    if (pending.kind === 'open') {
      if (!this.heldDocuments.includes(pending.path)) {
        this.heldDocuments.push(pending.path);
      }
      this.observe(pending.path);
    } else {
      this.heldDocuments = this.heldDocuments.filter(
        (path) => path !== pending.path,
      );
    }
    this.emit({ type: 'documentsChanged', documents: this.documents() });
  }

  /**
   * Fails every request still waiting. The connection they went out on is gone, so no
   * answer can reach them — and their frames must not outlive it either, or the next
   * connection would answer them under an id it has reissued.
   */
  private failPending(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new EngineClosedError());
    }
    this.pending.clear();
    this.queue = this.queue.filter((frame) => frame.requestId === undefined);
  }

  /** Removes a request's frame if it was never written to a socket. */
  private dropQueuedRequest(id: number): void {
    this.queue = this.queue.filter((frame) => frame.requestId !== id);
  }

  // -- inbound ---------------------------------------------------------------

  private handleText(text: string): void {
    // Counted in bytes, not code units: `Buffer.byteLength` walks without allocating,
    // where encoding the frame to count it would copy it first. Node-only by construction —
    // the extension host and the companion both run on Node — like the rest of this file.
    if (Buffer.byteLength(text, 'utf8') > MAX_INBOUND_TEXT_BYTES) {
      return;
    }
    const message = parseServerMessage(text);
    if (message === undefined) {
      return;
    }
    if (message.id !== undefined) {
      this.resolveRequest(message);
      return;
    }
    switch (message.event) {
      case eventName.roomCreated:
      case eventName.roomJoined: {
        this.settleSeat(message.params);
        break;
      }
      case eventName.peerJoined: {
        const peer = parsePeerEvent(message.params);
        if (peer !== undefined) {
          this.peerMap.set(peer.peer_id, peer);
          this.emit({ type: 'peersChanged', peers: this.peers() });
          // A newcomer has no awareness of us yet: republish ours, so its presence list
          // is complete before anyone moves a cursor.
          this.publishAwareness();
        }
        break;
      }
      case eventName.peerLeft: {
        this.peerLeft(message.params);
        break;
      }
      case eventName.peerRenamed: {
        this.peerRenamed(message.params);
        break;
      }
      case eventName.docOpened:
      case eventName.docClosed: {
        if (this.applyDocumentSet(message.params)) {
          this.emit({ type: 'documentsChanged', documents: this.documents() });
        }
        break;
      }
      case eventName.docGranted: {
        if (this.applyGrant(message.params)) {
          this.emit({ type: 'grantChanged', paths: this.grantedPaths() });
        }
        break;
      }
      case eventName.hostDetached: {
        const graceMs = numberParam(message.params, 'grace_ms') ?? 0;
        // A grace of 1e15 renders as a 31-million-second tooltip: the room rejoins in
        // seconds or not at all, so the wait is clamped to the hour it never needs.
        const windowMs = Math.min(Math.max(graceMs, 0), 3_600_000);
        // The other half of §9.1: a guest that never read `/meta`, or read it before the
        // grace was known, learns the same window here, and it is this one that arrives
        // mid-session — a detach is when the guest's own reconnects have to span it.
        this.applyGrace(windowMs);
        this.emit({ type: 'hostDetached', graceMs: windowMs });
        break;
      }
      case eventName.hostAttached: {
        const peer = parsePeerEvent(message.params);
        if (peer !== undefined) {
          this.peerMap.set(peer.peer_id, peer);
          this.emit({ type: 'hostAttached', peer });
          this.emit({ type: 'peersChanged', peers: this.peers() });
        }
        break;
      }
      case eventName.roomGone: {
        this.terminal = true;
        const reason = boundedText(textParam(message.params, 'reason') ?? 'room gone');
        // A room gone mid-handshake settles the seat waiter now: the session is already
        // known-terminal, and waiting out the handshake timeout would lie about it.
        this.rejectSeat(new ProtocolError(errCode.roomGone, reason));
        this.emit({ type: 'roomGone', reason });
        break;
      }
      case eventName.sessionError: {
        const refusal: Refusal = {
          code: boundedText(textParam(message.params, 'code') ?? 'error'),
          message: boundedText(
            textParam(message.params, 'message') ?? 'the server reported a fault',
          ),
        };
        this.refusal = refusal;
        if (isTerminalCode(refusal.code)) {
          this.terminal = true;
          this.rejectSeat(new ProtocolError(refusal.code, refusal.message));
        }
        if (this.seatWaiter === undefined) {
          this.emit({
            type: 'sessionError',
            code: refusal.code,
            message: refusal.message,
          });
        }
        break;
      }
      default: {
        // Unknown events and reserved `x.` names are ignored (§10.1).
        break;
      }
    }
  }

  /**
   * Moves the room's set to what a `doc.opened` / `doc.closed` event names, and says whether
   * it moved. The event goes to the connection that asked as well as to the room, and the
   * answer that made the change has already been applied here (§9.2), so a set that says what
   * this connection already has is not news: emitting it again would refresh every listener —
   * the status bar, and a guest's first document — twice for one open.
   */
  private applyDocumentSet(params: unknown): boolean {
    const body = params as DocEvent | undefined;
    const documents = receivedListing(body?.documents);
    if (documents === undefined) {
      return false;
    }
    if (
      documents.length === this.roomDocuments.length &&
      documents.every((path, index) => path === this.roomDocuments[index])
    ) {
      return false;
    }
    this.roomDocuments = documents;
    return true;
  }

  /**
   * Moves this replica's view of the grant to what a `doc.granted` names, and says whether it
   * moved. The listing replaces whatever was held — a shorter one is a smaller grant, not a
   * partial one — and it is kept in the order the host wrote (§5, §6.3): a receipt that says
   * what this replica already has is not news, exactly as for the open-document set.
   */
  private applyGrant(params: unknown): boolean {
    const body = params as Partial<GrantParams> | undefined;
    const paths = receivedListing(body?.paths);
    if (paths === undefined) {
      return false;
    }
    if (
      paths.length === this.granted.length &&
      paths.every((path, index) => path === this.granted[index])
    ) {
      return false;
    }
    this.granted = paths;
    return true;
  }

  private peerLeft(params: unknown): void {
    const peerId = textParam(params, 'peer_id');
    if (peerId === undefined) {
      return;
    }
    const peer = this.peerMap.get(peerId);
    this.peerMap.delete(peerId);
    if (peer?.awareness_client_id !== undefined) {
      // §8.4: the id is not an identity and nothing requires it to be unique in a room, so a
      // peer that reuses one after reconnecting makes two peers speak for one replica. The
      // state is the room's, not the departure's: it goes only once no other seated peer still
      // claims the id, or the first of two claimants to leave erases the other's cursor.
      const claimed = [...this.peerMap.values()].some(
        (other) => other.awareness_client_id === peer.awareness_client_id,
      );
      if (!claimed) {
        removeAwarenessStates(
          this.awareness,
          [peer.awareness_client_id],
          'peer-left',
        );
      }
    }
    this.emit({ type: 'peersChanged', peers: this.peers() });
  }

  /**
   * A peer changed its own name (§6). The event is the minimal pair, so a peer this client
   * does not hold is ignored rather than invented; the mover is not in `peerMap` — its own
   * record is `session.peer` — and updating it is what keeps `session().peer.display_name`
   * the name in force for the connection that renamed.
   */
  private peerRenamed(params: unknown): void {
    const renamed = parsePeerRenamed(params);
    if (renamed === undefined) {
      return;
    }
    const peer = this.peerMap.get(renamed.peer_id);
    if (peer !== undefined) {
      peer.display_name = renamed.display_name;
    }
    const self = this.current;
    if (self !== undefined && self.peer.peer_id === renamed.peer_id) {
      self.peer.display_name = renamed.display_name;
    }
    this.emit({ type: 'peersChanged', peers: this.peers() });
  }

  private handleBinary(frame: Uint8Array): void {
    if (frame.length > MAX_INBOUND_BINARY_BYTES) {
      // A payload this large never arrives from a conforming transport; applying it
      // would grow the replica without bound on a peer's word. Dropped, and the session
      // continues stale rather than ending: see `MAX_INBOUND_TEXT_BYTES`.
      return;
    }
    let replies: Uint8Array[];
    try {
      replies = applyFrame(frame, this.doc, this.awareness, REMOTE_ORIGIN)
        .replies;
    } catch {
      // A payload this client cannot decode is a peer bug; the session goes on.
      return;
    }
    for (const reply of replies) {
      this.enqueueBinary(reply);
    }
    this.flush();
  }

  /** Resolves the waiter `hello()` left behind when the server seats this connection. */
  private settleSeat(params: unknown): void {
    const waiter = this.seatWaiter;
    if (waiter === undefined) {
      return;
    }
    const session = sessionFrom(params, this.options.baseUrl);
    if (session === undefined) {
      this.rejectSeat(
        new ProtocolError(
          errCode.badMessage,
          'the server sent a malformed session reply',
        ),
      );
      return;
    }
    this.seatWaiter = undefined;
    clearTimeout(waiter.timer);
    waiter.resolve(session);
  }

  private rejectSeat(error: Error): void {
    const waiter = this.seatWaiter;
    if (waiter === undefined) {
      return;
    }
    this.seatWaiter = undefined;
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }

  // -- outbound --------------------------------------------------------------

  private enqueueText(text: string, requestId?: number): void {
    this.queue.push(requestId === undefined ? { text } : { text, requestId });
    this.flush();
  }

  private enqueueBinary(binary: Uint8Array): void {
    this.queue.push({ binary });
    this.flush();
  }

  private flush(): void {
    if (this.paused || this.socket === undefined || !this.socket.isOpen) {
      return;
    }
    while (this.queue.length > 0) {
      const frame = this.queue[0];
      this.queue.shift();
      if (frame.text !== undefined) {
        this.socket.sendText(frame.text);
      } else if (frame.binary !== undefined) {
        this.socket.sendBinary(frame.binary);
      }
    }
  }

  private emit(event: EngineEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }
}

/** The session error code a close code stands for, where it stands for one. */
function closeCodeName(code: number): string | undefined {
  switch (code) {
    case close.roomUnknown:
      return errCode.roomUnknown;
    case close.tokenInvalid:
      return errCode.tokenInvalid;
    case close.roomGone:
      return errCode.roomGone;
    case close.hostPresent:
      return errCode.hostPresent;
    case close.unsupportedVersion:
      return errCode.unsupportedVersion;
    // 4000 is protocol_error, the general refusal, which §11 spells `bad_message`.
    case close.protocolError:
      return errCode.badMessage;
    default:
      return undefined;
  }
}

function textParam(params: unknown, key: string): string | undefined {
  const value =
    typeof params === 'object' && params !== null
      ? (params as Record<string, unknown>)[key]
      : undefined;
  return typeof value === 'string' ? value : undefined;
}

/**
 * A server diagnostic cut to what a dialog can show: a hostile relay can put megabytes
 * in `message`/`reason`, shown verbatim by the adapter, so these are truncated rather
 * than passed whole. Server diagnostics, not owner-chosen names, so truncation with an
 * ellipsis is honest where it would not be for a display name.
 */
function boundedText(text: string): string {
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

/**
 * What a server-sent listing may move into this replica: the strings the grant would
 * publish, at most the listing's own bound, in the order the publisher wrote. The grant's
 * shape rule is the publish side's (`isGrantedPath`, in `src/bridge/grant.ts` — the one
 * home for what a session shares), applied here on receipt because a guest that trusts a
 * stranger's server trusts its listings as input. A hostile listing is filtered and
 * truncated, never allocated whole: a bogus set is a smaller grant, not N error dialogs,
 * and `undefined` is a frame with no listing at all rather than an empty one.
 */
function receivedListing(paths: unknown): string[] | undefined {
  if (!Array.isArray(paths)) {
    return undefined;
  }
  const listing: string[] = [];
  for (const path of paths) {
    if (listing.length >= MAX_GRANT_PATHS) {
      break;
    }
    if (typeof path === 'string' && isGrantedPath(path)) {
      listing.push(path);
    }
  }
  return listing;
}

function numberParam(params: unknown, key: string): number | undefined {
  const value =
    typeof params === 'object' && params !== null
      ? (params as Record<string, unknown>)[key]
      : undefined;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Reads a `room.created` / `room.joined` params object into a session description. */
function sessionFrom(params: unknown, baseUrl: string): SessionInfo | undefined {
  const body = params as SessionParams | undefined;
  const peer = parsePeer(body?.self);
  const roomId = body?.room_id;
  // A session without a room id is not a session: seating it would leave every later
  // reconnect minting a fresh room instead of reclaiming this one (spec §9.1).
  if (
    body === undefined ||
    peer === undefined ||
    typeof roomId !== 'string' ||
    roomId === ''
  ) {
    return undefined;
  }
  const peers: PeerInfo[] = [];
  for (const raw of body.peers ?? []) {
    const parsed = parsePeer(raw);
    if (parsed !== undefined) {
      peers.push(parsed);
    }
  }
  const keepalive = body.keepalive;
  return {
    roomId,
    ...(typeof body.token === 'string' ? { token: body.token } : {}),
    role: peer.role,
    peer,
    peers,
    documents: receivedListing(body.documents) ?? [],
    capabilities: (body.capabilities ?? []).filter(
      (name): name is string => typeof name === 'string',
    ),
    keepalive: {
      ping_interval_ms: pick(
        keepalive?.ping_interval_ms,
        DEFAULT_KEEPALIVE.ping_interval_ms,
      ),
      awareness_renew_ms: pick(
        keepalive?.awareness_renew_ms,
        DEFAULT_KEEPALIVE.awareness_renew_ms,
      ),
      awareness_expire_ms: pick(
        keepalive?.awareness_expire_ms,
        DEFAULT_KEEPALIVE.awareness_expire_ms,
      ),
    },
    baseUrl,
  };
}

function pick(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}
