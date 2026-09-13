/**
 * The seam, enforced rather than intended: the design record's §6
 * () puts the sync engine
 * and the editor adapter in one process but on opposite sides of an interface, and the
 * study's §6 makes "engine/ has no `vscode` import" the one thing that has to survive for
 * a sidecar or a second editor to be a move rather than a rewrite.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ENGINE_DIR = resolve(import.meta.dirname, '..', 'src', 'engine');
const PACKAGE = resolve(import.meta.dirname, '..', 'package.json');

/** A quoted module specifier, single or double quoted, as group 2. */
const QUOTED = `(['"])([^'"]+)\\1`;

/** Every engine module, so a new file cannot quietly opt out of the rules below. */
function engineFiles(): string[] {
  return readdirSync(ENGINE_DIR)
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((name) => resolve(ENGINE_DIR, name));
}

/**
 * The module specifiers a source file imports, static or dynamic, in either quote
 * style: `import ... from 'x'`, `export ... from 'x'`, `import 'x'` and `import('x')`.
 * A static import of `vscode` is erased by the type stripper when it is type-only, so
 * `npm run typecheck` is the other half of this check — this scan is the half that
 * needs no compiler.
 */
function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(
    new RegExp(`\\b(?:import|export)\\b[^;]*?\\bfrom\\s*${QUOTED}`, 'g'),
  )) {
    found.push(match[2]);
  }
  for (const match of source.matchAll(new RegExp(`\\bimport\\s*${QUOTED}`, 'g'))) {
    found.push(match[2]);
  }
  for (const match of source.matchAll(
    new RegExp(`\\bimport\\s*\\(\\s*${QUOTED}\\s*\\)`, 'g'),
  )) {
    found.push(match[2]);
  }
  return found;
}

/** True for the editor API and the packages that carry it. */
function isEditorPackage(specifier: string): boolean {
  return (
    specifier === 'vscode' ||
    specifier.startsWith('vscode-') ||
    specifier.startsWith('@types/vscode')
  );
}

test('the engine imports no editor API and no editor runtime', () => {
  const files = engineFiles();
  assert.ok(files.length >= 8, `expected the engine modules, found ${files.length}`);
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const specifier of specifiers(source)) {
      assert.ok(
        !isEditorPackage(specifier),
        `${file} imports ${specifier}, which is the adapter's side of the seam`,
      );
    }
    // A `require` this source could still make at runtime, however it is spelled.
    assert.doesNotMatch(
      source,
      /\brequire\s*\(\s*['"](?:vscode|vscode-[^'"]*|@types\/vscode)['"]\s*\)/,
      `${file} requires a VS Code package`,
    );
  }
});

test('the engine depends on the four declared packages and on itself, nothing else', () => {
  const manifest = JSON.parse(readFileSync(PACKAGE, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const declared = Object.keys(manifest.dependencies ?? {});
  const allowed = new Set(declared);
  for (const file of engineFiles()) {
    for (const specifier of specifiers(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) {
        assert.match(
          specifier,
          /\.ts$/,
          `${file}: a relative import needs its .ts extension for Node's type stripping`,
        );
        continue;
      }
      const root = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : (specifier.split('/')[0] ?? specifier);
      assert.ok(
        allowed.has(root),
        `${file} imports ${specifier}, which is not one of: ${declared.join(', ')}`,
      );
    }
  }
});

test('the engine exports the vocabulary an adapter is written against', async () => {
  const engine = await import('../src/engine/index.ts');
  for (const name of [
    'SelvageEngine',
    'ProtocolError',
    'EngineClosedError',
    'isProtocolError',
    'caret',
    'parseSessionUrl',
    'inviteUrl',
    'fetchMeta',
    'openSocket',
    'WIRE_VERSION',
  ]) {
    assert.ok(name in engine, `the engine's public surface has no ${name}`);
  }
  // The event vocabulary is the Rust client's, so the seam is one vocabulary project-wide.
  const document = await import('../src/engine/events.ts');
  assert.equal(typeof document, 'object');
});
