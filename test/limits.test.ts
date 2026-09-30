/**
 * The listing's ceiling: `PROTOCOL.md` §13.3's two bounds, and the accounting the seal and the
 * walks apply.
 *
 * The numbers are the protocol's and they are written once, in `src/engine/limits.ts`; the
 * grant's names for them and the walk's budget derive from there. What is pinned here is that
 * derivation — a second literal is how the walk and the seal would come to disagree about which
 * listing fits, and how a listing would be published whole by one and cut in silence by the
 * other.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_GRANT_LISTING_BYTES,
  MAX_GRANT_NODES,
  MAX_GRANT_PATHS,
} from '../src/bridge/index.ts';
import {
  LISTING_CEILING,
  MAX_LISTING_BYTES,
  MAX_LISTING_PATHS,
  listingBound,
  listingPathBytes,
} from '../src/engine/index.ts';

test("the ceiling has one home, and the grant's names for it derive from there", () => {
  assert.equal(MAX_LISTING_PATHS, 100_000, "§13.3's path bound is a different number");
  assert.equal(MAX_LISTING_BYTES, 4 * 1024 * 1024, "§13.3's byte bound is a different number");
  assert.deepEqual(LISTING_CEILING, { paths: MAX_LISTING_PATHS, bytes: MAX_LISTING_BYTES });
  assert.equal(MAX_GRANT_PATHS, MAX_LISTING_PATHS, 'the grant keeps a second path bound');
  assert.equal(MAX_GRANT_LISTING_BYTES, MAX_LISTING_BYTES, 'the grant keeps a second byte bound');
  assert.equal(
    MAX_GRANT_NODES,
    2 * MAX_GRANT_PATHS,
    'a shareability check can refuse and name nothing, so the budget is twice the path bound',
  );
});

test('a path is sized in UTF-8 bytes, never in UTF-16 code units', () => {
  assert.equal(listingPathBytes('src/main.rs'), 11);
  assert.equal(listingPathBytes('あ'), 3);
  assert.equal(listingPathBytes('😀'), 4);
  // The shorter count is what a listing of non-ASCII names would slip past the byte bound in.
  assert.notEqual(listingPathBytes('あ'), 'あ'.length);
});

test('a listing is held to the bound that binds first', () => {
  assert.equal(listingBound(LISTING_CEILING, 0, 0, 4), undefined);
  assert.equal(listingBound(LISTING_CEILING, MAX_LISTING_PATHS, 0, 1), 'paths');
  assert.equal(listingBound(LISTING_CEILING, 0, MAX_LISTING_BYTES, 1), 'bytes');
  // The byte bound is inclusive: a listing that lands exactly on it holds one more path of no
  // bytes, and no more than that.
  assert.equal(listingBound(LISTING_CEILING, 1, MAX_LISTING_BYTES - 4, 4), undefined);
  assert.equal(listingBound(LISTING_CEILING, 1, MAX_LISTING_BYTES - 3, 4), 'bytes');
});
