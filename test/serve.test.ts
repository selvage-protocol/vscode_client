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
import type { GrantRefusal, Report } from '../src/bridge/bridge.ts';
import * as vscodeLoader from './helpers/vscode-loader.ts';

registerHooks(vscodeLoader);
const vscode = await import('vscode');
const { enumerateGrant, grantedFile, isShareableFile } = await import(
  '../src/adapter/grant.ts'
);
const { WorkspaceEditor } = await import('../src/adapter/documents.ts');
const stub = createRequire(import.meta.url)('./helpers/vscode-stub.cjs') as {
  put(path: string, content: string | Uint8Array, options?: { size?: number }): void;
  putLink(path: string, kind: 'file' | 'directory', target?: string): void;
  remove(path: string): void;
  reset(): void;
};

function folders() {
  const found = vscode.workspace.workspaceFolders;
  assert.ok(found !== undefined && found.length > 0, 'the stub window has no folder');
  return found;
}

/** The answer `grantedFile` gives for a path this window does not resolve to a file. */
const refused = (cause: GrantRefusal) => ({ refusal: cause });

/** The answer a read gives for a file a session cannot carry. */
const unreadable = (cause: GrantRefusal) => ({ kind: 'refused', cause });

/** Whether `grantedFile` resolved a room path to a file this window serves. */
function servable(found: { uri: unknown } | { refusal: GrantRefusal }): boolean {
  return 'uri' in found;
}

test('a path that escapes the folder is not servable', async (t) => {
  stub.reset();
  t.after(() => {
    stub.reset();
  });
  stub.put('/etc/passwd', 'outside\n');
  stub.put('src/main.rs', 'inside\n');

  assert.deepEqual(await grantedFile(folders(), '../etc/passwd'), refused('not-granted'));
  assert.deepEqual(await grantedFile(folders(), 'src/../../etc/passwd'), refused('not-granted'));
  assert.deepEqual(await grantedFile(folders(), '/etc/passwd'), refused('not-granted'));
  assert.deepEqual(await grantedFile(folders(), ''), refused('not-granted'));
  assert.ok(
    servable(await grantedFile(folders(), 'src/main.rs')),
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

  assert.deepEqual(
    await grantedFile(folders(), 'link/secret.txt'),
    refused('not-a-file'),
    'a path through a link reaches outside the folder',
  );
  assert.ok(
    servable(await grantedFile(folders(), 'real/inner.txt')),
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
    servable(await grantedFile(folders(), 'swap/inner.txt')),
    'the plain directory serves before the swap',
  );

  // A build or a branch switch replaces the directory with a link to elsewhere: what the
  // walk saw no longer holds, and the same path is refused rather than read through it.
  stub.remove('swap/inner.txt');
  stub.putLink('swap', 'directory', '/outside');
  assert.deepEqual(
    await grantedFile(folders(), 'swap/inner.txt'),
    refused('not-a-file'),
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

  // The refusal is the read half's: `grantedFile` resolves the name, and the leaf's own
  // `stat` refuses the link itself — it reports the link bit for the final component, which
  // is what the walk assumes of every entry it lists.
  const reports: Report[] = [];
  const editor = new WorkspaceEditor({
    role: 'host',
    folders: folders(),
    report: (report) => reports.push(report),
  });
  assert.deepEqual(await editor.readGrantedFile('leaf.txt'), unreadable('not-a-file'));
  assert.deepEqual(await editor.readGrantedFile('plain.txt'), {
    kind: 'text',
    text: 'inside\n',
  });
  editor.dispose();
});

test('a binary file the listing names is refused as binary, not as missing', async (t) => {
  stub.reset();
  t.after(() => {
    stub.reset();
  });
  stub.put('logo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a]));
  stub.put('latin1.txt', new Uint8Array([0x63, 0x61, 0x66, 0xe9]));
  stub.put('notes.txt', 'notes\n');

  const editor = new WorkspaceEditor({
    role: 'host',
    folders: folders(),
    report: () => undefined,
  });
  assert.deepEqual(await editor.readGrantedFile('logo.png'), unreadable('binary'));
  assert.deepEqual(
    await editor.readGrantedFile('latin1.txt'),
    unreadable('binary'),
    'bytes that are not valid UTF-8 are not text either',
  );
  assert.deepEqual(await editor.readGrantedFile('notes.txt'), {
    kind: 'text',
    text: 'notes\n',
  });
  // The listing names it: the walk rules on a file's type and the size a session carries, and
  // reading every file to decide whether to name it would read a whole project to publish a
  // name list. So a binary can be listed, and this is the refusal a person gets for asking.
  assert.ok((await enumerateGrant(folders())).includes('logo.png'));
  editor.dispose();
});

test('a name the grant excludes is not servable, even when it is on disk', async (t) => {
  stub.reset();
  t.after(() => {
    stub.reset();
  });
  stub.put('.env', 'SECRET=1\n');
  stub.put('.git/config', 'secret\n');
  stub.put('id_rsa', 'secret\n');
  stub.put('src/main.rs', 'inside\n');

  assert.deepEqual(await grantedFile(folders(), '.env'), refused('not-granted'));
  assert.deepEqual(await grantedFile(folders(), '.git/config'), refused('not-granted'));
  assert.deepEqual(await grantedFile(folders(), 'id_rsa'), refused('not-granted'));
  assert.ok(servable(await grantedFile(folders(), 'src/main.rs')));
});

test('the listing names the plain files inside the size a session carries', async (t) => {
  stub.reset();
  t.after(() => {
    stub.reset();
  });
  stub.put('src/main.rs', 'inside\n');
  stub.put('.env', 'SECRET=1\n');
  stub.put('.git/config', 'secret\n');
  stub.put('id_rsa', 'secret\n');
  stub.put('node_modules/dep/index.js', 'dep\n');
  stub.put('big.bin', 'x', { size: 2 * 1024 * 1024 });
  stub.put('/outside/secret.txt', 'outside\n');
  stub.putLink('link', 'directory', '/outside');

  const paths = await enumerateGrant(folders());
  assert.deepEqual(paths, ['src/main.rs']);
  const main = await grantedFile(folders(), 'src/main.rs');
  assert.ok('uri' in main && (await isShareableFile(main.uri)));
});

test('a case-folded variant is not servable on a case-insensitive mount', async (t) => {
  stub.reset();
  const fs = vscode.workspace.fs as unknown as Record<string, unknown>;
  const originalStat = fs['stat'] as (uri: unknown) => Promise<unknown>;
  t.after(() => {
    stub.reset();
    fs['stat'] = originalStat;
  });
  stub.put('.git/config', 'secret\n');
  stub.put('.env', 'SECRET=1\n');
  stub.put('id_rsa', 'secret\n');
  stub.put('src/main.rs', 'inside\n');

  fs['stat'] = (async (uri: unknown) => {
    try {
      return await (originalStat as (uri: unknown) => Promise<unknown>)(uri);
    } catch {
      const lowered = String(uri).toLowerCase();
      const fake = {
        ...(typeof uri === 'object' && uri !== null ? (uri as Record<string, unknown>) : {}),
        toString: () => lowered,
        path: lowered.replace(/^file:\/\//, ''),
      };
      return await (originalStat as (uri: unknown) => Promise<unknown>)(fake);
    }
  }) as unknown;

  assert.deepEqual(await grantedFile(folders(), '.GIT/config'), refused('missing'));
  assert.deepEqual(await grantedFile(folders(), '.ENV'), refused('missing'));
  assert.deepEqual(await grantedFile(folders(), 'ID_RSA'), refused('missing'));
  assert.ok(servable(await grantedFile(folders(), 'src/main.rs')));
});
