/**
 * The guest's documents, behind a `FileSystemProvider`.
 *
 * A guest edits a buffer that exists nowhere on disk, and it has to be *editable* — the
 * workflow is "come edit my code with me", so a `TextDocumentContentProvider`, which is
 * read-only by contract, is the wrong tool (`docs/studies/vscode-plugin.md` §2.4). This
 * provider answers a `selvage:` URI with the replica's text and accepts writes by doing
 * nothing with them: the shared buffer is the truth, and there is no host file to write.
 *
 * There is no file tree in v1 (`DESIGN.md` §4.2): `readDirectory` is empty, and one URI is
 * one shared document.
 */

import * as vscode from 'vscode';

import { virtualDocument } from '../bridge/index.ts';

/** Where a guest's documents read from: the session that is live. */
export interface VirtualSource {
  roomId: string;
  text(path: string): string;
}

export class GuestFileSystem implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;

  private live?: VirtualSource;
  /**
   * What the tabs keep once the session ends. A room's text stops arriving when the room
   * dies, but a document the user is looking at should not turn into an error.
   */
  private readonly frozen = new Map<string, string>();

  /** Points the provider at a session, replacing whatever it read before. */
  use(source: VirtualSource): void {
    this.live = source;
  }

  /**
   * Keeps the text the open documents held when the session ended, so the tab a user is
   * looking at keeps its content instead of turning into an error.
   */
  freeze(text: Iterable<[uri: string, content: string]>): void {
    this.frozen.clear();
    for (const [uri, content] of text) {
      this.frozen.set(uri, content);
    }
    this.live = undefined;
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    // `mtime: 0` is VS Code's "no information": the room, not the filesystem, decides when a
    // guest document changes, so a real timestamp would only invite a reload that does not help.
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: this.bytes(uri).length };
  }

  /** Releases the change event, which nothing fires. */
  dispose(): void {
    this.changes.dispose();
  }

  readFile(uri: vscode.Uri): Uint8Array {
    return this.bytes(uri);
  }

  /**
   * A save writes nothing. The document's content is the room's, a guest has no file to
   * write it to, and the editor's own save path is what clears the dirty marker
   * (`docs/studies/vscode-plugin.md` §2.4, open-pair's `DocumentRegistry` does the same).
   */
  writeFile(_uri: vscode.Uri, _content: Uint8Array): void {
    // Deliberately empty.
  }

  watch(_uri: vscode.Uri): vscode.Disposable {
    // Nothing changes a guest's document except the session, which applies its own edits.
    return new vscode.Disposable(() => undefined);
  }

  readDirectory(): Array<[string, vscode.FileType]> {
    return [];
  }

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  private bytes(uri: vscode.Uri): Uint8Array {
    const parsed = virtualDocument(uri.scheme, uri.path, uri.query);
    if (parsed === undefined) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    const text =
      this.live !== undefined && this.live.roomId === parsed.roomId
        ? this.live.text(parsed.path)
        : this.frozen.get(uri.toString());
    if (text === undefined) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return new TextEncoder().encode(text);
  }
}
