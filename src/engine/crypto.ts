/**
 * The primitives a `selvage/2` frame is built from (`CANONICAL.md` §6.1): HKDF-SHA256, the
 * key id, AES-256-GCM and Ed25519.
 *
 * This is a seam and not an import. The engine is the code the VS Code, Neovim and browser
 * clients all drive, and the three do not share a crypto library: Node's `crypto` is
 * synchronous, absent from a page and reachable only through an `import` a bundler for the
 * page cannot resolve, while a page's WebCrypto is asynchronous and unavailable in Node 18.
 * A caller supplies a {@link FrameCrypto}; `src/node/crypto.ts` is the one this repository's
 * own clients and its corpus subject use, and a page's is the next phase's.
 *
 * Every primitive answers `undefined` where the platform refuses an input rather than
 * throwing: a refusal is a decision about a frame (`PROTOCOL.md` §13.2), and a signature that
 * does not verify is the `false` of {@link FrameCrypto.ed25519Verify}.
 */
export interface FrameCrypto {
  /** `length` fresh bytes from the platform's CSPRNG: a nonce, or a session key's seed. */
  randomBytes(length: number): Uint8Array;

  /** SHA-256, whose first eight bytes index a key. */
  sha256(bytes: Uint8Array): Promise<Uint8Array>;

  /**
   * HKDF-SHA256 (`L = length`), the key schedule's own expansion, `undefined` when the
   * platform refuses the inputs.
   */
  hkdfSha256(
    ikm: Uint8Array,
    salt: Uint8Array,
    info: Uint8Array,
    length: number,
  ): Promise<Uint8Array | undefined>;

  /**
   * The Ed25519 public key a 32-byte seed names, or `undefined` when the platform refuses
   * the seed.
   */
  ed25519PublicFromSeed(seed: Uint8Array): Promise<Uint8Array | undefined>;

  /** A 64-byte Ed25519 signature over `message`, or `undefined` for a seed it refuses. */
  ed25519Sign(
    seed: Uint8Array,
    message: Uint8Array,
  ): Promise<Uint8Array | undefined>;

  /**
   * Whether `signature` verifies against `publicKey`. A public key the curve refuses is a
   * `false`, not a throw: a room state may name any 32 bytes and a receiver decides about
   * them.
   */
  ed25519Verify(
    publicKey: Uint8Array,
    message: Uint8Array,
    signature: Uint8Array,
  ): Promise<boolean>;

  /**
   * AES-256-GCM: the ciphertext with its 16-byte tag appended, or `undefined` where the
   * platform refuses the inputs.
   */
  aesGcmSeal(
    key: Uint8Array,
    nonce: Uint8Array,
    plaintext: Uint8Array,
    aad: Uint8Array,
  ): Promise<Uint8Array | undefined>;

  /** AES-256-GCM's open: the plaintext, or `undefined` when the tag does not hold. */
  aesGcmOpen(
    key: Uint8Array,
    nonce: Uint8Array,
    ciphertext: Uint8Array,
    aad: Uint8Array,
  ): Promise<Uint8Array | undefined>;
}
