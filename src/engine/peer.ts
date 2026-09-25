/**
 * `selvage/2`'s peer side: what a client does with the frames it receives.
 *
 * {@link Reader} (in `sealed.ts`) is `CANONICAL.md` §6.1's bytes — the envelope, the key
 * schedule, the read order and its verdicts. This module is `PROTOCOL.md` §13 on top of it: the
 * session key the connection announces and the order of operations at a join (§13.1), what a
 * client may publish before and after a state commits its key, the marks and the mark's owner
 * (§13.2, §13.3), attribution by the key that verified and the role the state gives it (§13.4,
 * §13.5), the holds and their lease (§13.7), the two presence windows (§13.3, §13.8), and the
 * four ways a session ends (§13.10).
 *
 * **It holds no socket.** A frame goes in and the decisions come out, and every clock is a
 * value the caller passes in: §13.8 says a client's timers are its own monotone elapsed time
 * from an event it observed, so the session records the clock value at each event it sees and
 * asks no platform for the time. That is what lets the corpus's decision layer drive it —
 * `specification/runner/run_peer.py --subject` — and what lets its own tests be about the rule
 * rather than about how long a machine took.
 *
 * Every method that may publish a frame is **async**, because the crypto seam is
 * (`src/engine/crypto.ts`): a caller awaits each call before making the next, which is what a
 * socket reader and the corpus's subject protocol both do.
 */

import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

import type { FrameCrypto } from './crypto.ts';
import { ENDPOINT_PATH } from './envelope.ts';
import type { Keepalive } from './envelope.ts';
import {
  bytesEqual,
  decodeKey,
  encodeKey,
  mintSessionKey,
  Reader,
  seal,
} from './sealed.ts';
import type { DropReason, Committed, SessionKeypair, Verdict } from './sealed.ts';
import { ABSENCE_CHARGE, FRAME_BUDGET, HOST_MUTATIONS, HostProducer } from './host.ts';
import type { HostMutation, HostOptions, HostPublication, HostReason } from './host.ts';
import { applyFrame, encodeAwareness, encodeSyncStep1, encodeUpdate } from './sync.ts';
import { percentDecode } from './urls.ts';
import { buildPresence, sameAwareness, toAnchor, toRelativePosition } from './presence.ts';
import type { Anchor, AwarenessState, OffsetSelection, Presence, Selection } from './presence.ts';
import type { PeerInfo } from './envelope.ts';

/**
 * Whether the engine's clocks may hold a process open.
 *
 * A timer that is not `unref`ed keeps a Node process alive until it is cleared, and a session or
 * a relay that is never destroyed therefore never lets its process end. Nothing either of them
 * does is work the machine has to wait for — §13.8's clocks are the caller's own elapsed time —
 * so every timer the engine starts is unreferenced, and the browser, where there is no such
 * thing, is left alone by the optional call.
 */
export function unrefTimer(timer: unknown): void {
  const handle = timer as { unref?: () => void } | undefined;
  handle?.unref?.();
}

/**
 * The transaction origins this session's own changes and a peer's carry, so that a listener can
 * tell them apart: the edits this connection makes are the ones it may publish, and content
 * applied from another peer is not.
 */
const LOCAL_ORIGIN = Symbol('selvage/local');
const APPLIED_ORIGIN = Symbol('selvage/applied');

/**
 * The one character a document published with no text at all is named by.
 *
 * A path is a document here, and a `Y.Text` with nothing in it is a document no update
 * carries: a root type is named by the items under it, and `yjs` writes no struct at all for
 * one that has none. That is the whole of why a room could not say a file is empty — the empty
 * document never left the peer holding it. The type is therefore named by one character inserted
 * and removed inside the one transaction `insert` runs: its struct is what the encoding writes,
 * and it travels with no text in it, because the item is deleted before the update is taken and
 * this replica runs `yjs`'s default garbage collection, which replaces a deleted item's content
 * with its length. What a peer applies is the name, and no text.
 */
const EMPTY_DOCUMENT_MARK = 'x';

// --- the invite -----------------------------------------------------------------

/** An invite as `PROTOCOL.md` §5.1 writes one, and §13.1's first step reads it. */
export interface PeerInvite {
  /**
   * The connection URL, without the fragment. The fragment is the one part of a link a user
   * agent never sends, which is what makes it the one place a key can travel from a host to a
   * guest; nothing here puts it back.
   */
  socketUrl: string;
  room: string;
  token: string;
  roomKey: Uint8Array;
  hostKey: Uint8Array;
}

/**
 * What reading a link produced: the invite, or the client's own words for a link it cannot
 * join with.
 *
 * That refusal is **local** (`PROTOCOL.md` §5.1): it happens before a socket is opened, so
 * there is no frame to refuse on and no code to carry it — it is not a `session.error`, it is
 * paired with no close code, and §11's vocabulary is not involved.
 */
export type InviteRead =
  | { ok: true; invite: PeerInvite }
  | { ok: false; reason: string };

/** What a link without a fragment is told, which is §5.1's own sentence: ask for it all. */
export const MISSING_FRAGMENT =
  'the invite carries no fragment, so neither its room key nor its host key is here: ask for the whole link, `#` and all';

/**
 * Reads an invite: the room and the token from the query, the two keys from the fragment, and
 * a socket URL with the fragment stripped.
 *
 * Both keys are required, and their absence is refused here rather than at the socket: without
 * both a client can neither read a frame nor verify one, so there is no fallback and no
 * plaintext mode.
 */
export function parseInvite(link: string): InviteRead {
  const hash = link.indexOf('#');
  if (hash === -1) {
    return { ok: false, reason: MISSING_FRAGMENT };
  }
  // The fragment is stripped here, before anything else reads the link: it is the one part of a
  // URL a user agent never sends, and `socketUrl` is what a caller dials.
  const address = link.slice(0, hash);
  const queryAt = address.indexOf('?');
  const endpoint = queryAt === -1 ? address : address.slice(0, queryAt);
  if (!endpoint.endsWith(ENDPOINT_PATH)) {
    return {
      ok: false,
      reason: `${JSON.stringify(address)} does not address the session endpoint`,
    };
  }
  const join = inviteQuery(queryAt === -1 ? '' : address.slice(queryAt + 1));
  if (!join.ok) {
    return join;
  }
  const keys = fragmentKeys(link.slice(hash + 1));
  if (!keys.ok) {
    return keys;
  }
  return {
    ok: true,
    invite: {
      socketUrl: address,
      room: join.room,
      token: join.token,
      roomKey: keys.roomKey,
      hostKey: keys.hostKey,
    },
  };
}

type InviteQuery =
  | { ok: true; room: string; token: string }
  | { ok: false; reason: string };

/**
 * The room and the token from an invite's query.
 *
 * §5.1 has each of the two appear **at most once** and a URL that repeats either be malformed,
 * so a reader refuses one rather than let the last of two values win. A parameter the receiver
 * does not know is ignored, as an unknown query parameter is.
 */
function inviteQuery(query: string): InviteQuery {
  let room: string | undefined;
  let token: string | undefined;
  for (const pair of query.split('&')) {
    if (pair === '') {
      continue;
    }
    const at = pair.indexOf('=');
    const name = percentDecode(at === -1 ? pair : pair.slice(0, at));
    const value = percentDecode(at === -1 ? '' : pair.slice(at + 1));
    if (name === 'room') {
      if (room !== undefined) {
        return { ok: false, reason: 'the invite names `room` twice' };
      }
      room = value;
    } else if (name === 'token') {
      if (token !== undefined) {
        return { ok: false, reason: 'the invite names `token` twice' };
      }
      token = value;
    }
  }
  if (room === undefined) {
    return { ok: false, reason: 'the invite names no room' };
  }
  if (token === undefined) {
    return { ok: false, reason: 'the invite carries no token' };
  }
  return { ok: true, room, token };
}

type FragmentKeys =
  | { ok: true; roomKey: Uint8Array; hostKey: Uint8Array }
  | { ok: false; reason: string };

/**
 * The two keys a fragment carries: `k` and `h`, each at most once, decoded by §5.1's own rule
 * and held to §6.1's canonical encoding.
 */
function fragmentKeys(fragment: string): FragmentKeys {
  let roomKey: Uint8Array | undefined;
  let hostKey: Uint8Array | undefined;
  for (const pair of fragment.split('&')) {
    const at = pair.indexOf('=');
    const name = percentDecode(at === -1 ? pair : pair.slice(0, at));
    const value = percentDecode(at === -1 ? '' : pair.slice(at + 1));
    if (name === 'k') {
      const taken = takeKey(value, 'k', roomKey !== undefined);
      if (!taken.ok) {
        return taken;
      }
      roomKey = taken.key;
    } else if (name === 'h') {
      const taken = takeKey(value, 'h', hostKey !== undefined);
      if (!taken.ok) {
        return taken;
      }
      hostKey = taken.key;
    }
  }
  if (roomKey === undefined) {
    return { ok: false, reason: 'the invite carries no room key (`k`)' };
  }
  if (hostKey === undefined) {
    return { ok: false, reason: 'the invite carries no host key (`h`)' };
  }
  return { ok: true, roomKey, hostKey };
}

function takeKey(
  value: string,
  name: string,
  already: boolean,
): { ok: true; key: Uint8Array } | { ok: false; reason: string } {
  if (already) {
    return { ok: false, reason: `the invite names \`${name}\` twice` };
  }
  const key = decodeKey(value);
  if (key === undefined) {
    return {
      ok: false,
      reason: `\`${name}\` is not a 32-byte key in the fragment's encoding`,
    };
  }
  return { ok: true, key };
}

// --- what a session says about itself -------------------------------------------

/** The four endings a session reaches on its own (§13.10). */
export type Ending = 'closing' | 'host-away' | 'no-state' | 'frame-budget';

export { ABSENCE_CHARGE, FRAME_BUDGET } from './host.ts';

/** The words a client says when it ends a session, which §13.10 requires it to say. */
export function endingReason(ending: Ending): string {
  switch (ending) {
    case 'closing':
      return 'the room closed';
    case 'host-away':
      return 'the host has been away past its window';
    case 'frame-budget':
      return "the room has sealed as many frames as its key allows; start a new room";
    default:
      return 'no state arrived within the no-state window';
  }
}

/**
 * What a session is about to publish: the kind of envelope it is, and whether §13.11's report
 * counts it as a **publication** or as a §7 sync-handshake frame.
 *
 * The two counts are apart because a vector asserts one of them: §13.1's step 6 obliges a
 * client that applies a state committing its own key to send a `SyncStep1`, so a single number
 * could not tell a republished request from a publication.
 */
export type Publication = 'announcement' | 'holds' | 'content' | 'sync';

/** The kinds, as §6.1 numbers them. */
const KIND_OF: Readonly<Record<Publication, number>> = {
  content: 0,
  sync: 0,
  holds: 3,
  announcement: 4,
};

/** What a session did with one frame: the decision §13.11 observes. */
export type Outcome =
  | { status: 'applied'; kind: number }
  | { status: 'dropped'; reason: DropReason }
  /**
   * It verified and applied nothing: §13.10's closing handed to a receiver that holds no
   * verified state. Not a refusal — nothing was refused — and in neither list a vector
   * asserts.
   */
  | { status: 'ignored'; kind: number };

/** One frame a session applied, with the index of the frame it was handed as. */
export interface AppliedFrame {
  frame: number;
  kind: number;
}

/** One frame a session refused, and the reason §6.1's vocabulary gives. */
export interface DroppedFrame {
  frame: number;
  reason: DropReason;
}

/**
 * The guards a subject must be able to remove, one rule each (`PROTOCOL.md` §13.11's census).
 * The names are `specification/runner/subject.py`'s `SUBJECT_MUTATIONS`, which is the seam the
 * corpus reconciles them across.
 */
export const PEER_MUTATIONS = [
  'ignore-roles',
  'ignore-issued',
  'announce-once',
  'no-lease',
  'any-closing',
  'wait-for-ever',
] as const;

export type PeerMutation = (typeof PEER_MUTATIONS)[number];

/** What a session is opened with: the invite's two keys, the session's clock, and the seats. */
export interface PeerOptions {
  roomId: string;
  roomKey: Uint8Array;
  /**
   * The host key the invite's `h` carries: the room's root of trust, and the only key that
   * verifies a `kind = 1` state or a `kind = 2` closing.
   */
  hostKey: Uint8Array;
  /** The session's own clocks, from `room.created`/`room.joined` (`/meta`) as §8.2 reads them. */
  keepalive: Keepalive;
  crypto: FrameCrypto;
  /** The seat this connection is shown under. It decides no attribution (§13.4). */
  seat?: string;
  /** The seats the roster has, which is what §13.8 reads a state's `host` entry against. */
  roster?: Iterable<string>;
  /**
   * A fixed session keypair, as its 32-byte seed.
   *
   * **A test seam, and not production surface.** §13.1 mints the session keypair in memory for
   * the connection and never persists it, and no frame carries a private key to a client, so
   * nothing in the protocol lets a caller choose one. It exists because the corpus's decision
   * layer drives a *fixture* keypair: the state a decision vector delivers commits that fixture
   * key's public half, so a client that minted its own key could not be the peer the vector is
   * about. Left out, which is what a session does, it mints one.
   */
  sessionSeed?: Uint8Array;
  /** The role this client believes it has been given — `guest` or `viewer`, never `host`. */
  declaredRole?: 'guest' | 'viewer';
  /**
   * The awareness client id this connection is known by, which is the id its
   * `session.hello` announces (`PROTOCOL.md` §5, §8.4).
   *
   * y-protocols seeds one from the document's own id, and a peer's cursor is attributed by
   * joining the id the server records for the connection to the awareness state that arrives
   * under it — so a session minted its own and one announced by the caller would be two
   * numbers for one connection, and every peer would draw this client's caret as a stranger's.
   * Left out, this session mints one, which is what a caller with no handshake does.
   */
  awarenessClientId?: number;
  /**
   * The host's producer half (§7.1), which makes this session the room's authority rather than
   * one of its peers. The host key's private half lives here, so a session given this can sign
   * a state and a session without it cannot; a session with neither cannot be the host.
   */
  host?: HostOptions;
  /**
   * Whether the session keeps a record of every frame it applied, dropped or ignored
   * (`appliedFrames`, `droppedFrames`, `ignoredFrames`): §13.11's observables, which the
   * corpus subject and the tests read. On by default for them. A live connection turns it off,
   * because the record is one entry per frame for the life of the session, every keystroke and
   * caret move of every peer, and a peer or a server sending frames that are refused grows it
   * as fast as it likes (§2.1: a client bounds what it holds). `frameCount` is kept either way.
   */
  recordFrames?: boolean;
  /**
   * The room's frame budget (`CANONICAL.md` §6.1), {@link FRAME_BUDGET} when left out. **A test
   * seam**: a live session has no reason to set it, and a smaller one only ends a room sooner.
   */
  frameBudget?: number;
}

/**
 * One connection's `selvage/2` session.
 *
 * Every argument named `clock` is monotone elapsed time since the seat, in milliseconds, which
 * the caller reads from its own timer (`PROTOCOL.md` §13.8).
 */
export class PeerSession {
  readonly roomId: string;

  private readonly crypto: FrameCrypto;
  private readonly frameKey: Uint8Array;
  /** Mutable because §9.1 mints a new session keypair for every connection, a reconnect included. */
  private session: SessionKeypair;
  private readonly declaredRole: 'guest' | 'viewer' | undefined;
  private readonly renew: number;
  private readonly expire: number;
  /** Mutable because a reconnect is a new seat on a new connection (§9.1). */
  private seat: string | undefined;
  private roster: Set<string>;
  private readonly reader: Reader;
  private readonly host: HostProducer | undefined;
  private readonly doc: Y.Doc;
  private readonly awareness: Awareness;
  /** The local awareness state this connection published, so a renewal republishes it (§8.2). */
  private localState: AwarenessState | null = null;
  /** The clock of the renewal that last published the local state (§8.2). */
  private awarenessRenewedAt: number | undefined;
  /** The clock of the most recent tick or delivery, which a queued frame is stamped with. */
  private clockOfLastMove = 0;
  private readonly outbound: Uint8Array[] = [];
  /**
   * Whether the socket under this session is gone and no new one has taken its place (§9.1).
   *
   * The session key a dropped connection held is not one the room will commit again, so an edit
   * sealed under it now is a frame every peer refuses `uncommitted_key`. A detached session
   * therefore publishes nothing — what it would have sent goes to {@link unsent} instead, and the
   * state that commits the re-seat's key flushes it — and keeps nothing queued for the socket
   * that went (see {@link detach}).
   */
  private detached = false;
  private readonly held = new Set<string>();
  private holdsSent: string[] = [];
  private holdsAnnouncedAt: number | undefined;
  /** When the last holds message from each key was accepted, which is its lease. */
  private readonly leases = new Map<string, number>();
  /** The seats that have left, from `peer.left`: §13.7 drops holds on it. */
  private readonly departed = new Set<string>();
  private counter = 0;
  private announcedAt: number | undefined;
  /** §13.6's interval: the clock of the first content frame refused since the last `SyncStep1`. */
  private resyncFrom: number | undefined;
  private handshakenAt: number | undefined;
  private stateIssued: number | undefined;
  private hostAwaySince: number | undefined;
  private published = 0;
  private handshake = 0;
  private frames = 0;
  /**
   * `CANONICAL.md` §6.1's count: every binary frame this session was delivered and every frame it
   * sealed, across reconnects, because the frame key it is counted against outlives a socket.
   */
  private roomFrames = 0;
  private readonly frameBudget: number;
  private readonly applied: AppliedFrame[] = [];
  private readonly dropped: DroppedFrame[] = [];
  private readonly ignored: number[] = [];
  /** See {@link PeerOptions.recordFrames}. */
  private readonly recordFrames: boolean;
  private ending: Ending | undefined;
  private mutation: PeerMutation | HostMutation | undefined;
  /**
   * The local edits this client made while §13.1's step 4 held its content back.
   *
   * The deltas themselves and not a state vector over the replica: a state that does not commit
   * this key still lets its peers' content be applied (§13.2 refuses content only when no state
   * is held at all), so a vector taken at the first held-back edit would carry their changes out
   * again under this connection's key.
   */
  private readonly unsent: Uint8Array[] = [];
  /**
   * The bytes of the last room state this connection **applied** (§7.1).
   *
   * §7.1 has a peer that holds a verified state re-send it, unchanged, when it sees a
   * `peer.joined`, so that a joiner's state arrives while the host is away. The bytes are the
   * ones it received: only the host key signs a state, and a peer that re-sealed or re-signed
   * one would hand the room a frame every other peer refuses `uncommitted_key`.
   */
  private heldStateFrame: Uint8Array | undefined;
  /** Every state this connection published, in the order it published it (§7.1). */
  private readonly publishedStates: HostPublication[] = [];
  /** The `issued` of every closing this connection published, in order (§7.1). */
  private readonly publishedClosings: number[] = [];
  /**
   * One decision at a time, in the order the calls came.
   *
   * A read, a tick and a local edit are each several awaits long and each moves this session's
   * marks, clocks and tallies, so two of them in flight together would decide about one room
   * from two half-applied states — and a timer's tick and a socket's frame are exactly two
   * concurrent callers. The ordering is the session's to keep rather than the caller's.
   */
  private pending: Promise<unknown> = Promise.resolve();
  /**
   * The first thing that went wrong on the way *out* — a CSPRNG that would not read, an AEAD
   * that refused its own inputs. A session cannot refuse to publish without somewhere to say
   * so, and a driver that never looks is a driver publishing nothing.
   */
  private fault: string | undefined;

  private constructor(
    options: PeerOptions,
    frameKeyBytes: Uint8Array,
    session: SessionKeypair,
    reader: Reader,
    host: HostProducer | undefined,
  ) {
    this.roomId = options.roomId;
    this.crypto = options.crypto;
    this.frameKey = frameKeyBytes;
    this.session = session;
    this.declaredRole = options.declaredRole;
    this.recordFrames = options.recordFrames ?? true;
    this.frameBudget = options.frameBudget ?? FRAME_BUDGET;
    this.renew = options.keepalive.awareness_renew_ms;
    this.expire = options.keepalive.awareness_expire_ms;
    this.seat = options.seat;
    this.roster = new Set(options.roster ?? []);
    this.reader = reader;
    this.host = host;
    // `CANONICAL.md` §6.1: the host's count is the room's, so a host continues the one it saved.
    this.roomFrames = host?.roomFrames ?? 0;
    if (host !== undefined) {
      host.seated(options.seat ?? '', session.public);
      if (options.seat !== undefined) {
        // §9: a host is seated in the room it minted, whether or not the roster it was handed
        // names it. Without this its own state's `host` entry labels a seat the session believes
        // is absent, and §13.8's clock then ends the host's own session.
        this.roster.add(options.seat);
      }
    }
    // §7's document: one `Y.Doc`, one `Y.Text` per path.
    this.doc = new Y.Doc();
    this.awareness = new Awareness(this.doc);
    // y-protocols runs the awareness clock on an interval, and §8.2's renewal and expiry are
    // read on that same clock. `destroy()` clears it, and a caller that forgets would otherwise
    // hold its process open for ever: `unref` is what makes forgetting cost nothing.
    unrefTimer(this.awareness._checkInterval);
    const minted = this.awareness.clientID;
    if (options.awarenessClientId !== undefined) {
      // The id the handshake announced, so the states this connection publishes and the peer
      // records that attribute them agree (§8.4).
      this.awareness.clientID = options.awarenessClientId >>> 0;
    }
    if (minted !== this.awareness.clientID) {
      // y-protocols seeds a local `{}` under the id it minted with the document, and moving to
      // the handshake's id would leave that state behind as a record of a peer that does not
      // exist — it would answer `presence()` under a stranger's id for the whole session.
      this.awareness.states.delete(minted);
      this.awareness.meta.delete(minted);
    }
    // A session that holds no cursor publishes none: the seed above is a state a peer would
    // read as a participant with no caret.
    this.awareness.setLocalState(null);
    this.wireAwareness();
    this.doc.on('afterTransaction', (transaction: Y.Transaction) => {
      this.noteTouched(transaction);
    });
  }

  /**
   * The paths whose text a transaction changed, local or applied, kept until
   * {@link takeTouched} reads them. Every change to a `Y.Text` is a transaction on this one
   * document, so a path that is not here since the last read holds the text it held then.
   */
  private readonly touched = new Set<string>();

  private noteTouched(transaction: Y.Transaction): void {
    // A root type is a path's document. It is recorded whatever class it has now: content for a
    // path this replica has not asked for yet arrives under a placeholder type, which becomes the
    // path's `Y.Text` only when something reads it — and that swap is no transaction.
    const roots = new Set<unknown>();
    for (const type of transaction.changed.keys()) {
      if (type._item === null) {
        roots.add(type);
      }
    }
    if (roots.size === 0) {
      return;
    }
    // One pass over the documents, so a sync that changes many of them costs one walk and not
    // one per changed document.
    for (const [name, shared] of this.doc.share) {
      if (roots.has(shared)) {
        this.touched.add(name);
      }
    }
  }

  /** The paths whose text changed since the last call, and forgets them. */
  takeTouched(): string[] {
    const paths = [...this.touched];
    this.touched.clear();
    return paths;
  }

  /**
   * §8: the awareness states this client publishes, and the local state's renewal.
   *
   * A state applied from a peer's frame is not re-broadcast — awareness converges peer to peer
   * and the relay only carries it — while every local change is one frame carrying the clients
   * it touched, which is what §8.2's renewal is too: the same state on a newer clock.
   */
  private wireAwareness(): void {
    this.awareness.on(
      'update',
      (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        if (origin !== 'local') {
          return;
        }
        const clients = [...changes.added, ...changes.updated, ...changes.removed];
        if (clients.length === 0) {
          return;
        }
        void this.serial(async () => {
          // §13.1's step 4 holds every frame but the announcement back until a state commits
          // this key; §13.9 lets a `viewer` publish its awareness, so role decides nothing here.
          if (!this.mayPublish()) {
            return;
          }
          await this.publish('content', encodeAwareness(this.awareness, clients));
          // §8.2's renewal clock is measured from the state that last went out, whichever
          // caller published it: a caret moved by hand is a renewal of the same state.
          this.awarenessRenewedAt = this.clockOfLastMove;
        });
      },
    );
  }

  /** A connection's session: §13.1's steps 1 and 2, and nothing sent yet. */
  static async create(options: PeerOptions): Promise<PeerSession | undefined> {
    const reader = await Reader.create({
      roomId: options.roomId,
      roomKey: options.roomKey,
      hostKey: options.hostKey,
      crypto: options.crypto,
    });
    const session = await mintSessionKey(options.crypto, options.sessionSeed);
    if (reader === undefined || session === undefined) {
      return undefined;
    }
    const host =
      options.host === undefined
        ? undefined
        : await HostProducer.create(
            options.crypto,
            options.roomId,
            reader.frameKey,
            options.keepalive.awareness_renew_ms,
            options.host,
          );
    if (options.host !== undefined && (host === undefined || options.seat === undefined)) {
      // A host publishes a `peers` entry for its own connection, and the entry carries the
      // seat `room.created` seated it under. Without one there is nothing to write, and a
      // state whose `host` entry is missing leaves every peer with no identified host
      // connection at all (§13.4), so this is refused where it is built.
      return undefined;
    }
    const peer = new PeerSession(options, reader.frameKey, session, reader, host);
    // §13.1: a host's order is a peer's with one difference — it publishes a state at mint,
    // so its own state may precede any it verifies. That state is also what commits its own
    // connection's key, which is why a host has nothing to announce.
    if (host !== undefined) {
      await peer.publishState(0, 'mint');
      if (peer.fault !== undefined) {
        // §7.1's first state is what brings the room's listing into existence and commits this
        // connection's key. A host that could not seal one is a host no peer can see, and some
        // other connection holding the host key has to be the one that publishes instead. The
        // session that is not handed over is released here: it already holds a `Y.Doc` and the
        // clock `Awareness` runs, and one of those left behind is a process that never exits.
        peer.destroy();
        return undefined;
      }
    }
    return peer;
  }

  // --- what a caller reads ------------------------------------------------------

  /** This connection's session public key, which the announcement names. */
  get sessionKey(): Uint8Array {
    return this.session.public;
  }

  /** This connection's own seat, as a caller that needs to show it reads it. */
  get ownSeat(): string | undefined {
    return this.seat;
  }

  /** Whether a verified room state has been applied, which §13.3's waiting rules turn on. */
  stateHeld(): boolean {
    return this.stateIssued !== undefined;
  }

  /** The edition of the state this client holds, or `undefined` before one is applied. */
  get issued(): number | undefined {
    return this.stateIssued;
  }

  /** The listing of the last state applied, with §5's refused paths dropped. */
  get listing(): readonly string[] {
    return this.reader.listing;
  }

  /** How many frames this client **published** under §13's rules (§13.11). */
  get publishedCount(): number {
    return this.published;
  }

  /** How many §7 handshake frames it sent, counted apart from its publications. */
  get handshakeCount(): number {
    return this.handshake;
  }

  get frameCount(): number {
    return this.frames;
  }

  get appliedFrames(): readonly AppliedFrame[] {
    return this.applied;
  }

  get droppedFrames(): readonly DroppedFrame[] {
    return this.dropped;
  }

  /** The frames that verified and applied nothing, by the index they were handed as. */
  get ignoredFrames(): readonly number[] {
    return this.ignored;
  }

  /** Why the session ended, if it has. */
  get end(): Ending | undefined {
    return this.ending;
  }

  get mutationName(): PeerMutation | HostMutation | undefined {
    return this.mutation;
  }

  /** The first frame this session could not produce, if any. */
  get failure(): string | undefined {
    return this.fault;
  }

  /** The paths this client has open: what its own holds message carries. */
  heldPaths(): string[] {
    return [...this.held].sort();
  }

  /** Whether this connection holds the host key, which is the whole of what being the host is. */
  get isHost(): boolean {
    return this.host !== undefined;
  }

  /**
   * Every room state this connection published, in the order it published them (§7.1).
   *
   * A state that re-sends the one this host holds is in the list with `fresh: false`: §7.1
   * makes that the answer an announcement whose key the state already commits is owed, and the
   * difference between a new edition and a re-send is the whole of what the rule says.
   */
  hostStates(): readonly HostPublication[] {
    return this.publishedStates;
  }

  /** The `issued` of every closing this connection published, in order (§7.1). */
  hostClosings(): readonly number[] {
    return this.publishedClosings;
  }

  /**
   * What each peer is held to, by the key's canonical spelling where the applied state names it
   * and by its id where nothing does (§13.4). A key whose lease has lapsed is not here at all:
   * §13.7 has the receiver forget the whole set.
   */
  peerHolds(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const [id, paths] of this.reader.holds) {
      out.set(this.spelling(id) ?? id, [...paths]);
    }
    return out;
  }

  /**
   * The text this replica holds at a path, which is what a decision vector reads. Empty for a
   * path nothing has arrived for, and reading one does not bring a document into being: see
   * {@link has}, which an adapter asks precisely that question of.
   */
  text(path: string): string {
    return this.textIfPresent(path)?.toString() ?? '';
  }

  /** The length of a document's text in UTF-16 code units, the unit every editor counts in. */
  length(path: string): number {
    return this.textIfPresent(path)?.length ?? 0;
  }

  /** The paths this replica holds any text for: the documents that have arrived. */
  documents(): string[] {
    const paths: string[] = [];
    for (const [name, type] of this.doc.share) {
      if (type instanceof Y.Text) {
        paths.push(name);
      }
    }
    return paths.sort();
  }

  /**
   * Whether a document for this path is here (§13.5): one the room sent — an empty one
   * included, which is what a file that is genuinely empty is answered with, so that a reader
   * can tell it from a path nothing has arrived for — or one this window wrote into. A path
   * this window only *read* — an empty buffer drawn from the room's listing — has none, and an
   * adapter that could not tell that apart from an answer would treat the read as the room's
   * own publication: a guest would stop holding a listed path nothing has arrived for, and a
   * host that had read its replica would refuse to seed its working copy over it.
   */
  has(path: string): boolean {
    return this.doc.share.has(path);
  }

  /**
   * The role the applied state gives this connection's own key (§13.4), and `undefined` while
   * no state commits that key.
   *
   * It is what tells an adapter that its editor is read-only: §13.9 lets a `viewer` edit its own
   * screen and publishes none of it, and the role is the state's word rather than the
   * connection's claim, which is why the declared one is not the answer.
   */
  ownRole(): string | undefined {
    return this.role();
  }

  /**
   * The roles the applied state assigns, by the seat each committed key is labelled (§7.1).
   *
   * A seat may hold one key (§7.1), so this is a map and not a list; a key the state names
   * without a seat label is left out rather than labelled with nothing. Where one `peer_id` is
   * named under two keys, the reading is §6.1's: the entry whose key comes first in UTF-16
   * code-unit order, which is the order {@link committedEntries} sorts by, so this agrees with
   * `entries()`, `hostSeat()` and a second receiver on the same bytes.
   */
  rolesBySeat(): Map<string, string> {
    const out = new Map<string, string>();
    for (const entry of this.committedEntries()) {
      if (out.has(entry.peerId)) {
        continue;
      }
      out.set(entry.peerId, entry.role);
    }
    return out;
  }

  /**
   * Every awareness state this client holds, attributed to the seats the caller knows (§8.4).
   *
   * The session knows the ids and the roles; the names and the seats are the relay's, so a
   * caller that holds them hands them in — `buildPresence` is the one place the two meet.
   */
  presence(peers: Iterable<PeerInfo>, local: PeerInfo): Presence[] {
    return buildPresence(this.awareness, peers, local);
  }

  /**
   * Resolves a peer's selection to offsets in this replica, or `undefined` when either endpoint
   * does not resolve — a document that has not arrived resolves later, which is why a caller
   * resolves on demand rather than once (§8.1).
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

  // --- what the caller hands in -------------------------------------------------

  /** One sealed frame, as the relay delivered it. */
  deliver(clock: number, frame: Uint8Array): Promise<Outcome> {
    return this.serial(() => this.deliverOne(clock, frame));
  }

  private async deliverOne(clock: number, frame: Uint8Array): Promise<Outcome> {
    this.clockOfLastMove = clock;
    this.frames += 1;
    this.countFrame();
    const index = this.frames - 1;
    // A closing folds into the receiver the moment it verifies, and §13.10 ignores one handed
    // to a client holding no state. The two values it moved are put back, because `issued` is
    // an order between two states and this receiver has none to compare one with: vector 155
    // delivers a closing at edition 2 and then a state at 1, and the state must still be the
    // first edition this client holds.
    const issued = this.reader.issued;
    const ended = this.reader.ended;
    const verdict = await this.reader.read(frame);
    if (!verdict.ok) {
      this.noteRefusal(clock, verdict);
      return this.refuse(index, verdict.reason);
    }
    const kind = verdict.kind ?? 0;
    if (verdict.payload?.kind === 'state') {
      // §7.1: what a peer re-sends when it sees a `peer.joined` is the bytes it received, and
      // those are the ones that verified.
      this.heldStateFrame = frame;
    }
    if (this.ignores(verdict)) {
      this.reader.issued = issued;
      this.reader.ended = ended;
      if (this.recordFrames) {
        this.ignored.push(index);
      }
      return { status: 'ignored', kind };
    }
    await this.fold(clock, verdict);
    if (this.recordFrames) {
      this.applied.push({ frame: index, kind });
    }
    return { status: 'applied', kind };
  }

  /**
   * The clocks, on the caller's tick: §13.7's renewal and expiry, §13.8's host-away window and
   * §13.3's no-state window.
   *
   * The announcement of §13.1's step 4 goes out here too, at the first tick and whenever a
   * state has not committed this key since — so a driver has one path to publish it and nothing
   * has to remember to call it at the join.
   */
  tick(clock: number): Promise<void> {
    return this.serial(() => this.tickOne(clock));
  }

  /**
   * The next clock at which a tick has something to do that cannot wait for the renewal window,
   * or `undefined` when the ordinary window is the next thing due.
   *
   * Two of the session's deadlines start from an event rather than from the tick grid: §7.1's
   * publish window opens when a state went out for an announcement, and §13.1's step 4 renewal is
   * due a window after the announce that set it. Both are stated in `awareness_renew_ms`, so a
   * caller whose timer runs on that same number observes each of them up to a window late — and
   * the first is what leaves a guest whose announcement was folded into the window unable to
   * publish anything, its holds included (§13.7), for two windows instead of one. The other clocks
   * are due a window after something this session published, which a tick on the window observes.
   *
   * A deadline is reported whether or not it has already passed. A tick that runs inside the same
   * millisecond as the deadline can find the window a hair short of open, and a caller that then
   * waited out its ordinary window would be a whole one late for a state it is still owed.
   */
  nextDeadline(): number | undefined {
    if (this.ending !== undefined || this.detached) {
      return undefined;
    }
    let soonest = this.host?.owedAt();
    // A host has no announcement to renew: the state it published at mint commits its own key.
    // The conditions are `reannounce`'s own, so that a deadline is only stated for a tick that
    // would act on it — one stated for a tick that would return does not advance, and a caller
    // arming itself for it would come back for ever.
    if (
      this.host === undefined &&
      !this.commitsOurs() &&
      !this.mutating('announce-once') &&
      this.announcedAt !== undefined
    ) {
      const due = this.announcedAt + this.renew;
      if (soonest === undefined || due < soonest) {
        soonest = due;
      }
    }
    return soonest;
  }

  private async tickOne(clock: number): Promise<void> {
    this.clockOfLastMove = clock;
    this.host?.flushFrames(clock);
    this.expireLeases(clock);
    this.refreshHostAway(clock, false);
    if (this.ending !== undefined) {
      return;
    }
    if (await this.budgetSpent()) {
      return;
    }
    if (this.windowPassed(clock)) {
      return;
    }
    await this.publishState(clock, 'announcement');
    await this.reannounce(clock);
    await this.resync(clock);
    await this.announceHolds(clock);
    this.renewAwareness(clock);
  }

  /**
   * §8.2's renewal: the same local state on a newer awareness clock, which is what a peer's
   * expiry window measures. It runs on the renewal clock and not on every tick — a caller that
   * moves the session more often than `awareness_renew_ms` republishes nothing early, because a
   * state that goes out on every tick is a state another client applies on every one. A cleared
   * state stays cleared: publishing `{}` would put a live presence with a cursor at nowhere back
   * on the wire.
   */
  private renewAwareness(clock: number): void {
    if (this.localState === null) {
      return;
    }
    if (this.awarenessRenewedAt !== undefined && clock - this.awarenessRenewedAt < this.renew) {
      return;
    }
    this.awarenessRenewedAt = clock;
    this.awareness.setLocalState(this.localState);
  }

  /** Takes what this session has published, in the order it published it. */
  takeOutbound(): Uint8Array[] {
    return this.outbound.splice(0, this.outbound.length);
  }

  /**
   * Releases what the session holds outside itself: the awareness clock `y-protocols` runs, and
   * the document. A session that ends and is not destroyed leaves a timer behind, and a timer
   * with nothing to hold alive is a process that never exits.
   */
  destroy(): void {
    this.awareness.destroy();
    this.doc.destroy();
  }

  /**
   * A seat has joined, from `peer.joined`.
   *
   * §7.1 obliges a host to publish a state on it — which is how the joiner learns the listing
   * and the roles without asking — and asks any peer that holds a verified state to re-send
   * that state unchanged while the host is away, so a joiner's state arrives without it. §13.7 has a
   * holder re-announce its holds on the same event.
   */
  seatJoined(clock: number, seat: string): Promise<void> {
    return this.serial(async () => {
      this.host?.seatJoined(seat);
      this.departed.delete(seat);
      this.roster.add(seat);
      this.holdsAnnouncedAt = undefined;
      if (this.host !== undefined) {
        await this.publishState(clock, 'roster');
        return;
      }
      // §7.1: the re-send is for a room whose host is away — a joiner the host cannot answer, or
      // a returning host that lost its `issued`. While the seat the `host` entry labels is seated,
      // the host's own fresh state answers this join, and a copy from every peer would put the
      // whole listing on every connection once per seated peer.
      const hostSeat = this.hostSeat();
      if (
        this.heldStateFrame !== undefined &&
        (hostSeat === undefined || !this.roster.has(hostSeat))
      ) {
        this.republish(this.heldStateFrame);
      }
    });
  }

  /** A seat has left, from `peer.left`: §13.8's clock can arm on it and §13.7's holds go. */
  seatLeft(clock: number, seat: string): Promise<void> {
    return this.serial(async () => {
      this.host?.seatLeft(seat);
      this.roster.delete(seat);
      this.departed.add(seat);
      this.dropDepartedHolds();
      this.refreshHostAway(clock, false);
      if (this.host !== undefined) {
        await this.publishState(clock, 'roster');
      }
    });
  }

  /**
   * §9.1: a dropped socket is recovered by a fresh `session.hello` on a new socket, and a
   * reconnecting client is a new peer. What that changes here is the connection and nothing
   * about the replica: a new session keypair for the new connection (§13.1's step 2), the new
   * seat, the roster the handshake seated it among, and the clocks that belong to a connection.
   *
   * What survives is what §9.1 says survives — the `Y.Doc`, the receiver's marks (which are
   * what refuses a replayed state or closing), the roles the last state assigned until the next
   * state replaces them, and the paths this connection still holds open. `announcedAt`,
   * `handshakenAt` and `resyncFrom` are cleared so the first tick after the re-seat re-announces
   * the new key (§13.1's step 4) and re-runs the sync handshake (§13.1's step 6). The `ending` is
   * cleared because a drop is recoverable and the session did not end; the `fault` is cleared
   * because it belonged to the connection that died. The awareness id is rotated for the same
   * reason §9.1 gives: a library may remember an id whose state was removed and drop its next
   * publish, so the rejoined peer would look like one with no cursor at all (`§8.4`).
   */
  reseat(seat: string, roster: Iterable<string>, awarenessClientId: number): Promise<void> {
    return this.serial(async () => {
      const session = await mintSessionKey(this.crypto);
      if (session === undefined) {
        this.fault = 'a session key could not be minted for the reconnect';
        return;
      }
      this.session = session;
      this.detached = false;
      this.seat = seat;
      this.roster = new Set(roster);
      const previousAwareness = this.awareness.clientID;
      this.awareness.clientID = awarenessClientId >>> 0;
      if (previousAwareness !== this.awareness.clientID) {
        // The old id's entry is this connection's leftover, not a peer's; left behind it would
        // answer `presence()` under a stranger's id and be tombstoned on the next rotation.
        this.awareness.states.delete(previousAwareness);
        this.awareness.meta.delete(previousAwareness);
      }
      this.awarenessRenewedAt = undefined;
      // The counter is per key (§6.1): the new key starts at 0, and the marks the receiver
      // keeps are keyed by the old and new keys alike, so nothing is lost by resetting it.
      this.counter = 0;
      this.announcedAt = undefined;
      this.handshakenAt = undefined;
      this.resyncFrom = undefined;
      this.holdsAnnouncedAt = undefined;
      this.ending = undefined;
      this.fault = undefined;
      // `CANONICAL.md` §6.1: a host's return costs its count the absence charge, because the
      // frames sealed while it was away are ones it never saw.
      if (this.host !== undefined) {
        this.roomFrames += ABSENCE_CHARGE;
        this.host.countFrames(this.roomFrames);
        this.host.saveFrames();
      }
    });
  }

  /**
   * The host's listing changed, from whatever watches its working tree (§7.1).
   *
   * A listing is replaced wholesale by every state, so this is the one thing a host's adapter
   * has to say about it: the state that follows names the whole tree as it now is, and a
   * shorter listing is a smaller working tree rather than a partial update (§13.3).
   */
  listingChanged(clock: number): Promise<void> {
    return this.serial(async () => {
      await this.publishState(clock, 'listing');
    });
  }

  /**
   * §7.1's closing: the host's statement that the room is over, above every state it published.
   *
   * A host that publishes one stops publishing; every peer that already holds a verified state
   * below its `issued` applies it and ends, and §9's room dies when its last connection ends.
   */
  /**
   * §7.1's closing: the host's statement that the room is over, above every state it published.
   *
   * A host that publishes one stops publishing; every peer that already holds a verified state
   * below its `issued` applies it and ends, and §9's room dies when its last connection ends. The
   * session that published it ends with them, which is what §13.10 gives a receiver that applies
   * one and what keeps a host from publishing content into a room it has just declared over.
   */
  async closeRoom(): Promise<boolean> {
    if (this.host === undefined) {
      return false;
    }
    return await this.serial(async () => {
      const publication = await this.host?.closing();
      if (publication === undefined) {
        this.fault ??= this.host?.failure ?? 'the closing could not be sealed';
        return false;
      }
      this.countFrame();
      this.host?.saveFrames();
      this.outbound.push(publication.frame);
      this.published += 1;
      this.publishedClosings.push(publication.issued);
      this.ending = 'closing';
      return true;
    });
  }

  /** Opens a path: this client offers it, and its whole held set changes (§13.7). */
  open(path: string): void {
    this.held.add(path);
  }

  /**
   * Releases a path, or every path when given none. §13.7 asks for the empty set rather than
   * for silence, so the room learns in one hop instead of waiting out a lease.
   */
  release(path?: string): void {
    if (path === undefined) {
      this.held.clear();
      return;
    }
    this.held.delete(path);
  }

  /**
   * A local edit, published as the delta it produced and never as the whole document.
   *
   * The edit lands in the replica **before this call returns a promise**: an adapter reads the
   * replica back synchronously after a keystroke — the bridge diffs the buffer against it — and
   * one that had to wait for a seal would compute the same keystroke a second time. What is
   * serialized is the publication, in the order the calls came.
   *
   * Returns whether anything went out: §13.5 and §13.9 have a `viewer` keep its edit and not
   * send it, and §13.1's step 4 has any peer keep it until a state commits its key.
   *
   * An empty text into a path this replica holds no document for **publishes the document** —
   * the room's only way of saying that a path exists and its text is empty — and an empty text
   * into one that is here is the edit it always was, which changes nothing. The path is named
   * by {@link EMPTY_DOCUMENT_MARK}.
   */
  insert(path: string, index: number, text: string): Promise<boolean> {
    const publishing = text === '' && !this.doc.share.has(path);
    const update = this.editLocally(path, (handle) => {
      // An index past the end of the text is the caller's bug, and `yjs` answers one by writing
      // at the end. A client any caller can silently mis-edit is not one a decision vector can
      // drive, so it is refused.
      if (index < 0 || index > handle.length) {
        throw new Error(`there is no offset ${index} in ${JSON.stringify(path)}`);
      }
      if (publishing) {
        handle.insert(0, EMPTY_DOCUMENT_MARK);
        handle.delete(0, EMPTY_DOCUMENT_MARK.length);
        return;
      }
      handle.insert(index, text);
    });
    return this.publishEdit(update);
  }

  /** A local deletion, published exactly as {@link PeerSession.insert} publishes an insertion. */
  remove(path: string, index: number, length: number): Promise<boolean> {
    const update = this.editLocally(path, (handle) => {
      if (index < 0 || length < 0 || index + length > handle.length) {
        throw new Error(
          `there is no range ${index}..${index + length} in ${JSON.stringify(path)}`,
        );
      }
      handle.delete(index, length);
    });
    return this.publishEdit(update);
  }

  /**
   * Applies one local change to the replica and returns the update it produced, or `undefined`
   * for a change that produced none.
   *
   * The update is the one this edit's own transaction produced, and not a diff over the
   * document: a state-vector diff carries the whole delete set — a peer's deletion of a peer's
   * text included — and that is a change this connection did not make and must not publish
   * under its own key. `LOCAL_ORIGIN` is what tells the two apart: peer content is applied
   * under `APPLIED_ORIGIN`.
   */
  private editLocally(path: string, edit: (handle: Y.Text) => void): Uint8Array | undefined {
    const captured: Uint8Array[] = [];
    const capture = (update: Uint8Array, origin: unknown): void => {
      if (origin === LOCAL_ORIGIN) {
        captured.push(update);
      }
    };
    const handle = this.doc.getText(path);
    this.doc.on('update', capture);
    try {
      this.doc.transact(() => {
        edit(handle);
      }, LOCAL_ORIGIN);
    } finally {
      this.doc.off('update', capture);
    }
    return captured.length === 0 ? undefined : Y.mergeUpdates(captured);
  }

  /** Puts one local edit's update on the wire, or holds it back, in call order. */
  private publishEdit(update: Uint8Array | undefined): Promise<boolean> {
    return this.serial(async () => {
      if (update === undefined) {
        return false;
      }
      if (!this.mayPublish() || this.role() === 'viewer') {
        // §13.9: a `viewer`'s edit is its own and never the room's, so there is nothing to send
        // later. Anyone else's is held back by §13.1's step 4 and sent by
        // {@link PeerSession.flushHeldBackEdits} once a state commits this key.
        if (this.role() !== 'viewer') {
          this.unsent.push(update);
        }
        return false;
      }
      await this.publish('content', encodeUpdate(update));
      return true;
    });
  }

  // --- presence -----------------------------------------------------------------

  /**
   * Publishes this client's presence: document path plus selection. `null` clears it.
   *
   * A state that says what the last one said is not published: y-protocols emits an `update`
   * for every `setLocalState`, changed or not, and §8.2's renewal is deliberately the same state
   * on a newer clock — which the library's own renewal clock runs, not this.
   */
  setAwareness(state: AwarenessState | null): void {
    if (sameAwareness(this.localState, state)) {
      return;
    }
    this.localState = state;
    this.awareness.setLocalState(state);
  }

  /**
   * Publishes a selection given as editor offsets (UTF-16 code units), converting each endpoint
   * to the anchor the wire carries (§8.1). Offsets stop at this seam.
   *
   * A selection this replica cannot anchor is not published: when the text is not here yet, or
   * an endpoint is past its end, the state carries the path and no selection (§8.1).
   */
  setSelection(path: string, selection: OffsetSelection): void {
    const text = this.textIfPresent(path);
    if (text === undefined || selection.anchor > text.length || selection.head > text.length) {
      this.setAwareness({ path });
      return;
    }
    this.setAwareness({
      path,
      selection: {
        anchor: toAnchor(Y.createRelativePositionFromTypeIndex(text, selection.anchor)),
        head: toAnchor(Y.createRelativePositionFromTypeIndex(text, selection.head)),
      },
    });
  }

  /**
   * The `Y.Text` a path already names, without creating one (§8.1's sender rule, and what
   * {@link has} means). `share` names a type as soon as this replica has one — written here,
   * or arrived in a peer's update — and nothing at all before that, so a read that created a
   * document would make "nothing has arrived" indistinguishable from "the room sent it".
   */
  private textIfPresent(path: string): Y.Text | undefined {
    return this.doc.share.has(path) ? this.doc.getText(path) : undefined;
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

  /** The committed entries of the applied state, sorted by key spelling (§6.1's order). */
  private committedEntries(): Committed[] {
    return this.reader.entries();
  }

  /**
   * Resolves when every decision this session has in flight has settled.
   *
   * A caller that changed something publishes nothing synchronously — the crypto seam is
   * asynchronous — so a socket reader that drains what the session produced has to know when
   * there is nothing left to drain. Without this, a caret is published at the next renewal
   * window, which is a whole `awareness_renew_ms` of a stale cursor.
   */
  whenIdle(): Promise<void> {
    return this.pending.then(
      () => undefined,
      () => undefined,
    );
  }

  /** One task at a time, in the order the calls came; see {@link PeerSession.pending}. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.pending.then(work, work);
    this.pending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Removes one of §13.11's client guards, for the corpus's mutation census.
   *
   * Throws naming the guard when nothing here removes it: a subject that cannot take a mutation
   * must say so rather than pass the census silently.
   */
  mutate(name: string): void {
    if (name === 'ignore-roles' || name === 'ignore-issued') {
      this.reader.guards.add(name);
    } else if ((HOST_MUTATIONS as readonly string[]).includes(name)) {
      if (this.host === undefined) {
        throw new Error(`no host publishes here, so ${JSON.stringify(name)} removes nothing`);
      }
      this.host.mutate(name);
    } else if (!(PEER_MUTATIONS as readonly string[]).includes(name)) {
      throw new Error(`no mutation is named ${JSON.stringify(name)}`);
    }
    this.mutation = name as PeerMutation | HostMutation;
  }

  // --- the rules, in the order §13 states them ----------------------------------

  private mutating(name: PeerMutation): boolean {
    return this.mutation === name;
  }

  /**
   * §13.6: a refused *content* frame opens an interval this client re-syncs in. The envelope's
   * `kind` is readable before any signature is verified, so that is a claim about the bytes and
   * not about the reason the frame was refused.
   */
  private noteRefusal(clock: number, verdict: Verdict): void {
    if (verdict.kind === 0 && this.resyncFrom === undefined) {
      this.resyncFrom = clock;
    }
  }

  /** One refused frame: §13.2's local report, which is never sent anywhere. */
  private refuse(frame: number, reason: DropReason | undefined): Outcome {
    // Every refusal carries the step that refused it; one without a reason would be a bug in
    // the byte layer and not a decision to report.
    const named = reason ?? 'bad_envelope';
    if (this.recordFrames) {
      this.dropped.push({ frame, reason: named });
    }
    return { status: 'dropped', reason: named };
  }

  /** Whether §13.10 has this frame ignored rather than applied. */
  private ignores(verdict: Verdict): boolean {
    return (
      verdict.payload?.kind === 'closing' &&
      !this.stateHeld() &&
      !this.mutating('any-closing')
    );
  }

  /**
   * Folds an applied frame into the session: §13.3's state, §13.7's lease, §13.10's closing,
   * and the content a `kind = 0` frame carries.
   */
  private async fold(clock: number, verdict: Verdict): Promise<void> {
    const payload = verdict.payload;
    if (payload === undefined) {
      return;
    }
    switch (payload.kind) {
      case 'state':
        await this.afterState(clock, payload.state.issued);
        break;
      case 'closing':
        this.ending = 'closing';
        break;
      case 'holds':
        this.renewLease(clock, verdict.sender);
        break;
      case 'announcement':
        await this.hearAnnouncement(clock, payload.key, payload.role);
        break;
      case 'content':
        await this.applyContent(verdict.plaintext);
        break;
      default:
        break;
    }
  }

  /** What §13.3, §13.1's step 6 and §13.7 owe an applied room state. */
  private async afterState(clock: number, issued: number): Promise<void> {
    this.stateIssued = issued;
    this.host?.verifiedState(issued);
    this.refreshHostAway(clock, true);
    this.dropDepartedHolds();
    // §13.1's steps 6 and 4: a state that commits this key is where the handshake belongs, and
    // one that does not is what a re-announcement is for — the renewal clock alone would wait a
    // whole window for it.
    if (this.commitsOurs()) {
      await this.handshakeOnce(clock);
      await this.flushHeldBackEdits();
      // §13.7 asks for the whole held set when it changes. A hold taken while this connection
      // could not publish — the open that lands the window in the room, before the state that
      // commits this key has arrived — is a change with nothing sent for it, and the renewal
      // clock alone would hold it back a whole window: for the room that is a path nobody asked
      // for, and for a path the host has to supply, no read at all.
      await this.announceHolds(clock);
    } else {
      await this.announce(clock);
    }
  }

  /**
   * Publishes the edits this connection made before a state committed its key.
   *
   * §13.1's step 4 held them in the replica, and a client that kept them there would leave the
   * room without them for good: §13.1's step 6 is a `SyncStep1`, which asks the room for what
   * this replica lacks, and nothing asks the room for what it lacks. What is sent is the deltas
   * this replica's own edits produced, merged, and never a diff over the document: another
   * peer's content can have arrived in between (§13.2 refuses content only while no state is
   * held), and a client that re-sent it would be publishing under its own key changes it did
   * not make.
   */
  private async flushHeldBackEdits(): Promise<void> {
    const held = this.unsent.splice(0, this.unsent.length);
    if (held.length === 0 || this.role() === 'viewer') {
      return;
    }
    await this.publish('content', encodeUpdate(Y.mergeUpdates(held)));
  }

  /** §13.2 and §13.3: a `kind = 0` plaintext, applied to the session document and answered. */
  private async applyContent(plaintext: Uint8Array): Promise<void> {
    if (!this.stateHeld()) {
      return;
    }
    let replies: Uint8Array[];
    try {
      replies = applyFrame(plaintext, this.doc, this.awareness, APPLIED_ORIGIN).replies;
    } catch {
      // A stream no replica decodes is a sender's bug: dropped, and the session goes on.
      return;
    }
    // §13.9: a `viewer` publishes its SyncStep1, its awareness and its holds, and nothing else
    // — a SyncStep2 is document content (§13.5) and is not its to send.
    if (this.role() === 'viewer') {
      return;
    }
    if (!this.commitsOurs()) {
      return;
    }
    for (const reply of replies) {
      await this.publish('sync', reply);
    }
  }

  /**
   * §13.7: only an accepted holds message renews a lease, and nothing else from the same peer
   * does.
   */
  private renewLease(clock: number, sender: string | undefined): void {
    if (sender !== undefined) {
      this.leases.set(sender, clock);
    }
  }

  /** Whether an applied state commits this connection's own session key. */
  private commitsOurs(): boolean {
    for (const entry of this.reader.committed.values()) {
      if (bytesEqual(entry.key, this.session.public)) {
        return true;
      }
    }
    return false;
  }

  /** The role the applied state gives this connection's own key (§13.4). */
  private role(): string | undefined {
    return this.reader.roleOfKey(this.session.public);
  }

  /** Whether §13.1's step 4 lets this client publish anything but its announcement. */
  private mayPublish(): boolean {
    // A session that has ended publishes nothing, whichever ending reached it (§13.10), and one
    // whose socket is gone publishes nothing under the key that socket held (§9.1).
    return !this.detached && this.ending === undefined && this.stateHeld() && this.commitsOurs();
  }

  /**
   * The socket under this session is gone: it keeps its replica and its holds, and publishes
   * nothing under the key the dead connection held until {@link reseat} seats a new one (§9.1).
   *
   * What that socket left queued goes with it, and here rather than at the re-seat: those frames
   * are sealed under the key being left, and a re-dial that has the new socket before the re-seat
   * has run would put them on it — where every peer refuses them, and where the edit they carry
   * is not in {@link unsent} to be published later.
   */
  detach(): void {
    this.detached = true;
    this.outbound.splice(0, this.outbound.length);
  }

  /** §13.1's step 4: the session-key announcement, `kind = 4`, signed by the key it names. */
  private async announce(clock: number): Promise<void> {
    // A host has nothing to announce: the state it published at mint commits its own
    // connection's key, which is what §13.1's step 4 exists to make possible.
    if (this.host !== undefined) {
      return;
    }
    // §2.1's order is ascending by member name, and `key` sorts before `role`.
    const members: Record<string, string> = { key: encodeKey(this.session.public) };
    if (this.declaredRole !== undefined) {
      members['role'] = this.declaredRole;
    }
    await this.publish('announcement', utf8(JSON.stringify(members)));
    this.announcedAt = clock;
  }

  /**
   * §13.1's step 4: re-announce on the session's renewal clock for as long as no applied state
   * commits this key, which is how an announcement the relay dropped is recovered.
   */
  private async reannounce(clock: number): Promise<void> {
    if (this.commitsOurs() || this.mutating('announce-once')) {
      return;
    }
    const due =
      this.announcedAt === undefined || clock - this.announcedAt >= this.renew;
    if (due) {
      await this.announce(clock);
    }
  }

  /**
   * §13.7: the whole held set, renewed on the client's own clock and published at once when it
   * changes. Rising from the tick and from nothing a peer sends is what lets a seated, idle
   * peer keep its holds.
   */
  private async announceHolds(clock: number): Promise<void> {
    if (!this.mayPublish()) {
      return;
    }
    // A holder with nothing open and nothing yet said has no frame to send; one that has
    // released everything says so, because the empty set is what §13.7 asks for.
    if (
      this.held.size === 0 &&
      this.holdsSent.length === 0 &&
      this.holdsAnnouncedAt === undefined
    ) {
      return;
    }
    const paths = this.heldPaths();
    const unchanged =
      paths.length === this.holdsSent.length &&
      paths.every((path, at) => path === this.holdsSent[at]);
    const due =
      !unchanged ||
      this.holdsAnnouncedAt === undefined ||
      clock - this.holdsAnnouncedAt >= this.renew;
    if (!due) {
      return;
    }
    await this.publish('holds', utf8(JSON.stringify({ holds: paths })));
    this.holdsSent = paths;
    this.holdsAnnouncedAt = clock;
  }

  // --- the clocks, the seats and what leaves the session -------------------------

  /**
   * §7.1: a session-key announcement the receiver accepted.
   *
   * A peer that is not the host owes it nothing at all — the state is the only source of the
   * keys a receiver keeps, and an announcement is read for the host's sake (§13.3) — so the
   * host's answer is the whole of what this decision is.
   */
  private async hearAnnouncement(
    clock: number,
    key: string,
    role: string | undefined,
  ): Promise<void> {
    const host = this.host;
    if (host === undefined) {
      return;
    }
    const named = decodeKey(key);
    if (named === undefined) {
      return;
    }
    host.announcement(named, role === 'guest' || role === 'viewer' ? role : undefined);
    await this.publishState(clock, 'announcement');
  }

  /**
   * The state §7.1 has this host publish now, if it is due: sealed by the host key, counted as
   * a publication, and folded into this session's own receiver.
   *
   * A host never receives the state it writes — the relay sends a frame to the room's *other*
   * connections — so the receiver is folded from the value rather than from the bytes, and
   * before anything that follows the frame (`afterState`) so that a `SyncStep1` goes out only
   * once a state commits this connection's key (§13.1's steps 4 and 6).
   */
  private async publishState(clock: number, reason: HostReason): Promise<void> {
    const host = this.host;
    if (host === undefined) {
      return;
    }
    if (this.roomFrames >= this.frameBudget) {
      return;
    }
    const publication = await host.publish(clock, reason);
    this.fault ??= host.failure;
    if (publication === undefined) {
      return;
    }
    if (publication.fresh) {
      this.countFrame();
    }
    this.outbound.push(publication.frame);
    this.published += 1;
    this.publishedStates.push(publication);
    if (!publication.fresh || publication.state === undefined) {
      return;
    }
    await this.reader.applyOwn(publication.state);
    await this.afterState(clock, publication.issued);
  }

  /**
   * One frame this connection did not author, put on the wire as the bytes it arrived as:
   * §7.1's re-send of a state the room holds, when a peer is seated. A frame at the edition
   * every peer already holds is refused `stale_issued` and changes nothing; the one this
   * re-send is for is the peer that holds none.
   */
  private republish(frame: Uint8Array): void {
    if (this.ending !== undefined) {
      return;
    }
    this.outbound.push(frame);
    this.published += 1;
  }

  /**
   * §13.7's expiry: a peer's whole held set is forgotten once its lease has lapsed.
   *
   * The text has this checked on the renewal tick, and a client whose tick *is* its renewal
   * tick checks there; a tick that comes more often forgets sooner, which is inside the
   * `awareness_expire_ms + awareness_renew_ms` the text bounds the delay by and never inside
   * the `MUST forget … after awareness_expire_ms` it states. An expiry is not a refusal — no
   * frame is dropped, the peer is not gone and nothing is reported anywhere — which is why the
   * only observable is the set becoming empty.
   */
  private expireLeases(clock: number): void {
    if (this.mutating('no-lease')) {
      return;
    }
    for (const [id, at] of [...this.leases]) {
      if (clock - at >= this.expire) {
        this.leases.delete(id);
        this.reader.holds.delete(id);
      }
    }
  }

  /**
   * §13.8's host-away clock: armed while the applied state's `host` entry labels a seat the
   * roster does not have, disarmed when it labels one the roster has. `restart` is what a new
   * state does to a clock that is already running.
   */
  private refreshHostAway(clock: number, restart: boolean): void {
    // §13.4: a state that names no `host` entry leaves this client with no identified host
    // connection and it MUST NOT guess one, so there is nothing to arm a clock with.
    const seat = this.hostSeat();
    const absent = seat !== undefined && !this.roster.has(seat);
    if (!absent) {
      this.hostAwaySince = undefined;
    } else if (restart || this.hostAwaySince === undefined) {
      this.hostAwaySince = clock;
    }
  }

  /**
   * The seat the applied state's `host` entry labels, in the order §6.1 reads two `host` keys:
   * the one whose key comes first in UTF-16 code-unit order.
   */
  private hostSeat(): string | undefined {
    for (const entry of this.reader.entries()) {
      if (entry.role === 'host') {
        return entry.peerId;
      }
    }
    return undefined;
  }

  /**
   * The seat the applied state names as the room's host connection, or `undefined` while no
   * state does (§13.4: a client with none MUST NOT guess one).
   */
  namedHostSeat(): string | undefined {
    return this.hostSeat();
  }

  /**
   * §13.8's host-away clock: how long the room may still hold together with the host's own
   * connection gone, or `undefined` while that connection is present (or while no state names
   * one, in which case nothing is owed). A caller shows this and does not end anything with it;
   * the window's expiry ends the session, and that is this session's own decision.
   */
  hostAwayGraceMs(clock: number): number | undefined {
    if (this.hostAwaySince === undefined) {
      return undefined;
    }
    return Math.max(0, this.expire - (clock - this.hostAwaySince));
  }

  /**
   * §13.7: the roster is the authority on who is present, so a key whose entry labels a seat
   * that has left loses its holds at once rather than with its lease. A seat the roster never
   * knew is not this rule: it is left to its lease.
   */
  private dropDepartedHolds(): void {
    for (const entry of this.reader.committed.values()) {
      if (this.departed.has(entry.peerId)) {
        this.leases.delete(entry.id);
        this.reader.holds.delete(entry.id);
      }
    }
  }

  /** One more frame against the room's count, handed to the host's producer to persist. */
  private countFrame(): void {
    this.roomFrames += 1;
    this.host?.countFrames(this.roomFrames);
  }

  /**
   * `CANONICAL.md` §6.1's frame budget: once the room's count reaches it, nothing more is sealed
   * under the frame key. A host publishes its one closing first — the frame that ends the room for
   * every peer holding its state — and every session, the host's included, ends and says why.
   */
  private async budgetSpent(): Promise<boolean> {
    if (this.roomFrames < this.frameBudget) {
      return false;
    }
    const publication = await this.host?.closing();
    if (publication !== undefined) {
      this.countFrame();
      this.outbound.push(publication.frame);
      this.published += 1;
      this.publishedClosings.push(publication.issued);
    }
    // The session ends here, so the count is written now rather than on a tick that will not come.
    this.host?.saveFrames();
    this.ending = 'frame-budget';
    return true;
  }

  /** §13.3's no-state window and §13.8's host-away window, which run in sequence. */
  private windowPassed(clock: number): boolean {
    if (
      this.hostAwaySince !== undefined &&
      clock - this.hostAwaySince >= this.expire
    ) {
      this.ending = 'host-away';
      return true;
    }
    if (
      !this.stateHeld() &&
      !this.mutating('wait-for-ever') &&
      clock >= this.expire
    ) {
      this.ending = 'no-state';
      return true;
    }
    return false;
  }

  /**
   * §13.1's step 6's handshake, run when this connection's own key *becomes* committed and not
   * for every state that commits it: a host republishes its state on every `peer.joined` and on
   * every announcement it accepts, so a handshake per state would be a frame per republish.
   */
  private async handshakeOnce(clock: number): Promise<void> {
    if (this.handshakenAt === undefined) {
      await this.syncStep1(clock);
    }
  }

  /**
   * §13.1's step 6: a `SyncStep1` with this replica's state vector, so the room can tell a
   * client that has been refusing frames from one that has been applying them.
   */
  private async syncStep1(clock: number): Promise<void> {
    await this.publish('sync', encodeSyncStep1(this.doc));
    this.handshakenAt = clock;
  }

  /**
   * §13.6: a client that refused a content frame re-syncs, and no more than once per renewal
   * interval however many it refused — the lower bound is what keeps a peer that floods refused
   * frames from being answered frame for frame.
   */
  private async resync(clock: number): Promise<void> {
    if (this.resyncFrom === undefined || !this.mayPublish()) {
      return;
    }
    const due =
      this.handshakenAt === undefined || clock - this.handshakenAt >= this.renew;
    if (due) {
      this.resyncFrom = undefined;
      await this.syncStep1(clock);
    }
  }

  /**
   * One frame sealed under the frame key and signed by this connection's session key.
   *
   * A session that has ended publishes nothing, whatever handed it something to answer: §13.6's
   * reply to a content frame and §7.1's re-send below are both frames out of a room that is over.
   * This is the one place every authored frame passes through; {@link mayPublish} is the caller's
   * own check of the same rule.
   */
  private async publish(what: Publication, plaintext: Uint8Array): Promise<void> {
    if (this.ending !== undefined || this.roomFrames >= this.frameBudget) {
      return;
    }
    this.counter += 1;
    const bytes = await this.sealedFrame(KIND_OF[what], plaintext);
    if (bytes === undefined) {
      // A CSPRNG that will not read, or an AEAD that refuses its own inputs. Neither happens
      // in practice, and a session that kept quiet about one would look like a client with
      // nothing to say.
      this.fault = `a ${what} frame could not be sealed`;
      return;
    }
    this.countFrame();
    this.outbound.push(bytes);
    if (what === 'sync') {
      this.handshake += 1;
    } else {
      this.published += 1;
    }
  }

  /** One frame's bytes, sealed under the frame key and signed by the session key. */
  private async sealedFrame(
    kind: number,
    plaintext: Uint8Array,
  ): Promise<Uint8Array | undefined> {
    let nonce: Uint8Array;
    try {
      nonce = this.crypto.randomBytes(12);
    } catch {
      return undefined;
    }
    return await seal(
      this.crypto,
      {
        roomId: this.roomId,
        frameKey: this.frameKey,
        kind,
        epoch: 0,
        counter: this.counter,
        nonce,
        signer: this.session,
      },
      plaintext,
    );
  }

  /** The canonical spelling of a key id where an applied state names one, and its id otherwise. */
  private spelling(id: string): string | undefined {
    return this.reader.spellingOf(id);
  }
}

const encoder = new TextEncoder();

function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}
