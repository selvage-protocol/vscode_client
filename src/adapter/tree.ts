/**
 * The Explorer's view of the room.
 *
 * The owner's ask was a real tree rather than a list to pick from: a person looking at a
 * session should see their peer's project, which is the room's grant — a listing of files and
 * never content (`DESIGN.md` §4.2) — and the paths the room happens to hold open beside it, so
 * a server with no grant still shows what the room knows.
 *
 * The tree is a view and not a file system: reading a file's text is the `selvage:`
 * `FileSystemProvider`'s, and this only derives the shape by splitting the listing.
 */

import * as vscode from 'vscode';

import { grantChildren } from '../bridge/index.ts';
import type { GrantChild } from '../bridge/index.ts';

/** Where the tree reads the room from: the session that is live. */
export interface GrantTreeSource {
  /** What the room offers, ascending by UTF-16 code unit. */
  offered(): readonly string[];
}

export class GrantTree implements vscode.TreeDataProvider<GrantChild>, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<GrantChild | undefined>();
  readonly onDidChangeTreeData = this.changes.event;

  private source?: GrantTreeSource;

  /** Points the tree at a session, or at nothing when the session ends. */
  use(source?: GrantTreeSource): void {
    this.source = source;
    this.changes.fire(undefined);
  }

  /** Redraws what the room offers, which is the one thing the tree shows. */
  refresh(): void {
    this.changes.fire(undefined);
  }

  getChildren(node?: GrantChild): GrantChild[] {
    return grantChildren(this.source?.offered() ?? [], node?.path ?? '');
  }

  getTreeItem(node: GrantChild): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.name,
      node.directory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = node.path;
    item.tooltip = node.path;
    if (!node.directory) {
      // A guest opens a granted path the same way it opens an offered one; a host is told that
      // its own files are the room's, which is what the command already says.
      item.command = {
        command: 'selvage.openDocument',
        title: 'Open a document from the room',
        arguments: [{ path: node.path }],
      };
    }
    return item;
  }

  dispose(): void {
    this.source = undefined;
    this.changes.dispose();
  }
}
