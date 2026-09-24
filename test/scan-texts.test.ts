/**
 * The facade's scan after a content frame (`peer-engine.ts`): a document no transaction touched
 * is not read again, so a peer moving a caret reads no document at all and a keystroke reads the
 * one it changed — while every change still reaches the adapter as `documentChanged`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PeerEngine } from '../src/bridge/peer-engine.ts';
import { RelaySession } from '../src/engine/relay.ts';
import { FakeServer } from './helpers/fake-server.ts';
import { waitFor } from './helpers/wait.ts';

const KEEPALIVE = { awareness_renew_ms: 50, awareness_expire_ms: 5000 };
const A = 'a.txt';
const B = 'b.txt';

test('selvage/2: a frame reads only the documents it changed, and reports each change', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const host = await RelaySession.host({
    baseUrl: server.wsBase,
    displayName: 'Ada',
    listing: () => [A, B],
    keepalive: KEEPALIVE,
  });
  t.after(() => {
    host.disconnect();
  });
  const invite = host.invite();
  assert.ok(invite !== undefined);
  const engine = await PeerEngine.join({ invite, displayName: 'Bob', keepalive: KEEPALIVE });
  t.after(() => {
    void engine.disconnect();
  });
  await waitFor("the guest to apply the host's state", () =>
    engine.grantedPaths().length > 0 ? true : false,
  );
  // The guest holds both documents before the host types, as an adapter does once it opens
  // them. A path nobody on this side has read arrives as a Yjs placeholder that becomes its
  // `Y.Text` only when first read, with no frame to scan it on if the room is then quiet: that is
  // the replica's shape and not this scan's, and it is not what this test is about.
  engine.text(A);
  engine.text(B);
  const changed: string[] = [];
  engine.on((event) => {
    if (event.type === 'documentChanged') {
      changed.push(event.path);
    }
  });
  assert.ok(await host.insert(A, 0, 'alpha\n'));
  assert.ok(await host.insert(B, 0, 'beta\n'));
  // The facade's own report, and not the replica, is what says the scans for them have run.
  await waitFor('both documents to be reported', () =>
    engine.text(A) === 'alpha\n' &&
    engine.text(B) === 'beta\n' &&
    changed.includes(A) &&
    changed.includes(B)
      ? true
      : false,
  );
  changed.length = 0;

  // Count the replica reads the scan makes, per path, from here on; this test's own reads of
  // the text it waits for are not the scan's and are made with the count off.
  const reads = new Map<string, number>();
  let counting = true;
  const original = RelaySession.prototype.text;
  RelaySession.prototype.text = function (this: RelaySession, path: string): string {
    if (counting) {
      reads.set(path, (reads.get(path) ?? 0) + 1);
    }
    return original.call(this, path);
  };
  const quietly = (path: string): string => {
    counting = false;
    try {
      return engine.text(path);
    } finally {
      counting = true;
    }
  };
  t.after(() => {
    RelaySession.prototype.text = original;
  });

  // A caret move is an awareness-only content frame: no document is read for it.
  host.setSelection(A, { anchor: 1, head: 3 });
  await waitFor('the caret to arrive', () =>
    engine.presence().some((record) => record.state?.selection !== undefined) ? true : false,
  );
  assert.equal(reads.get(A) ?? 0, 0, 'a caret move read a document');
  assert.equal(reads.get(B) ?? 0, 0, 'a caret move read a document');

  // A keystroke in A reads A, reports A, and leaves B alone.
  assert.ok(await host.insert(A, 5, '!'));
  await waitFor('the edit to arrive', () => (quietly(A) === 'alpha!\n' ? true : false));
  await waitFor('the change to be reported', () => (changed.includes(A) ? true : false));
  assert.equal(reads.get(B) ?? 0, 0, 'an edit to A read B');
  assert.deepEqual([...new Set(changed)], [A]);

  // And B still reports its own change when it has one.
  assert.ok(await host.insert(B, 0, '>'));
  await waitFor('B to be reported', () => (changed.includes(B) ? true : false));
  assert.equal(quietly(B), '>beta\n');
});
