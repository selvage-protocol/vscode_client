/** The wire layer on its own: versions, URLs, envelope parsing, error codes. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_KEEPALIVE,
  WIRE_VERSION,
  close,
  closeCodeFor,
  code,
  isCompatible,
  isTerminalCode,
  parsePeer,
  parsePeerEvent,
  parseServerMessage,
  parseVersion,
} from '../src/engine/envelope.ts';
import { fetchMeta, metaAccepts } from '../src/engine/meta.ts';
import {
  inviteUrl,
  metaUrl,
  parseJoinQuery,
  parseSessionUrl,
  percentDecode,
  percentEncode,
  sessionUrl,
} from '../src/engine/urls.ts';

test('version compatibility is same-major, and the minor is decisive only at 0.x', () => {
  assert.equal(WIRE_VERSION, 'selvage/1');
  assert.equal(isCompatible('selvage/1'), true);
  assert.equal(isCompatible('selvage/1.0'), true);
  assert.equal(isCompatible('selvage/1.9'), true);
  assert.equal(isCompatible('selvage/2'), false);
  assert.equal(isCompatible('selvage/0.1'), false);
  assert.equal(isCompatible('selvage'), false);
  assert.equal(isCompatible('selvage/'), false);
  assert.equal(isCompatible('selvage/x'), false);
  assert.equal(isCompatible('selvage/1.'), false);
  assert.equal(isCompatible('other/1'), false);
  assert.equal(isCompatible(''), false);

  // The parse mirrors `impl/crates/protocol/src/lib.rs`: the minor defaults to 0.
  assert.deepEqual(parseVersion('selvage/1'), [1, 0]);
  assert.deepEqual(parseVersion('selvage/1.9'), [1, 9]);
  assert.equal(parseVersion('selvage/1.2.3'), undefined);
});

test('a fatal session error code pairs with the close code the server uses', () => {
  assert.equal(closeCodeFor(code.roomUnknown), close.roomUnknown);
  assert.equal(closeCodeFor(code.tokenInvalid), close.tokenInvalid);
  assert.equal(closeCodeFor(code.roomGone), close.roomGone);
  assert.equal(closeCodeFor(code.hostPresent), close.hostPresent);
  assert.equal(closeCodeFor(code.unsupportedVersion), close.unsupportedVersion);
  assert.equal(closeCodeFor(code.badParams), close.protocolError);

  // §9.1: retrying one of these cannot help; the rest can.
  for (const fatal of [
    code.roomUnknown,
    code.tokenInvalid,
    code.hostPresent,
    code.unsupportedVersion,
    code.roomGone,
  ]) {
    assert.equal(isTerminalCode(fatal), true, fatal);
  }
  for (const recoverable of [code.badMessage, code.badParams, 'close_1006']) {
    assert.equal(isTerminalCode(recoverable), false, recoverable);
  }
  assert.equal(isTerminalCode(undefined), false);
});

test('the invite URL is the connection URL, and is taken apart again', () => {
  const invite = sessionUrl('ws://127.0.0.1:8080', 'room 1', 't/k');
  assert.equal(invite, 'ws://127.0.0.1:8080/session?room=room%201&token=t%2Fk');

  const parsed = parseSessionUrl(invite);
  assert.ok(parsed !== undefined);
  assert.equal(parsed.base, 'ws://127.0.0.1:8080');
  assert.equal(parsed.join.room, 'room 1');
  assert.equal(parsed.join.token, 't/k');

  // A host connection carries no room, and a URL off the endpoint is not a session URL.
  assert.equal(sessionUrl('ws://h/', undefined, undefined), 'ws://h/session');
  assert.equal(
    sessionUrl('wss://h/prefix', 'r', undefined),
    'wss://h/prefix/session?room=r',
  );
  assert.equal(parseSessionUrl('ws://h/meta'), undefined);
  assert.equal(parseSessionUrl('not a url'), undefined);

  // Unknown query parameters are ignored, so a client may attach its own (§5.1).
  assert.deepEqual(parseJoinQuery('extra=1&room=r'), { room: 'r' });
  assert.deepEqual(parseJoinQuery(''), {});

  // Percent decoding is byte-wise and '+' is a space, as the reference implementation has it.
  assert.equal(percentDecode('a+b'), 'a b');
  assert.equal(percentDecode('%E2%9C%93'), '✓');
  assert.equal(percentDecode('100%'), '100%');
  assert.equal(percentDecode('%2'), '%2');
  // A URL is bytes: what is not escaped is UTF-8 too, so a literal non-ASCII character
  // survives rather than being read as one byte per UTF-16 code unit.
  assert.equal(percentDecode('r%C3%A4um'), 'räum');
  assert.equal(percentDecode('räum'), 'räum');
  assert.equal(percentDecode('😀'), '😀');
  assert.equal(percentEncode('a b/c~d'), 'a%20b%2Fc~d');
  assert.equal(percentDecode(percentEncode('üñî ✓')), 'üñî ✓');

  assert.equal(
    inviteUrl({ baseUrl: 'ws://h', roomId: 'r', token: 'tok' }),
    'ws://h/session?room=r&token=tok',
  );
  assert.equal(inviteUrl({ baseUrl: 'ws://h', roomId: 'r' }), undefined);
  assert.equal(metaUrl('ws://h:9/'), 'http://h:9/meta');
  assert.equal(metaUrl('wss://h'), 'https://h/meta');
});

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

test('peer records are read where they are, or wrapped in an event', () => {
  const peer = {
    peer_id: 'p-1',
    display_name: 'Ada',
    role: 'host',
    awareness_client_id: 42,
  };
  assert.deepEqual(parsePeer(peer), peer);
  assert.deepEqual(parsePeerEvent({ peer }), peer);
  assert.deepEqual(parsePeerEvent(peer), peer);
  assert.equal(parsePeer({ peer_id: 'p-1' }), undefined);
  assert.equal(parsePeerEvent(undefined), undefined);
  // An unknown role is not a reason to drop a peer; it is read as a guest.
  assert.deepEqual(parsePeer({ ...peer, role: 'x.host' }), {
    peer_id: 'p-1',
    display_name: 'Ada',
    role: 'guest',
    awareness_client_id: 42,
  });
});

test('/meta decides compatibility, and saying nothing about versions decides nothing', () => {
  assert.equal(metaAccepts({ wire_versions: ['selvage/1'] }), true);
  assert.equal(metaAccepts({ wire_versions: ['selvage/1.4'] }), true);
  assert.equal(metaAccepts({ wire_versions: ['selvage/2'] }), false);
  assert.equal(metaAccepts({ wire_versions: [] }), true);
  assert.equal(metaAccepts({}), true);

  assert.equal(DEFAULT_KEEPALIVE.awareness_renew_ms, 15_000);
  assert.equal(DEFAULT_KEEPALIVE.awareness_expire_ms, 30_000);
  assert.equal(DEFAULT_KEEPALIVE.ping_interval_ms, 30_000);
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
