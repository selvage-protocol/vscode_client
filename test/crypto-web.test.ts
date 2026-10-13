/**
 * The WebCrypto seam, which a page and the relay's default use: it agrees with the Node seam
 * byte for byte, and the keys it keeps imported across calls change no answer — a frame seals
 * and opens the same the hundredth time as the first, and an input the platform refuses is
 * refused every time rather than once.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { webCrypto } from '../src/engine/crypto-web.ts';
import { nodeCrypto } from '../src/node/crypto.ts';
import {
  authentic,
  frameKey,
  mintSessionKey,
  opens,
  parseEnvelope,
  seal,
} from '../src/engine/sealed.ts';
import type { FrameCrypto } from '../src/engine/crypto.ts';
import type { SessionKeypair } from '../src/engine/sealed.ts';

const ROOM = 'R7f3a2c19';
const utf8 = new TextEncoder();

function filled(length: number, value: number): Uint8Array {
  return new Uint8Array(length).fill(value);
}

async function sealed(
  crypto: FrameCrypto,
  key: Uint8Array,
  signer: SessionKeypair,
  counter: number,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const bytes = await seal(
    crypto,
    { roomId: ROOM, frameKey: key, kind: 0, epoch: 0, counter, nonce: filled(12, counter), signer },
    plaintext,
  );
  assert.ok(bytes !== undefined, 'the frame seals');
  return bytes;
}

test('a frame one seam seals, the other opens and verifies, in both directions', async () => {
  const key = await frameKey(webCrypto, ROOM, filled(32, 7));
  assert.ok(key !== undefined);
  assert.deepEqual(key, await frameKey(nodeCrypto, ROOM, filled(32, 7)));
  const web = (await mintSessionKey(webCrypto, filled(32, 5))) as SessionKeypair;
  const node = (await mintSessionKey(nodeCrypto, filled(32, 5))) as SessionKeypair;
  assert.deepEqual(web.public, node.public, 'one seed names one public key');

  const plaintext = utf8.encode('shared text');
  for (const [writer, reader] of [
    [webCrypto, nodeCrypto],
    [nodeCrypto, webCrypto],
  ] as const) {
    const envelope = parseEnvelope(await sealed(writer, key, web, 1, plaintext));
    assert.ok(envelope !== undefined);
    assert.deepEqual(await opens(reader, key, ROOM, envelope), plaintext);
    assert.equal(await authentic(reader, ROOM, envelope, web.public), true);
  }
  // Signing is deterministic, so the two seams write the same frame.
  assert.deepEqual(
    await sealed(webCrypto, key, web, 2, plaintext),
    await sealed(nodeCrypto, key, node, 2, plaintext),
  );
});

test('the keys kept imported across calls change no answer', async () => {
  const key = (await frameKey(webCrypto, ROOM, filled(32, 9))) as Uint8Array;
  const signer = (await mintSessionKey(webCrypto, filled(32, 13))) as SessionKeypair;
  const other = (await mintSessionKey(webCrypto, filled(32, 17))) as SessionKeypair;
  for (let counter = 1; counter <= 50; counter += 1) {
    const plaintext = utf8.encode(`edit ${counter}`);
    const envelope = parseEnvelope(await sealed(webCrypto, key, signer, counter, plaintext));
    assert.ok(envelope !== undefined);
    assert.deepEqual(await opens(webCrypto, key, ROOM, envelope), plaintext);
    assert.equal(await authentic(webCrypto, ROOM, envelope, signer.public), true);
    assert.equal(await authentic(webCrypto, ROOM, envelope, other.public), false);
  }
  // The wrong frame key is refused however often the right one has been used.
  const wrong = (await frameKey(webCrypto, ROOM, filled(32, 10))) as Uint8Array;
  const envelope = parseEnvelope(await sealed(webCrypto, key, signer, 51, utf8.encode('x')));
  assert.ok(envelope !== undefined);
  assert.equal(await opens(webCrypto, wrong, ROOM, envelope), undefined);
});

test('an input the platform refuses is refused every time, not only the first', async () => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(
      await webCrypto.aesGcmSeal(filled(31, 1), filled(12, 0), utf8.encode('x'), new Uint8Array()),
      undefined,
      'a 31-byte AES key is refused',
    );
    assert.equal(
      await webCrypto.ed25519Verify(filled(31, 1), utf8.encode('x'), filled(64, 0)),
      false,
      'a 31-byte public key verifies nothing',
    );
  }
});

test('more keys than the seam keeps imported still seal and verify', async () => {
  const key = (await frameKey(webCrypto, ROOM, filled(32, 21))) as Uint8Array;
  const signers: SessionKeypair[] = [];
  for (let at = 0; at < 300; at += 1) {
    const seed = filled(32, 0);
    seed[0] = at & 0xff;
    seed[1] = at >> 8;
    signers.push((await mintSessionKey(webCrypto, seed)) as SessionKeypair);
  }
  // The first keys were imported longest ago; they are asked for again after the rest.
  for (const signer of [...signers.slice(-5), ...signers.slice(0, 5)]) {
    const envelope = parseEnvelope(await sealed(webCrypto, key, signer, 1, utf8.encode('y')));
    assert.ok(envelope !== undefined);
    assert.equal(await authentic(webCrypto, ROOM, envelope, signer.public), true);
  }
});

/**
 * Counts `crypto.subtle.importKey` calls for one raw key's bytes while `work` runs, optionally
 * refusing the first `refuse` of them, so the cache's reuse, eviction and retry are observable.
 */
async function importsOf(
  bytes: Uint8Array,
  work: () => Promise<void>,
  refuse = 0,
): Promise<number> {
  const subtle = globalThis.crypto.subtle;
  const original = subtle.importKey;
  let count = 0;
  let refused = 0;
  subtle.importKey = function (this: SubtleCrypto, ...args: unknown[]) {
    const data = args[1];
    if (data instanceof ArrayBuffer && Buffer.from(data).equals(Buffer.from(bytes))) {
      count += 1;
      if (refused < refuse) {
        refused += 1;
        return Promise.reject(new DOMException('refused for the test', 'OperationError'));
      }
    }
    return (original as (...rest: unknown[]) => Promise<CryptoKey>).apply(this, args);
  } as typeof subtle.importKey;
  try {
    await work();
  } finally {
    subtle.importKey = original;
  }
  return count;
}

/** 32 bytes no other test in this file uses, so the module-wide cache starts cold for them. */
function fresh(tag: number): Uint8Array {
  const bytes = webCrypto.randomBytes(32);
  bytes[0] = tag;
  return bytes;
}

test('one key is imported once per use and reused after that', async () => {
  const key = fresh(1);
  const aad = new Uint8Array();
  let sealedOnce: Uint8Array | undefined;
  const sealImports = await importsOf(key, async () => {
    for (let at = 0; at < 5; at += 1) {
      sealedOnce = await webCrypto.aesGcmSeal(key, filled(12, at), utf8.encode('x'), aad);
      assert.ok(sealedOnce !== undefined);
    }
  });
  assert.equal(sealImports, 1, 'five seals under one key imported it more than once');
  const openImports = await importsOf(key, async () => {
    for (let at = 0; at < 5; at += 1) {
      assert.ok((await webCrypto.aesGcmOpen(key, filled(12, 4), sealedOnce as Uint8Array, aad)) !== undefined);
    }
  });
  assert.equal(openImports, 1, 'decrypting is its own use, imported once and then reused');
});

test('a refused import is not kept, and the next call imports again and succeeds', async () => {
  const key = fresh(2);
  const aad = new Uint8Array();
  const imports = await importsOf(
    key,
    async () => {
      assert.equal(await webCrypto.aesGcmSeal(key, filled(12, 0), utf8.encode('x'), aad), undefined);
      assert.ok((await webCrypto.aesGcmSeal(key, filled(12, 1), utf8.encode('x'), aad)) !== undefined);
      assert.ok((await webCrypto.aesGcmSeal(key, filled(12, 2), utf8.encode('x'), aad)) !== undefined);
    },
    1,
  );
  assert.equal(imports, 2, 'the refusal was cached, or the success was not');
});

test('a key pushed out by 256 newer ones is imported again when it is next used', async () => {
  const key = fresh(3);
  const aad = new Uint8Array();
  const imports = await importsOf(key, async () => {
    // Used twice while it is cached: one import between them.
    assert.ok((await webCrypto.aesGcmSeal(key, filled(12, 0), utf8.encode('x'), aad)) !== undefined);
    assert.ok((await webCrypto.aesGcmSeal(key, filled(12, 2), utf8.encode('x'), aad)) !== undefined);
    for (let at = 0; at < 256; at += 1) {
      assert.ok((await webCrypto.aesGcmSeal(fresh(4), filled(12, 0), utf8.encode('x'), aad)) !== undefined);
    }
    assert.ok((await webCrypto.aesGcmSeal(key, filled(12, 1), utf8.encode('x'), aad)) !== undefined);
  });
  assert.equal(imports, 2, 'an evicted key was not imported again, or was never evicted');
});

/** The bytes as a Node `Buffer` view carved from a larger pooled allocation, as `ws` delivers. */
function pooledView(bytes: Uint8Array): Uint8Array {
  const pool = Buffer.alloc(bytes.byteLength + 8, 0xcd);
  Buffer.from(bytes).copy(pool, 4);
  return pool.subarray(4, 4 + bytes.byteLength);
}

/** The bytes as an ordinary `Uint8Array` subarray of a larger backing buffer. */
function subarrayView(bytes: Uint8Array): Uint8Array {
  const backing = new Uint8Array(bytes.byteLength + 8).fill(0xcd);
  backing.set(bytes, 4);
  return backing.subarray(4, 4 + bytes.byteLength);
}

test('a pooled Buffer view is the bytes it spans, not the pool, for every primitive', async () => {
  const key = filled(32, 7);
  const nonce = filled(12, 9);
  const plaintext = utf8.encode('a sealed frame payload');
  const aad = utf8.encode('the room and frame header');

  const keyView = pooledView(key);
  assert.ok(keyView.byteOffset > 0, 'the view does not start at the pool');
  assert.ok(keyView.byteLength < keyView.buffer.byteLength, 'the view is shorter than its pool');

  const flatSealed = await webCrypto.aesGcmSeal(key, nonce, plaintext, aad);
  const viewSealed = await webCrypto.aesGcmSeal(
    pooledView(key),
    pooledView(nonce),
    pooledView(plaintext),
    pooledView(aad),
  );
  assert.ok(flatSealed !== undefined, 'the flat seal is answered');
  assert.ok(viewSealed !== undefined, 'the view seal is answered');
  assert.deepEqual(viewSealed, flatSealed, 'the same bytes seal to the same ciphertext');
  assert.deepEqual(
    await webCrypto.aesGcmOpen(pooledView(key), pooledView(nonce), pooledView(flatSealed), pooledView(aad)),
    plaintext,
  );
  assert.deepEqual(await webCrypto.sha256(pooledView(plaintext)), await webCrypto.sha256(plaintext));
  assert.deepEqual(
    await webCrypto.hkdfSha256(pooledView(key), pooledView(nonce), pooledView(aad), 32),
    await webCrypto.hkdfSha256(key, nonce, aad, 32),
  );

  const seed = filled(32, 5);
  const publicKey = await webCrypto.ed25519PublicFromSeed(seed);
  const signature = await webCrypto.ed25519Sign(seed, plaintext);
  assert.ok(publicKey !== undefined, 'the seed names a public key');
  assert.ok(signature !== undefined, 'the seed signs');
  assert.deepEqual(await webCrypto.ed25519PublicFromSeed(pooledView(seed)), publicKey);
  assert.deepEqual(await webCrypto.ed25519Sign(pooledView(seed), pooledView(plaintext)), signature);
  assert.equal(
    await webCrypto.ed25519Verify(pooledView(publicKey), pooledView(plaintext), pooledView(signature)),
    true,
  );
});

test('a Uint8Array subarray view is its own bytes, not the buffer behind it', async () => {
  const key = filled(32, 11);
  const nonce = filled(12, 13);
  const plaintext = utf8.encode('a second payload');
  const aad = new Uint8Array();

  const view = subarrayView(plaintext);
  assert.ok(view.byteOffset > 0, 'the view does not start at the backing buffer');
  assert.ok(view.byteLength < view.buffer.byteLength, 'the view is shorter than its backing buffer');

  const flatSealed = await webCrypto.aesGcmSeal(key, nonce, plaintext, aad);
  const viewSealed = await webCrypto.aesGcmSeal(subarrayView(key), subarrayView(nonce), view, subarrayView(aad));
  assert.ok(flatSealed !== undefined, 'the flat seal is answered');
  assert.ok(viewSealed !== undefined, 'the view seal is answered');
  assert.deepEqual(viewSealed, flatSealed, 'the same bytes seal to the same ciphertext');
  assert.deepEqual(
    await webCrypto.aesGcmOpen(subarrayView(key), subarrayView(nonce), viewSealed, subarrayView(aad)),
    plaintext,
  );
  assert.deepEqual(await webCrypto.sha256(view), await webCrypto.sha256(plaintext));
});
