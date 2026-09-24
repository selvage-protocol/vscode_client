/**
 * The crypto seam over WebCrypto (`globalThis.crypto`), which is the one seam every client
 * here can reach: a page has it, Node has had it since 20, and the VS Code extension host has
 * it too. `CANONICAL.md` §6.1's primitives are all in it — HKDF-SHA256 as `deriveBits`,
 * AES-256-GCM as `encrypt`/`decrypt`, and Ed25519 as `importKey`/`sign`/`verify`.
 *
 * This is the default a caller that supplies none gets, and not the only seam: `src/node/`
 * has one over `node:crypto` for the code that wants it, and the engine's own suite drives
 * both. WebCrypto is asynchronous, which is why every method that may seal a frame is.
 *
 * Ed25519 in WebCrypto is not as old as AES-GCM is: a browser needs Chrome 137, Firefox 130
 * or Safari 17, and Node needs 20 (`globalThis.crypto`) with Ed25519 available, which it is
 * from 18.4. A platform that lacks it answers `undefined` for the three key calls rather than
 * throwing, and the session reports the frame it could not seal.
 */

import type { FrameCrypto } from './crypto.ts';

/** The WebCrypto implementation of the seam, over whatever `globalThis.crypto` this host has. */
export const webCrypto: FrameCrypto = {
  randomBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
  },

  async sha256(bytes: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', toBuffer(bytes)));
  },

  hkdfSha256(
    ikm: Uint8Array,
    salt: Uint8Array,
    info: Uint8Array,
    length: number,
  ): Promise<Uint8Array | undefined> {
    return subtle(async () => {
      const key = await crypto.subtle.importKey('raw', toBuffer(ikm), 'HKDF', false, [
        'deriveBits',
      ]);
      const bits = await crypto.subtle.deriveBits(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: toBuffer(salt),
          info: toBuffer(info),
        },
        key,
        length * 8,
      );
      return new Uint8Array(bits);
    });
  },

  ed25519PublicFromSeed(seed: Uint8Array): Promise<Uint8Array | undefined> {
    return subtle(async () => {
      const key = await ed25519Private(seed);
      const jwk = (await crypto.subtle.exportKey('jwk', key)) as { x?: string };
      if (typeof jwk.x !== 'string') {
        return undefined;
      }
      return base64Url(jwk.x);
    });
  },

  ed25519Sign(seed: Uint8Array, message: Uint8Array): Promise<Uint8Array | undefined> {
    return subtle(async () => {
      const key = await ed25519Private(seed);
      return new Uint8Array(await crypto.subtle.sign('Ed25519', key, toBuffer(message)));
    });
  },
  ed25519Verify(
    publicKey: Uint8Array,
    message: Uint8Array,
    signature: Uint8Array,
  ): Promise<boolean> {
    return subtle(async () => {
      // A public key is any 32 bytes, and the curve refuses some of them: a refusal is a
      // `false` here and never a throw, because a room state may name them (§13.2).
      const key = await imported('verify', publicKey, () =>
        crypto.subtle.importKey('raw', toBuffer(publicKey), { name: 'Ed25519' }, false, [
          'verify',
        ]),
      );
      return crypto.subtle.verify('Ed25519', key, toBuffer(signature), toBuffer(message));
    }).then((verified) => verified ?? false);
  },

  aesGcmSeal(
    key: Uint8Array,
    nonce: Uint8Array,
    plaintext: Uint8Array,
    aad: Uint8Array,
  ): Promise<Uint8Array | undefined> {
    return subtle(async () => {
      const imported = await aesKey(key, 'encrypt');
      const sealed = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: toBuffer(nonce), additionalData: toBuffer(aad) },
        imported,
        toBuffer(plaintext),
      );
      return new Uint8Array(sealed);
    });
  },

  aesGcmOpen(
    key: Uint8Array,
    nonce: Uint8Array,
    ciphertext: Uint8Array,
    aad: Uint8Array,
  ): Promise<Uint8Array | undefined> {
    return subtle(async () => {
      const imported = await aesKey(key, 'decrypt');
      const opened = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: toBuffer(nonce), additionalData: toBuffer(aad) },
        imported,
        toBuffer(ciphertext),
      );
      return new Uint8Array(opened);
    });
  },
};

/** A copy of the bytes, as an `ArrayBuffer` WebCrypto takes and never sees aliased. */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

/**
 * Runs one WebCrypto call, answering `undefined` for an input the platform refuses — an
 * Ed25519 key the curve will not take, an AES key of the wrong length, an IV that is not
 * twelve bytes. A refusal is a decision about a frame, and every caller of the seam reads
 * `undefined` as one; a thrown `OperationError` would end a session instead.
 */
async function subtle<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work();
  } catch {
    return undefined;
  }
}

/**
 * An Ed25519 private key from its 32-byte seed.
 *
 * WebCrypto takes a private Ed25519 key as PKCS#8 and not as the raw seed — `raw` is the public
 * key's format — so the seed is wrapped in the one DER structure that holds it: a PKCS#8
 * `PrivateKeyInfo` naming `id-Ed25519` (OID 1.3.101.112) whose private key is the seed in an
 * `OCTET STRING`. It is fixed bytes and no cryptography: the wrap is not what makes the key.
 *
 * `extractable` is on because the public half is read back out of the same key
 * ({@link ed25519PublicFromSeed}); nothing here exports it anywhere else.
 */
function ed25519Private(seed: Uint8Array): Promise<CryptoKey> {
  return imported('sign', seed, () => ed25519PrivateImport(seed));
}

function ed25519PrivateImport(seed: Uint8Array): Promise<CryptoKey> {
  const der = new Uint8Array(PKCS8_ED25519_PREFIX.length + seed.length);
  der.set(PKCS8_ED25519_PREFIX);
  der.set(seed, PKCS8_ED25519_PREFIX.length);
  return crypto.subtle.importKey('pkcs8', der.buffer as ArrayBuffer, { name: 'Ed25519' }, true, [
    'sign',
  ]);
}

/** `30 2e 02 01 00 30 05 06 03 2b 65 70 04 22 04 20`: PKCS#8's header for a 32-byte seed. */
const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

function aesKey(key: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  return imported(usage, key, () =>
    crypto.subtle.importKey('raw', toBuffer(key), { name: 'AES-GCM' }, false, [usage]),
  );
}

/**
 * The keys this seam has already imported, by use and by the bytes they were imported from.
 *
 * A session seals and opens every frame under one frame key, signs every frame with one
 * session key and verifies each peer's frames against the few keys the room state commits, so
 * without this each keystroke re-imported the same two or three keys. A `CryptoKey` is not
 * extractable where the import said so, and the bytes it came from are the caller's and are
 * held by the caller anyway; this holds nothing a session does not already hold.
 *
 * Bounded, oldest first out, because a room state may name any number of keys over a long
 * session. An import the platform refuses is not kept, so a refusal is decided again next time
 * exactly as it was the first.
 */
const KEY_CACHE_LIMIT = 256;
const keyCache = new Map<string, Promise<CryptoKey>>();

function imported(
  use: string,
  bytes: Uint8Array,
  importKey: () => Promise<CryptoKey>,
): Promise<CryptoKey> {
  const name = `${use}:${hexOf(bytes)}`;
  const known = keyCache.get(name);
  if (known !== undefined) {
    return known;
  }
  const fresh = importKey();
  keyCache.set(name, fresh);
  fresh.catch(() => {
    if (keyCache.get(name) === fresh) {
      keyCache.delete(name);
    }
  });
  if (keyCache.size > KEY_CACHE_LIMIT) {
    const oldest = keyCache.keys().next().value;
    if (oldest !== undefined) {
      keyCache.delete(oldest);
    }
  }
  return fresh;
}

function hexOf(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/** The 32 bytes a base64url `x` member carries, which is WebCrypto's own encoding of a public key. */
function base64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='));
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) {
    bytes[at] = binary.charCodeAt(at);
  }
  return bytes;
}
