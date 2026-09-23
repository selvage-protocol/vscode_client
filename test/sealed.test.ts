/**
 * `CANONICAL.md` §6.1 on its own: the envelope's bytes, the key schedule, the canonical key
 * encoding, and the ten-step read with the reason each step reports.
 *
 * Every fixture here is built from constants rather than from the corpus, so these are the
 * engine's own unit tests and run without a sibling checkout. The corpus
 * (`test/peer-corpus.test.ts`) is what pins these bytes against a second implementation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nodeCrypto } from '../src/node/crypto.ts';
import {
  DROP_REASONS,
  MAX_PATH_BYTES,
  Reader,
  associatedData,
  authentic,
  bytesEqual,
  decodeKey,
  encodeEnvelope,
  encodeKey,
  frameKey,
  hex,
  mintSessionKey,
  opens,
  parseEnvelope,
  readPayload,
  readVaruint,
  seal,
  signingInput,
  usablePath,
  varuint,
  varuint8Array,
} from '../src/engine/sealed.ts';
import type { SessionKeypair } from '../src/engine/sealed.ts';

const ROOM = 'R7f3a2c19';
const KEY_BYTES = 32;

/** A room, its host keypair and two session keypairs, all derived from constants. */
interface Room {
  frameKey: Uint8Array;
  roomKey: Uint8Array;
  host: SessionKeypair;
  ours: SessionKeypair;
  peer: SessionKeypair;
}

let cached: Promise<Room> | undefined;

function room(): Promise<Room> {
  cached ??= (async () => {
    const roomKey = new Uint8Array(KEY_BYTES).fill(7);
    const derive = await frameKey(nodeCrypto, ROOM, roomKey);
    assert.ok(derive !== undefined, 'the room key derives a frame key');
    return {
      roomKey,
      frameKey: derive,
      host: (await mintSessionKey(nodeCrypto, new Uint8Array(KEY_BYTES).fill(3))) as SessionKeypair,
      ours: (await mintSessionKey(nodeCrypto, new Uint8Array(KEY_BYTES).fill(5))) as SessionKeypair,
      peer: (await mintSessionKey(nodeCrypto, new Uint8Array(KEY_BYTES).fill(11))) as SessionKeypair,
    };
  })();
  return cached;
}

function seed(fill: number): Uint8Array {
  return new Uint8Array(KEY_BYTES).fill(fill);
}

/** One frame's bytes, sealed with the room's own key and a caller-chosen field. */
async function frame(
  signer: SessionKeypair,
  kind: number,
  counter: number,
  plaintext: Uint8Array,
  options: { epoch?: number; nonce?: number; roomKey?: Uint8Array } = {},
): Promise<Uint8Array> {
  const now = await room();
  const sealed = await seal(
    nodeCrypto,
    {
      roomId: ROOM,
      frameKey:
        options.roomKey === undefined
          ? now.frameKey
          : ((await frameKey(nodeCrypto, ROOM, options.roomKey)) as Uint8Array),
      kind,
      epoch: options.epoch ?? 0,
      counter,
      nonce: new Uint8Array(12).fill(options.nonce ?? 9),
      signer,
    },
    plaintext,
  );
  assert.ok(sealed !== undefined, 'a frame seals');
  return sealed;
}

const text = (value: unknown): Uint8Array =>
  new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));

function peers(
  entries: Array<[SessionKeypair, string, string]>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, role, seat] of entries) {
    out[encodeKey(key.public)] = { peer_id: seat, role };
  }
  return out;
}

/** A room state, signed by the host key: §6.1's `kind = 1`. */
function state(
  signer: SessionKeypair,
  issued: number,
  listing: string[],
  entries: Array<[SessionKeypair, string, string]>,
  counter = 1,
): Promise<Uint8Array> {
  return frame(signer, 1, counter, text({ issued, listing, peers: peers(entries) }));
}

function holds(
  signer: SessionKeypair,
  counter: number,
  paths: string[],
): Promise<Uint8Array> {
  return frame(signer, 3, counter, text({ holds: paths }));
}

async function reader(commit: boolean): Promise<Reader> {
  const now = await room();
  const read = await Reader.create({
    roomId: ROOM,
    roomKey: now.roomKey,
    hostKey: now.host.public,
    crypto: nodeCrypto,
  });
  assert.ok(read !== undefined, 'a reader is built');
  if (commit) {
    const verdict = await read.read(
      await state(now.host, 1, ['README.md'], [[now.host, 'host', 'p-host'], [now.peer, 'guest', 'p-other']]),
    );
    assert.ok(verdict.ok, 'the fixture state applies');
  }
  return read;
}

// --- the bytes ------------------------------------------------------------------

test('a key round-trips through its canonical encoding, and no other spelling is one', () => {
  const raw = Uint8Array.from([
    0x9b, 0x04, 0xa4, 0xc5, 0xe4, 0x72, 0xb4, 0x55, 0x2c, 0xd1, 0x77, 0x1a, 0x06, 0xe8,
    0xe4, 0x03, 0x1b, 0x9a, 0x98, 0x59, 0x9f, 0x8d, 0xbf, 0x60, 0x00, 0x6d, 0x55, 0xd5,
    0xa6, 0x14, 0x90, 0x4c,
  ]);
  assert.equal(encodeKey(raw), 'mwSkxeRytFUs0XcaBujkAxuamFmfjb9gAG1V1aYUkEw');
  assert.deepEqual(decodeKey(encodeKey(raw)), raw);

  // 43 characters whose last carries non-zero pad bits spell no 32-byte value.
  const altered = `${encodeKey(new Uint8Array(KEY_BYTES))}`.slice(0, 42);
  assert.equal(decodeKey(`${altered}B`), undefined);
  assert.equal(decodeKey('short'), undefined);
  assert.equal(decodeKey(`${encodeKey(raw).slice(0, 42)}-`), undefined, '`-` is not a final character');
});

test('the frame key is the schedule, and both halves of it decide', async () => {
  const key = new Uint8Array(KEY_BYTES).fill(7);
  const one = await frameKey(nodeCrypto, 'R7f3a2c19', key);
  const two = await frameKey(nodeCrypto, 'R7f3a2c20', key);
  assert.notDeepEqual(one, two);
  assert.equal(
    hex(one as Uint8Array),
    '739337c9af500213a0f9b8fef0bebb0fce044c32fc0f1619846196c877bb64ba',
    'HKDF-SHA256(ikm = room key, salt = the room id, info = "selvage/2 frame")',
  );
});

test('one sealed frame opens and verifies', async () => {
  const now = await room();
  const plaintext = text({ holds: ['src/main.rs'] });
  const raw = await frame(now.peer, 3, 1, plaintext);
  const envelope = parseEnvelope(raw);
  assert.ok(envelope !== undefined);
  assert.equal(envelope.kind, 3);
  assert.equal(envelope.epoch, 0);
  assert.equal(envelope.counter, 1);
  assert.deepEqual(
    await opens(nodeCrypto, now.frameKey, ROOM, envelope),
    plaintext,
    'the AEAD opens under the frame key',
  );
  assert.ok(
    await authentic(nodeCrypto, ROOM, envelope, now.peer.public),
    'the signature verifies against the signer',
  );
  assert.equal(
    hex(envelope.keyId),
    hex((await nodeCrypto.sha256(now.peer.public)).slice(0, 8)),
    'the key id is the first eight bytes of the SHA-256',
  );
});

test('a corrupted tag is a signature failure and not an AEAD one', async () => {
  const now = await room();
  const raw = await frame(now.peer, 3, 1, text({ holds: ['a'] }));
  const envelope = parseEnvelope(raw);
  assert.ok(envelope !== undefined);
  // One bit inside the GCM tag, which is the ciphertext's last byte.
  envelope.ciphertext[envelope.ciphertext.length - 1] ^= 0x01;
  assert.equal(
    await authentic(nodeCrypto, ROOM, envelope, now.peer.public),
    false,
    'the signature covers the ciphertext, so a corrupted tag is a signature failure',
  );
});

test('left-over bytes and a truncated frame are not envelopes', async () => {
  const now = await room();
  const raw = await frame(now.peer, 3, 1, text({ holds: [] }));
  assert.equal(parseEnvelope(Uint8Array.from([...raw, 0])), undefined);
  assert.equal(parseEnvelope(raw.slice(0, raw.length - 1)), undefined);
  assert.equal(parseEnvelope(new Uint8Array(0)), undefined);
  const parsed = parseEnvelope(raw);
  assert.ok(parsed !== undefined);
  assert.deepEqual(encodeEnvelope(parsed), raw, 'and re-encode to the bytes they came from');
});

test('a varUint is LEB128, and one this receiver cannot hold is refused', () => {
  assert.deepEqual([...varuint(0)], [0]);
  assert.deepEqual([...varuint(127)], [127]);
  assert.deepEqual([...varuint(128)], [0x80, 0x01]);
  assert.deepEqual([...varuint(300)], [0xac, 0x02]);
  assert.deepEqual(readVaruint(Uint8Array.from([0xac, 0x02, 0xff]), 0), [300, 2]);
  assert.deepEqual([...varuint8Array(new Uint8Array([1, 2]))], [2, 1, 2]);
  assert.equal(readVaruint(new Uint8Array([0x80]), 0), undefined, 'the bytes run out');
  // Ten bytes carry more than 2^53−1, which a JavaScript receiver cannot hold.
  assert.equal(
    readVaruint(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]), 0),
    undefined,
  );
});

test('the associated data and the signature input are the version, the room and the fields', async () => {
  const now = await room();
  const envelope = parseEnvelope(await frame(now.peer, 0, 3, text([1])));
  assert.ok(envelope !== undefined);
  const aad = associatedData(ROOM, envelope.kind, envelope.epoch, envelope.keyId);
  const signed = signingInput(aad, envelope);
  assert.ok(
    bytesEqual(signed.slice(0, aad.length), aad),
    'the signature input starts with the associated data',
  );
  assert.ok(
    signed.length > aad.length,
    'and carries the counter, the nonce and the ciphertext after it',
  );
});

// --- the ten steps --------------------------------------------------------------

test('the first step that refuses a frame is the reason it is reported', async () => {
  const now = await room();
  const read = await reader(true);

  const layout = await holds(now.peer, 1, ['a']);
  assert.equal((await read.read(Uint8Array.from([...layout, 0]))).reason, 'bad_envelope');

  assert.equal((await read.read(await frame(now.peer, 5, 1, text([1])))).reason, 'unknown_kind');
  assert.equal(
    (await read.read(await frame(now.peer, 0, 1, text([1]), { epoch: 1 }))).reason,
    'unknown_epoch',
  );
  assert.equal(
    (await read.read(await holds(now.ours, 1, ['a']))).reason,
    'uncommitted_key',
    'a key no applied state commits is refused whatever else is right',
  );
  assert.equal(
    (await read.read(await state(now.ours, 2, [], [[now.peer, 'guest', 'p-other']]))).reason,
    'uncommitted_key',
    'only the host key may sign a state, and a committed session key is not it',
  );

  const holdsBytes = await holds(now.peer, 1, ['src/main.rs']);
  assert.ok((await read.read(holdsBytes)).ok);
  assert.equal(
    (await read.read(holdsBytes)).reason,
    'replayed_counter',
    'the same bytes twice is a replay',
  );

  const tamperedSignature = parseEnvelope(await holds(now.peer, 2, ['a']));
  assert.ok(tamperedSignature !== undefined);
  tamperedSignature.signature[0] ^= 0x01;
  assert.equal((await read.read(encodeEnvelope(tamperedSignature))).reason, 'bad_signature');

  // Authentic and signed by a committed key, but sealed under another room's frame key: the
  // AEAD does not open, which is a report about a sender's bug rather than about an attack.
  assert.ok((await read.read(await holds(now.peer, 3, ['a']))).ok);
  const otherRoom = parseEnvelope(await frame(now.peer, 3, 4, text({ holds: ['a'] }), {
    roomKey: seed(21),
  }));
  assert.ok(otherRoom !== undefined);
  assert.equal(
    await authentic(nodeCrypto, ROOM, otherRoom, now.peer.public),
    true,
    'the signature is the sender\'s own',
  );
  assert.equal((await read.read(encodeEnvelope(otherRoom))).reason, 'bad_aead');

  assert.ok(
    (await read.read(await state(now.host, 9, ['a'], [[now.peer, 'guest', 'p-other']]))).ok,
    'and an accepted frame above the mark still applies',
  );
});

test('step 8 reads a member set and each member type, and no other rule\'s value', async () => {
  const now = await room();
  const read = await reader(true);

  const notAnObject = await frame(now.host, 1, 1, text('"hello"'));
  assert.equal((await read.read(notAnObject)).reason, 'bad_payload');

  const issuedIsAString = await frame(
    now.host,
    1,
    1,
    text({ issued: '1', listing: [], peers: {} }),
  );
  assert.equal((await read.read(issuedIsAString)).reason, 'bad_payload');

  const roleAClosingDoesNotHave = await frame(
    now.host,
    2,
    1,
    text({ closing: false, issued: 5 }),
  );
  assert.equal((await read.read(roleAClosingDoesNotHave)).reason, 'bad_payload');

  // A key that is not the canonical encoding is a member of the wrong type, where a path §5
  // refuses is a value another rule governs and is dropped instead.
  const uncanonical = await frame(
    now.host,
    1,
    1,
    text({ issued: 1, listing: [], peers: { [`${encodeKey(now.peer.public).slice(0, 42)}B`]: { peer_id: 'p', role: 'guest' } } }),
  );
  assert.equal((await read.read(uncanonical)).reason, 'bad_payload');

  const aRoleThisVersionDoesNotDefine = await frame(
    now.host,
    1,
    1,
    text({ issued: 1, listing: [], peers: peers([[now.peer, 'owner', 'p']]) }),
  );
  assert.equal((await read.read(aRoleThisVersionDoesNotDefine)).reason, 'bad_payload');
});

test('a path §5 refuses, or one over the bound, is dropped and the rest is applied', async () => {
  const now = await room();
  const read = await reader(false);
  const long = 'a'.repeat(MAX_PATH_BYTES);
  const over = `${'a'.repeat(MAX_PATH_BYTES)}b`;
  const verdict = await read.read(
    await state(
      now.host,
      1,
      ['README.md', '', 'src/main\u0000.rs', long, over],
      [[now.host, 'host', 'p-host'], [now.peer, 'guest', 'p-other']],
    ),
  );
  assert.ok(verdict.ok, 'the state is applied');
  assert.deepEqual(read.listing, ['README.md', long], 'the rest of the listing goes in');

  assert.equal(usablePath(''), false);
  assert.equal(usablePath('a\u0000b'), false);
  assert.equal(usablePath('a\u007fb'), false);
  assert.equal(usablePath(long), true);
  assert.equal(usablePath(over), false);
  assert.equal(usablePath('é'.repeat(MAX_PATH_BYTES / 2)), true, 'the bound is bytes, and this is exactly it');
  assert.equal(usablePath('é'.repeat(MAX_PATH_BYTES / 2 + 1)), false);

  const holdsVerdict = await read.read(
    await holds(now.peer, 1, ['src/main.rs', '', 'src/main\t.rs']),
  );
  assert.ok(holdsVerdict.ok, 'a holds message with an unusable path is still applied');
  const id = hex((await nodeCrypto.sha256(now.peer.public)).slice(0, 8));
  assert.deepEqual(read.holds.get(id), ['src/main.rs']);
});

test('a refused frame never moves a mark, whatever step refused it', async () => {
  const now = await room();
  const read = await reader(true);
  const genuine = await holds(now.peer, 1, ['a']);

  const tampered = parseEnvelope(genuine);
  assert.ok(tampered !== undefined);
  tampered.signature[0] ^= 0x01;
  const refused = encodeEnvelope(tampered);
  assert.equal((await read.read(refused)).reason, 'bad_signature');
  assert.equal((await read.read(refused)).reason, 'bad_signature', 'and again');

  assert.ok(
    (await read.read(genuine)).ok,
    'the genuine frame under the same counter still applies: a forgery cannot lock a key out',
  );
  assert.equal((await read.read(genuine)).reason, 'replayed_counter');
});

test('two states at one issued leave the first applied and the second refused', async () => {
  const now = await room();
  const read = await reader(false);
  const first = await state(now.host, 2, ['src/main.rs'], [[now.peer, 'guest', 'p-other']]);
  const second = await state(now.host, 2, ['old.md'], [[now.peer, 'guest', 'p-other']], 2);
  assert.ok((await read.read(first)).ok);
  assert.equal((await read.read(second)).reason, 'stale_issued');
  assert.deepEqual(read.listing, ['src/main.rs']);
  assert.equal(read.issued, 2);
});

test('a state replaces the keys it names, and one that drops a key uncommits it', async () => {
  const now = await room();
  const read = await reader(true);
  assert.deepEqual(read.entries().map((entry) => entry.role), ['host', 'guest']);
  assert.ok((await read.read(await holds(now.peer, 1, ['a']))).ok, 'the committed key may send');

  const dropped = await state(now.host, 2, ['README.md'], [[now.host, 'host', 'p-host']]);
  assert.ok((await read.read(dropped)).ok);
  assert.equal(read.entries().length, 1);
  assert.equal((await read.read(await holds(now.peer, 2, ['a']))).reason, 'uncommitted_key');
});

test('the two host readings turn on the key\'s order, so two receivers read one state alike', async () => {
  const now = await room();
  const read = await reader(false);
  const other = (await mintSessionKey(nodeCrypto, seed(13))) as SessionKeypair;
  const third = (await mintSessionKey(nodeCrypto, seed(17))) as SessionKeypair;
  // Two keys given `host`: the reading is the one whose key comes first in UTF-16 code-unit
  // order of its spelling, whatever order the state writes them in.
  const spelling = (key: SessionKeypair): string => encodeKey(key.public);
  const hosts = [now.peer, other].sort((left, right) =>
    spelling(left) < spelling(right) ? -1 : 1,
  );
  assert.ok(
    (
      await read.read(
        await state(
          now.host,
          1,
          [],
          [
            [hosts[1] as SessionKeypair, 'host', 'p-later'],
            [hosts[0] as SessionKeypair, 'host', 'p-earlier'],
            [third, 'guest', 'p-other'],
          ],
        ),
      )
    ).ok,
  );
  const hostEntries = read.entries().filter((entry) => entry.role === 'host');
  assert.equal(hostEntries.length, 2);
  assert.equal(hostEntries[0]?.spelling, spelling(hosts[0] as SessionKeypair));
  assert.equal(hostEntries[0]?.peerId, 'p-earlier');
});

test('kind = 4 is read in its own order: the AEAD, the payload, the key, the signature, the mark', async () => {
  const now = await room();
  const read = await reader(false);

  const announcement = (signer: SessionKeypair, counter: number): Promise<Uint8Array> =>
    frame(signer, 4, counter, text({ key: encodeKey(signer.public) }));

  // A key no state commits announces itself, which is the whole of what the frame is for.
  const first = await read.read(await announcement(now.peer, 1));
  assert.ok(first.ok, 'an announcement is accepted from a key no state commits');

  assert.equal(
    (await read.read(await announcement(now.peer, 1))).reason,
    'replayed_counter',
    'the mark guards the announcement',
  );
  assert.equal(
    (await read.read(await frame(now.peer, 4, 2, text({ key: encodeKey(now.ours.public) })))).reason,
    'uncommitted_key',
    'the envelope\'s key id must be the announced key\'s id',
  );
  assert.equal(
    (await read.read(await frame(now.peer, 4, 3, text('"hello"')))).reason,
    'bad_payload',
  );
  assert.equal(
    (
      await read.read(
        await frame(now.peer, 4, 4, text({ key: encodeKey(now.peer.public), role: 'host' })),
      )
    ).reason,
    'bad_payload',
    'the role is never `host`: that entry is the host\'s own connection\'s',
  );
  assert.equal(
    (
      await read.read(
        await frame(now.peer, 4, 5, text({ key: encodeKey(now.peer.public), role: null })),
      )
    ).reason,
    'bad_payload',
    '§2.6: an absent member is omitted, never null',
  );
  assert.ok(
    (
      await read.read(
        await frame(now.peer, 4, 6, text({ key: encodeKey(now.peer.public), role: 'viewer' })),
      )
    ).ok,
  );
});

test('step 10 refuses only content, and only from a key the state gives role viewer', async () => {
  const now = await room();
  const read = await reader(false);
  assert.ok(
    (
      await read.read(
        await state(
          now.host,
          1,
          ['README.md'],
          [[now.host, 'host', 'p-host'], [now.peer, 'viewer', 'p-viewer']],
        ),
      )
    ).ok,
  );
  // message type 0 (sync), sub-type 1 (SyncStep2), then a length of zero.
  const content = await frame(now.peer, 0, 1, Uint8Array.from([0, 1, 0]));
  assert.equal((await read.read(content)).reason, 'unauthorised_content');
  // A SyncStep1 is a request and not content; awareness and holds are not content either.
  assert.ok((await read.read(await frame(now.peer, 0, 2, Uint8Array.from([0, 0, 0])))).ok);
  assert.ok((await read.read(await holds(now.peer, 3, ['README.md']))).ok);
  // message type 1 (awareness), then a length of zero.
  assert.ok((await read.read(await frame(now.peer, 0, 4, Uint8Array.from([1, 0])))).ok);
});

test('the guards a census removes are the two client rules in the byte layer', async () => {
  const now = await room();
  const read = await reader(false);
  assert.ok(
    (
      await read.read(
        await state(now.host, 1, ['README.md'], [[now.host, 'host', 'p-host'], [now.peer, 'viewer', 'p-viewer']]),
      )
    ).ok,
  );
  read.guards.add('ignore-roles');
  assert.ok((await read.read(await frame(now.peer, 0, 1, Uint8Array.from([0, 1, 0])))).ok);
  read.guards.add('ignore-issued');
  const earlier = await state(now.host, 1, ['again.md'], [[now.host, 'host', 'p-host']], 3);
  assert.ok((await read.read(earlier)).ok, 'a state at the mark is applied under `ignore-issued`');
});

test('the payload a frame carries is read as its own kind, or not at all', () => {
  const asObject = readPayload(1, text({ issued: 1, listing: [], peers: {} }));
  assert.equal(asObject?.kind, 'state');
  assert.equal(readPayload(2, text({ closing: true, issued: 2 }))?.kind, 'closing');
  assert.equal(readPayload(3, text({ holds: ['a'] }))?.kind, 'holds');
  assert.equal(readPayload(0, Uint8Array.from([0, 0]))?.kind, 'content');
  assert.equal(readPayload(0, Uint8Array.from([9]))?.kind, 'content', 'a kind = 0 frame carries a stream');
  assert.equal(readPayload(1, Uint8Array.from([0xff, 0xfe])), undefined, 'not UTF-8');
  assert.equal(readPayload(3, text({ holds: [1] })), undefined);
  assert.equal(readPayload(2, text({ closing: true })), undefined);
});

test('every reason the read reports is one §6.1 names', () => {
  assert.deepEqual(DROP_REASONS, [
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
  ]);
});
