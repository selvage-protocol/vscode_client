/**
 * The editor side of the seam, over `vscode`: which documents this window shares, how a
 * change reaches one, and when one is written.
 *
 * Everything decidable about a document lives in `src/bridge/`; what is left here is
 * translation. A reviewer should be able to read this file and see that each method does
 * exactly what its bridge method promised.
 */

import * as vscode from 'vscode';

import { diff, SCHEME, virtualDocument } from '../bridge/index.ts';
import type { Cursor, EditorHost, LineEnding, Report, TextChange } from '../bridge/index.ts';
import type { Role } from '../engine/index.ts';
import { decodableText, grantedFile, isShareableFile, roomPathOf } from './grant.ts';

import { Cursors } from './decorations.ts';

export interface WorkspaceEditorOptions {
  role: Role;
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
  private readonly onReport: (report: Report) => void;
  private readonly folders: readonly vscode.WorkspaceFolder[];
  private readonly cursors = new Cursors();
  /** The documents this window shares, by room path, and the same back again by URI. */
  private readonly documents = new Map<string, vscode.TextDocument>();
  private readonly paths = new Map<string, string>();

  constructor(options: WorkspaceEditorOptions) {
    this.role = options.role;
    this.onReport = options.report;
    this.folders = options.folders;
  }

  /**
   * The room path this document is shared under, or `undefined` when the session does not
   * share it. A host shares the `file:` documents open under a folder it captured — the
   * folder chosen at invite time is the grant (`DESIGN.md` §4.2) — and a guest shares only
   * the `selvage:` documents the room gave it. Recording it here is what makes the reverse
   * lookup in `pathOf` possible.
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
    this.documents.set(path, document);
    this.paths.set(document.uri.toString(), path);
    return path;
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

  /** The guest documents this window has open, as their URI strings and room paths. */
  virtualDocuments(): Array<[uri: string, path: string]> {
    const prefix = `${SCHEME}:`;
    return [...this.paths.entries()].filter(([uri]) => uri.startsWith(prefix));
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
      if (await vscode.workspace.applyEdit(edit)) {
        return true;
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

  async save(path: string): Promise<boolean> {
    const document = this.documents.get(path);
    if (document === undefined || !document.isDirty) {
      return true;
    }
    // A guest's virtual document has nowhere to be written, so its provider's `writeFile` is
    // a no-op. The call is made all the same: it is what clears the dirty marker. A host's
    // save is an ordinary write, and the room's content is what it writes. `false` means the
    // write failed and the file is stale; the bridge reports it rather than swallowing it.
    return document.save();
  }

  /**
   * Reads a file the room asked for, out of the folder this session was invited on.
   *
   * The path came from a peer, so it is resolved against the captured folders and has to be a
   * path the grant itself would publish — the `.git/**` and `.env` defaults included, and every
   * directory on the way a plain directory of the folder rather than a symbolic link out of it —
   * before a single byte is read. `undefined` is then the answer for a directory, a symbolic
   * link, a file over the size a session will carry, and bytes that are not text; the bridge
   * reports that rather than putting an empty document into the room.
   */
  async readGrantedFile(path: string): Promise<string | undefined> {
    const uri = await grantedFile(this.folders, path);
    if (uri === undefined || !(await isShareableFile(uri))) {
      return undefined;
    }
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      return undefined;
    }
    return decodableText(bytes);
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
  }

  private roomPath(uri: vscode.Uri): string | undefined {
    const virtual = virtualDocument(uri.scheme, uri.path, uri.query);
    if (virtual !== undefined) {
      return this.role === 'guest' ? virtual.path : undefined;
    }
    if (this.role !== 'host' || uri.scheme !== 'file') {
      return undefined;
    }
    // The captured folders, not the live ones: a folder added to the window mid-session must
    // not quietly widen what the room holds. Two folders or more qualify the path with the
    // folder's name, so two `main.rs` are two room paths rather than one document.
    return roomPathOf(this.folders, uri);
  }
}
