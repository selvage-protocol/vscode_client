/**
 * The room's seats, and the colour each one wears.
 *
 * `DESIGN.md` §4.3 leaves a peer's colour to the adapter. `peerColour` derives one from the peer id
 * and repeats past eight, so a six-person room can show three faces in one fill and no seat is
 * reliably the host's. A client that knows the room's seat order colours the *seat* instead, so a
 * room of thirteen or fewer gives every person a fill of their own, and the host is always Mauve.
 *
 * Yellow is left out and reserved: the host's crown is drawn in it, and a face filled with it would
 * swallow the mark.
 */

import type { Role } from '../engine/envelope.ts';

/** The thirteen accents, in the order the seats take them. */
export const SEAT_PALETTE = [
  '#cba6f7', // mauve
  '#94e2d5', // teal
  '#f5e0dc', // rosewater
  '#f2cdcd', // flamingo
  '#f5c2e7', // pink
  '#f38ba8', // red
  '#eba0ac', // maroon
  '#fab387', // peach
  '#a6e3a1', // green
  '#89dceb', // sky
  '#74c7ec', // sapphire
  '#89b4fa', // blue
  '#b4befe', // lavender
] as const;

/** How many seats the palette fills: a seat past its end keeps the colour the bridge gave it. */
export const SEAT_LIMIT = SEAT_PALETTE.length;

/** One person, as the seat order reads them. */
export interface Seat {
  peerId: string;
  role: Role;
}

/**
 * The colour each seat wears, keyed by peer id.
 *
 * The host's seat leads whatever position it holds in `seats`, and every other seat keeps the order
 * it came in. The caller hands the room over as its own roster draws it (your own seat first, then
 * the room's people), so the host is Mauve, the seat beside it Teal, and the faces read in the same
 * order as the colours.
 *
 * A seat past the palette's end, and a peer the list does not name at all, is left out rather than
 * guessed at: whatever draws them then keeps `peerColour`.
 */
export function seatColours(seats: readonly Seat[]): Map<string, string> {
  const host = seats.find((seat) => seat.role === 'host');
  const order = host === undefined ? seats : [host, ...seats.filter((seat) => seat !== host)];
  const colours = new Map<string, string>();
  order.slice(0, SEAT_LIMIT).forEach((seat, index) => {
    colours.set(seat.peerId, SEAT_PALETTE[index]);
  });
  return colours;
}
