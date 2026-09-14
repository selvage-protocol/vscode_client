/**
 * A peer's name, as a decoration attachment: what the editor is told to draw, and how.
 *
 * The attachment is the only place a name can live. `TextEditorDecorationType` is an opaque
 * handle and `DecorationOptions` has just `before` and `after`, so a zero-width caret range
 * with an `after` attachment is the whole vocabulary, and everything about how the name *looks*
 * has to be said in that attachment. There are two answers:
 *
 * - `floating` — a small coloured box above the caret, out of the line's flow. The public API
 *   has no position, layer or overlay, so this is done by writing declarations into
 *   `textDecoration`; see `FLOATING_DECLARATIONS`. It is the default, because a label drawn in
 *   the line, in the document's own font and size, is *designed* to read as the document's own
 *   text, which is how it was reported.
 * - `chip` — the same attachment in documented fields only: background, colour, bold, a border.
 *   It draws in the line, and it is the fallback. If the floating declarations ever stop being
 *   drawn, `selvage.cursorLabel` is the one setting that puts the name back inside the line.
 *
 * The option objects below are a value rather than an editor-only effect: this module imports
 * `vscode` for its types alone, so the tests can build them without an editor — and it sits in
 * `src/adapter/` rather than `src/bridge/` because these are VS Code's option names. The bridge
 * is vendored by the Neovim client, which has no use for them.
 */

import type { ThemableDecorationAttachmentRenderOptions } from 'vscode';

import type { Cursor } from '../bridge/index.ts';

/** How a peer's name is drawn. The values are the `selvage.cursorLabel` setting's values. */
export type LabelMode = 'floating' | 'chip';

/** The mode a window gets with nothing configured — the floating label. */
export const DEFAULT_LABEL_MODE: LabelMode = 'floating';

/** Reads the `selvage.cursorLabel` setting. Anything unrecognised is the default. */
export function labelMode(value: unknown): LabelMode {
  return value === 'chip' ? 'chip' : DEFAULT_LABEL_MODE;
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
 *   `0.7em` below — so it tracks `editor.fontSize` and ignores the line height: a tall line
 *   leaves the box inside the line above it, a short one leaves a gap.
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
 * The attachment for one cursor's label. Both modes draw the name in the peer's own colour with
 * black text, which the palette is chosen to be legible against; the difference is whether the
 * box is in the line or above it.
 */
export function labelAttachment(
  cursor: Pick<Cursor, 'label' | 'colour'>,
  mode: LabelMode,
): ThemableDecorationAttachmentRenderOptions {
  if (mode === 'chip') {
    return {
      // An attachment has no `padding` field, so the spaces are the only padding a chip has.
      contentText: ` ${cursor.label} `,
      backgroundColor: cursor.colour,
      color: '#000000',
      fontWeight: 'bold',
      border: '1px solid #000000',
      margin: '0 0.4ch',
    };
  }
  return {
    // No spaces around it: the CSS padding is the padding.
    contentText: cursor.label,
    backgroundColor: cursor.colour,
    color: '#000000',
    textDecoration: FLOATING_DECLARATIONS,
  };
}
