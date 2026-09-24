/** The wire layer on its own: the envelope's parsing and its refusal codes. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { code, isTerminalCode, parseServerMessage } from '../src/engine/envelope.ts';
import { fetchMeta } from '../src/engine/meta.ts';

test('a text frame parses permissively, and unknown fields do not matter', () => {
  const event = parseServerMessage(
    JSON.stringify({
      v: 'selvage/1',
      event: 'peer.left',
      params: { peer_id: 'p-1' },
      future_field: 9,
    }),
  );
  assert.deepEqual(event, {
    v: 'selvage/1',
    id: undefined,
    event: 'peer.left',
    params: { peer_id: 'p-1' },
    result: undefined,
    error: undefined,
  });

  const response = parseServerMessage(
    JSON.stringify({ v: 'selvage/1', id: 3, error: { code: 'bad_params' } }),
  );
  assert.equal(response?.id, 3);
  assert.deepEqual(response?.error, {
    code: 'bad_params',
    message: 'the server reported a fault',
  });

  // Anything that is not a JSON object is ignored rather than fatal.
  for (const frame of ['', 'not json', '[]', 'null', '"text"', '42']) {
    assert.equal(parseServerMessage(frame), undefined, frame);
  }
  assert.deepEqual(parseServerMessage('{"v":"selvage/1","id":7,"result":{}}'), {
    v: 'selvage/1',
    id: 7,
    event: undefined,
    params: undefined,
    result: {},
    error: undefined,
  });
});

test('a refusal is terminal when §11 names it so, or when it is in the reserved namespace', () => {
  // §9.1: a refusal a retry cannot change is not retried. The reserved `x.` namespace is
  // terminal whatever it names, so an implementation can refuse without teaching a client its
  // word first, and the bare codes are the four §11 fixes.
  for (const named of [code.roomUnknown, code.tokenInvalid, code.hostPresent, code.roomGone]) {
    assert.equal(isTerminalCode(named), true, named);
  }
  assert.equal(isTerminalCode('x.room_full'), true);
  assert.equal(isTerminalCode('x.anything'), true);
  for (const transient of [code.badMessage, code.badParams, code.helloRequired, code.alreadySeated, undefined]) {
    assert.equal(isTerminalCode(transient), false, String(transient));
  }
});

test('an unreachable /meta is reported as an error the caller can ignore', async () => {
  // No fetch implementation is available at all: the engine treats that as unreachable.
  await assert.rejects(
    fetchMeta('ws://127.0.0.1:1', {
      fetchImpl: () => Promise.reject(new Error('refused')),
    }),
    /refused/,
  );
});
