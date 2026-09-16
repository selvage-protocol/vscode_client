/**
 * The built extension, loaded in a plain Node process: `require('vscode')` is answered by
 * `vscode-stub.cjs`, so `activate` runs without an editor and the test can look at what it
 * registered. `npm run test:fast` builds `dist/` first, so this is the current source.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const here = fileURLToPath(new URL('.', import.meta.url));
export const ROOT = resolve(here, '..', '..');
export const BUNDLE = resolve(ROOT, 'dist', 'extension.js');
const STUB = resolve(here, 'vscode-stub.cjs');

/** The three URI components a provider is given, as the stub's `Uri.parse` would give them. */
export interface UriLike {
  scheme: string;
  path: string;
  query: string;
  toString(): string;
}

/** The guest file system, as the stub recorded it: the contract the adapter implements. */
export interface GuestFiles {
  use(source: {
    roomId: string;
    text(path: string): string;
    paths?(): readonly string[];
    has?(path: string): boolean;
    fetch?(path: string): Promise<void>;
  }): void;
  freeze(text: Iterable<[uri: string, content: string]>): void;
  stat(uri: UriLike): { type: number; size: number };
  readFile(uri: UriLike): Uint8Array | Promise<Uint8Array>;
  writeFile(uri: UriLike, content: Uint8Array): void;
  watch(uri: UriLike): { dispose(): void };
  readDirectory(uri: UriLike): Array<[string, number]>;
  createDirectory(uri: UriLike): void;
  delete(uri: UriLike): void;
  rename(uri: UriLike): void;
}

export interface Registered {
  commands: string[];
  schemes: string[];
  /** Every tree view the extension created, with the options it was given. */
  treeViews: Array<{ id: string; options: Record<string, unknown> }>;
  /** Every file system watcher the extension created, as the stub keeps it. */
  watchers: Array<{
    pattern: { base?: { uri?: { toString(): string } }; pattern?: string };
    ignored: { create: boolean; change: boolean; delete: boolean };
    disposed: boolean;
  }>;
  /** Every `workspace.fs.readDirectory` call: the listing was walked that many times. */
  listings: number;
  /**
   * Holds a directory read until the promise it returns resolves, as `(path, index) => Promise`,
   * so a test can have two republish walks overlap: a walk in a large tree outlasts a later one.
   */
  readHold: ((path: string, index: number) => Promise<unknown> | undefined) | undefined;
  files?: GuestFiles;
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
  };
  ConfigurationTarget: { Global: number; Workspace: number; WorkspaceFolder: number };
  ProgressLocation: { SourceControl: number; Window: number; Notification: number };
  TextEditorRevealType: { InCenterIfOutsideViewport: number };
  commands: {
    executeCommand(id: string, ...args: unknown[]): Promise<unknown>;
  };
}

export interface LoadedExtension {
  activate(context: unknown): void;
  deactivate(): void;
  registered: Registered;
  stub: EditorStub;
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
