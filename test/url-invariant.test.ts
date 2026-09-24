/**
 * The engine's URL invariant: every base handed between engine components is normalised to a
 * `ws://`/`wss://` scheme-and-authority base — at most a path prefix, the scheme written with
 * `//`, and no credentials, query, fragment or endpoint path — so that a component cannot read
 * a different server out of a base than the component that produced it.
 *
 * The shape that matters most here is the one that shipped: a special-scheme URL needs no
 * `//` (RFC 3986 §3), so `ws:host/session?room=…` parses as `ws://host/session?room=…`. The
 * producer kept the spelling `ws:host`; `metaUrl` matched `^ws(s?)://`, found nothing, and
 * built `ws:host/meta`, which a browser resolves to an `http://host/meta` GET. Every test
 * below is written against that spelling, not against the tidy one.
 *
 * The guard is `sessionBase` plus the `SessionBase` type it is the only producer of; the
 * tests fail if either half goes away. `test/boundary.test.ts` pins the surface, this file
 * pins the invariant that surface is written in.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import WebSocket from 'ws';

import { WIRE_VERSION } from '../src/engine/envelope.ts';
import { LiveSession } from './helpers/live-session.ts';
import {
  fetchMeta,
  metaUrl,
  parseSessionUrl,
  sessionBase,
  sessionUrl,
} from '../src/engine/index.ts';
import type { SessionUrl } from '../src/engine/index.ts';
import type { WebSocketLike } from '../src/engine/transport.ts';
import { baseOf } from './helpers/base.ts';
import { FakeServer } from './helpers/fake-server.ts';

test('a base is read into the one spelling every consumer is written in', () => {
  // The reading is what the URL parser read, not the text as written: an address a link or a
  // person wrote without the `//` a special scheme does not need names the same server.
  for (const [written, base] of [
    ['ws://127.0.0.1:8080', 'ws://127.0.0.1:8080'],
    ['ws:127.0.0.1:8080', 'ws://127.0.0.1:8080'],
    ['wss:selvage.example', 'wss://selvage.example'],
    ['WS://selvage.example/Prefix', 'ws://selvage.example/Prefix'],
    ['ws://127.0.0.1:8080/', 'ws://127.0.0.1:8080'],
    ['ws://127.0.0.1:8080/session', 'ws://127.0.0.1:8080'],
    ['wss://selvage.example/prefix/', 'wss://selvage.example/prefix'],
    ['wss://selvage.example/prefix/session', 'wss://selvage.example/prefix'],
    // The http(s) spelling of the same server: the engine derives it back for `/meta`, and a
    // socket is dialled on the scheme a socket speaks.
    ['http://127.0.0.1:8080', 'ws://127.0.0.1:8080'],
    ['https://selvage.example', 'wss://selvage.example'],
    // The URL parser's own normalisation: ws and wss have default ports.
    ['ws://127.0.0.1:80', 'ws://127.0.0.1'],
    ['wss://selvage.example:443', 'wss://selvage.example'],
  ] as const) {
    assert.equal(sessionBase(written), base, `${written} was not read as ${base}`);
  }

  // What a base may not name is refused rather than read into something else: no authority
  // at all, a scheme that is not a socket's, and anything that would put a different address
  // in the request than the base reads as naming.
  for (const written of [
    '',
    '   ',
    'host:8080',
    '127.0.0.1:8080',
    'ws://',
    '//other:8080',
    '/session',
    'ftp://selvage.example',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'ws://user:pw@selvage.example',
    'ws://selvage.example?room=r',
    'ws://selvage.example#frag',
  ]) {
    assert.equal(sessionBase(written), undefined, `${written} was read as a base`);
  }
});

test('the scheme of a base is a prefix on every base the reader accepts', () => {
  // What every consumer of a base does: `metaUrl` matches `^ws(s?)://` and `sessionUrl`
  // appends the endpoint to the authority. A base that kept a spelling without the `//`
  // would leave the first unmatched — `ws:host/meta`, which a browser resolves to a
  // cleartext GET — and put the second's path in the wrong place.
  for (const written of [
    'ws:host:8080',
    'ws:host:8080/session',
    'wss:selvage.example/prefix',
    'WS://host',
    'http://host',
    'https://host/',
    'ws://host/',
  ]) {
    const base = sessionBase(written);
    assert.ok(base !== undefined, `${written} was refused`);
    assert.match(base, /^wss?:\/\/[^/]/, `${written} reads as ${base}`);
    assert.match(sessionUrl(base), /^wss?:\/\/[^/]/, `${written} dials as ${sessionUrl(base)}`);
    assert.match(metaUrl(base), /^https?:\/\/[^/]/, `${written} reads /meta at ${metaUrl(base)}`);
  }
});

test('the base a session URL is taken apart into is the one the engine dials', () => {
  // The paste that shipped: a wire invite left without the `//`. `parseSessionUrl` is the
  // boundary a paste crosses, so the base it hands back is already the engine's.
  for (const [written, base] of [
    ['ws:host:8080/session?room=r&token=t', 'ws://host:8080'],
    ['wss:host/prefix/session?room=r&token=t', 'wss://host/prefix'],
    ['ws://host/session?room=r&token=t', 'ws://host'],
  ] as const) {
    const parsed = parseSessionUrl(written);
    assert.equal(parsed?.base, base, `${written} was taken apart into ${parsed?.base}`);
    assert.equal(parsed?.join.room, 'r');
    assert.equal(parsed?.join.token, 't');
  }
  // A URL off the endpoint, and one whose base names no server, are not session URLs.
  assert.equal(parseSessionUrl('ws://host/meta'), undefined);
  assert.equal(parseSessionUrl('ws:///session?room=r&token=t'), undefined);
  assert.equal(parseSessionUrl('not a url'), undefined);
});

test('a host address spelled without the `//` dials and reads /meta as one server', async (t) => {
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  const dialled: string[] = [];
  const metaReads: string[] = [];
  const engine = await LiveSession.host(
    // The bug's shape, against the fake server's own base with the `//` taken out.
    server.wsBase.replace('ws://', 'ws:'),
    'Ada',
    {
      client: 'selvage-test/0.1.0',
      fetchImpl: fakeFetch(metaReads),
      webSocketFactory: (url) => {
        dialled.push(url);
        return new WebSocket(url) as unknown as WebSocketLike;
      },
    },
  );
  t.after(async () => {
    await engine.disconnect();
  });

  // The dial is the one thing this pins: an address spelled without `//` is the same server.
  assert.deepEqual(dialled, [`${server.wsBase}/session`]);
  // And the base the session carries is the one every consumer reads, not the spelling the
  // caller happened to pass.
  assert.equal(engine.session().baseUrl, server.wsBase);
});

test('an invite pasted without the `//` joins on the server it names', async (t) => {
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  const host = await LiveSession.host(server.wsBase, 'Ada');
  t.after(async () => {
    await host.disconnect();
  });
  const invite = host.inviteUrl();
  assert.ok(invite !== undefined, 'the host published no invite');
  const pasted = invite.replace(`${server.wsBase}/session`, `${server.wsBase.replace('ws://', 'ws:')}/session`);

  const guest = await LiveSession.join(pasted, 'Bob');
  t.after(async () => {
    await guest.disconnect();
  });

  assert.equal(guest.session().baseUrl, server.wsBase);
  assert.equal(guest.session().role, 'guest');
  // The room the paste named, not a room minted because the address read as something else.
  assert.equal(guest.session().roomId, host.session().roomId);
});

test('the /meta read reads its own address the way the engine reads a base', async () => {
  const metaReads: string[] = [];
  const meta = await fetchMeta('ws:selvage.example:8080/prefix', {
    fetchImpl: fakeFetch(metaReads),
  });
  assert.deepEqual(meta.wire_versions, [WIRE_VERSION]);
  assert.deepEqual(metaReads, ['http://selvage.example:8080/prefix/meta']);

  await assert.rejects(
    fetchMeta('host:8080', { fetchImpl: fakeFetch([]) }),
    /not a session address/,
  );
});

/**
 * A `fetch` that records the URL it was asked for and answers `/meta` with one wire version.
 * The engine reads only `response.json()`, so nothing here speaks HTTP.
 */
function fakeFetch(reads: string[]): typeof fetch {
  const meta = { server: 'fake-selvaged/0.0.0', wire_versions: [WIRE_VERSION] };
  return ((url: string | URL) => {
    reads.push(String(url));
    return Promise.resolve({ json: () => Promise.resolve(meta) });
  }) as unknown as typeof fetch;
}

/**
 * The compile-time half of the invariant: `SessionBase` is produced only by `sessionBase`,
 * so a raw string — a base no component has read — does not satisfy the components that
 * read a base. `tsc` runs over this file in the repository's own checks
 * (`scripts/ci-local.sh`), and each `@ts-expect-error` below fails the typecheck when the
 * brand is removed: an unused directive is an error.
 */
function rawStringsAreNotBases(): void {
  // @ts-expect-error a raw string is not a base any component has read
  void sessionUrl('ws://host');
  // @ts-expect-error a raw string is not a base any component has read
  void metaUrl('ws://host');
  // @ts-expect-error a raw string is not a base any component has read
  const writtenAsTheLinkWroteIt: SessionUrl = { base: 'ws://host', join: {} };
  void writtenAsTheLinkWroteIt;
  void baseOf('ws://host');
}
void rawStringsAreNotBases;
