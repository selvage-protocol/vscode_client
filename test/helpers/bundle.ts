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
  use(source: { roomId: string; text(path: string): string }): void;
  freeze(text: Iterable<[uri: string, content: string]>): void;
  stat(uri: UriLike): { type: number; size: number };
  readFile(uri: UriLike): Uint8Array;
  writeFile(uri: UriLike, content: Uint8Array): void;
  watch(uri: UriLike): { dispose(): void };
  readDirectory(): Array<[string, number]>;
  createDirectory(uri: UriLike): void;
  delete(uri: UriLike): void;
  rename(uri: UriLike): void;
}

export interface Registered {
  commands: string[];
  schemes: string[];
  files?: GuestFiles;
}

/** The stub module itself, for a test that needs to run a command or read what it recorded. */
export interface EditorStub {
  registered: Registered & {
    clipboard: string;
    clipboardWrites: string[];
    information: string[];
    warnings: string[];
    errors: string[];
    quickPicks: Array<{ items: string[]; options: unknown }>;
    inputs: unknown[];
    opened: string[];
    shown: string[];
    informationReply: unknown;
    warningReply: unknown;
    quickPickReply: unknown;
    inputReply: unknown;
  };
  reset(): void;
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
