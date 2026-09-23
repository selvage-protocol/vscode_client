/**
 * The crypto seam over Node's `crypto` (`src/engine/crypto.ts`): one implementation of the
 * primitives a `selvage/2` frame is built from.
 *
 * It lives outside `src/engine/` on purpose. The engine is the code all three clients drive and
 * a page has no `node:crypto` — a bundler for the browser cannot resolve the import, and the
 * seam is what lets a page supply WebCrypto instead. This is the Node half: the extension
 * host, the Neovim companion and the corpus subject.
 *
 * The two Ed25519 keys are wrapped in the fixed DER prefixes RFC 8410 gives them (`pkcs8` for a
 * seed, `spki` for a public key), because that is the form Node's `createPrivateKey` and
 * `createPublicKey` read a key in without a second encoder here.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import type { FrameCrypto } from '../engine/crypto.ts';

/** The tag GCM appends to the ciphertext, and the length a ciphertext has to reach. */
const TAG_BYTES = 16;
const NONCE_BYTES = 12;

/** RFC 8410's `PrivateKeyInfo` prefix for an Ed25519 seed. */
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
/** RFC 8410's `SubjectPublicKeyInfo` prefix for an Ed25519 public key. */
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');

function signingKey(seed: Uint8Array): KeyObject | undefined {
  if (seed.length !== 32) {
    return undefined;
  }
  try {
    return createPrivateKey({
      key: Buffer.concat([PKCS8, Buffer.from(seed)]),
      format: 'der',
      type: 'pkcs8',
    });
  } catch {
    return undefined;
  }
}

function verifyingKey(publicKey: Uint8Array): KeyObject | undefined {
  if (publicKey.length !== 32) {
    return undefined;
  }
  try {
    return createPublicKey({
      key: Buffer.concat([SPKI, Buffer.from(publicKey)]),
      format: 'der',
      type: 'spki',
    });
  } catch {
    return undefined;
  }
}

/** One implementation of the engine's crypto seam, over Node's `crypto`. */
export const nodeCrypto: FrameCrypto = {
  randomBytes(length: number): Uint8Array {
    return randomBytes(length);
  },

  async sha256(bytes: Uint8Array): Promise<Uint8Array> {
    return createHash('sha256').update(bytes).digest();
  },

  async hkdfSha256(
    ikm: Uint8Array,
    salt: Uint8Array,
    info: Uint8Array,
    length: number,
  ): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(hkdfSync('sha256', ikm, salt, info, length));
    } catch {
      return undefined;
    }
  },

  async ed25519PublicFromSeed(seed: Uint8Array): Promise<Uint8Array | undefined> {
    const key = signingKey(seed);
    if (key === undefined) {
      return undefined;
    }
    const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
    const raw = spki.subarray(SPKI.length);
    return raw.length === 32 ? new Uint8Array(raw) : undefined;
  },

  async ed25519Sign(
    seed: Uint8Array,
    message: Uint8Array,
  ): Promise<Uint8Array | undefined> {
    const key = signingKey(seed);
    if (key === undefined) {
      return undefined;
    }
    return new Uint8Array(sign(null, message, key));
  },

  async ed25519Verify(
    publicKey: Uint8Array,
    message: Uint8Array,
    signature: Uint8Array,
  ): Promise<boolean> {
    const key = verifyingKey(publicKey);
    if (key === undefined) {
      return false;
    }
    try {
      // A signature of the wrong length is a verification that fails and not a throw.
      return verify(null, message, key, signature);
    } catch {
      return false;
    }
  },

  async aesGcmSeal(
    key: Uint8Array,
    nonce: Uint8Array,
    plaintext: Uint8Array,
    aad: Uint8Array,
  ): Promise<Uint8Array | undefined> {
    if (key.length !== 32 || nonce.length !== NONCE_BYTES) {
      return undefined;
    }
    try {
      const cipher = createCipheriv('aes-256-gcm', key, nonce, {
        authTagLength: TAG_BYTES,
      });
      cipher.setAAD(aad);
      const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return new Uint8Array(Buffer.concat([body, cipher.getAuthTag()]));
    } catch {
      return undefined;
    }
  },

  async aesGcmOpen(
    key: Uint8Array,
    nonce: Uint8Array,
    ciphertext: Uint8Array,
    aad: Uint8Array,
  ): Promise<Uint8Array | undefined> {
    if (key.length !== 32 || nonce.length !== NONCE_BYTES || ciphertext.length < TAG_BYTES) {
      return undefined;
    }
    const body = Buffer.from(ciphertext.subarray(0, ciphertext.length - TAG_BYTES));
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, nonce, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(aad);
      decipher.setAuthTag(Buffer.from(ciphertext.subarray(ciphertext.length - TAG_BYTES)));
      return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]));
    } catch {
      return undefined;
    }
  },
};
