/**
 * `selvage/2`'s host: the producer half of `PROTOCOL.md` §7.1.
 *
 * A host is a peer with one extra key and one statement to publish. The key is the host key of
 * the invite's fragment, whose private half only the host holds; the statement is the **room
 * state** (`kind = 1`) — the room's listing, the roles the host assigns and the state's own
 * `issued` edition — sealed under the frame key and signed by the host key. Nothing else in
 * this version carries a listing or a role, so a joiner that has no state holds no key and may
 * publish nothing at all (§13.1).
 *
 * This module decides **when** a state goes out and **what it carries**: §7.1's obligations
 * (at mint, on a change to the listing or to `peers`, on every `peer.joined` and `peer.left`,
 * on every announcement accepted), the publish-rate bound that keeps a peer minting keys
 * without bound from obliging a state a frame, and the two values a host that means to keep
 * hosting after a reload must keep (the host key, and its `issued` beside it).
 *
 * It holds no socket, no clock and no editor: `clock` is the caller's monotone elapsed time
 * since the seat (§13.8), exactly as it is for `PeerSession`, and the listing comes from a
 * caller that knows the host's working tree.
 */

import type { FrameCrypto } from './crypto.ts';
import {
  bytesEqual,
  canonicalJson,
  encodeKey,
  mintSessionKey,
  seal,
  usablePath,
} from './sealed.ts';
import type { PeerEntry, RoomState, SessionKeypair } from './sealed.ts';

/** The three roles a state may assign (`CANONICAL.md` §6.1); `host` is the host's own entry. */
export type HostRole = 'host' | 'guest' | 'viewer';

/**
 * The host rules a subject may remove, one each, for a mutation census (`PROTOCOL.md` §13.11):
 * each names a rule this producer's clean behaviour rests on, so that a test can show it fails
 * without it rather than only that it holds with it.
 */
export const HOST_MUTATIONS = [
  'withhold-commitment',
  'duplicate-seat',
  'no-role-stickiness',
  'keep-departed-seat',
  'no-roster-publish',
  'no-listing-publish',
  'frozen-issued',
  'no-answer',
] as const;

export type HostMutation = (typeof HOST_MUTATIONS)[number];

/** §13.3's second bound: what this host will enumerate. */
export const MAX_LISTING_PATHS = 100_000;
/** §13.3's third bound: the path bytes one listing may carry. */
export const MAX_LISTING_BYTES = 4 * 1024 * 1024;

/**
 * `CANONICAL.md` §6.1's frame budget: half of SP 800-38D's 2³² bound on one key with random
 * nonces, which is the room's and not one sender's, so that a client that missed frames the relay
 * dropped still stops well short of it.
 */
export const FRAME_BUDGET = 2 ** 31;

/**
 * `CANONICAL.md` §6.1's absence charge: what every return of the host — a reconnect or a reload —
 * costs its count, a fixed ceiling on the frames one absence can hide. 1024 returns spend the
 * budget on charges alone.
 */
export const ABSENCE_CHARGE = 2 ** 21;

/**
 * What §7.1 has a host keep together: the host key, its `issued` beside it, and the room's frame
 * count (`CANONICAL.md` §6.1).
 */
export interface PersistedHost {
  /** The host key's 32-byte seed — the private half of the `h` the fragment carries. */
  readonly hostSeed: Uint8Array;
  /** The highest `issued` this host has published. */
  readonly issued: number;
  /**
   * The room's frame count as this host has kept it since the mint (`CANONICAL.md` §6.1's frame
   * budget). Optional so that a value saved before the count existed still loads, as `0`.
   */
  readonly frames?: number;
}

/**
 * Where a host keeps what makes it the host after a reload (§7.1, §9.1).
 *
 * The engine has no filesystem and this is the seam: an adapter hands one in, and a session
 * without one is a host that cannot outlive its process, which §7.1 permits and §9.1 prices —
 * a host whose key is gone can be seated in its room and can never publish a state a peer
 * accepts again.
 *
 * `load` is called once, when the session is built; `save` once per state the host publishes.
 * Each half is checked where it is read rather than trusted: a seed that is not the one this
 * host signs with starts the series at `1` instead of continuing another host's.
 */
export interface HostStore {
  load(): PersistedHost | undefined;
  save(persisted: PersistedHost): void;
}

/** What a host is given: the key it signs states with, and where its listing comes from. */
export interface HostOptions {
  /** The host key's 32-byte seed, minted where the invite is minted (§5.1). */
  hostSeed: Uint8Array;
  /** The room's working tree as this host enumerates it: names, and no content (§7.1). */
  listing(): readonly string[];
  /** Where the host key and its `issued` are kept; omitted is an in-memory host. */
  store?: HostStore;
}

/** One key this host has committed, and the seat label and role it committed it under. */
interface SeatEntry {
  readonly spelling: string;
  readonly seat: string;
  role: HostRole;
  /** Where this commitment sits in the host's order, so a replacement has a rule (§7.1). */
  readonly order: number;
}

/** What asked for a state. Only `announcement` is measured by §7.1's publish-rate bound. */
export type HostReason = 'mint' | 'roster' | 'listing' | 'announcement';

/** One state (or closing) this host published. */
export interface HostPublication {
  /** The frame's bytes, exactly as the relay carries them. */
  readonly frame: Uint8Array;
  /** The edition the frame carries. */
  readonly issued: number;
  /**
   * Whether the frame carries a new edition or re-sends the state this host holds.
   *
   * §7.1: an announcement whose key the state already commits publishes nothing new, so what
   * answers it is the state its sender has not applied, re-sent unchanged.
   */
  readonly fresh: boolean;
  /** The state's own value, for a `kind = 1` publication; absent for a closing. */
  readonly state?: RoomState;
}

/**
 * One host's producer: the room's seats, the room's listing, and the `issued` series.
 *
 * A session drives it from four places — its own seat, the roster's changes, its listing's
 * changes and the announcements its receiver accepts — and takes the frame it owes from
 * {@link publish} and {@link closing}.
 */
export class HostProducer {
  /** The public half of the host key, which the invite's `h` carries. */
  readonly hostPublic: Uint8Array;

  private readonly crypto: FrameCrypto;
  private readonly roomId: string;
  private readonly frameKey: Uint8Array;
  private readonly host: SessionKeypair;
  private readonly listing: () => readonly string[];
  private readonly store: HostStore | undefined;
  private readonly renew: number;

  /** The seats the roster has, in the order the relay showed them. */
  private readonly roster: string[] = [];
  /** The keys this host has committed, by the key's canonical spelling. */
  private readonly seats = new Map<string, SeatEntry>();

  private ownSeat: string | undefined;
  private ownKey: Uint8Array | undefined;

  /** The highest `issued` this host has published. */
  private issued = 0;
  /** `CANONICAL.md` §6.1: the room's frame count, which the host's session keeps from the mint. */
  private frames = 0;
  /** The count the store last holds, and the clock it was written at. */
  private savedFrames = 0;
  private savedAt: number | undefined;
  /** The highest `issued` a state this host verified carried (§7.1). */
  private verified = 0;
  private hostCounter = 0;
  private order = 0;
  /** The clock of the last state this host published: §7.1's publish-rate window. */
  private windowFrom: number | undefined;
  /** An announcement this host accepted is owed a state (§7.1). */
  private owed = false;
  /** The last state published and its frame, so §7.1's answer can re-send it unchanged. */
  private lastState: RoomState | undefined;
  private lastFrame: Uint8Array | undefined;
  /** §13.8's clock read as §7.1 writes it: a host that has left publishes nothing. */
  private gone = false;
  /** §7.1's closing has gone out: the room is over and this host publishes nothing more. */
  private closed = false;
  /** The first state this host could not seal, which its session reports as a fault. */
  private faulted: string | undefined;
  private mutation: HostMutation | undefined;

  private constructor(
    crypto: FrameCrypto,
    roomId: string,
    frameKey: Uint8Array,
    renew: number,
    host: SessionKeypair,
    options: HostOptions,
  ) {
    this.crypto = crypto;
    this.roomId = roomId;
    this.frameKey = frameKey;
    this.renew = renew;
    this.host = host;
    this.hostPublic = host.public;
    this.listing = options.listing;
    this.store = options.store;
  }

  /**
   * The host key's keypair, from the seed the invite was minted with, and the `issued` series
   * a previous session of this host left behind (§7.1).
   */
  static async create(
    crypto: FrameCrypto,
    roomId: string,
    frameKey: Uint8Array,
    renew: number,
    options: HostOptions,
  ): Promise<HostProducer | undefined> {
    const host = await mintSessionKey(crypto, options.hostSeed);
    if (host === undefined) {
      return undefined;
    }
    const producer = new HostProducer(crypto, roomId, frameKey, renew, host, options);
    const persisted = options.store?.load();
    if (
      persisted !== undefined &&
      persisted.hostSeed.length === 32 &&
      bytesEqual(persisted.hostSeed, host.seed)
    ) {
      if (Number.isSafeInteger(persisted.issued) && persisted.issued > 0) {
        producer.issued = persisted.issued;
      }
      // `CANONICAL.md` §6.1: a reload is a return, so it costs the absence charge; a record with no
      // count cannot say what the room has sealed, so it reads as a spent budget and the room
      // closes at the first tick.
      const frames = persisted.frames;
      const known = frames !== undefined && Number.isSafeInteger(frames) && frames >= 0;
      producer.frames = known ? frames + ABSENCE_CHARGE : FRAME_BUDGET;
      producer.savedFrames = known ? frames : -1;
    }
    return producer;
  }

  /** Whether this host has a seat and a connection key to publish an entry for. */
  ready(): boolean {
    return !this.gone && !this.closed && this.ownSeat !== undefined && this.ownKey !== undefined;
  }

  /** The first state this host could not seal, if any. */
  get failure(): string | undefined {
    return this.faulted;
  }

  /** The highest `issued` this host has published. */
  get publishedIssued(): number {
    return this.issued;
  }

  /** The room's frame count this host continues from: `0` at a mint, the stored one on a reload. */
  get roomFrames(): number {
    return this.frames;
  }

  /** The session's count as it moves, kept here so every save writes it beside `issued`. */
  countFrames(count: number): void {
    this.frames = count;
  }

  /**
   * Writes the count now, whatever the window: a session that is ending has no later tick to
   * leave it to, and a reload must continue from the frame that ended it.
   */
  saveFrames(): void {
    if (this.frames !== this.savedFrames) {
      this.save(this.savedAt);
    }
  }

  /**
   * `CANONICAL.md` §6.1: the count is written at least once every `awareness_renew_ms` while it
   * moves, so a host that dies loses at most one renewal interval of it.
   */
  flushFrames(clock: number): void {
    if (this.frames === this.savedFrames) {
      return;
    }
    if (this.savedAt !== undefined && clock - this.savedAt < this.renew) {
      return;
    }
    this.save(clock);
  }

  /** §7.1's own entry: exactly one key has role `host` and it is this connection's. */
  seated(seat: string, sessionKey: Uint8Array): void {
    if (seat === '') {
      return;
    }
    this.ownSeat = seat;
    this.ownKey = sessionKey;
    this.addSeat(seat);
  }

  private addSeat(seat: string): void {
    if (!this.roster.includes(seat)) {
      this.roster.push(seat);
    }
  }

  /** A `peer.joined`: the roster gains a seat, and §7.1 obliges a state. */
  seatJoined(seat: string): void {
    if (seat === this.ownSeat) {
      this.gone = false;
    }
    this.addSeat(seat);
  }

  /**
   * A `peer.left`: the roster loses a seat and every key its label named goes with it (§7.1).
   *
   * A host that has left publishes nothing, so losing its own seat stops it rather than
   * emptying its own entry out of one more state.
   */
  seatLeft(seat: string): void {
    if (seat === this.ownSeat) {
      this.gone = true;
    }
    const at = this.roster.indexOf(seat);
    if (at !== -1) {
      this.roster.splice(at, 1);
    }
    if (this.mutating('keep-departed-seat')) {
      return;
    }
    for (const [spelling, entry] of this.seats) {
      if (entry.seat === seat) {
        this.seats.delete(spelling);
      }
    }
  }

  /**
   * §7.1: commit every announcement accepted, with the seat label this host believes, and
   * never withhold a commitment for want of a label.
   *
   * A declaration of `guest` or `viewer` is honoured when the key is first committed — it is
   * the one statement about a peer's role that comes from that peer's own key — and a
   * declaration changes nothing for a key the state already commits.
   */
  announcement(key: Uint8Array, declared: 'guest' | 'viewer' | undefined): void {
    const spelling = encodeKey(key);
    const known = this.seats.has(spelling);
    if (known) {
      if (this.mutating('no-role-stickiness') && declared !== undefined) {
        const entry = this.seats.get(spelling);
        if (entry !== undefined) {
          entry.role = declared;
        }
      } else if (this.mutating('no-answer')) {
        // §7.1's answer, removed: the announcer that has not applied the state that commits
        // its key is owed nothing, and a peer whose announcement was dropped stays unable to
        // publish for the rest of the session.
        return;
      }
      this.owed = true;
      return;
    }
    if (!this.mutating('withhold-commitment')) {
      this.commit(spelling, declared);
    }
    this.owed = true;
  }

  /** A state this host verified, whose edition its own series must stay above (§7.1). */
  verifiedState(issued: number): void {
    if (Number.isSafeInteger(issued) && issued > this.verified) {
      this.verified = issued;
    }
  }

  /**
   * The state frame this host owes at `clock`, or `undefined` when it owes none.
   *
   * `'mint'`, `'roster'` and `'listing'` are the obligations §7.1's rate bound does not touch:
   * the roster is the server's word and bounded by it, and the listing is the host's own.
   * `'announcement'` is the one the bound is about, and it takes the promise §7.1 leaves a host:
   * a later announcement is answered **at once** where no state has gone out for one in the
   * current window, and folded into the end of that window where one has — so a peer that mints
   * keys without bound obliges at most one state a window, and a joiner is not left unable to
   * publish for a window it has no reason to wait for.
   */
  async publish(clock: number, reason: HostReason): Promise<HostPublication | undefined> {
    if (!this.ready()) {
      return undefined;
    }
    if (reason === 'roster' && this.mutating('no-roster-publish')) {
      return undefined;
    }
    if (reason === 'listing' && this.mutating('no-listing-publish')) {
      return undefined;
    }
    if (reason === 'announcement' && (!this.owed || !this.windowOpen(clock))) {
      return undefined;
    }
    this.owed = false;
    const listing = this.roomListing();
    const peers = this.peerEntries();
    const held = this.lastState;
    if (
      held !== undefined &&
      this.lastFrame !== undefined &&
      // §7.1: a state this host verified above its own is one its peers hold, so re-sending the
      // edition it published itself would be a frame they all refuse `stale_issued` — and the
      // fresh state it would otherwise publish above that edition is what a joiner needs.
      held.issued >= this.verified &&
      !this.mutating('frozen-issued') &&
      samePaths(held.listing, listing) &&
      samePeers(held.peers, peers)
    ) {
      this.window(clock, reason);
      return { frame: this.lastFrame, issued: held.issued, fresh: false, state: held };
    }
    const issued = this.nextIssued();
    const members: Record<string, unknown> = {
      issued,
      listing,
      peers: Object.fromEntries(peers),
    };
    const frame = await this.seal(1, canonicalJson(members));
    if (frame === undefined) {
      return undefined;
    }
    this.commitSeries(issued, clock);
    const state: RoomState = { issued, listing, peers };
    this.lastState = state;
    this.lastFrame = frame;
    this.window(clock, reason);
    return { frame, issued, fresh: true, state };
  }

  /** §7.1's rate bound is the announcements' own: only an answer opens a window. */
  private window(clock: number, reason: HostReason): void {
    if (reason === 'announcement') {
      this.windowFrom = clock;
    }
  }

  /**
   * §7.1's closing: the host's statement that the room is over, at an `issued` above every
   * state it has published. Only the host key signs one, and a receiver applies one only when
   * it already holds a verified state below it (§13.10).
   */
  async closing(): Promise<HostPublication | undefined> {
    if (!this.ready()) {
      return undefined;
    }
    const issued = this.nextIssued();
    const frame = await this.seal(2, canonicalJson({ closing: true, issued }));
    if (frame === undefined) {
      return undefined;
    }
    this.commitSeries(issued);
    this.closed = true;
    return { frame, issued, fresh: true };
  }

  /** Removes one of the host rules a corpus mutation names. */
  mutate(name: string): void {
    if (!(HOST_MUTATIONS as readonly string[]).includes(name)) {
      throw new Error(`no host rule is named ${JSON.stringify(name)}`);
    }
    this.mutation = name as HostMutation;
  }

  // --- the rules, one method each ------------------------------------------------

  private mutating(name: HostMutation): boolean {
    return this.mutation === name;
  }

  /** §7.1: `issued` above every state published, and above one it has verified. */
  private nextIssued(): number {
    if (this.mutating('frozen-issued')) {
      return this.issued === 0 ? 1 : this.issued;
    }
    return Math.max(this.issued, this.verified) + 1;
  }

  /**
   * `clock` is the publication's own, and a save records it: the renewal-window batching in
   * {@link flushFrames} measures from the last write of any kind. A closing has no clock of its
   * own and keeps the last one, which is harmless because nothing is published after it.
   */
  private commitSeries(issued: number, clock?: number): void {
    this.issued = issued;
    this.save(clock ?? this.savedAt);
  }

  private save(clock: number | undefined): void {
    if (this.store === undefined) {
      return;
    }
    this.store.save({ hostSeed: this.host.seed, issued: this.issued, frames: this.frames });
    this.savedFrames = this.frames;
    this.savedAt = clock;
  }

  /** §7.1's rate bound: the window the last published state opened. */
  private windowOpen(clock: number): boolean {
    return this.windowFrom === undefined || clock - this.windowFrom >= this.renew;
  }

  private commit(spelling: string, declared: 'guest' | 'viewer' | undefined): void {
    const seat = this.label();
    if (seat === undefined) {
      return;
    }
    // §7.1's *at most one key per seat* is about the seats the roster has. The host's own seat
    // is the last resort of the label above, not one a second key can take over: evicting the
    // key already there would drop a commitment §7.1 obliges, in exchange for nothing.
    if (!this.mutating('duplicate-seat') && seat !== this.ownSeat) {
      for (const [other, entry] of this.seats) {
        if (entry.seat === seat) {
          this.seats.delete(other);
        }
      }
    }
    this.seats.set(spelling, {
      spelling,
      seat,
      role: declared ?? 'guest',
      order: this.order,
    });
    this.order += 1;
  }

  /**
   * The seat §7.1 has this host label a newly committed key with: the announcer's own seat
   * where it can tell which seat that is, and otherwise any seat the roster names that carries
   * no key yet.
   *
   * Nothing on the wire ties a key to a seat — an announcement names no peer and the relay
   * says nothing about which connection sent one (§13.4) — so a host can tell in no case this
   * engine can see, and the label is the belief §7.1 calls it rather than a fact.
   *
   * A roster whose every seat already carries a key is §7.1's *commit every announcement* and
   * its *at most one key per seat* meeting, and that section does not say which seat gives way.
   * This host replaces the key it has held longest, which is the one most likely to belong to a
   * connection the roster no longer has. A key that arrives before its seat does — an
   * announcement whose `peer.joined` the host has not been given yet — leaves no other seat to
   * replace, and the label is then the host's own, which §7.1 permits by name (*its own
   * included*) and which it obliges over withholding the commitment. That is the one case where
   * two keys carry one seat, and §7.1's *at most one key per seat*, with §13.3's derivation from
   * it, does not allow for it: the commitment is what a peer cannot do without, so the label is
   * the half that gives way — and with the label gone as a rule, `commit` evicts nothing, so no
   * commitment is dropped either.
   */
  private label(): string | undefined {
    if (this.ownSeat === undefined) {
      return undefined;
    }
    const taken = new Set<string>([this.ownSeat]);
    for (const entry of this.seats.values()) {
      if (this.roster.includes(entry.seat)) {
        taken.add(entry.seat);
      }
    }
    for (const seat of this.roster) {
      if (!taken.has(seat)) {
        return seat;
      }
    }
    let oldest: SeatEntry | undefined;
    for (const entry of this.seats.values()) {
      if (entry.seat === this.ownSeat || !this.roster.includes(entry.seat)) {
        continue;
      }
      if (oldest === undefined || entry.order < oldest.order) {
        oldest = entry;
      }
    }
    return oldest === undefined ? this.ownSeat : oldest.seat;
  }

  /**
   * `peers` as §7.1 writes it: the keys of the seats the roster has, ascending by the key's
   * canonical spelling, and the host's own connection's key as the one `host` entry.
   */
  private peerEntries(): Map<string, PeerEntry> {
    const entries: SeatEntry[] = [];
    for (const entry of this.seats.values()) {
      if (!this.mutating('keep-departed-seat') && !this.roster.includes(entry.seat)) {
        continue;
      }
      entries.push(entry);
    }
    entries.sort((left, right) =>
      left.spelling < right.spelling ? -1 : left.spelling > right.spelling ? 1 : 0,
    );
    const peers = new Map<string, PeerEntry>();
    for (const entry of entries) {
      peers.set(entry.spelling, { peer_id: entry.seat, role: entry.role });
    }
    if (this.ownSeat !== undefined && this.ownKey !== undefined) {
      peers.set(encodeKey(this.ownKey), { peer_id: this.ownSeat, role: 'host' });
    }
    return peers;
  }

  /**
   * The room's listing: §5's rule applied, ascending by UTF-16 code unit (§2.7), and bounded,
   * because a listing is one sealed frame and one that does not fit never arrives at all
   * (§13.3).
   */
  private roomListing(): string[] {
    const paths: string[] = [];
    const seen = new Set<string>();
    let bytes = 0;
    for (const path of this.listing()) {
      if (!usablePath(path) || seen.has(path)) {
        continue;
      }
      const size = new TextEncoder().encode(path).length;
      if (paths.length >= MAX_LISTING_PATHS || bytes + size > MAX_LISTING_BYTES) {
        break;
      }
      seen.add(path);
      paths.push(path);
      bytes += size;
    }
    return paths.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  }

  /**
   * One frame, signed by the host key, at this host's own counter under it.
   *
   * `undefined` here is a fault and not a decision — a CSPRNG that will not read, or an AEAD
   * that refuses its own inputs — so it is kept where the session can report it: a host that
   * said nothing would look like one with nothing to publish.
   */
  private async seal(kind: number, plaintext: Uint8Array): Promise<Uint8Array | undefined> {
    let nonce: Uint8Array;
    try {
      nonce = this.crypto.randomBytes(12);
    } catch {
      this.faulted ??= `a ${kind === 2 ? 'closing' : 'state'} frame could not be sealed`;
      return undefined;
    }
    this.hostCounter += 1;
    const bytes = await seal(
      this.crypto,
      {
        roomId: this.roomId,
        frameKey: this.frameKey,
        kind,
        epoch: 0,
        counter: this.hostCounter,
        nonce,
        signer: this.host,
      },
      plaintext,
    );
    if (bytes === undefined) {
      this.hostCounter -= 1;
      this.faulted ??= `a ${kind === 2 ? 'closing' : 'state'} frame could not be sealed`;
    }
    return bytes;
  }
}

/** Whether two listings are the same sequence, which decides §7.1's re-send. */
function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, at) => path === right[at]);
}

/** Whether two `peers` maps say the same thing, key for key and member for member. */
function samePeers(
  left: ReadonlyMap<string, PeerEntry>,
  right: ReadonlyMap<string, PeerEntry>,
): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [spelling, entry] of left) {
    const other = right.get(spelling);
    if (other === undefined || other.role !== entry.role || other.peer_id !== entry.peer_id) {
      return false;
    }
  }
    return true;
}
