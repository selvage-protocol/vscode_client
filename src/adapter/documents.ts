/**
 * The editor side of the seam, over `vscode`: which documents this window shares, how a
 * change reaches one, and when one is written.
 *
 * Everything decidable about a document lives in `src/bridge/`; what is left here is
 * translation. A reviewer should be able to read this file and see that each method does
 * exactly what its bridge method promised.
 */

import * as vscode from 'vscode';

import { applyChange, diff, render } from '../bridge/index.ts';
import type {
  Cursor,
  EditorHost,
  GrantedRead,
  LineEnding,
  Report,
  TextChange,
} from '../bridge/index.ts';
import type { Role } from '../engine/index.ts';
import { grantedFile, grantedText, roomPathOf } from './grant.ts';
import { MIRROR_MARKER, mirrorRelative, plainMirrorPath } from './mirror.ts';

import { Cursors } from './decorations.ts';

export interface WorkspaceEditorOptions {
  role: Role;
  /**
   * A guest's mirror root on disk. A guest shares the `file:` documents under it;
   * without one a guest shares nothing, which is the state before the join mints it.
   */
  mirrorRoot?: string;
  /** Something the user has to see. */
  report: (report: Report) => void;
  /**
   * The folders this session shares, captured when it started. The window's own folder list can
   * change under a session — a folder added, another closed — and what the room shares must not
   * change with it: the grant is the folder chosen at invite time (`DESIGN.md` §4.2).
   */
  folders: readonly vscode.WorkspaceFolder[];
}

/**
 * How many times a refused change is moved through the local edit behind it and offered again
 * before the refusal goes to the bridge. A document that refuses without moving is handed back
 * after one offer, and so is one whose range a local edit straddles; the bound is reached only
 * by a document that keeps moving under the range, because each movement is what buys the next
 * offer — which is exactly what a user typing through the window supplies. When it is reached
 * the refusal and the deferred text go to the bridge together, and the bridge reports it.
 */
const MAX_REBASED_OFFERS = 3;

/**
 * `change`'s range as the document now reads, moved through the local edit `local` the document
 * took after the range was computed.
 *
 * A local edit the range sits entirely after moves the range by what it did to the text's
 * length; one the range sits entirely before leaves it alone. One the range straddles is not
 * expressible — the peer wrote about the same characters the user did, and there is no position
 * left to put it at — and answers `undefined`, which is the refusal the bridge's own retry is
 * for.
 */
function rebase(change: TextChange, local: TextChange): TextChange | undefined {
  if (local.end <= change.start) {
    const moved = local.text.length - (local.end - local.start);
    return { start: change.start + moved, end: change.end + moved, text: change.text };
  }
  if (local.start >= change.end) {
    return change;
  }
  return undefined;
}

export class WorkspaceEditor implements EditorHost {
  private readonly role: Role;
  private readonly mirrorRoot: string | undefined;
  private readonly onReport: (report: Report) => void;
  private readonly folders: readonly vscode.WorkspaceFolder[];
  private readonly cursors = new Cursors();
  /** The documents this window shares, by room path, and the same back again by URI. */
  private readonly documents = new Map<string, vscode.TextDocument>();
  private readonly paths = new Map<string, string>();
  /**
   * Room paths whose mirror leaf is not a regular file, so the refusal is said once rather
   * than on every open event and every save.
   */
  private readonly unshareable = new Set<string>();
  /**
   * The text each in-flight *bridge* apply of this window's asked its document to hold, by room
   * path: what tells a change event whether it is the room's own edit landing or a keystroke
   * (`{@link applyingTo}`). One entry per apply, because an apply issued while another is still
   * in flight — a put-back over a put-back, which a fast typist produces — is its own answer.
   *
   * A put-back's ask is deliberately not recorded: a put-back is this adapter correcting the
   * buffer, not the bridge applying the room's text, so a change event carrying it is judged
   * against the replica like any keystroke. Otherwise it would excuse the buffer holding text
   * the room has moved past, and `bridge.documentChanged` would publish it into the replica.
   */
  private readonly askedFor = new Map<string, string[]>();

  constructor(options: WorkspaceEditorOptions) {
    this.role = options.role;
    this.mirrorRoot = options.mirrorRoot;
    this.onReport = options.report;
    this.folders = options.folders;
  }

  /**
   * The room path this document is shared under, or `undefined` when the session does not
   * share it. A host shares the `file:` documents open under a folder it captured — the
   * folder chosen at invite time is the grant (`DESIGN.md` §4.2) — and a guest shares the
   * `file:` documents under its mirror root, never outside it and never the mirror's own
   * marker. Recording it here is what makes the reverse lookup in `pathOf` possible.
   */
  register(document: vscode.TextDocument): string | undefined {
    const path = this.roomPath(document.uri);
    if (
      path === undefined ||
      this.paths.has(document.uri.toString()) ||
      this.documents.has(path)
    ) {
      return undefined;
    }
    // A guest's mirror leaf is read with `lstat` before its text is shared: a link there is
    // read through by the editor, and its target's bytes would be the room's, which is the
    // refusal Neovim makes on the same path (`lua/selvage/init.lua`). Anything but a
    // regular file — a link, a directory, a socket — is refused the way a path outside the
    // mirror is.
    if (this.mirrorLeafRefusal(path) !== undefined) {
      return undefined;
    }
    this.documents.set(path, document);
    this.paths.set(document.uri.toString(), path);
    return path;
  }

  /**
   * Says, once per path, that the mirror holds no regular file at `path`, and answers the
   * sentence for a caller that must act on the refusal: the room's text is not read out of
   * such a path and not written through it. `undefined` is the answer for a path there is
   * nothing to refuse — a host's own file, a guest with no mirror, a leaf that is absent or
   * a regular file.
   */
  private mirrorLeafRefusal(path: string): string | undefined {
    if (this.mirrorRoot === undefined || plainMirrorPath(this.mirrorRoot, path)) {
      return undefined;
    }
    const refusal = `${path} is not a regular file, so it is not shared`;
    if (!this.unshareable.has(path)) {
      this.unshareable.add(path);
      this.onReport({
        kind: 'sessionError',
        code: 'error',
        message: `will not share ${path} with the room: ${refusal}; nothing was shared for it`,
      });
    }
    return refusal;
  }

  /** The path a document was registered under, if it is one this window shares. */
  pathOf(document: vscode.TextDocument): string | undefined {
    return this.paths.get(document.uri.toString());
  }

  /** Stops sharing a document. Returns its room path, or `undefined` if it was never shared. */
  forget(uri: vscode.Uri): string | undefined {
    const path = this.paths.get(uri.toString());
    if (path === undefined) {
      return undefined;
    }
    this.paths.delete(uri.toString());
    this.documents.delete(path);
    return path;
  }

  // -- EditorHost ------------------------------------------------------------

  text(path: string): string | undefined {
    return this.documents.get(path)?.getText();
  }

  lineEnding(path: string): LineEnding {
    return this.documents.get(path)?.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  }

  async applyChange(path: string, change: TextChange): Promise<boolean> {
    const document = this.documents.get(path);
    if (document === undefined) {
      return false;
    }
    return this.offer(path, document, change, true);
  }

  private async offer(
    path: string,
    document: vscode.TextDocument,
    change: TextChange,
    bridgeApply: boolean,
  ): Promise<boolean> {
    // `false` means the editor refused the change and the buffer is unchanged: the editor
    // stamps a workspace edit with the version its document mirror holds and refuses one whose
    // version has moved, so a `false` says the range — not the change — no longer fits. The
    // common cause is a local edit that reached the document while the change was being
    // offered, and the change is still the one the room wants: it is moved through that edit
    // and offered again, which lands it where the document now holds the text it was computed
    // from and leaves the user's own text where they put it. Handing that refusal to the bridge
    // instead would let it work the change out again from the buffer, which is the room's text
    // without the local edit, and the user's keystroke would be dropped rather than merged with
    // the peer's — `nvim_client/companion/editor.ts` defends against exactly this.
    //
    // A `false` with no local edit behind it is a document that refuses the range for a reason
    // this side cannot see — a read-only document is the plain case — and it is passed on, as
    // the bridge's bounded retry and its `applyRefused` report are for. One whose local edit
    // overlaps the range, and one still moving when the bound is reached, are passed on too:
    // neither has a position to move the range to, and the bridge reconciles the deferred text
    // away and reports it rather than dropping it in silence. A rejection is `applyEdit` failing
    // outright, and it reaches the bridge's catch with the message.
    let offered = change;
    let before = document.getText();
    for (let offers = 0; ; offers += 1) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        document.uri,
        new vscode.Range(
          document.positionAt(offered.start),
          document.positionAt(offered.end),
        ),
        offered.text,
      );
      // What the buffer holds if this edit lands, recorded for as long as the apply is in
      // flight: the change event the editor fires for it arrives inside that window, and it is
      // this — not a count of everything in flight — that says whose edit the buffer holds.
      // Only a bridge apply is recorded: a put-back is this adapter's own correction, and a
      // change event carrying its target is either the replica's text already or a keystroke.
      const expected = applyChange(before, offered);
      if (bridgeApply) {
        this.noteAsked(path, expected);
      }
      try {
        if (await vscode.workspace.applyEdit(edit)) {
          return true;
        }
      } finally {
        if (bridgeApply) {
          this.forgetAsked(path, expected);
        }
      }
      const current = document.getText();
      if (current === before) {
        return false;
      }
      const moved = offers < MAX_REBASED_OFFERS ? rebase(offered, diff(before, current)) : undefined;
      if (moved === undefined) {
        return false;
      }
      offered = moved;
      before = current;
    }
  }

  /**
   * The room's text back into a document the buffer had moved away from: how a viewer's edit is
   * discarded (`§13.9`), as the inverse of the change the buffer took. Offered the way
   * {@link applyChange} offers one — through the same rebase — but without recording the ask,
   * because a put-back is this adapter's own correction and never the bridge applying the
   * room's text.
   *
   * `text` is the replica's, which is LF-only, and the buffer may hold `\r\n`: it is rendered
   * into the document's own endings first, the way every other writer in the policy does, so a
   * refused keystroke in a CRLF document does not rewrite the whole document's endings.
   *
   * The caller passes the document rather than a path because the change event that asked for
   * this is the one holding it, and a document the room has since stopped sharing has nothing
   * to put back. `false` is the editor refusing every offer: the buffer then still holds the
   * edit, and the caller is what says so.
   */
  async putBack(path: string, document: vscode.TextDocument, text: string): Promise<boolean> {
    const held = document.getText();
    const room = render(text, this.lineEnding(path));
    if (held === room) {
      return true;
    }
    return this.offer(path, document, diff(held, room), false);
  }

  /**
   * Whether a *bridge* apply of this window's has asked this document to hold `text` and has
   * not settled. A change event carrying it is the room's own edit landing, not a keystroke.
   *
   * Per path and by text, because neither a count of the applies in flight nor the path alone
   * can tell the two apart: an apply for another path says nothing about this one, and an apply
   * for this path that has not landed has not moved this buffer either (`§13.9`). A put-back's
   * ask is not recorded here, so a change event carrying one is a keystroke to refuse.
   */
  applyingTo(path: string, text: string): boolean {
    return this.askedFor.get(path)?.includes(text) ?? false;
  }

  private noteAsked(path: string, text: string): void {
    const texts = this.askedFor.get(path);
    if (texts === undefined) {
      this.askedFor.set(path, [text]);
      return;
    }
    texts.push(text);
  }

  private forgetAsked(path: string, text: string): void {
    const texts = this.askedFor.get(path);
    if (texts === undefined) {
      return;
    }
    const at = texts.lastIndexOf(text);
    if (at >= 0) {
      texts.splice(at, 1);
    }
    if (texts.length === 0) {
      this.askedFor.delete(path);
    }
  }

  async save(path: string): Promise<boolean> {
    const document = this.documents.get(path);
    if (document === undefined || !document.isDirty) {
      return true;
    }
    // A guest's mirror file holds what the room already holds — the keystrokes went first,
    // so the save writes the room's own text. The call is also what clears the dirty
    // marker. A host's save is the same ordinary write. `false` means the write failed and
    // the file is stale; the bridge reports it rather than swallowing it.
    //
    // A guest's leaf is read once more, immediately before the write: the registration that
    // shared this document may have been a link-free path that a local process has since
    // replaced, and a save through a link writes the room's text out of the mirror.
    if (this.mirrorLeafRefusal(path) !== undefined) {
      return false;
    }
    return document.save();
  }

  /**
   * Reads a file the room asked for, out of the folder this session was invited on.
   *
   * The path came from a peer, so it is resolved against the captured folders and has to be a
   * path the grant itself would publish — the `.git/**` and `.env` defaults included, and every
   * directory on the way a plain directory of the folder rather than a symbolic link out of it —
   * before a single byte is read. The answer is the text, or why there is none: a name this
   * window does not share, one that is not there, one that is not a plain file, one over the
   * size a session will carry, or bytes that are not text. The bridge says which of those
   * happened.
   */
  async readGrantedFile(path: string): Promise<GrantedRead> {
    const found = await grantedFile(this.folders, path);
    return 'refusal' in found
      ? { kind: 'refused', cause: found.refusal }
      : await grantedText(found.uri);
  }

  renderCursors(cursors: Cursor[]): void {
    const byPath = new Map<string, Cursor[]>();
    for (const cursor of cursors) {
      const here = byPath.get(cursor.path) ?? [];
      here.push(cursor);
      byPath.set(cursor.path, here);
    }
    this.cursors.render(byPath, (document) => this.pathOf(document));
  }

  report(report: Report): void {
    this.onReport(report);
  }

  dispose(): void {
    this.cursors.dispose();
    this.documents.clear();
    this.paths.clear();
    this.unshareable.clear();
    this.askedFor.clear();
  }

  private roomPath(uri: vscode.Uri): string | undefined {
    if (this.role !== 'host') {
      // A viewer's documents live where a guest's do (`§13.9`): under the mirror, which is the
      // only working copy this window has of the room.
      //
      // The mirror's own marker is the client's bookkeeping, not a document: it must
      // never publish, or a join's invite would reach the room it names.
      if (uri.scheme !== 'file' || this.mirrorRoot === undefined) {
        return undefined;
      }
      const rel = mirrorRelative(this.mirrorRoot, uri.fsPath);
      return rel === undefined || rel === MIRROR_MARKER ? undefined : rel;
    }
    if (uri.scheme !== 'file') {
      return undefined;
    }
    // The captured folders, not the live ones: a folder added to the window mid-session must
    // not quietly widen what the room holds. Two folders or more qualify the path with the
    // folder's name, so two `main.rs` are two room paths rather than one document.
    return roomPathOf(this.folders, uri);
  }
}
