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
import type { DropReason, SessionKeypair, Verdict } from './sealed.ts';
import { applyFrame, encodeSyncStep1, encodeUpdate } from './sync.ts';
import { percentDecode } from './urls.ts';

/**
 * The transaction origins this session's own changes and a peer's carry, so that a listener can
 * tell them apart: the edits this connection makes are the ones it may publish, and content
 * applied from another peer is not.
 */
const LOCAL_ORIGIN = Symbol('selvage/local');
const APPLIED_ORIGIN = Symbol('selvage/applied');

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

/** The three endings a session reaches on its own (§13.10). */
export type Ending = 'closing' | 'host-away' | 'no-state';

/** The words a client says when it ends a session, which §13.10 requires it to say. */
export function endingReason(ending: Ending): string {
  switch (ending) {
    case 'closing':
      return 'the room closed';
    case 'host-away':
      return 'the host has been away past its window';
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
  private readonly session: SessionKeypair;
  private readonly declaredRole: 'guest' | 'viewer' | undefined;
  private readonly renew: number;
  private readonly expire: number;
  private readonly seat: string | undefined;
  private readonly roster: Set<string>;
  private readonly reader: Reader;
  private readonly doc: Y.Doc;
  private readonly awareness: Awareness;
  private readonly outbound: Uint8Array[] = [];
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
  private readonly applied: AppliedFrame[] = [];
  private readonly dropped: DroppedFrame[] = [];
  private readonly ignored: number[] = [];
  private ending: Ending | undefined;
  private mutation: PeerMutation | undefined;
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
  ) {
    this.roomId = options.roomId;
    this.crypto = options.crypto;
    this.frameKey = frameKeyBytes;
    this.session = session;
    this.declaredRole = options.declaredRole;
    this.renew = options.keepalive.awareness_renew_ms;
    this.expire = options.keepalive.awareness_expire_ms;
    this.seat = options.seat;
    this.roster = new Set(options.roster ?? []);
    this.reader = reader;
    // §7's document: one `Y.Doc`, one `Y.Text` per path.
    this.doc = new Y.Doc();
    this.awareness = new Awareness(this.doc);
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
    return new PeerSession(options, reader.frameKey, session, reader);
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

  get mutationName(): PeerMutation | undefined {
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

  /** The text this replica holds at a path, which is what a decision vector reads. */
  text(path: string): string {
    return this.doc.getText(path).toString();
  }

  /** The length of a document's text in UTF-16 code units, the unit every editor counts in. */
  length(path: string): number {
    return this.doc.getText(path).length;
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

  // --- what the caller hands in -------------------------------------------------

  /** One sealed frame, as the relay delivered it. */
  deliver(clock: number, frame: Uint8Array): Promise<Outcome> {
    return this.serial(() => this.deliverOne(clock, frame));
  }

  private async deliverOne(clock: number, frame: Uint8Array): Promise<Outcome> {
    this.frames += 1;
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
    if (this.ignores(verdict)) {
      this.reader.issued = issued;
      this.reader.ended = ended;
      this.ignored.push(index);
      return { status: 'ignored', kind };
    }
    await this.fold(clock, verdict);
    this.applied.push({ frame: index, kind });
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

  private async tickOne(clock: number): Promise<void> {
    this.expireLeases(clock);
    this.refreshHostAway(clock, false);
    if (this.ending !== undefined) {
      return;
    }
    if (this.windowPassed(clock)) {
      return;
    }
    await this.reannounce(clock);
    await this.resync(clock);
    await this.announceHolds(clock);
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
   * §13.7 has a holder **re-announce when it sees a `peer.joined`**, so that a joiner learns the
   * holds without asking: the whole set is due again from that moment, and the next tick is what
   * sends it.
   */
  seatJoined(seat: string): void {
    this.departed.delete(seat);
    this.roster.add(seat);
    this.holdsAnnouncedAt = undefined;
  }

  /** A seat has left, from `peer.left`: §13.8's clock can arm on it and §13.7's holds go. */
  seatLeft(clock: number, seat: string): void {
    this.roster.delete(seat);
    this.departed.add(seat);
    this.dropDepartedHolds();
    this.refreshHostAway(clock, false);
  }

  /** Opens a path: this client offers it, and its whole held set changes (§13.7). */
  open(path: string): void {
    this.held.add(path);
  }

  /**
   * Releases every path. §13.7 asks for the empty set rather than for silence, so the room
   * learns in one hop instead of waiting out a lease.
   */
  release(): void {
    this.held.clear();
  }

  /**
   * A local edit, published as the delta it produced and never as the whole document.
   *
   * Returns whether anything went out: §13.5 and §13.9 have a `viewer` keep its edit and not
   * send it, and §13.1's step 4 has any peer keep it until a state commits its key.
   */
  insert(path: string, index: number, text: string): Promise<boolean> {
    return this.serial(() => this.insertOne(path, index, text));
  }

  private async insertOne(path: string, index: number, text: string): Promise<boolean> {
    // An index past the end of the text is the caller's bug, and `yjs` answers one by writing
    // at the end. A client any caller can silently mis-edit is not one a decision vector can
    // drive, so it is refused.
    if (index < 0 || index > this.length(path)) {
      throw new Error(`there is no offset ${index} in ${JSON.stringify(path)}`);
    }
    // The update this edit's own transaction produced, and not a diff over the document: a
    // state-vector diff carries the whole delete set — a peer's deletion of a peer's text
    // included — and that is a change this connection did not make and must not publish under
    // its own key. `LOCAL_ORIGIN` is what tells the two apart: peer content is applied under
    // `APPLIED_ORIGIN`.
    const captured: Uint8Array[] = [];
    const capture = (update: Uint8Array, origin: unknown): void => {
      if (origin === LOCAL_ORIGIN) {
        captured.push(update);
      }
    };
    const handle = this.doc.getText(path);
    this.doc.on('update', capture);
    try {
      this.doc.transact(() => handle.insert(index, text), LOCAL_ORIGIN);
    } finally {
      this.doc.off('update', capture);
    }
    if (captured.length === 0) {
      return false;
    }
    const update = Y.mergeUpdates(captured);
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
    } else if (!(PEER_MUTATIONS as readonly string[]).includes(name)) {
      throw new Error(`no mutation is named ${JSON.stringify(name)}`);
    }
    this.mutation = name as PeerMutation;
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
    this.dropped.push({ frame, reason: named });
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
    this.refreshHostAway(clock, true);
    this.dropDepartedHolds();
    // §13.1's steps 6 and 4: a state that commits this key is where the handshake belongs, and
    // one that does not is what a re-announcement is for — the renewal clock alone would wait a
    // whole window for it.
    if (this.commitsOurs()) {
      await this.handshakeOnce(clock);
      await this.flushHeldBackEdits();
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
    return this.stateHeld() && this.commitsOurs();
  }

  /** §13.1's step 4: the session-key announcement, `kind = 4`, signed by the key it names. */
  private async announce(clock: number): Promise<void> {
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

  /** One frame sealed under the frame key and signed by this connection's session key. */
  private async publish(what: Publication, plaintext: Uint8Array): Promise<void> {
    this.counter += 1;
    const bytes = await this.sealedFrame(KIND_OF[what], plaintext);
    if (bytes === undefined) {
      // A CSPRNG that will not read, or an AEAD that refuses its own inputs. Neither happens
      // in practice, and a session that kept quiet about one would look like a client with
      // nothing to say.
      this.fault = `a ${what} frame could not be sealed`;
      return;
    }
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
