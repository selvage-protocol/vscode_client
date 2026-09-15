/**
 * The editor side of the seam, over `vscode`: which documents this window shares, how a
 * change reaches one, and when one is written.
 *
 * Everything decidable about a document lives in `src/bridge/`; what is left here is
 * translation. A reviewer should be able to read this file and see that each method does
 * exactly what its bridge method promised.
 */

import * as vscode from 'vscode';

import { SCHEME, virtualDocument } from '../bridge/index.ts';
import type { Cursor, EditorHost, LineEnding, Report, TextChange } from '../bridge/index.ts';
import type { Role } from '../engine/index.ts';
import { roomPathOf } from './grant.ts';

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
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(
        document.positionAt(change.start),
        document.positionAt(change.end),
      ),
      change.text,
    );
    // `false` means the editor refused it and the buffer is unchanged; the bridge works the
    // change out again from the buffer rather than replaying the range. A rejection is
    // `applyEdit` failing outright, and it reaches the bridge's catch with the message.
    return vscode.workspace.applyEdit(edit);
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
