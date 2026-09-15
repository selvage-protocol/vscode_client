/**
 * Answers the bare `vscode` specifier with the editor stub, for a test that imports an adapter
 * module directly rather than through the built bundle.
 *
 * `bundle.ts` redirects the same specifier for `require`; this is that redirection for the ESM
 * resolver, which is what an adapter module's own `import * as vscode from 'vscode'` goes
 * through once a test pulls it in with `import()`. A test installs it with
 * `module.registerHooks(vscodeLoader)` before that import.
 *
 * The specifier resolves to a facade rather than to the stub itself: Node builds an ESM
 * namespace for a CommonJS module from a static scan of its source, and the stub's export object
 * is written in a shape that scan stops part-way through, so `import * as vscode` would see only
 * its first few names. The facade re-exports every name the stub actually has, read from it at
 * runtime, so there is no second list of the editor API to keep in step.
 */

import { createRequire } from 'node:module';
import type { ResolveHookSync } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const STUB = pathToFileURL(require.resolve('./vscode-stub.cjs')).href;
const names = Object.keys(require('./vscode-stub.cjs') as Record<string, unknown>);

const facade = [
  `import stub from ${JSON.stringify(STUB)};`,
  'export default stub;',
  ...names.map((name) => `export const ${name} = stub[${JSON.stringify(name)}];`),
].join('\n');
const FACADE = `data:text/javascript;base64,${Buffer.from(facade, 'utf8').toString('base64')}`;

export const resolve: ResolveHookSync = (specifier, context, next) => {
  if (specifier === 'vscode') {
    return { url: FACADE, format: 'module', shortCircuit: true };
  }
  return next(specifier, context);
};
