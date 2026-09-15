/**
 * The serve path's bound: a peer names a path, and the host reads its own disk for it.
 * Every shape that tries to leave the shared folder is refused — a `..`, an absolute
 * path, a symlinked directory on the way, a leaf that is itself a link, a name the grant
 * excludes — while a granted file is still served and still listed.
 *
 * The adapter is loaded directly with the editor stubbed, and the working copy is the
 * stub's disk: `put` seeds files, `putLink` seeds links, and swapping one for the other
 * is how a directory becomes a link after it was walked. Each refusal below is a state
 * the code checks, not the race it cannot close — the link swapped in *between* the walk
 * and the read, which `vscode.workspace.fs` exposes no `realpath` to shut — and that
 * window is said as a residual where the read lives, not claimed away.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import type { Report } from '../src/bridge/bridge.ts';
import * as vscodeLoader from './helpers/vscode-loader.ts';

registerHooks(vscodeLoader);
const vscode = await import('vscode');
const { enumerateGrant, grantedFile, isShareableFile } = await import(
  '../src/adapter/grant.ts'
);
const { WorkspaceEditor } = await import('../src/adapter/documents.ts');
const stub = createRequire(import.meta.url)('./helpers/vscode-stub.cjs') as {
  put(path: string, content: string, options?: { size?: number }): void;
  putLink(path: string, kind: 'file' | 'directory', target?: string): void;
  remove(path: string): void;
  reset(): void;
};

function folders() {
  const found = vscode.workspace.workspaceFolders;
  assert.ok(found !== undefined && found.length > 0, 'the stub window has no folder');
  return found;
}

test('a path that escapes the folder is not servable', async (t) => {
  stub.reset();
  t.after(() => {
    stub.reset();
  });
  stub.put('/etc/passwd', 'outside\n');
  stub.put('src/main.rs', 'inside\n');

  assert.equal(await grantedFile(folders(), '../etc/passwd'), undefined);
  assert.equal(await grantedFile(folders(), 'src/../../etc/passwd'), undefined);
  assert.equal(await grantedFile(folders(), '/etc/passwd'), undefined);
  assert.equal(await grantedFile(folders(), ''), undefined);
  assert.ok(
    (await grantedFile(folders(), 'src/main.rs')) !== undefined,
    'a granted file is still served',
  );
});

test('a path through a symlinked directory is not servable', async (t) => {
  stub.reset();
  t.after(() => {
    stub.reset();
  });
  stub.put('/outside/secret.txt', 'outside\n');
  stub.put('real/inner.txt', 'inside\n');
  stub.putLink('link', 'directory', '/outside');

  assert.equal(
    await grantedFile(folders(), 'link/secret.txt'),
    undefined,
    'a path through a link reaches outside the folder',
  );
  assert.ok(
    (await grantedFile(folders(), 'real/inner.txt')) !== undefined,
    'a path through plain directories is still served',
  );
});

test('a directory swapped for a link stops being servable', async (t) => {
  stub.reset();
  t.after(() => {
    stub.reset();
  });
  stub.put('/outside/secret.txt', 'outside\n');
  stub.put('swap/inner.txt', 'inside\n');

  assert.ok(
    (await grantedFile(folders(), 'swap/inner.txt')) !== undefined,
    'the plain directory serves before the swap',
  );

  // A build or a branch switch replaces the directory with a link to elsewhere: what the
  // walk saw no longer holds, and the same path is refused rather than read through it.
  stub.remove('swap/inner.txt');
  stub.putLink('swap', 'directory', '/outside');
  assert.equal(
    await grantedFile(folders(), 'swap/inner.txt'),
    undefined,
    'the swapped segment is refused after the swap',
  );
});

test('a leaf that is itself a link is not readable, even at a readable target', async (t) => {
  stub.reset();
  t.after(() => {
    stub.reset();
  });
  stub.put('/outside/secret.txt', 'outside\n');
  stub.putLink('leaf.txt', 'file', '/outside/secret.txt');
  stub.put('plain.txt', 'inside\n');

  // The refusal is the read half's: `grantedFile` resolves the name, and `isShareableFile`
  // refuses the link itself — a `stat` that reports the link bit for the final component,
  // which is what the walk assumes of every entry it lists.
  const reports: Report[] = [];
  const editor = new WorkspaceEditor({
    role: 'host',
    folders: folders(),
    report: (report) => reports.push(report),
  });
  assert.equal(await editor.readGrantedFile('leaf.txt'), undefined);
  assert.equal(await editor.readGrantedFile('plain.txt'), 'inside\n');
  editor.dispose();
});

test('a name the grant excludes is not servable, even when it is on disk', async (t) => {
  stub.reset();
  t.after(() => {
    stub.reset();
  });
  stub.put('.env', 'SECRET=1\n');
  stub.put('.GIT/config', 'secret\n');
  stub.put('id_rsa', 'secret\n');
  stub.put('src/main.rs', 'inside\n');

  assert.equal(await grantedFile(folders(), '.env'), undefined);
  assert.equal(await grantedFile(folders(), '.GIT/config'), undefined);
  assert.equal(await grantedFile(folders(), 'id_rsa'), undefined);
  assert.ok((await grantedFile(folders(), 'src/main.rs')) !== undefined);
});

test('the listing names only what the room may serve', async (t) => {
  stub.reset();
  t.after(() => {
    stub.reset();
  });
  stub.put('src/main.rs', 'inside\n');
  stub.put('.env', 'SECRET=1\n');
  stub.put('.GIT/config', 'secret\n');
  stub.put('id_rsa', 'secret\n');
  stub.put('node_modules/dep/index.js', 'dep\n');
  stub.put('big.bin', 'x', { size: 2 * 1024 * 1024 });
  stub.put('/outside/secret.txt', 'outside\n');
  stub.putLink('link', 'directory', '/outside');

  const paths = await enumerateGrant(folders());
  assert.deepEqual(paths, ['src/main.rs']);
  assert.ok(await isShareableFile((await grantedFile(folders(), 'src/main.rs'))!));
});
