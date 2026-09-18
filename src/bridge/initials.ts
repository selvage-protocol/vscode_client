/**
 * The initials a peer is drawn by: the glyph margin's badge, and the badge a room file's own
 * row wears in the Explorer (`participants.ts`). It lives on this side of the seam because
 * both draw it and both are decoration; the web client's grant tree draws the same rule.
 *
 * The initials are peer-controlled and are drawn, so they are bounded here and escaped by
 * whoever puts them in an image or a markup document — the SVG in `src/adapter/gutter.ts`,
 * never a file decoration, which takes the text the editor renders.
 */

/** The bullet a peer whose name yields no letters is shown by, matching the Neovim client. */
export const ANONYMOUS_INITIALS = '\u2022';

/** How many code points of a name a badge shows. The box is one line-height square. */
export const INITIALS_LIMIT = 2;

/**
 * The initials a badge draws: the first `INITIALS_LIMIT` code points of `label`, or the
 * anonymous bullet when there are none.
 *
 * Iterating the string yields whole code points, so a leading astral character is taken whole
 * rather than as half of a surrogate pair — a lone surrogate is text the editor cannot draw and
 * a strict JSON consumer refuses.
 */
export function initials(label: string): string {
  const characters = [...label].slice(0, INITIALS_LIMIT);
  return characters.length === 0 ? ANONYMOUS_INITIALS : characters.join('');
}
