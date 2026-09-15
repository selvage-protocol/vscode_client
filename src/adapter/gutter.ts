/**
 * A peer's initials, as the small coloured badge the glyph margin shows: what the badge says
 * and the image the editor is handed.
 *
 * The glyph margin is the one place the API draws outside the document's text flow — the
 * `gutterIconPath` image, not an `after` attachment, which is injected text. That image has to
 * be self-contained: a data URI carrying an SVG that draws both the rounded rectangle and the
 * letters, because the resolved gutter background is not exposed and there is no
 * `gutterIconBackgroundColor`. The badge stands beside the line and never covers it.
 *
 * The shape is the Neovim client's sign: the peer's colour behind bold black initials. Only the
 * first two code points of the name are taken, split by code point so an astral character is
 * never cut through the middle of a surrogate pair, and a name with no letters falls back to
 * the same bullet Neovim uses. (Neovim additionally drops the second character when two wide
 * characters will not both fit a two-cell sign; the badge is a square that the SVG scales to,
 * so this keeps both code points and lets `'contain'` do the fitting.)
 *
 * The initials are peer-controlled, so the SVG escapes them rather than letting a name close
 * the `<text>` element.
 */

import type { ThemableDecorationRenderOptions } from 'vscode';

/** The bullet a peer whose name yields no letters is shown by, matching the Neovim client. */
export const ANONYMOUS_INITIALS = '\u2022';

/** How many code points of a name a badge shows. The box is one line-height square. */
export const INITIALS_LIMIT = 2;

/**
 * The one decoration field a badge needs beyond its image, typed against the editor's own
 * option object so a field the API does not have cannot be set here. `'contain'` scales the
 * SVG into the one-line-square glyph cell; `decorations.ts` adds the `gutterIconPath` itself,
 * because the data URI has to be handed to `Uri.parse` and this module imports no editor at
 * runtime.
 */
export const BADGE_OPTIONS: Pick<ThemableDecorationRenderOptions, 'gutterIconSize'> = {
  gutterIconSize: 'contain',
};

/**
 * One cursor to a line: the lowest peer id among the cursors that share it.
 *
 * Glyph-margin icons on one line land in the same lane and are drawn over one another, so
 * several peers on a line produce one badge, not several. Taking the lowest peer id rather
 * than the first or the last makes the choice stable across draws and across windows.
 */
export function onePerLine<T extends { peerId: string }>(
  cursors: readonly T[],
  lineOf: (cursor: T) => number,
): Map<number, T> {
  const chosen = new Map<number, T>();
  for (const cursor of cursors) {
    const line = lineOf(cursor);
    const known = chosen.get(line);
    if (known === undefined || cursor.peerId < known.peerId) {
      chosen.set(line, cursor);
    }
  }
  return chosen;
}

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

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

function escaped(text: string): string {
  return text.replace(/[&<>"']/g, (character) => XML_ESCAPES[character] ?? character);
}

/**
 * The SVG for one badge: a rounded rectangle in the peer's colour, a black stroke, and the
 * initials in bold black over it. The viewBox is square because the glyph margin cell is.
 */
export function badgeSvg(text: string, colour: string): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">' +
    `<rect x="0.5" y="0.5" width="19" height="19" rx="3" fill="${colour}" ` +
    'stroke="#000000" stroke-width="1"/>' +
    '<text x="10" y="14" font-family="monospace" font-size="11" font-weight="bold" ' +
    `text-anchor="middle" fill="#000000">${escaped(text)}</text></svg>`
  );
}

/**
 * The badge as the data URI the editor is handed. Base64 rather than a raw `;utf8,` SVG: the
 * URI is passed through `Uri.parse`, and `#` and quotes in an unencoded SVG are fragile there
 * and in the CSS `url()` it becomes.
 */
export function badgeDataUri(text: string, colour: string): string {
  const svg = badgeSvg(text, colour);
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}
