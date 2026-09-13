/**
 * The crossing: bytes from one implementation's library, consumed by the other's code path.
 *
 * The fixture (`spec/vectors/anchors/relative-position.json`) carries one document and the
 * anchor each library publishes for the same caret in it. This suite rebuilds the `yjs` half
 * from real `yjs`, so a fixture that has drifted from the library fails here, and resolves the
 * `yrs` half — the shape the reference client publishes — against a replica of that document.
 * The Rust suite does the same in the other direction, and each side pins what it publishes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as Y from 'yjs';

import { caret } from '../src/engine/presence.ts';
import type { Anchor } from '../src/engine/presence.ts';
import { fakeSession } from './helpers/session.ts';
import { converge, waitForSelection } from './helpers/wait.ts';

/** One library's anchor for the caret, and the offset it denotes. */
interface Published {
  anchor: Anchor;
  offset: number;
}

interface Crossing {
  path: string;
  document: { client: number; text: string; update: string };
  yjs: Published;
  yrs: Published;
}

function fixture(): Crossing {
  const location = new URL(
    '../../../spec/vectors/anchors/relative-position.json',
    import.meta.url,
  );
  return JSON.parse(readFileSync(location, 'utf8')) as Crossing;
}

/** The fixture's document as `yjs` writes it, with the client id the fixture fixes. */
function yjsDocument(crossing: Crossing): { doc: Y.Doc; text: Y.Text } {
  const doc = new Y.Doc();
  doc.clientID = crossing.document.client;
  const text = doc.getText(crossing.path);
  text.insert(0, crossing.document.text);
  return { doc, text };
}

test('the yjs half of the fixture is what yjs emits, byte for byte', () => {
  const crossing = fixture();
  const { doc, text } = yjsDocument(crossing);

  assert.equal(
    Buffer.from(Y.encodeStateAsUpdate(doc)).toString('hex'),
    crossing.document.update,
    'the document bytes are the ones yjs encodes for it',
  );

  const anchor = JSON.parse(
    JSON.stringify(Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, crossing.yjs.offset))),
  ) as Anchor;
  assert.deepEqual(
    anchor,
    crossing.yjs.anchor,
    'a root type gets the scope beside the element',
  );
  const absolute = Y.createAbsolutePositionFromRelativePosition(
    Y.createRelativePositionFromJSON(anchor),
    doc,
  );
  assert.equal(absolute?.index, crossing.yjs.offset, 'and it denotes the offset it says');

  // The `yrs` half is the same position with the scope dropped, which is what the reference
  // client can publish: one element, no root name.
  assert.deepEqual(crossing.yrs.anchor.item, crossing.yjs.anchor.item);
  assert.equal(crossing.yrs.anchor.assoc, crossing.yjs.anchor.assoc);
  assert.equal(crossing.yrs.anchor.tname, undefined, 'no scope, as `yrs` writes it');
  assert.equal(crossing.yrs.offset, crossing.yjs.offset);
});

test("the anchor the reference client publishes resolves through this pipeline", async (t) => {
  const crossing = fixture();
  const session = await fakeSession();
  t.after(async () => {
    await session.host.disconnect();
    await session.guest.disconnect();
    await session.server.stop();
  });
  const { host, guest } = session;
  await host.open(crossing.path);
  await guest.open(crossing.path);

  // The document arrives as the bytes `yjs` encoded for it. Applying them here is what a sync
  // frame from a peer does, minus the socket: this client's own doc update event sends it on,
  // so both replicas hold it.
  const held = guest.getText(crossing.path);
  const doc = held.doc;
  assert.ok(doc !== null, 'a text belongs to a document');
  Y.applyUpdate(doc, Buffer.from(crossing.document.update, 'hex'));
  await converge(host, guest, crossing.path);
  assert.equal(host.text(crossing.path), crossing.document.text);

  // And the peer publishes exactly the anchor the reference client emits for its caret.
  guest.setAwareness({ path: crossing.path, selection: caret(crossing.yrs.anchor) });
  const seen = await waitForSelection(
    host,
    'Bob',
    crossing.path,
    (selection) => selection.anchor === crossing.yrs.offset,
  );
  assert.deepEqual(seen.selection, {
    anchor: crossing.yrs.offset,
    head: crossing.yrs.offset,
  });
});
