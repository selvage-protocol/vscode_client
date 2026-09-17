/**
 * The built extension, loaded in a plain Node process: `require('vscode')` is answered by
 * `vscode-stub.cjs`, so `activate` runs without an editor and the test can look at what it
 * registered. `npm run test:fast` builds `dist/` first, so this is the current source.
 */

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

import { waitFor } from './wait.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
export const ROOT = resolve(here, '..', '..');
export const BUNDLE = resolve(ROOT, 'dist', 'extension.js');
const STUB = resolve(here, 'vscode-stub.cjs');

/** A URI the stub's `Uri` builds, with the filesystem path the mirror resolves by. */
export interface StubUri {
  scheme: string;
  path: string;
  fsPath: string;
  query: string;
  toString(): string;
}

export interface Registered {
  commands: string[];
  /** Every `executeCommand` call, as `{ id, args }`, handled or not. */
  executed: Array<{ id: string; args: unknown[] }>;
  /** Every file system watcher the extension created, as the stub keeps it. */
  watchers: Array<{
    pattern: { base?: { uri?: { toString(): string } }; pattern?: string };
    ignored: { create: boolean; change: boolean; delete: boolean };
    disposed: boolean;
  }>;
  /** Every `workspace.updateWorkspaceFolders` call: `{ start, deleteCount, added }` URIs. */
  folderCalls: Array<{ start: number; deleteCount: number | null | undefined; added: string[] }>;
  /**
   * How the editor answers `workspace.updateWorkspaceFolders`: `false` is the silent
   * refusal, so a test stages what the client does when the folder never lands.
   */
  updateFoldersReturn: boolean;
  /** Every `tabGroups.close` call, as the tabs it was given, in order. */
  closedTabs: unknown[][];
  /** Every `workspace.fs.readDirectory` call: the listing was walked that many times. */
  listings: number;
  /** Every view the extension registered, as `{ viewId, provider }`, in order. */
  treeDataProviders: Array<{
    viewId: string;
    provider: TestTreeDataProvider;
  }>;
  /** Every file-badge provider the extension registered, in order. */
  fileDecorationProviders: Array<TestFileDecorationProvider>;
  /**
   * Holds a directory read until the promise it returns resolves, as `(path, index) => Promise`,
   * so a test can have two republish walks overlap: a walk in a large tree outlasts a later one.
   */
  readHold: ((path: string, index: number) => Promise<unknown> | undefined) | undefined;
  /** The window's open documents, as a test seeded them before the session started. */
  textDocuments: unknown[];
}

/** The stub module itself, for a test that needs to run a command or read what it recorded. */
export interface EditorStub {
  registered: Registered & {
    clipboard: string;
    clipboardWrites: string[];
    /** Every clipboard read, in order: joining must leave this empty. */
    clipboardReads: string[];
    information: string[];
    informationItems: unknown[][];
    warnings: string[];
    errors: string[];
    quickPicks: Array<{ items: unknown[]; options: unknown }>;
    inputs: Array<Record<string, unknown>>;
    /** Every progress notice the extension showed, in order. */
    progress: Array<{ title?: string; location?: number }>;
    settingWrites: Array<{ key: string; value: unknown; target: number }>;
    settingWriteFails: boolean;
    opened: string[];
    shown: string[];
    /** Every editor `showTextDocument` answered with: the landing is read back from these. */
    shownEditors: Array<{
      document: unknown;
      selection: unknown;
      revealed: Array<{ range: unknown; kind: unknown }>;
    }>;
    /** Every decoration type the extension created, as the options it was given. */
    decorations: Array<{ options: Record<string, unknown>; handle: { options: Record<string, unknown>; disposed?: boolean } }>;

    /** Every status bar item the extension created, as the object it kept drawing into. */
    statusBarItems: Array<{ text: string; tooltip?: string; command?: string; name: string; color?: string }>;
    watcherFailure: string | undefined;
    informationReply: unknown;
    warningReply: unknown;
    quickPickReply: unknown;
    inputReply: unknown;
    /** How the editor answers `workspace.applyEdit`; a test may replace it to observe applies. */
    applyEditImpl: (edit: unknown) => Promise<boolean>;
  };
  reset(): void;
  /** Seeds settings as a hand-edited settings.json would; `reset` clears them again. */
  configure(values: Record<string, unknown>): void;
  /** The `globalState` memento, for a test that activates with its own context. */
  globalState: {
    get(key: string): unknown;
    update(key: string, value: unknown): Promise<void>;
  };
  /** Seeds the window's working copy, as a host's folder: a file a session can enumerate. */
  put(path: string, content: string | Uint8Array, options?: { size?: number }): void;
  /**
   * A symbolic link in the working copy, which a listing never carries. A link with a `target`
   * names something elsewhere, as a link out of the folder does, and a path through it reaches
   * what it names.
   */
  putLink(path: string, kind: 'file' | 'directory', target?: string): void;
  /** A directory whose listing the editor refuses. */
  makeUnreadable(path: string): void;
  /** Deletes a file from the working copy, as removing it from the project does. */
  remove(path: string): void;
  /** Fires a file system event on every live watcher, as an editor's own watcher arrives. */
  watchEvent(kind: 'create' | 'change' | 'delete', path: string): void;
  /** Makes every watcher the extension creates throw, as an unwatchable folder does. */
  refuseWatchers(reason?: string, after?: number): void;
  /** Replaces the folders the window is open on, as adding one mid-session would. */
  setWorkspaceFolders(paths: string[]): void;
  /** Fires an editor event the extension subscribed to, as VS Code would. */
  fire(name: string, ...args: unknown[]): void;
  /** Puts a `file:` document in the window, as VS Code would have it open at activation. */
  openWorkspaceDocument(uri: string): unknown;
  /** The editor state the extension reads: what a test puts in `visibleTextEditors`. */
  window: {
    visibleTextEditors: unknown[];
    activeTextEditor: unknown;
    /**
     * The window's tab groups: leaving a room closes the room's tabs through these.
     * One group is enough to stage that; a test seeds its tabs.
     */
    tabGroups: {
      all: Array<{ tabs: unknown[] }>;
      close(tabs: readonly unknown[]): Promise<boolean>;
    };
  };
  /** The editor's `Uri`, for the mirror file a test opens the room through. */
  Uri: {
    parse(value: string): StubUri;
    file(path: string): StubUri;
    joinPath(base: unknown, ...parts: string[]): StubUri;
  };
  ConfigurationTarget: { Global: number; Workspace: number; WorkspaceFolder: number };
  ProgressLocation: { SourceControl: number; Window: number; Notification: number };
  TextEditorRevealType: { InCenterIfOutsideViewport: number };
  commands: {
    executeCommand(id: string, ...args: unknown[]): Promise<unknown>;
  };
}

/** A tree view's provider, as the stub keeps it: enough to list rows and watch refreshes. */
export interface TestTreeDataProvider {
  getChildren(element?: unknown): Promise<unknown[]> | unknown[];
  getTreeItem(element: unknown): unknown;
  onDidChangeTreeData(handler: (element: unknown) => void): { dispose(): void };
}

/** A file-badge provider, as the stub keeps it: enough to ask what a file wears. */
export interface TestFileDecorationProvider {
  provideFileDecoration(uri: unknown): unknown;
  onDidChangeFileDecorations(handler: (uri: unknown) => void): { dispose(): void };
}

export interface LoadedExtension {
  activate(context: unknown): void;
  deactivate(): void;
  registered: Registered;
  stub: EditorStub;
}

/**
 * A fresh `globalStorageUri` home for a test, under `<repo>/.tmp/`, removed with it.
 * A guest join mints exactly one window directory under it, which `mirrorWindowDir`
 * finds again.
 */
export function testStoragePath(t: { after(callback: () => void): void }): string {
  // A clean checkout has no `.tmp` until something needs scratch: make the parent,
  // or the mkdtemp below fails with ENOENT instead of a storage directory.
  mkdirSync(join(ROOT, '.tmp'), { recursive: true });
  const dir = mkdtempSync(join(ROOT, '.tmp', 'storage-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** The one window directory a join minted for `room` under a storage path. */
export function mirrorWindowDir(storagePath: string, room: string): string {
  // Room ids are server-minted `[A-Za-z0-9_-]` and sanitise to themselves.
  const roomDir = join(storagePath, 'rooms', room);
  const entries = readdirSync(roomDir);
  assert.equal(entries.length, 1, `expected one window in ${roomDir}, found ${entries.length}`);
  return join(roomDir, entries[0] as string);
}

/** A `file:` URI string for a mirror path, as the adapter opens it. */
export function mirrorFileUri(storagePath: string, room: string, path: string): string {
  return `file://${mirrorWindowDir(storagePath, room)}/${path}`;
}

/** Waits until the mirror for `room` holds every path in `paths` on disk. */
export async function waitForMirrorFiles(
  storagePath: string,
  room: string,
  paths: readonly string[],
): Promise<void> {
  await waitFor(
    'the listing to reach the mirror',
    () => {
      let dir: string;
      try {
        dir = mirrorWindowDir(storagePath, room);
      } catch {
        return false;
      }
      return paths.every((path) => existsSync(join(dir, ...path.split('/')))) ? true : false;
    },
    {
      describe: () => {
        try {
          return readdirSync(mirrorWindowDir(storagePath, room));
        } catch {
          return 'no mirror yet';
        }
      },
    },
  );
}

/** Waits until none of `paths` is on disk in the mirror for `room` anymore. */
export async function waitForMirrorGone(
  storagePath: string,
  room: string,
  paths: readonly string[],
): Promise<void> {
  await waitFor(
    'the listing to leave the mirror',
    () => {
      let dir: string;
      try {
        dir = mirrorWindowDir(storagePath, room);
      } catch {
        return false;
      }
      return paths.every((path) => !existsSync(join(dir, ...path.split('/')))) ? true : false;
    },
  );
}

/**
 * Loads the bundle with the editor API stubbed. The stub is a module the bundle `require`s,
 * so the resolution of the bare specifier `vscode` is redirected for this call only.
 */
export function loadBundle(): LoadedExtension {
  assert.ok(
    existsSync(BUNDLE),
    `${BUNDLE} is missing: run \`npm run build\` (npm test and npm run test:fast do it first)`,
  );
  const require = createRequire(import.meta.url);
  const Module = require('node:module') as {
    _resolveFilename: (...args: unknown[]) => string;
  };
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = (...args: unknown[]): string =>
    args[0] === 'vscode' ? STUB : resolveFilename(...args);
  try {
    const stub = require(STUB) as EditorStub;
    const bundle = require(BUNDLE) as { activate: unknown; deactivate: unknown };
    return {
      activate: bundle.activate as (context: unknown) => void,
      deactivate: bundle.deactivate as () => void,
      registered: stub.registered,
      stub,
    };
  } finally {
    Module._resolveFilename = resolveFilename;
  }
}
