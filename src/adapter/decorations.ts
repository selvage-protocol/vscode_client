/**
 * Remote cursors, drawn.
 *
 * Two decoration types per peer colour — a caret bar and a selection's fill — created the
 * first time that colour appears and disposed with the session, because a decoration type
 * is a handle the editor keeps for the life of the window. The name label is a single type
 * carrying its text and colour per instance, which is what keeps the type count a function
 * of the palette rather than of the peer list. With the default `selvage.cursorLabel: none`
 * it carries nothing.
 *
 * The gutter badge is a third type, cached per (initials, colour): a `gutterIconPath` image
 * drawn in the glyph margin, so a peer's name is visible without covering the document. It is
 * independent of `selvage.cursorLabel`; that setting draws a *text* label over the document and
 * defaults to none, while the badge is on by default. The image is `gutter.ts`'s; the type is
 * built here. Several peers on one line would share a glyph lane and overlap, so the lowest
 * peer id is chosen per line.
 *
 * A caret is a zero-width range with an `after` attachment. `DecorationOptions` says the
 * range must not be empty; both extensions the study read use one anyway and it renders, so
 * this follows them rather than the comment (`docs/studies/vscode-plugin.md` §3).
 *
 * What that attachment looks like — nothing, a floating box above the caret, or a chip inside
 * the line — is `labels.ts`'s, and `selvage.cursorLabel` chooses. Nothing is the default: a
 * name drawn in the document reads as the document's own text and one above the caret covers
 * the line, so a peer is shown by their caret bar, their selection fill, the overview ruler
 * tick and the caret's `hoverMessage` (name · role) until the user opts into a label. The
 * `hoverMessage` stays on the caret whatever the mode, because a label is a pseudo-element no
 * screen reader can reach.
 */

import * as vscode from 'vscode';

import type { Cursor } from '../bridge/index.ts';

import { BADGE_OPTIONS, badgeDataUri, initials, onePerLine } from './gutter.ts';
import { labelAttachment, labelMode } from './labels.ts';

/** How many badge decoration types a rename loop may retain before the oldest goes. */
export const MAX_BADGE_TYPES = 32;

export class Cursors {
  private readonly carets = new Map<string, vscode.TextEditorDecorationType>();
  private readonly selections = new Map<string, vscode.TextEditorDecorationType>();
  private readonly labels: vscode.TextEditorDecorationType;
  private readonly badges = new Map<string, vscode.TextEditorDecorationType>();

  constructor() {
    this.labels = vscode.window.createTextEditorDecorationType({
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
  }

  /**
   * Draws the cursors on every visible editor showing the document they are in, and clears
   * every type on the editors that are not — which is how a cursor whose peer moved to
   * another file, or left, is withdrawn.
   */
  render(
    cursors: Map<string, Cursor[]>,
    pathOf: (document: vscode.TextDocument) => string | undefined,
  ): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const path = pathOf(editor.document);
      this.draw(editor, path === undefined ? [] : (cursors.get(path) ?? []));
    }
  }

  dispose(): void {
    for (const type of this.carets.values()) {
      type.dispose();
    }
    for (const type of this.selections.values()) {
      type.dispose();
    }
    for (const type of this.badges.values()) {
      type.dispose();
    }
    this.carets.clear();
    this.selections.clear();
    this.badges.clear();
    this.labels.dispose();
  }

  private draw(editor: vscode.TextEditor, cursors: readonly Cursor[]): void {
    const mode = labelMode(vscode.workspace.getConfiguration('selvage').get('cursorLabel'));
    const carets = new Map<vscode.TextEditorDecorationType, vscode.DecorationOptions[]>();
    const selections = new Map<vscode.TextEditorDecorationType, vscode.DecorationOptions[]>();
    const badges = new Map<vscode.TextEditorDecorationType, vscode.DecorationOptions[]>();
    const labels: vscode.DecorationOptions[] = [];
    // One badge per line: glyph-margin icons on the same line share a lane and overlap, so
    // the peers are grouped by line and the lowest peer id wins, which is stable across draws.
    const badged = onePerLine(cursors, (cursor) => editor.document.positionAt(cursor.head).line);

    for (const cursor of cursors) {
      const anchor = editor.document.positionAt(cursor.anchor);
      const head = editor.document.positionAt(cursor.head);
      if (cursor.anchor !== cursor.head) {
        const fill = this.selectionType(cursor.fill);
        const options = selections.get(fill) ?? [];
        options.push({ range: new vscode.Range(anchor, head) });
        selections.set(fill, options);
      }
      const caret = this.caretType(cursor.colour);
      const options = carets.get(caret) ?? [];
      options.push({
        range: new vscode.Range(head, head),
        // A plain string renders as Markdown, so a peer's `[text](url)` name renders as a
        // link; `appendText` escapes it to plain text.
        hoverMessage: new vscode.MarkdownString().appendText(`${cursor.label} · ${cursor.role}`),
      });
      carets.set(caret, options);
      const attachment = labelAttachment(cursor, mode);
      if (attachment !== undefined) {
        labels.push({
          range: new vscode.Range(head, head),
          renderOptions: { after: attachment },
        });
      }
    }

    for (const type of this.carets.values()) {
      editor.setDecorations(type, carets.get(type) ?? []);
    }
    for (const type of this.selections.values()) {
      editor.setDecorations(type, selections.get(type) ?? []);
    }
    for (const [line, cursor] of badged) {
      const badge = this.badgeType(cursor);
      const options = badges.get(badge) ?? [];
      options.push({ range: new vscode.Range(line, 0, line, 0) });
      badges.set(badge, options);
    }
    for (const type of this.badges.values()) {
      editor.setDecorations(type, badges.get(type) ?? []);
    }
    editor.setDecorations(this.labels, labels);
  }

  private caretType(colour: string): vscode.TextEditorDecorationType {
    const known = this.carets.get(colour);
    if (known !== undefined) {
      return known;
    }
    const type = vscode.window.createTextEditorDecorationType({
      borderWidth: '0 0 0 2px',
      borderStyle: 'solid',
      borderColor: colour,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      // The overview ruler is a one-line answer to "where is the other person".
      overviewRulerColor: colour,
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
    this.carets.set(colour, type);
    return type;
  }

  /**
   * The glyph-margin badge for one peer, cached per (initials, colour) so a cursor move never
   * mints a new decoration type. The image is a base64 SVG handed to `Uri.parse`: a plain
   * string would be read as a file path, and there is no background-colour field to fill it.
   * Bounded: a rename loop churns types, so the oldest is evicted past the bound, cleared
   * from every visible editor before it is disposed.
   */
  private badgeType(cursor: Pick<Cursor, 'label' | 'colour'>): vscode.TextEditorDecorationType {
    const text = initials(cursor.label);
    const key = `${text}\u0000${cursor.colour}`;
    const known = this.badges.get(key);
    if (known !== undefined) {
      this.badges.delete(key);
      this.badges.set(key, known);
      return known;
    }
    const type = vscode.window.createTextEditorDecorationType({
      ...BADGE_OPTIONS,
      gutterIconPath: vscode.Uri.parse(badgeDataUri(text, cursor.colour)),
    });
    this.badges.set(key, type);
    while (this.badges.size > MAX_BADGE_TYPES) {
      const oldest = this.badges.keys().next();
      if (oldest.done) {
        break;
      }
      const oldestKey = oldest.value;
      if (oldestKey === key) {
        break;
      }
      const evicted = this.badges.get(oldestKey);
      if (evicted === undefined) {
        break;
      }
      for (const editor of vscode.window.visibleTextEditors) {
        editor.setDecorations(evicted, []);
      }
      evicted.dispose();
      this.badges.delete(oldestKey);
    }
    return type;
  }

  /** Keyed by the fill the bridge computed, so the alpha lives in one place. */
  private selectionType(fill: string): vscode.TextEditorDecorationType {
    const known = this.selections.get(fill);
    if (known !== undefined) {
      return known;
    }
    const type = vscode.window.createTextEditorDecorationType({
      backgroundColor: fill,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    this.selections.set(fill, type);
    return type;
  }
}
