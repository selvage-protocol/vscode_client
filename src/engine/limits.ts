/**
 * The listing's ceiling: the two bounds `PROTOCOL.md` §13.3 holds a listing to, and the
 * accounting that applies them.
 *
 * The bounds are the **receiver's** — no server holds a listing, and a listing is one sealed
 * frame — but the host is the one that enumerates and seals it, so the seal and every walk that
 * feeds it have to agree: a walk that stopped somewhere else would hand the seal an array it
 * shortens in silence, and the cut the host's own window reports would name a bound that is not
 * the one that bound.
 */

/** §13.3's second bound: the most paths one listing carries. */
export const MAX_LISTING_PATHS = 100_000;

/** §13.3's third bound: the path bytes one listing may carry. */
export const MAX_LISTING_BYTES = 4 * 1024 * 1024;

/** The two bounds as one value, so a walk and the seal are handed the same ceiling. */
export interface ListingCeiling {
  readonly paths: number;
  readonly bytes: number;
}

/** §13.3's ceiling, for a caller that applies the protocol's own bounds. */
export const LISTING_CEILING: ListingCeiling = {
  paths: MAX_LISTING_PATHS,
  bytes: MAX_LISTING_BYTES,
};

/** Which of the two bounds a listing did not fit inside. */
export type ListingBound = 'paths' | 'bytes';

const ENCODER = new TextEncoder();

/**
 * A path's size in the unit §13.3's third bound counts. UTF-8 bytes, never `path.length`,
 * which counts UTF-16 code units: a room of non-ASCII names is two to three times its length
 * on the wire, so the shorter count would let a listing through at a multiple of its bound.
 */
export function listingPathBytes(path: string): number {
  return ENCODER.encode(path).length;
}

/**
 * Which bound a listing of `count` paths carrying `bytes` hits before it takes one more of
 * `size` bytes, or `undefined` when it holds it.
 *
 * One rule for the seal and the walks: the caller that enumerates stops where the caller that
 * seals would, so a listing is never published whole by one and cut by the other.
 */
export function listingBound(
  ceiling: ListingCeiling,
  count: number,
  bytes: number,
  size: number,
): ListingBound | undefined {
  if (count >= ceiling.paths) {
    return 'paths';
  }
  if (bytes + size > ceiling.bytes) {
    return 'bytes';
  }
  return undefined;
}
