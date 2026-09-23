/**
 * `selvage/2`'s sealed frame: the bytes, and the verdict a receiver reaches on them.
 *
 * `CANONICAL.md` §6.1 fixes the envelope, the key schedule, the associated data, the signature
 * input, the key id, the counter and the order a receiver reads the bytes in; this module is
 * that section. It seals and signs a frame, opens it again, and reads a frame the way §6.1
 * says — reporting the first of the ten steps that refuses it, in that order, because the
 * report is observable.
 *
 * The five kinds the version defines are `0` (a y-protocols stream), `1` (the room state), `2`
 * (the closing), `3` (the sender's holds) and `4` (the session-key announcement).
 * `PROTOCOL.md` §7.1 says what each carries.
 */

import * as decoding from 'lib0/decoding';

import type { FrameCrypto } from './crypto.ts';

/** The five kinds this version defines, in the order §6.1 gives them. */
export const KINDS: readonly number[] = [0, 1, 2, 3, 4];

/**
 * The ten reasons a receiver reports, in the order §6.1's table reads them. The order is
 * normative because the report is observable: the same bytes refused at two steps would be
 * two reports for one frame.
 */
export const DROP_REASONS = [
  'bad_envelope',
  'unknown_kind',
  'unknown_epoch',
  'uncommitted_key',
  'replayed_counter',
  'bad_signature',
  'bad_aead',
  'bad_payload',
  'stale_issued',
  'unauthorised_content',
] as const;

/** One of §6.1's ten reports. */
export type DropReason = (typeof DROP_REASONS)[number];

const utf8 = new TextEncoder();
/** `fatal`, because a payload that is not UTF-8 is not the object §6.1's step 8 reads. */
const text = new TextDecoder('utf-8', { fatal: true });

// --- bytes ----------------------------------------------------------------------

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) {
    length += part.length;
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

export function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

export function fromHex(digits: string): Uint8Array | undefined {
  const compact = digits.replace(/\s+/g, '');
  if (compact.length % 2 !== 0 || /[^0-9a-fA-F]/.test(compact)) {
    return undefined;
  }
  const out = new Uint8Array(compact.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

/**
 * `varUint` is LEB128 (`PROTOCOL.md` §7).
 *
 * A value that is not a non-negative safe integer has no encoding here and is refused rather
 * than truncated: a fractional value would silently become another number, and a negative one
 * would leave the loop below with no terminating byte to write. `seal` validates a frame's
 * fields before it reaches this, so a caller cannot hand it one across that boundary.
 */
export function varuint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`a varUint is a non-negative count, and this is ${value}`);
  }
  const out: number[] = [];
  let rest = value;
  for (;;) {
    const byte = rest % 128;
    const shifted = Math.floor(rest / 128);
    if (shifted === 0) {
      out.push(byte);
      return Uint8Array.from(out);
    }
    out.push(byte + 128);
    rest = shifted;
  }
}

/** A length in front of the bytes, as `PROTOCOL.md` §7 writes one. */
export function varuint8Array(raw: Uint8Array): Uint8Array {
  return concat(varuint(raw.length), raw);
}

/**
 * One `varUint`, and the offset after it; `undefined` when the bytes run out inside it.
 *
 * A value this reader cannot hold — the encoding runs past 2^53−1 — is refused here rather
 * than rounded: `CANONICAL.md` §2.4 gives every count that bound because a JavaScript receiver
 * would otherwise answer with a different number than the sender wrote.
 */
export function readVaruint(
  data: Uint8Array,
  at: number,
): [number, number] | undefined {
  let value = 0;
  let scale = 1;
  let cursor = at;
  for (;;) {
    if (cursor >= data.length) {
      return undefined;
    }
    const byte = data[cursor];
    cursor += 1;
    const part = (byte & 0x7f) * scale;
    if (!Number.isSafeInteger(part) || !Number.isSafeInteger(value + part)) {
      return undefined;
    }
    value += part;
    if ((byte & 0x80) === 0) {
      return [value, cursor];
    }
    scale *= 128;
    if (!Number.isSafeInteger(scale)) {
      return undefined;
    }
  }
}

// --- keys -----------------------------------------------------------------------

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** The sixteen final characters a 32-byte value can end on (§6.1). */
const FINAL = 'AEIMQUYcgkosw048';

/** A key's canonical base64url spelling, unpadded. */
export function encodeKey(raw: Uint8Array): string {
  let out = '';
  for (let at = 0; at < raw.length; at += 3) {
    const b0 = raw[at] ?? 0;
    const b1 = raw[at + 1] ?? 0;
    const b2 = raw[at + 2] ?? 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    for (const shift of [18, 12, 6, 0]) {
      out += ALPHABET[(triple >> shift) & 0x3f];
    }
  }
  return out.slice(0, Math.ceil((raw.length * 8) / 6));
}

function base64Value(byte: number): number | undefined {
  const at = ALPHABET.indexOf(String.fromCharCode(byte));
  return at === -1 ? undefined : at;
}

/**
 * The 32-byte value a canonical base64url spelling names, or `undefined`.
 *
 * §6.1 makes the encoding canonical: over 32 bytes it is 43 characters, the last of which
 * carries four bits of the value and two that are zero, so a spelling whose last character is
 * any other spells no 32-byte value and is refused rather than resolved to something a strict
 * decoder would not produce.
 */
export function decodeKey(spelling: string): Uint8Array | undefined {
  if (spelling.length !== 43 || !FINAL.includes(spelling[42] ?? '')) {
    return undefined;
  }
  const out = new Uint8Array(32);
  let written = 0;
  let acc = 0;
  let bits = 0;
  for (const character of spelling) {
    const value = base64Value(character.charCodeAt(0));
    if (value === undefined) {
      return undefined;
    }
    acc = ((acc << 6) | value) & 0xffffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written] = (acc >>> bits) & 0xff;
      written += 1;
    }
  }
  return written === 32 ? out : undefined;
}

/** The key id: the first **8 bytes of the SHA-256** of a public key's 32 bytes (§6.1). */
export async function keyId(
  crypto: FrameCrypto,
  publicKey: Uint8Array,
): Promise<Uint8Array> {
  return (await crypto.sha256(publicKey)).slice(0, 8);
}

// --- the key schedule -----------------------------------------------------------

/**
 * `frame_key = HKDF-SHA256(ikm = room key, salt = the room id in UTF-8, info = "selvage/2
 * frame", L = 32)` (§6.1). Derived once per room and never on the wire.
 */
export function frameKey(
  crypto: FrameCrypto,
  roomId: string,
  roomKey: Uint8Array,
): Promise<Uint8Array | undefined> {
  return crypto.hkdfSha256(roomKey, utf8.encode(roomId), FRAME_INFO, 32);
}

const FRAME_INFO = utf8.encode('selvage/2 frame');
const VERSION = utf8.encode('selvage/2');

/** A connection's session keypair: Ed25519, minted per connection and never persisted. */
export interface SessionKeypair {
  readonly seed: Uint8Array;
  readonly public: Uint8Array;
}

/**
 * A session keypair, from a fresh seed or from the one a caller fixes.
 *
 * `PROTOCOL.md` §13.1 mints this in memory for the connection and never persists it. A caller
 * may fix the seed, which is the corpus's one test seam: a decision vector's state commits a
 * *fixture* keypair, and nothing on a wire lets a host choose a peer's key.
 */
export async function mintSessionKey(
  crypto: FrameCrypto,
  seed?: Uint8Array,
): Promise<SessionKeypair | undefined> {
  const raw = seed ?? crypto.randomBytes(32);
  if (raw.length !== 32) {
    return undefined;
  }
  const publicKey = await crypto.ed25519PublicFromSeed(raw);
  if (publicKey === undefined || publicKey.length !== 32) {
    return undefined;
  }
  return { seed: raw, public: publicKey };
}

// --- the envelope ---------------------------------------------------------------

/** One `selvage/2` binary frame, as §6.1's table writes its fields. */
export interface Envelope {
  keyId: Uint8Array;
  kind: number;
  epoch: number;
  counter: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  signature: Uint8Array;
}

/** The frame's bytes: three fixed-width fields, three `varUint`s, the ciphertext length-prefixed. */
export function encodeEnvelope(envelope: Envelope): Uint8Array {
  return concat(
    envelope.keyId,
    varuint(envelope.kind),
    varuint(envelope.epoch),
    varuint(envelope.counter),
    envelope.nonce,
    varuint8Array(envelope.ciphertext),
    envelope.signature,
  );
}

/** Reads one envelope's layout, or `undefined` when the bytes are not one (§6.1's step 1). */
export function parseEnvelope(raw: Uint8Array): Envelope | undefined {
  if (raw.length < 8) {
    return undefined;
  }
  const keyIdBytes = raw.slice(0, 8);
  let at = 8;
  const kind = readVaruint(raw, at);
  if (kind === undefined) {
    return undefined;
  }
  at = kind[1];
  const epoch = readVaruint(raw, at);
  if (epoch === undefined) {
    return undefined;
  }
  at = epoch[1];
  const counter = readVaruint(raw, at);
  if (counter === undefined) {
    return undefined;
  }
  at = counter[1];
  const nonce = raw.slice(at, at + 12);
  if (nonce.length !== 12) {
    return undefined;
  }
  at += 12;
  const size = readVaruint(raw, at);
  if (size === undefined) {
    return undefined;
  }
  at = size[1];
  const end = at + size[0];
  if (end > raw.length || raw.length - end !== 64) {
    return undefined;
  }
  return {
    keyId: keyIdBytes,
    kind: kind[0],
    epoch: epoch[0],
    counter: counter[0],
    nonce,
    ciphertext: raw.slice(at, end),
    signature: raw.slice(end),
  };
}

/**
 * `aad = varUint8Array("selvage/2") ‖ varUint8Array(room id) ‖ varUint(kind) ‖ varUint(epoch)
 * ‖ varUint8Array(key_id)`. Each byte string is length-prefixed, so no two different inputs
 * write the same bytes.
 */
export function associatedData(
  roomId: string,
  kind: number,
  epoch: number,
  keyIdBytes: Uint8Array,
): Uint8Array {
  return concat(
    varuint8Array(VERSION),
    varuint8Array(utf8.encode(roomId)),
    varuint(kind),
    varuint(epoch),
    varuint8Array(keyIdBytes),
  );
}

/**
 * `signed = aad ‖ varUint(counter) ‖ varUint8Array(nonce) ‖ varUint8Array(ciphertext)`, which
 * is what the Ed25519 signature covers.
 */
export function signingInput(aad: Uint8Array, envelope: Envelope): Uint8Array {
  return concat(
    aad,
    varuint(envelope.counter),
    varuint8Array(envelope.nonce),
    varuint8Array(envelope.ciphertext),
  );
}

/** What a producer seals: the frame's kind, counter and nonce, the room, and the signer. */
export interface SealRecipe {
  roomId: string;
  frameKey: Uint8Array;
  kind: number;
  epoch: number;
  counter: number;
  nonce: Uint8Array;
  signer: SessionKeypair;
}

/**
 * Seal and sign one frame: the bytes a `selvage/2` client hands the relay.
 *
 * A recipe whose fields are not what §6.1's table writes is refused instead of sealed: a
 * counter that is not a count, a nonce that is not twelve bytes, a key that is not thirty-two.
 * `undefined` is what a caller reports, which is how a session says it could not publish rather
 * than handing the relay bytes no peer would read.
 */
export async function seal(
  crypto: FrameCrypto,
  recipe: SealRecipe,
  plaintext: Uint8Array,
): Promise<Uint8Array | undefined> {
  const counts = [recipe.kind, recipe.epoch, recipe.counter];
  if (
    counts.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    recipe.nonce.length !== 12 ||
    recipe.frameKey.length !== 32 ||
    recipe.signer.seed.length !== 32 ||
    recipe.signer.public.length !== 32
  ) {
    return undefined;
  }
  const id = await keyId(crypto, recipe.signer.public);
  const aad = associatedData(recipe.roomId, recipe.kind, recipe.epoch, id);
  const ciphertext = await crypto.aesGcmSeal(
    recipe.frameKey,
    recipe.nonce,
    plaintext,
    aad,
  );
  if (ciphertext === undefined) {
    return undefined;
  }
  const unsigned: Envelope = {
    keyId: id,
    kind: recipe.kind,
    epoch: recipe.epoch,
    counter: recipe.counter,
    nonce: recipe.nonce,
    ciphertext,
    signature: new Uint8Array(64),
  };
  const signature = await crypto.ed25519Sign(
    recipe.signer.seed,
    signingInput(aad, unsigned),
  );
  if (signature === undefined || signature.length !== 64) {
    return undefined;
  }
  return encodeEnvelope({ ...unsigned, signature });
}

/** The AEAD's output, with the frame's own associated data — §6.1's step 7. */
export async function opens(
  crypto: FrameCrypto,
  frameKeyBytes: Uint8Array,
  roomId: string,
  envelope: Envelope,
): Promise<Uint8Array | undefined> {
  const aad = associatedData(roomId, envelope.kind, envelope.epoch, envelope.keyId);
  return crypto.aesGcmOpen(
    frameKeyBytes,
    envelope.nonce,
    envelope.ciphertext,
    aad,
  );
}

/** Whether a signature over `envelope` verifies against `publicKey`. */
export async function authentic(
  crypto: FrameCrypto,
  roomId: string,
  envelope: Envelope,
  publicKey: Uint8Array,
): Promise<boolean> {
  const aad = associatedData(roomId, envelope.kind, envelope.epoch, envelope.keyId);
  return crypto.ed25519Verify(
    publicKey,
    signingInput(aad, envelope),
    envelope.signature,
  );
}

// --- the four sealed payloads ---------------------------------------------------

/** One entry of a room state's `peers`, keyed by the key's canonical spelling. */
export interface PeerEntry {
  peer_id: string;
  role: string;
}

/** `kind = 1`: the room's listing, the roles the host assigns, and the state's edition. */
export interface RoomState {
  issued: number;
  listing: string[];
  peers: Map<string, PeerEntry>;
}

/** What a frame's plaintext carries, once §6.1's step 8 has read it. */
export type Payload =
  | { kind: 'state'; state: RoomState }
  | { kind: 'closing'; issued: number }
  | { kind: 'holds'; holds: string[] }
  | { kind: 'announcement'; key: string; role?: string }
  | { kind: 'content' };

/** What a receiver did with one frame: accepted it, or refused it and why. */
export interface Verdict {
  ok: boolean;
  reason?: DropReason;
  /** The key id whose signature verified, or the one the frame claimed. */
  sender?: string;
  kind?: number;
  counter?: number;
  plaintext: Uint8Array;
  payload?: Payload;
}

/** One committed entry: the key that verified, its role, and the seat it is labelled. */
export interface Committed {
  key: Uint8Array;
  /** The key's id, the first 8 bytes of its SHA-256, derived once where the state is read. */
  id: string;
  spelling: string;
  role: string;
  peerId: string;
}

/** The roles a state may assign (`CANONICAL.md` §6.1). */
function isSeatedRole(role: unknown): role is 'host' | 'guest' | 'viewer' {
  return role === 'host' || role === 'guest' || role === 'viewer';
}

/** A count in §2.4's form and inside this receiver's bound. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * A path `PROTOCOL.md` §5 refuses is dropped at the receiver, never refused: §13.3 and §13.7
 * leave it out of a listing and a hold set and apply the rest. So is a path over §13.3's
 * 4096-byte bound, which the host **MUST NOT** write and a receiver **MUST** drop.
 */
export function usablePath(path: string): boolean {
  return (
    path !== '' &&
    !/\p{Cc}/u.test(path) &&
    utf8.encode(path).length <= MAX_PATH_BYTES
  );
}

/** §13.3's and §13.7's bound on one path, in the bytes a listing carries it as. */
export const MAX_PATH_BYTES = 4096;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses a state's `peers`, or `undefined` for a member set §6.1's step 8 refuses. */
function parsePeers(value: unknown): Map<string, PeerEntry> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const peers = new Map<string, PeerEntry>();
  for (const [spelling, entry] of Object.entries(value)) {
    if (decodeKey(spelling) === undefined) {
      return undefined;
    }
    if (!isPlainObject(entry)) {
      return undefined;
    }
    const { peer_id: peerId, role } = entry;
    if (typeof peerId !== 'string' || !isSeatedRole(role)) {
      return undefined;
    }
    peers.set(spelling, { peer_id: peerId, role });
  }
  return peers;
}

function parsePaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((path) => typeof path !== 'string')) {
    return undefined;
  }
  return value as string[];
}

/**
 * §6.1's step 8 for a frame whose plaintext is one of the four JSON payloads.
 *
 * A `kind = 0` plaintext is the y-protocols stream of `PROTOCOL.md` §7 and not JSON: the
 * receiver that applies it is the one that decodes it, so this layer carries it whole. The
 * read is a member set and each member's type, and no value a rule elsewhere governs: a
 * listing's path and a holds' path are held to `PROTOCOL.md` §5's rule *after* this step, by
 * the receiver that would carry them (§13.3, §13.7).
 */
export function readPayload(kind: number, plaintext: Uint8Array): Payload | undefined {
  if (kind === 0) {
    return { kind: 'content' };
  }
  let value: unknown;
  try {
    value = JSON.parse(text.decode(plaintext));
  } catch {
    return undefined;
  }
  if (!isPlainObject(value)) {
    return undefined;
  }
  if (kind === 1) {
    const issued = value['issued'];
    const listing = parsePaths(value['listing']);
    const peers = parsePeers(value['peers']);
    if (!isCount(issued) || listing === undefined || peers === undefined) {
      return undefined;
    }
    return { kind: 'state', state: { issued, listing, peers } };
  }
  if (kind === 2) {
    const issued = value['issued'];
    if (value['closing'] !== true || !isCount(issued)) {
      return undefined;
    }
    return { kind: 'closing', issued };
  }
  if (kind === 3) {
    const holds = parsePaths(value['holds']);
    return holds === undefined ? undefined : { kind: 'holds', holds };
  }
  return undefined;
}

/**
 * A session-key announcement, or `undefined` when it is not step 8's object.
 *
 * `role` is a declaration of `guest` or `viewer`, and never `host`: a state names exactly one
 * `host` entry and it is the host's own connection's, so the role is not a peer's to declare.
 * A `role` written as `null` is the wrong type for a member §6.1 types as a role, and §2.6 has
 * an absent member be omitted rather than null.
 */
function parseAnnouncement(plaintext: Uint8Array): { key: string; role?: string } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text.decode(plaintext));
  } catch {
    return undefined;
  }
  if (!isPlainObject(value) || typeof value['key'] !== 'string') {
    return undefined;
  }
  const key = value['key'];
  const role = value['role'];
  if (role === undefined) {
    return { key };
  }
  if (role !== 'guest' && role !== 'viewer') {
    return undefined;
  }
  return { key, role };
}

/** The `issued` a state or a closing is ordered by, or `undefined` for any other payload. */
export function payloadIssued(payload: Payload | undefined): number | undefined {
  if (payload === undefined) {
    return undefined;
  }
  if (payload.kind === 'state') {
    return payload.state.issued;
  }
  return payload.kind === 'closing' ? payload.issued : undefined;
}

/**
 * Document content is a `kind = 0` plaintext **carrying** a `SyncStep2` or an `Update`
 * (`PROTOCOL.md` §13.5): message type 0, sync sub-type 1 or 2, anywhere in the stream.
 *
 * The whole stream, and not its first message, because the check is what refuses a `viewer`'s
 * edits and the receiver that applies them reads every message a frame holds (`sync.ts`): a
 * frame whose first message is a `SyncStep1` and whose second is an `Update` would otherwise
 * pass the check and have its content applied. The walk here is that reader's, message for
 * message, so the two cannot disagree about where one message ends and the next begins.
 */
export function isContent(plaintext: Uint8Array): boolean {
  const decoder = decoding.createDecoder(plaintext);
  let content = false;
  try {
    while (decoding.hasContent(decoder)) {
      const type = decoding.readVarUint(decoder);
      if (type === 0) {
        const subtype = decoding.readVarUint(decoder);
        content ||= subtype === 1 || subtype === 2;
        decoding.readVarUint8Array(decoder);
      } else if (type === 1 || type === 2) {
        decoding.readVarUint8Array(decoder);
      } else if (type !== 3) {
        // A message type this version does not read: the walk stops where the stream stops
        // making sense, and what it has already seen is what the frame carries.
        break;
      }
    }
  } catch {
    // The bytes ran out inside a message. The receiver that would apply this frame refuses it
    // for the same reason, and a frame that carries content before that point still carries it.
    return content;
  }
  return content;
}

// --- the reader -----------------------------------------------------------------

/** One of §6.1's read steps that is also a client rule, so the census removes it here. */
export type ReaderGuard = 'ignore-issued' | 'ignore-roles';

export interface ReaderOptions {
  roomId: string;
  roomKey: Uint8Array;
  hostKey: Uint8Array;
  crypto: FrameCrypto;
}

/**
 * A conforming receiver's byte layer: §6.1's marks, and §13.3's committed keys and roles.
 *
 * It holds the frame key and the host key the invite's fragment carries, and the marks §6.1
 * says a receiver keeps for as long as it holds the room's keys. Every {@link Reader.read} is
 * one frame and one verdict; an accepted frame folds into the receiver exactly as §13.2,
 * §13.3, §13.7 and §13.10 describe, so a sequence of frames is a sequence of decisions and not
 * a list of independent ones.
 */
export class Reader {
  readonly roomId: string;
  readonly frameKey: Uint8Array;
  readonly hostKey: Uint8Array;
  /** The keys an applied state commits, under the canonical spelling of each key. */
  committed = new Map<string, Committed>();
  /** §6.1's marks: the highest counter **not refused** under each key. */
  readonly marks = new Map<string, number>();
  /** The listing of the last applied state, with §5's refused paths dropped. */
  listing: string[] = [];
  /** Each key's held paths, by key id. */
  readonly holds = new Map<string, string[]>();
  issued = 0;
  ended = false;
  /** The read steps a mutation census has removed (`PROTOCOL.md` §13.11). */
  readonly guards = new Set<ReaderGuard>();

  private readonly crypto: FrameCrypto;
  private readonly hostId: Uint8Array;
  /**
   * The frame being read, so that a second call waits for the first.
   *
   * A read is several awaits long and moves a mark when it accepts, so two of them in flight
   * together would decide about the same counter twice and could apply a frame below a mark
   * another had already moved. Every call queues behind the one before it and the verdicts come
   * back in arrival order.
   */
  private pending: Promise<unknown> = Promise.resolve();

  private constructor(options: ReaderOptions, frameKeyBytes: Uint8Array, hostId: Uint8Array) {
    this.roomId = options.roomId;
    this.frameKey = frameKeyBytes;
    this.hostKey = options.hostKey;
    this.hostId = hostId;
    this.crypto = options.crypto;
  }

  /** A reader that knows only the invite's two keys, which is a joiner before a state. */
  static async create(options: ReaderOptions): Promise<Reader | undefined> {
    const frameKeyBytes = await frameKey(options.crypto, options.roomId, options.roomKey);
    if (frameKeyBytes === undefined) {
      return undefined;
    }
    return new Reader(
      options,
      frameKeyBytes,
      await keyId(options.crypto, options.hostKey),
    );
  }

  /**
   * The committed entries in UTF-16 code-unit order of the key's spelling.
   *
   * §6.1 orders the two readings that turn on a tie — which `host` entry is the host's
   * connection, and which of two keys naming one `peer_id` is read — by the key's order, so a
   * receiver that keeps its keys in any other order reads a state differently from a second
   * receiver on the same bytes.
   */
  entries(): Committed[] {
    return [...this.committed.values()].sort((left, right) =>
      left.spelling < right.spelling ? -1 : left.spelling > right.spelling ? 1 : 0,
    );
  }

  /** The committed entries an 8-byte id names, in that same order. */
  byKeyId(id: string): Committed[] {
    return this.entries().filter((entry) => entry.id === id);
  }

  /** The canonical spelling of the key an id names, when an applied state names one. */
  spellingOf(id: string): string | undefined {
    return this.entries().find((entry) => entry.id === id)?.spelling;
  }

  /**
   * §6.1's table, in its order, with the first step that refuses the frame reported.
   *
   * One frame at a time, in the order the frames were handed over; see {@link Reader.pending}.
   */
  read(frame: Uint8Array): Promise<Verdict> {
    const verdict = this.pending.then(
      () => this.readOne(frame),
      () => this.readOne(frame),
    );
    this.pending = verdict.then(
      () => undefined,
      () => undefined,
    );
    return verdict;
  }

  private async readOne(frame: Uint8Array): Promise<Verdict> {
    const envelope = parseEnvelope(frame);
    if (envelope === undefined) {
      return refused('bad_envelope');
    }
    if (!KINDS.includes(envelope.kind)) {
      return refused('unknown_kind', envelope);
    }
    if (envelope.epoch !== 0) {
      return refused('unknown_epoch', envelope);
    }
    return envelope.kind === 4
      ? this.readAnnouncement(envelope)
      : this.readOrdinary(envelope);
  }

  /** The committed key a spelling names, or `undefined`. */
  committedBySpelling(spelling: string): Committed | undefined {
    return this.committed.get(spelling);
  }

  /** The role this receiver's applied state gives a key, which is what a frame is read with. */
  roleOfKey(key: Uint8Array): string | undefined {
    return this.entries().find((entry) => bytesEqual(entry.key, key))?.role;
  }

  private markOf(id: string): number {
    return this.marks.get(id) ?? 0;
  }

  /** A `kind = 0`, `3` or `4` frame at or below the mark is a replay, whatever else is right. */
  private replayed(id: string, counter: number): boolean {
    return counter <= this.markOf(id);
  }

  private advance(id: string, counter: number): void {
    this.marks.set(id, Math.max(this.markOf(id), counter));
  }

  /**
   * When an applied state is where a receiver's `issued` mark comes from. A state is a whole
   * read: the mark moves inside {@link accept}, which is the one place a frame changes this
   * receiver.
   */
  private async accept(
    envelope: Envelope,
    sender: string,
    plaintext: Uint8Array,
    payload: Payload,
  ): Promise<Verdict> {
    if (envelope.kind === 0 || envelope.kind === 3) {
      this.advance(sender, envelope.counter);
    }
    if (payload.kind === 'state') {
      await this.applyState(payload.state);
    } else if (payload.kind === 'closing') {
      this.issued = payload.issued;
      this.ended = true;
    } else if (payload.kind === 'holds') {
      this.holds.set(sender, payload.holds.filter(usablePath));
    }
    return {
      ok: true,
      sender,
      kind: envelope.kind,
      counter: envelope.counter,
      plaintext,
      payload,
    };
  }

  private async applyState(state: RoomState): Promise<void> {
    // §13.3: a state replaces the receiver's keys and roles for the whole room, and a key it
    // does not name is uncommitted from that moment.
    const committed = new Map<string, Committed>();
    for (const [spelling, entry] of state.peers) {
      const key = decodeKey(spelling);
      if (key === undefined) {
        continue;
      }
      committed.set(spelling, {
        key,
        id: hex(await keyId(this.crypto, key)),
        spelling,
        role: entry.role,
        peerId: entry.peer_id,
      });
    }
    this.committed = committed;
    this.listing = state.listing.filter(usablePath);
    this.issued = state.issued;
  }

  /**
   * `kind = 4`'s own order: the AEAD (7), the payload (8), the key (4), the signature (6), and
   * last the mark (5).
   *
   * Its signer is inside its plaintext, so a receiver cannot verify anything before it opens
   * the AEAD — the one place the table's order is not the read's. What is not read for this
   * kind is the step-4 rule about *commitment*: the announcement is the frame that makes a key
   * knowable in the first place, so a receiver accepts one from a key no state commits.
   */
  private async readAnnouncement(envelope: Envelope): Promise<Verdict> {
    const plaintext = await opens(
      this.crypto,
      this.frameKey,
      this.roomId,
      envelope,
    );
    if (plaintext === undefined) {
      return refused('bad_aead', envelope);
    }
    const announcement = parseAnnouncement(plaintext);
    if (announcement === undefined) {
      return refused('bad_payload', envelope);
    }
    const key = decodeKey(announcement.key);
    if (key === undefined) {
      return refused('bad_payload', envelope);
    }
    const id = hex(await keyId(this.crypto, key));
    if (id !== hex(envelope.keyId)) {
      return refused('uncommitted_key', envelope);
    }
    if (!(await authentic(this.crypto, this.roomId, envelope, key))) {
      return refused('bad_signature', envelope);
    }
    if (this.replayed(id, envelope.counter)) {
      return refused('replayed_counter', envelope);
    }
    this.advance(id, envelope.counter);
    return {
      ok: true,
      sender: id,
      kind: envelope.kind,
      counter: envelope.counter,
      plaintext,
      payload: {
        kind: 'announcement',
        key: announcement.key,
        ...(announcement.role === undefined ? {} : { role: announcement.role }),
      },
    };
  }

  private async readOrdinary(envelope: Envelope): Promise<Verdict> {
    // A `kind = 1` or `2` frame verifies against the host key the fragment names; a `kind = 0`
    // or `3` one against the committed keys its `key_id` indexes. §6.1 makes the id an index
    // and not an identity, so every key the id names is tried and the frame belongs to the one
    // that verified: a collision costs a verification that fails, never a misattribution.
    const id = hex(envelope.keyId);
    const candidates =
      envelope.kind === 1 || envelope.kind === 2
        ? hex(this.hostId) === id
          ? [this.hostKey]
          : []
        : this.byKeyId(id).map((entry) => entry.key);
    if (candidates.length === 0) {
      return refused('uncommitted_key', envelope);
    }
    if (
      (envelope.kind === 0 || envelope.kind === 3) &&
      this.replayed(id, envelope.counter)
    ) {
      return refused('replayed_counter', envelope);
    }
    let sender: Uint8Array | undefined;
    for (const candidate of candidates) {
      if (await authentic(this.crypto, this.roomId, envelope, candidate)) {
        sender = candidate;
        break;
      }
    }
    if (sender === undefined) {
      return refused('bad_signature', envelope);
    }
    const plaintext = await opens(this.crypto, this.frameKey, this.roomId, envelope);
    if (plaintext === undefined) {
      return refused('bad_aead', envelope);
    }
    const payload = readPayload(envelope.kind, plaintext);
    if (payload === undefined) {
      return refused('bad_payload', envelope);
    }
    // Step 9: a state or a closing is ordered by its own `issued`.
    const issued = payloadIssued(payload);
    if (
      issued !== undefined &&
      issued <= this.issued &&
      !this.guards.has('ignore-issued')
    ) {
      return refused('stale_issued', envelope);
    }
    // Step 10: a committed `viewer` may not send document content.
    if (
      envelope.kind === 0 &&
      isContent(plaintext) &&
      !this.guards.has('ignore-roles') &&
      this.roleOfKey(sender) === 'viewer'
    ) {
      return refused('unauthorised_content', envelope);
    }
    return await this.accept(envelope, hex(await keyId(this.crypto, sender)), plaintext, payload);
  }
}

function refused(reason: DropReason, envelope?: Envelope): Verdict {
  return {
    ok: false,
    reason,
    plaintext: new Uint8Array(0),
    ...(envelope === undefined
      ? {}
      : { sender: hex(envelope.keyId), kind: envelope.kind, counter: envelope.counter }),
  };
}
