/** The wire layer on its own: versions, URLs, envelope parsing, error codes. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_KEEPALIVE,
  WIRE_VERSION,
  close,
  closeCodeFor,
  code,
  event,
  grantParams,
  isCompatible,
  isTerminalCode,
  method,
  parsePeer,
  parsePeerEvent,
  parsePeerRenamed,
  parseServerMessage,
  parseVersion,
  renameParams,
} from '../src/engine/envelope.ts';
import { fetchMeta, hostVersion, metaAccepts } from '../src/engine/meta.ts';
import type { Meta } from '../src/engine/envelope.ts';
import { baseOf } from './helpers/base.ts';
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

  // The parse is the grammar of §10: `selvage/` major [ "." minor ], the minor defaulting to 0.
  assert.deepEqual(parseVersion('selvage/1'), [1, 0]);
  assert.deepEqual(parseVersion('selvage/1.9'), [1, 9]);
  assert.equal(parseVersion('selvage/1.2.3'), undefined);
});

test('the wire version grammar is the one §10 and the schema fix', () => {
  // `wireVersion` in `schema/negotiation.json`:
  //   ^selvage/(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*))?$
  // CANONICAL.md §2.5 writes the numbers as §2.4 does, so a leading zero is not in the
  // grammar — `selvage/1.0` is, and so is `selvage/0`, but `selvage/01` and `selvage/1.02`
  // are strings §10 refuses alongside `selvage/2`.
  assert.deepEqual(parseVersion('selvage/0'), [0, 0]);
  assert.deepEqual(parseVersion('selvage/0.0'), [0, 0]);
  assert.deepEqual(parseVersion('selvage/1.0'), [1, 0]);
  assert.deepEqual(parseVersion('selvage/10.20'), [10, 20]);

  const malformed = [
    'selvage/01',
    'selvage/00',
    'selvage/1.01',
    'selvage/1.00',
    'selvage/1.2.3',
    'selvage/1..2',
    'selvage/1.',
    'selvage/.1',
    'selvage/-1',
    'selvage/+1',
    'selvage/1e2',
    'selvage/ 1',
    'selvage/1 ',
    'selvage/1.0 ',
    'SELVAGE/1',
    'xselvage/1',
    'selvage',
    'selvage/',
    'selvage//1',
    '',
  ];
  for (const version of malformed) {
    assert.equal(parseVersion(version), undefined, version);
    assert.equal(isCompatible(version), false, version);
  }

  // `/meta` decides on the same grammar: an advertised string outside it is not a version
  // the client can speak, so it decides nothing (§2.1, §10).
  assert.equal(metaAccepts({ wire_versions: ['selvage/01'] }), false);
  assert.equal(metaAccepts({ wire_versions: ['selvage/01', 'selvage/1'] }), true);
  assert.equal(metaAccepts({ wire_versions: ['selvage/2', 'selvage/1.2.3'] }), false);
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
  for (const recoverable of [
    code.badMessage,
    code.badParams,
    'close_1006',
    'X.room_full',
    '',
  ]) {
    assert.equal(isTerminalCode(recoverable), false, recoverable);
  }
  assert.equal(isTerminalCode(undefined), false);

  // §9.1: a refusal in the reserved `x.` namespace is a stop as well, whatever it means —
  // the namespace is how an implementation refuses without teaching every client its word.
  for (const reserved of [
    'x.server_full',
    'x.room_full',
    'x.something.invented.later',
    'x.',
  ]) {
    assert.equal(isTerminalCode(reserved), true, reserved);
  }
});

test('the invite URL is the connection URL, and is taken apart again', () => {
  const invite = sessionUrl(baseOf('ws://127.0.0.1:8080'), 'room 1', 't/k');
  assert.equal(invite, 'ws://127.0.0.1:8080/session?room=room%201&token=t%2Fk');

  const parsed = parseSessionUrl(invite);
  assert.ok(parsed !== undefined);
  assert.equal(parsed.base, 'ws://127.0.0.1:8080');
  assert.equal(parsed.join.room, 'room 1');
  assert.equal(parsed.join.token, 't/k');

  // A host connection carries no room, and a URL off the endpoint is not a session URL.
  assert.equal(sessionUrl(baseOf('ws://h/'), undefined, undefined), 'ws://h/session');
  assert.equal(
    sessionUrl(baseOf('wss://h/prefix'), 'r', undefined),
    'wss://h/prefix/session?room=r',
  );
  assert.equal(parseSessionUrl('ws://h/meta'), undefined);
  assert.equal(parseSessionUrl('not a url'), undefined);

  // Unknown query parameters are ignored, so a client may attach its own (§5.1).
  assert.deepEqual(parseJoinQuery('extra=1&room=r'), { room: 'r' });
  assert.deepEqual(parseJoinQuery(''), {});

  // Percent decoding is byte-wise and RFC 3986's: `%XX` is the only escape, and a literal
  // '+' is '+', never a space (PROTOCOL.md §5.1), as the reference decoder has it.
  assert.equal(percentDecode('a+b'), 'a+b');
  assert.equal(percentDecode('a%2Bb'), 'a+b');
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
    inviteUrl({ baseUrl: baseOf('ws://h'), roomId: 'r', token: 'tok' }),
    'ws://h/session?room=r&token=tok',
  );
  assert.equal(inviteUrl({ baseUrl: baseOf('ws://h'), roomId: 'r' }), undefined);
  assert.equal(metaUrl(baseOf('ws://h:9/')), 'http://h:9/meta');
  assert.equal(metaUrl(baseOf('wss://h')), 'https://h/meta');
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

test('the rename request and its event are the names and shapes §5 and §6 fix', () => {
  assert.equal(method.rename, 'session.rename');
  assert.equal(event.peerRenamed, 'peer.renamed');

  // The request carries one member, built the way `helloParams` is.
  assert.deepEqual(renameParams({ displayName: 'Ada Lovelace' }), {
    display_name: 'Ada Lovelace',
  });

  // `peer.renamed` is the minimal pair; both members are required, so a partial frame is
  // ignored rather than read as a rename of nobody (a missing `role` cannot be invented).
  assert.deepEqual(parsePeerRenamed({ peer_id: 'p-1', display_name: 'Ada' }), {
    peer_id: 'p-1',
    display_name: 'Ada',
  });
  assert.equal(parsePeerRenamed({ peer_id: 'p-1' }), undefined);
  assert.equal(parsePeerRenamed({ display_name: 'Ada' }), undefined);
  assert.equal(parsePeerRenamed({ peer_id: 'p-1', display_name: 7 }), undefined);
  assert.equal(parsePeerRenamed(undefined), undefined);
});

test('the grant request and its event are the names and shapes §5 and §6.3 fix', () => {
  assert.equal(method.docGrant, 'doc.grant');
  assert.equal(event.docGranted, 'doc.granted');

  // The listing is copied, so a caller cannot mutate the frame it is about to send, and the
  // order it is given is the order it is written: a publisher's claim, not this client's.
  const paths = ['README.md', '\u{1F600}.txt', 'ｆ.txt'];
  const params = grantParams({ paths });
  assert.deepEqual(params, { paths });
  paths.push('src/main.rs');
  assert.deepEqual(params.paths, ['README.md', '\u{1F600}.txt', 'ｆ.txt']);
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

/** The `MINT`/`refused` pairs of `/meta` against a hosting client, for the table below. */
const mint = (version: string) => ({ outcome: 'mint', version });
const refused = (reason: string, offered: string[], pin?: string) => ({
  outcome: 'refuse',
  reason,
  offered,
  ...(pin === undefined ? {} : { pin }),
});

test('which version a hosting client mints at is /meta\u2019s answer, or its setting\u2019s pin', () => {
  const both = { wire_versions: ['selvage/1', 'selvage/2'] };
  const version1Only = { wire_versions: ['selvage/1'] };

  // §2: a client that can speak `selvage/2` mints it wherever the list holds it, and the list is
  // the server's word about what it seats — the case a version is not written down for.
  assert.deepEqual(hostVersion(both), mint('selvage/2'));
  assert.deepEqual(hostVersion({ wire_versions: ['selvage/2'] }), mint('selvage/2'));
  // §10's compatibility rule is the major's alone above 0.x, so a server that seats `selvage/2.1`
  // seats this client, which speaks `selvage/2`.
  assert.deepEqual(hostVersion({ wire_versions: ['selvage/2.1'] }), mint('selvage/2'));
  assert.deepEqual(
    hostVersion({ wire_versions: ['selvage/1', 'selvage/2.7'] }),
    mint('selvage/2'),
  );
  // A `/meta` that could not be read is not an answer that the server refuses this version: the
  // attempt is made and the handshake decides (§2, §10).
  assert.deepEqual(hostVersion(undefined), mint('selvage/2'));
  // A body that says nothing about versions is the same non-answer `metaAccepts` reads it as.
  assert.deepEqual(hostVersion({}), mint('selvage/2'));
  assert.deepEqual(hostVersion({ wire_versions: [] }), mint('selvage/2'));
  // A membership that is not a version is not an answer either: the body is JSON this client does
  // not control, and what it can read of the list is still read.
  assert.deepEqual(
    hostVersion({ wire_versions: [7] } as unknown as Meta),
    mint('selvage/2'),
  );
  assert.deepEqual(
    hostVersion({ wire_versions: [7, 'selvage/2'] } as unknown as Meta),
    mint('selvage/2'),
  );

  // An answer without it is a refusal: the encrypted wire is what this client hosts at, and a
  // fall back to `selvage/1` would mint exactly the room the version exists to prevent.
  assert.deepEqual(hostVersion(version1Only), refused('not-seated', ['selvage/1']));
  // A version outside the grammar is not one the server has said it seats (§10).
  assert.deepEqual(
    hostVersion({ wire_versions: ['selvage/01', 'selvage/1.2.3'] }),
    refused('not-seated', ['selvage/01', 'selvage/1.2.3']),
  );
  assert.deepEqual(hostVersion({ wire_versions: ['selvage/1.4'] }), refused('not-seated', ['selvage/1.4']));

  // A pin is the host's own deliberate choice, and it outranks what the server advertises.
  assert.deepEqual(hostVersion(both, 'selvage/1'), mint('selvage/1'));
  assert.deepEqual(hostVersion(both, 'selvage/2'), mint('selvage/2'));
  assert.deepEqual(hostVersion(undefined, 'selvage/2'), mint('selvage/2'));
  assert.deepEqual(hostVersion(undefined, 'selvage/1'), mint('selvage/1'));
  assert.deepEqual(
    hostVersion(version1Only, 'selvage/2'),
    refused('pin-not-seated', ['selvage/1'], 'selvage/2'),
  );
  // A server that seats only the encrypted wire cannot seat the readable one, and a pin there is
  // a refusal rather than a connection that would be refused at the handshake anyway.
  assert.deepEqual(
    hostVersion({ wire_versions: ['selvage/2'] }, 'selvage/1'),
    refused('pin-not-seated', ['selvage/2'], 'selvage/1'),
  );
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
