/**
 * Bundles the extension for the extension host: one CommonJS file with `vscode` left to the
 * host and everything else — the engine, the bridge, `ws`, `yjs`, `y-protocols` — included,
 * because an extension is installed as a directory and resolves no dependencies of its own.
 *
 * `dist/package.json` is what makes the output CommonJS. This package is `"type": "module"`
 * so that `node --test` runs the sources as ES modules with types stripped, and Node reads a
 * `.js` file under that setting as one too; the marker in `dist/` overrides it there and
 * nowhere else.
 *
 * `ws` requires `bufferutil` and `utf-8-validate` inside a `try`, to use them when they are
 * installed. They are left out of the bundle, so the bundle never needs them.
 */

import { build, context } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

mkdirSync(resolve(root, 'dist'), { recursive: true });
writeFileSync(resolve(root, 'dist/package.json'), '{"type":"commonjs"}\n');

const options = {
  entryPoints: [resolve(root, 'src/adapter/extension.ts')],
  outfile: resolve(root, 'dist/extension.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  // The oldest VS Code the manifest declares; the extension host's Node tracks it.
  target: 'node18',
  external: ['vscode', 'bufferutil', 'utf-8-validate'],
  sourcemap: true,
  logLevel: 'info',
};

if (watch) {
  const running = await context(options);
  await running.watch();
} else {
  await build(options);
}
