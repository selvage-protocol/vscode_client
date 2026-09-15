/**
 * The guest's documents, behind a `FileSystemProvider`.
 *
 * A guest edits a buffer that exists nowhere on disk, and it has to be *editable* — the
 * workflow is "come edit my code with me", so a `TextDocumentContentProvider`, which is
 * read-only by contract, is the wrong tool (`docs/studies/vscode-plugin.md` §2.4). This
 * provider answers a `selvage:` URI with the replica's text and accepts writes by doing
 * nothing with them: the shared buffer is the truth, and there is no host file to write.
 *
 * The room also carries the host's grant — a listing of paths and never content — and the
 * provider mirrors its *shape*: `readDirectory` and `stat` are derived from the listing, so
 * the room looks like a project rather than one document (`DESIGN.md` §4.2). Content is still
 * fetched only when something reads it.
 */

import * as vscode from 'vscode';

import { SCHEME, grantChildren, roomFromQuery, virtualDocument } from '../bridge/index.ts';

/** Where a guest's documents read from: the session that is live. */
export interface VirtualSource {
  roomId: string;
  text(path: string): string;
  /**
   * The paths the room offers: its grant, and the documents it holds open. Absent for a source
   * that knows no listing, which reads as an empty tree rather than as every path.
   */
  paths?(): readonly string[];
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
    const directory = this.directory(uri);
    if (directory !== undefined) {
      // A listing carries files and no directory entry (`PROTOCOL.md` §5): an intermediate
      // path is a directory because some listed path goes through it, and that is the only
      // reason it exists at all.
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }
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

  /**
   * The immediate children of a directory, derived by splitting the room's listing: `src`
   * exists because `src/main.rs` does, and the room never said so.
   */
  readDirectory(uri: vscode.Uri): Array<[string, vscode.FileType]> {
    const directory = this.directory(uri);
    if (directory === undefined) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return grantChildren(this.paths(), directory).map((child) => [
      child.name,
      child.directory ? vscode.FileType.Directory : vscode.FileType.File,
    ]);
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

  /** The paths the live session offers, or nothing when no session is holding the room. */
  private paths(): readonly string[] {
    return this.live?.paths?.() ?? [];
  }

  /**
   * The directory a URI names inside the live room, or `undefined` when it names no directory.
   *
   * The root is `selvage:/?room=<id>`, which is a directory and not a document, so it is
   * recognised here rather than through `virtualDocument`, which rightly refuses a URI that
   * names no path at all.
   */
  private directory(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== SCHEME || this.live === undefined) {
      return undefined;
    }
    const parsed = virtualDocument(uri.scheme, uri.path, uri.query);
    if (parsed !== undefined) {
      if (parsed.roomId !== this.live.roomId) {
        return undefined;
      }
      const prefix = `${parsed.path}/`;
      return this.paths().some((path) => path.startsWith(prefix)) ? parsed.path : undefined;
    }
    if (uri.path === '/' && roomFromQuery(uri.query) === this.live.roomId) {
      return '';
    }
    return undefined;
  }
}
