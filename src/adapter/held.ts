/**
 * The address a room document has when the room's listing names no file for it.
 *
 * A guest's mirror is the listing's shape on disk (`mirror.ts`): a path the room holds and its
 * listing does not name has no file there, and materialising one anyway would put a file in the
 * window's tree that the room never listed — which is why the Neovim client keeps such a
 * document in a `selvage://` buffer instead (`nvim_client/lua/selvage/mirror.lua`). This is that
 * address on this editor, and it is the whole of the scheme: one document per room path, at the
 * mirror's file where the listing names it and at `selvage:` where it does not.
 *
 * The path is percent-encoded segment by segment, because a room path may carry `#`, `?` and `%`
 * and `Uri` reads all three as its own delimiters; `Uri.path` is the decoded path, so
 * {@link heldRoomPath} reads it back as it stands.
 */

import * as vscode from 'vscode';

/** The scheme a room path with no file in this window is addressed at. */
export const HELD_SCHEME = 'selvage';

/** The `selvage:` address of a room path. */
export function heldRoomUri(path: string): vscode.Uri {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return vscode.Uri.parse(`${HELD_SCHEME}:/${encoded}`);
}

/** The room path a `selvage:` URI names, or `undefined` for a URI that is not one. */
export function heldRoomPath(uri: vscode.Uri): string | undefined {
  if (uri.scheme !== HELD_SCHEME) {
    return undefined;
  }
  const path = uri.path.replace(/^\/+/, '');
  return path === '' ? undefined : path;
}

/**
 * What the provider reads a room through. The session is the room's own address space, and it
 * is asked rather than copied: the listing, the holds and the replica all move under the
 * window while a document is open.
 */
export interface HeldRoom {
  /** The room's text at `path`, or `''` while this replica holds none. */
  text(path: string): string;
  /** Whether `path` is one this window may hold at the `selvage:` address. */
  heldWithoutFile(path: string): boolean;
}

/**
 * The `selvage:` file system: one virtual file per room path this window holds without a file.
 *
 * It is a `FileSystemProvider` rather than a read-only content provider because the document is
 * a real one: the room's open-document set is the union of the seated peers' holds, and every
 * holder of the invite token edits the session (`DESIGN.md` §4.2). A read-only view would show
 * the room's text and refuse every keystroke, which is a different product from the Neovim
 * client's writable `selvage://` buffer. Edits reach the room through the ordinary document
 * path (`../bridge/bridge.ts` `documentChanged`), exactly as a mirror file's do, because the
 * editor treats this like any other document.
 *
 * The read is the room's text as this replica holds it, and a write has nowhere to go: the
 * buffer's changes are the room's already — they were published as they were typed — so the
 * save that follows writes the same text back into the room it came from. There is no file to
 * hold a second copy of it, which is the point of the address.
 */
export class HeldDocuments implements vscode.FileSystemProvider {
  /**
   * The room's changes reach a held document through the bridge's own apply, never through the
   * file system, so nothing is ever fired here. A change event would have the editor re-read
   * the file under a buffer that is already the room's.
   */
  private readonly watchers = new vscode.EventEmitter<vscode.FileChangeEvent[]>();

  readonly onDidChangeFile = this.watchers.event;

  private readonly room: () => HeldRoom | undefined;

  constructor(room: () => HeldRoom | undefined) {
    this.room = room;
  }

  /** The room and the path this URI names, when this window is the one that may address it. */
  private address(uri: vscode.Uri): { room: HeldRoom; path: string } {
    const path = heldRoomPath(uri);
    const room = this.room();
    if (path === undefined || room === undefined || !room.heldWithoutFile(path)) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return { room, path };
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const { room, path } = this.address(uri);
    const size = new TextEncoder().encode(room.text(path)).length;
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size };
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const { room, path } = this.address(uri);
    return new TextEncoder().encode(room.text(path));
  }

  /**
   * Accepts the buffer's text and keeps none of it. The keystrokes went to the room as they
   * were typed, and this address has no file behind it for a save to leave anything in, so the
   * call is how the editor's dirty marker clears and nothing else.
   */
  writeFile(uri: vscode.Uri, _content: Uint8Array, _options: { create: boolean; overwrite: boolean }): void {
    this.address(uri);
  }

  readDirectory(uri: vscode.Uri): never {
    throw vscode.FileSystemError.FileNotADirectory(uri);
  }

  /**
   * A room document is the room's to make and to end: a path is offered when the room offers it
   * and gone when the room drops it. A window that could create, delete or rename one here would
   * hold a document the room has never heard of, or leave the room offering a path this window
   * has nothing behind.
   */
  createDirectory(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri, _options: { recursive: boolean }): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri, _target: vscode.Uri, _options: { overwrite: boolean }): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  watch(_uri: vscode.Uri, _options: { recursive: boolean; excludes: string[] }): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  dispose(): void {
    this.watchers.dispose();
  }
}
