/**
 * The crossing: bytes from one implementation's library, consumed by the other's code path.
 *
 * The fixture is vendored at `test/fixtures/anchors/relative-position.json`, or taken from a
 * `specification` checkout named by `SELVAGE_VECTORS`. It carries one document and the
 * anchor each library publishes for the same caret in it. This suite rebuilds the `yjs` half
 * from real `yjs`, so a fixture that has drifted from the library fails here, and resolves the
 * `yrs` half — the shape the reference client publishes — against a replica of that document.
 * The Rust suite does the same in the other direction, and each side pins what it publishes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as Y from 'yjs';

import { caret, toRelativePosition } from '../src/engine/presence.ts';
import type { Anchor } from '../src/engine/presence.ts';

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

const VENDORED = resolve(import.meta.dirname, 'fixtures');

function fixture(): Crossing {
  const override = process.env.SELVAGE_VECTORS;
  const root = override !== undefined && override !== '' ? override : VENDORED;
  const location = resolve(root, 'anchors', 'relative-position.json');
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

test("the anchor the reference client publishes resolves through this pipeline", () => {
  const crossing = fixture();
  // The replica the anchor resolves against is built from the fixture's own bytes, which is
  // what a content frame from the reference client carries.
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(crossing.document.update, 'hex'));
  assert.equal(doc.getText(crossing.path).toString(), crossing.document.text);

  // §8.1: the anchor the reference client publishes resolves here to the offset it denotes —
  // through this client's own reading of an anchor, which is the whole of what the crossing is.
  const absolute = Y.createAbsolutePositionFromRelativePosition(
    toRelativePosition(crossing.yrs.anchor),
    doc,
  );
  assert.equal(absolute?.index, crossing.yrs.offset, 'the reference anchor did not resolve');

  // And the same anchor is what this pipeline publishes for that caret: `caret` maps the offset
  // this client resolved back onto the anchor it sends, which is the round trip in reverse.
  const published = caret(crossing.yrs.anchor);
  assert.deepEqual(published, { anchor: crossing.yrs.anchor, head: crossing.yrs.anchor });
});
