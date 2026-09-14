/**
 * A peer's name, as a decoration attachment: what the editor is told to draw, and how.
 *
 * The attachment is the only place a name can live. `TextEditorDecorationType` is an opaque
 * handle and `DecorationOptions` has just `before` and `after`, so a zero-width caret range
 * with an `after` attachment is the whole vocabulary, and everything about how the name *looks*
 * has to be said in that attachment. There are three answers, and the default draws nothing:
 *
 * - `none` — the name is not drawn in the document at all. The peer is still visible: their
 *   caret is a bar in their colour, their selection a tint of it, the overview ruler carries a
 *   tick where they are, the caret's `hoverMessage` names them, and the status bar lists the
 *   room. This is the default, because any label in the line reads as the document's own text
 *   and one above it covers the line — the complaint the floating label was drawn to answer.
 * - `floating` — a small coloured box above the caret, out of the line's flow. The public API
 *   has no position, layer or overlay, so this is done by writing declarations into
 *   `textDecoration`; see `FLOATING_DECLARATIONS`. It is an explicit opt-in and it *does*
 *   cover the line above the caret, which is the trade.
 * - `chip` — the same attachment in documented fields only: background, colour, bold, a border.
 *   It draws in the line, so it covers the text it sits against; it is the documented fallback
 *   if the floating declarations ever stop being drawn.
 *
 * Whatever a mode draws is bounded: a name is peer-controlled and unbounded, so `boundedLabel`
 * clips it before it becomes text the editor measures. The full name is never lost — the caret
 * keeps its `hoverMessage` and the status bar lists the room — only the drawn copy is clipped.
 *
 * The option objects below are a value rather than an editor-only effect: this module imports
 * `vscode` for its types alone, so the tests can build them without an editor — and it sits in
 * `src/adapter/` rather than `src/bridge/` because these are VS Code's option names. The bridge
 * is vendored by the Neovim client, which has no use for them.
 */

import type { ThemableDecorationAttachmentRenderOptions } from 'vscode';

import type { Cursor } from '../bridge/index.ts';

/** How a peer's name is drawn. The values are the `selvage.cursorLabel` setting's values. */
export type LabelMode = 'none' | 'floating' | 'chip';

/** The mode a window gets with nothing configured: no name over the document. */
export const DEFAULT_LABEL_MODE: LabelMode = 'none';

/** Reads the `selvage.cursorLabel` setting. Anything unrecognised is the default. */
export function labelMode(value: unknown): LabelMode {
  if (value === 'floating' || value === 'chip') {
    return value;
  }
  return DEFAULT_LABEL_MODE;
}

/**
 * The longest name a label draws, in code points.
 *
 * The decoration API measures nothing, so a width here can only be a guess; what the bound
 * buys is that the guess cannot be defeated by the length of a name the peer chose. Twenty-four
 * code points is a few words at the editor's own font size, which is what a name is.
 */
export const LABEL_LIMIT = 24;

/**
 * A name clipped to `LABEL_LIMIT` code points with a trailing ellipsis, or the name itself when
 * it already fits.
 *
 * The clip is by code point, not by UTF-16 unit: a name may hold an astral character, and
 * cutting between the halves of a surrogate pair would leave a lone surrogate in the string —
 * text the editor cannot draw and a strict JSON consumer refuses. Iterating the string yields
 * whole code points, so a pair is never split.
 */
export function boundedLabel(label: string): string {
  const characters = [...label];
  if (characters.length <= LABEL_LIMIT) {
    return label;
  }
  return `${characters.slice(0, LABEL_LIMIT - 1).join('')}\u2026`;
}

/**
 * The declarations that lift the label out of the line, carried through
 * `ThemableDecorationAttachmentRenderOptions.textDecoration`.
 *
 * What this relies on, read out of a shipped editor rather than assumed: every decoration
 * option becomes one CSS declaration by `{0}`-substitution with no sanitisation of the value
 * (`textDecoration` → `text-decoration:{0};`), and the converter between the API type and the
 * editor's options passes the twelve documented strings through verbatim — `contentText` is the
 * one value it escapes. The leading `none;` closes the `text-decoration` declaration the field
 * was meant to be, and every declaration after it is emitted into the generated
 * `.monaco-editor .ced-<key>-4::after` rule as ordinary CSS. That is how a label the API cannot
 * place becomes an absolutely positioned box.
 *
 * What it costs, in full, because none of it is a contract and nothing in the suite can see a
 * pixel:
 *
 * - `top` is a magic constant against a line box whose height is `editor.lineHeight`, which is
 *   settable and unknowable from here. `-1.3em` is measured in the label's own font size — the
 *   `0.7em` below — so it tracks `editor.fontSize` and ignores the line height: at the default
 *   the box ends up over the text of the line above, and at `editor.lineHeight: 34` it lands
 *   inside the caret's own line instead.
 * - The box cannot escape the editor's top edge (`.overflow-guard` clips), so on one of the
 *   first visible lines it is cut off; the left and right edges clip it too.
 * - `pointer-events: none` is mandatory. Without it the box swallows the clicks and selection
 *   drags that pass under it.
 * - It is a pseudo-element, so screen readers and anything else that reads the DOM cannot see
 *   it. That is why the caret keeps its `hoverMessage`, which carries "name · role".
 * - Two peers at the same offset get two boxes drawn on top of each other.
 */
const FLOATING_DECLARATIONS =
  'none; position: absolute; display: inline-block; z-index: 10; pointer-events: none; ' +
  'font-size: 0.7em; font-weight: bold; border-radius: 0.15rem; padding: 0 0.5ch; ' +
  'top: -1.3em;';

/**
 * The attachment for one cursor's label, or `undefined` when the mode draws none. Both drawn
 * modes use the peer's own colour with black text, which the palette is chosen to be legible
 * against; the difference is whether the box is in the line or above it. The name is clipped by
 * `boundedLabel`, so no caller can put an unbounded peer string in the document.
 */
export function labelAttachment(
  cursor: Pick<Cursor, 'label' | 'colour'>,
  mode: 'floating' | 'chip',
): ThemableDecorationAttachmentRenderOptions;
export function labelAttachment(
  cursor: Pick<Cursor, 'label' | 'colour'>,
  mode: LabelMode,
): ThemableDecorationAttachmentRenderOptions | undefined;
export function labelAttachment(
  cursor: Pick<Cursor, 'label' | 'colour'>,
  mode: LabelMode,
): ThemableDecorationAttachmentRenderOptions | undefined {
  if (mode === 'none') {
    return undefined;
  }
  const label = boundedLabel(cursor.label);
  if (mode === 'chip') {
    return {
      // An attachment has no `padding` field, so the spaces are the only padding a chip has.
      contentText: ` ${label} `,
      backgroundColor: cursor.colour,
      color: '#000000',
      fontWeight: 'bold',
      border: '1px solid #000000',
      margin: '0 0.4ch',
    };
  }
  return {
    // No spaces around it: the CSS padding is the padding.
    contentText: label,
    backgroundColor: cursor.colour,
    color: '#000000',
    textDecoration: FLOATING_DECLARATIONS,
  };
}
