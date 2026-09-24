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
