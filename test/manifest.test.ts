/**
 * The extension manifest, against the code it describes.
 *
 * `vsce package` would catch some of this and CI runs neither `vsce` nor an editor, so what
 * is checked here is the part a machine without VS Code can still check: the bundle the
 * manifest points at builds and loads, activating it registers exactly the commands the
 * manifest contributes, and the settings the manifest declares are settings the adapter
 * reads. `npm run test:fast` builds the bundle first, so the file under test is the current
 * source and not a stale one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { loadBundle } from './helpers/bundle.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(here, '..');
const ADAPTER = resolve(ROOT, 'src', 'adapter');

interface Manifest {
  main?: string;
  engines?: { vscode?: string; node?: string };
  activationEvents?: string[];
  contributes?: {
    commands?: Array<{ command: string; title: string; category?: string }>;
    configuration?: { properties?: Record<string, { type?: string; default?: unknown }> };
  };
  devDependencies?: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as Manifest;

test('the manifest points at a bundle that exists and loads', () => {
  assert.equal(manifest.main, './dist/extension.js');
  const bundle = loadBundle();
  assert.equal(typeof bundle.activate, 'function');
  assert.equal(typeof bundle.deactivate, 'function');
});

test('activating registers exactly the commands the manifest contributes', () => {
  const bundle = loadBundle();
  bundle.activate({ subscriptions: [] });
  bundle.deactivate();

  const registered = [...bundle.registered.commands].sort();
  const contributed = (manifest.contributes?.commands ?? [])
    .map((entry) => entry.command)
    .sort();
  assert.ok(contributed.length > 0, 'the manifest contributes no commands');
  assert.deepEqual(
    registered,
    contributed,
    'a command the palette cannot reach, or a contributed one that is never registered',
  );
  for (const entry of manifest.contributes?.commands ?? []) {
    assert.match(entry.command, /^selvage\./, `${entry.command} is outside the extension's namespace`);
    assert.ok(entry.title.trim() !== '', `${entry.command} has no title`);
  }

  assert.deepEqual(
    bundle.registered.schemes,
    ['selvage'],
    'the guest document scheme is registered once, under the name the bridge builds',
  );
});

test('every setting the manifest declares is one the adapter reads', () => {
  const source = ['extension.ts', 'documents.ts', 'guest-fs.ts', 'decorations.ts']
    .map((name) => readFileSync(resolve(ADAPTER, name), 'utf8'))
    .join('\n');
  const properties = Object.keys(manifest.contributes?.configuration?.properties ?? {});
  assert.ok(properties.length > 0, 'the manifest declares no settings');
  for (const key of properties) {
    assert.match(key, /^selvage\./, `${key} is outside the extension's namespace`);
    const name = key.slice('selvage.'.length);
    assert.ok(
      source.includes(`'${name}'`),
      `no adapter module reads ${key}`,
    );
  }
});

test('the manifest asks for a VS Code no older than its type definitions', () => {
  // `vsce` refuses to package when `@types/vscode` needs a newer API than `engines.vscode`
  // promises, and nothing else checks it (`validateVSCodeTypesCompatibility`).
  const engines = /^\^?(\d+)\.(\d+)/.exec(manifest.engines?.vscode ?? '');
  const types = /^(\d+)\.(\d+)/.exec(manifest.devDependencies?.['@types/vscode'] ?? '');
  assert.ok(engines !== null, `engines.vscode is not a version: ${manifest.engines?.vscode}`);
  assert.ok(types !== null, '@types/vscode is not pinned to a version');
  const promised = Number(engines[1]) * 1000 + Number(engines[2]);
  const required = Number(types[1]) * 1000 + Number(types[2]);
  assert.ok(
    required <= promised,
    `@types/vscode ${manifest.devDependencies?.['@types/vscode']} is newer than engines.vscode ${manifest.engines?.vscode}`,
  );
});

test('activation stays lazy: a command starts the extension, a guest tab restores it', () => {
  // A command activation event is generated from `contributes.commands` since VS Code
  // 1.74, so the extension starts when a user runs one of its commands and not before. A
  // `selvage:` tab restored in a new window is the one other way in: without the file-system
  // event the tab is an unresolvable resource until a command happens to run.
  assert.deepEqual(manifest.activationEvents ?? [], ['onFileSystem:selvage']);
});
