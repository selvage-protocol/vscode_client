/**
 * The seam, enforced rather than intended: `DESIGN.md` §6 puts the sync engine
 * and the editor adapter in one process but on opposite sides of an interface, and the
 * study's §6 makes "engine/ has no `vscode` import" the one thing that has to survive for
 * a sidecar or a second editor to be a move rather than a rewrite.
 *
 * The adapter landed on the same seam, one layer further out: `src/bridge/` is the half of
 * the adapter that knows nothing about an editor, `src/adapter/` is the part that imports
 * `vscode`. This file checks all three rules a reviewer would otherwise have to hold in
 * their head — no editor import on either side of the seam, no undeclared dependency, and
 * no module with logic that a test cannot reach.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

const SRC = resolve(import.meta.dirname, '..', 'src');
const ENGINE_DIR = resolve(SRC, 'engine');
const BRIDGE_DIR = resolve(SRC, 'bridge');
const ADAPTER_DIR = resolve(SRC, 'adapter');
const PACKAGE = resolve(import.meta.dirname, '..', 'package.json');

/** A quoted module specifier, single or double quoted, as group 2. */
const QUOTED = `(['"])([^'"]+)\\1`;

/** Every TypeScript module under `dir`, at any depth, sorted. */
function modulesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...modulesUnder(path));
    } else if (entry.name.endsWith('.ts')) {
      found.push(path);
    }
  }
  return found.sort();
}

/** True when the directory exists, so the checks below are honest before it does. */
function exists(dir: string): boolean {
  try {
    readdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

/** Every module of the editor-independent half: the ones a test must be able to reach. */
function editorIndependentFiles(): string[] {
  return [
    ...modulesUnder(ENGINE_DIR),
    ...(exists(BRIDGE_DIR) ? modulesUnder(BRIDGE_DIR) : []),
  ];
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

/**
 * A module reached through something other than a quoted literal — `` import(`${name}`) `` —
 * which the literal scan above cannot see and which could therefore name `vscode`. Nothing
 * in either half does it; if something starts, it belongs in the adapter where it is read.
 */
const COMPUTED_SPECIFIER = /\b(?:import|require)\s*\(\s*(?!['"])/;

test('the engine and the bridge import no editor API and no editor runtime', () => {
  const files = editorIndependentFiles();
  assert.ok(files.length >= 12, `expected both halves, found ${files.length} modules`);
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
    assert.doesNotMatch(
      source,
      COMPUTED_SPECIFIER,
      `${file} reaches a module through a specifier the scan cannot read`,
    );
  }
});

test('the editor API is imported in src/adapter and nowhere else', () => {
  const outside = modulesUnder(SRC).filter(
    (file) => !file.startsWith(`${ADAPTER_DIR}${sep}`),
  );
  assert.ok(outside.length >= 12, `expected to scan the tree, found ${outside.length}`);
  for (const file of outside) {
    const source = readFileSync(file, 'utf8');
    for (const specifier of specifiers(source)) {
      assert.ok(
        !isEditorPackage(specifier),
        `${relative(SRC, file)} imports ${specifier}: that belongs in src/adapter/`,
      );
    }
    assert.doesNotMatch(
      source,
      COMPUTED_SPECIFIER,
      `${relative(SRC, file)} reaches a module through a specifier the scan cannot read`,
    );
  }
});

test('every adapter module is one that imports the editor API', () => {
  // The adapter layer is meant to be a reading exercise. A file there that does not touch
  // `vscode` is logic that could have been tested, so it belongs in the bridge instead.
  if (!exists(ADAPTER_DIR)) {
    return;
  }
  const files = modulesUnder(ADAPTER_DIR);
  assert.ok(files.length >= 1, 'src/adapter/ exists but holds no modules');
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    assert.ok(
      specifiers(source).some(isEditorPackage),
      `${relative(SRC, file)} does not import vscode: its logic belongs in src/bridge/`,
    );
  }
});

test('the editor-independent half depends on the declared packages and on itself, nothing else', () => {
  const manifest = JSON.parse(readFileSync(PACKAGE, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const declared = Object.keys(manifest.dependencies ?? {});
  const allowed = new Set(declared);
  for (const file of editorIndependentFiles()) {
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

test('every module of the editor-independent half is reachable from a test', () => {
  // The brief's rule, mechanised: if a module has logic and no test can reach it, either the
  // logic belongs in `src/adapter/` (where reading is the only check) or the test is missing.
  const seen = new Set<string>();
  const queue = modulesUnder(import.meta.dirname);
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) {
      continue;
    }
    seen.add(file);
    for (const specifier of specifiers(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) {
        queue.push(resolve(dirname(file), specifier));
      }
    }
  }
  for (const file of editorIndependentFiles()) {
    assert.ok(
      seen.has(file),
      `${relative(SRC, file)} is not reachable from any test`,
    );
  }
});

test('the editor-independent half exports the vocabulary an adapter is written against', async () => {
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
