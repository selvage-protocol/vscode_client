/**
 * The serve path's bound: a peer names a path, and the host reads its own disk for it.
 * Every shape that tries to leave the shared folder is refused — a `..`, an absolute
 * path, a symlinked directory on the way, a leaf that is itself a link, a name the grant
 * excludes, a path the folder's own ignore files leave out — while a granted file is still
 * served and still listed.
 *
 * The adapter is loaded directly with the editor stubbed, and the working copy is the
 * stub's disk: `put` seeds files, `putLink` seeds links, and swapping one for the other
 * is how a directory becomes a link after it was walked. Each refusal below is a state
 * the code checks, not the race it cannot close — the link swapped in *between* the walk
 * and the read, which `vscode.workspace.fs` exposes no `realpath` to shut — and that
 * window is said as a residual where the read lives, not claimed away.
 *
 * The last two tests mount the real disk instead, over a tree under `<repo>/.tmp/` — never
 * `/tmp`, which is a RAM-backed tmpfs on this host. A real tree is what carries a real
 * symbolic link, and what lets the walk's own reads be read back: `readPaths` is every path
 * `workspace.fs.readFile` was asked for, and `openedPaths` is the real file each mounted read
 * actually opened with its links followed. A read through a link is asked for under the link's
 * own name, so only `openedPaths` can say that nothing outside the shared folder — and nothing
 * behind a link — was ever opened.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { createRequire, registerHooks } from 'node:module';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { GrantRefusal, Report } from '../src/bridge/bridge.ts';
import {
  MAX_GRANT_FILE_BYTES,
  MAX_GRANT_LISTING_BYTES,
  MAX_GRANT_NODES,
  MAX_GRANT_PATHS,
} from '../src/bridge/index.ts';
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
  /** Reads the window's file system off the real disk instead of the seeded copy. */
  mount(root: string): void;
  /** Every path `workspace.fs.readFile` was asked for since the last reset, in order. */
  readPaths(): string[];
  /** Every real file a mounted `readFile` opened since the last reset, links followed. */
  openedPaths(): string[];
  /** Replaces the folders the window is open on. */
  setWorkspaceFolders(paths: readonly string[]): void;
};

const ROOT = resolve(import.meta.dirname, '..');
const CASES = join(ROOT, '.tmp', 'serve-tests');

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

test('a file whose name declares a binary format is refused as binary, and not listed', async (t) => {
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
  // The listing does not name it: the walk reads no bytes, so the name is all it can judge a
  // file by (`GRANT_BINARY_SUFFIXES`), and a name is a floor rather than a classification. A
  // binary whose name declares no format — `latin1.txt` here — is still listed, and asking for
  // it gets this same refusal.
  const listed = (await enumerateGrant(folders())).paths;
  assert.ok(!listed.includes('logo.png'), `a declared binary is still listed: ${listed.join(', ')}`);
  assert.ok(listed.includes('latin1.txt'), 'a name that declares no format was left out');
  assert.ok(listed.includes('notes.txt'), 'a plain text file was left out of the listing');
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

  const paths = (await enumerateGrant(folders())).paths;
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

test('a peer-named path is not servable where the folder\u2019s own ignore files leave it out', async (t) => {
  stub.reset();
  t.after(() => {
    stub.reset();
  });
  stub.put('.gitignore', '*.log\n!keep.log\n');
  stub.put('src/.gitignore', 'generated/\n');
  stub.put('a.log', 'dropped\n');
  stub.put('keep.log', 'kept\n');
  stub.put('src/main.rs', 'listed\n');
  stub.put('src/generated/out.ts', 'dropped by a deeper ignore file\n');

  // A guess at a path the folder ignores reads as the grant's own no: the refusal says the grant
  // leaves it out, and never that the guess was worth making.
  assert.deepEqual(await grantedFile(folders(), 'a.log'), refused('not-granted'));
  assert.deepEqual(await grantedFile(folders(), 'src/generated/out.ts'), refused('not-granted'));
  // The negated name and the untouched tree are still served, and still listed; an ignore file
  // is an ordinary name of the folder, so it is listed like any other.
  assert.ok(servable(await grantedFile(folders(), 'keep.log')));
  assert.ok(servable(await grantedFile(folders(), 'src/main.rs')));
  assert.deepEqual((await enumerateGrant(folders())).paths, ['.gitignore', 'keep.log', 'src/.gitignore', 'src/main.rs']);
});

test('a folder that is no repository, and one whose .git is a file, still walk', async (t) => {
  stub.reset();
  t.after(() => {
    stub.reset();
  });
  stub.put('.git', 'gitdir: ../elsewhere\n');
  stub.put('.gitignore', 'dropped.txt\n');
  stub.put('dropped.txt', 'dropped\n');
  stub.put('kept.txt', 'kept\n');

  // Neither shape has an `info/exclude` to read, and neither is a fault: a folder shared with a
  // room need not be a repository at all, and a linked worktree's `.git` is a file.
  assert.deepEqual((await enumerateGrant(folders())).paths, ['.gitignore', 'kept.txt']);
  assert.ok(servable(await grantedFile(folders(), 'kept.txt')));
  assert.deepEqual(await grantedFile(folders(), 'dropped.txt'), refused('not-granted'));
});

/**
 * A tree on disk for the walk to read: a real folder with real ignore files, a real symbolic link
 * out of it, and a `.gitignore` above it that names something inside. `root` is the case
 * directory, which is what the stub's file system is mounted on.
 */
function ignoreTree(): { root: string; folder: string } {
  const root = mkdtempSync(join(CASES, 'grant-walk-'));
  const folder = join(root, 'folder');
  const put = (at: string, text: string): void => {
    const path = join(folder, at);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };

  // Above the shared folder, as `~/proj/.gitignore` stands above a shared `~/proj/src`.
  writeFileSync(join(root, '.gitignore'), 'folder/src/\n');
  // Outside the shared folder, reached by the link below and holding an ignore file a read
  // through that link would find.
  mkdirSync(join(root, 'outside'), { recursive: true });
  writeFileSync(join(root, 'outside', '.gitignore'), 'named.txt\n');
  writeFileSync(join(root, 'outside', 'named.txt'), 'outside\n');

  put('.gitignore', '*.log\n!keep.log\n/root-only\nmoved/\n');
  put('.git/info/exclude', '*.tmp\n');
  put('keep.log', 'kept by a negation\n');
  put('drop.log', 'dropped at the root\n');
  put('notes.tmp', 'dropped by info/exclude\n');
  put('root-only/inside.txt', 'behind an anchored directory\n');
  put('moved/a.txt', 'behind a directory pattern\n');
  put('src/main.rs', 'named by the ignore file above the folder\n');
  put('nested/.gitignore', '!drop.log\nnote.txt\n');
  put('nested/drop.log', 're-included by the deeper source\n');
  put('nested/note.txt', 'dropped by the deeper source\n');
  put('nested/root-only/inside.txt', 'the anchored pattern names the root one only\n');
  symlinkSync(join(root, 'outside'), join(folder, 'link'), 'dir');
  return { root, folder };
}

/** A case directory on the real disk, mounted as the window's file system, cleaned up after. */
function mounted(t: TestContext): { root: string; folder: string } {
  mkdirSync(CASES, { recursive: true });
  const tree = ignoreTree();
  t.after(() => {
    stub.reset();
    rmSync(tree.root, { recursive: true, force: true });
  });
  stub.mount(tree.root);
  stub.setWorkspaceFolders([tree.folder]);
  return tree;
}

/**
 * A tree whose own ignore files would change the listing, with the ignore file itself and the
 * `.git` directory planted as links to files and directories outside the folder: `sub/.gitignore`
 * is a link to an outside file holding `!hidden.txt`, and `.git` is a link to an outside
 * repository directory whose `info/exclude` names `dropped-by-the-link.txt`. If either outside
 * file is read, it re-includes `sub/hidden.txt` or drops `dropped-by-the-link.txt` from the
 * listing, and `realpathSync` on what a read opened reaches outside the shared folder.
 */
function linkedIgnoreTree(): { root: string; folder: string; outside: string } {
  const root = mkdtempSync(join(CASES, 'grant-link-'));
  const folder = join(root, 'folder');
  const outside = join(root, 'outside');
  const put = (at: string, text: string): void => {
    const path = join(folder, at);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };

  mkdirSync(join(outside, 'gitdir', 'info'), { recursive: true });
  writeFileSync(join(outside, 'said-by-the-link.gitignore'), '!hidden.txt\n');
  writeFileSync(join(outside, 'gitdir', 'info', 'exclude'), 'dropped-by-the-link.txt\n');
  writeFileSync(join(outside, 'dropped-by-the-link.txt'), 'outside\n');

  put('.gitignore', 'hidden.txt\n');
  put('hidden.txt', 'ignored by the folder\n');
  put('dropped-by-the-link.txt', 'kept unless the outside .git is read\n');
  put('kept.txt', 'kept\n');
  put('sub/hidden.txt', 'ignored by the folder, re-included by a link\n');
  symlinkSync(join(outside, 'said-by-the-link.gitignore'), join(folder, 'sub', '.gitignore'), 'file');
  symlinkSync(join(outside, 'gitdir'), join(folder, '.git'), 'dir');
  return { root, folder, outside };
}

/** The linked tree on the real disk, mounted as the window's file system and cleaned up after. */
function linkedMounted(t: TestContext): { root: string; folder: string; outside: string } {
  mkdirSync(CASES, { recursive: true });
  const tree = linkedIgnoreTree();
  t.after(() => {
    stub.reset();
    rmSync(tree.root, { recursive: true, force: true });
  });
  stub.mount(tree.root);
  stub.setWorkspaceFolders([tree.folder]);
  return tree;
}

/**
 * Asserts every mounted read opened a file inside the shared folder, links followed, and that
 * none of `outsidePaths` — relative to the outside directory — was opened.
 */
function assertNoReadLeftTheFolder(
  tree: { folder: string; outside: string },
  outsidePaths: readonly string[],
): void {
  const folder = realpathSync(tree.folder);
  const outside = realpathSync(tree.outside);
  const opened = stub.openedPaths();
  assert.ok(opened.length > 0, 'the folder’s own ignore files were never read');
  for (const path of opened) {
    assert.ok(path.startsWith(`${folder}/`), `${path} was opened outside the shared folder`);
  }
  for (const path of outsidePaths) {
    assert.ok(!opened.includes(join(outside, path)), `${path} outside the folder was opened`);
  }
}

test('a host lists its folder through the ignore files the folder holds, and reads nothing above it', async (t) => {
  const { root, folder } = mounted(t);
  const listed = (await enumerateGrant(folders())).paths;
  assert.deepEqual(listed, [
    '.gitignore',
    'keep.log',
    'nested/.gitignore',
    'nested/drop.log',
    'nested/root-only/inside.txt',
    'src/main.rs',
  ]);

  // The ignore files the walk used are the folder's own, at its root and below it, and every read
  // it made stayed inside the folder: the shared folder is the bound on what a host reads, so the
  // `.gitignore` above it is not consulted and its rule is not honored.
  const reads = stub.readPaths();
  for (const wanted of ['.gitignore', '.git/info/exclude', 'nested/.gitignore']) {
    assert.ok(reads.includes(join(folder, wanted)), `${wanted} was never read`);
  }
  for (const path of reads) {
    assert.ok(path.startsWith(`${folder}/`), `${path} is outside the shared folder`);
  }
  assert.ok(!reads.includes(join(root, '.gitignore')), 'the ignore file above the folder was read');

  // The read half agrees with the listing, and the rule above the folder has nothing to say.
  assert.ok(servable(await grantedFile(folders(), 'keep.log')));
  assert.ok(servable(await grantedFile(folders(), 'nested/drop.log')));
  assert.ok(servable(await grantedFile(folders(), 'src/main.rs')), 'a rule above the folder is honored');
  for (const path of ['drop.log', 'notes.tmp', 'moved/a.txt', 'nested/note.txt', 'root-only/inside.txt']) {
    assert.deepEqual(await grantedFile(folders(), path), refused('not-granted'), `${path} is servable`);
  }
});

test('a peer cannot reach an ignore file through a link out of the folder', async (t) => {
  const { root, folder } = mounted(t);

  // The link's target holds a `.gitignore` naming `named.txt`, so a read of
  // `<folder>/link/.gitignore` would be the escape. The path is resolved first, the link is not a
  // plain directory, and the refusal comes before any read at all. `openedPaths` records what a
  // read would actually have opened, links followed, which `readPaths` cannot show.
  assert.deepEqual(await grantedFile(folders(), 'link/named.txt'), refused('not-a-file'));
  assert.deepEqual(await grantedFile(folders(), 'link/known.txt'), refused('not-a-file'));
  assert.deepEqual(stub.openedPaths(), [], 'an ignore file behind the link was opened');

  // And the walk never names what is behind it either. It does read the folder's own ignore
  // files, so `openedPaths` is what says none of those reads followed the link out.
  const listed = (await enumerateGrant(folders())).paths;
  assert.deepEqual(listed.filter((path) => path.startsWith('link/')), []);
  const realRoot = realpathSync(root);
  const realFolder = realpathSync(folder);
  for (const path of stub.openedPaths()) {
    assert.ok(path.startsWith(`${realFolder}/`), `${path} was opened outside the shared folder`);
  }
  assert.ok(
    !stub.openedPaths().includes(join(realRoot, 'outside', '.gitignore')),
    'the outside .gitignore was opened through the link',
  );
  assert.ok(listed.includes('src/main.rs'), 'the folder itself is still listed');
});

test('a linked ignore file is not read, so its rule re-includes nothing', async (t) => {
  const tree = linkedMounted(t);

  // `folder/.gitignore` is an ordinary file and ignores `hidden.txt` at every depth. The link at
  // `sub/.gitignore` names an outside file holding `!hidden.txt`; were it read, `sub/hidden.txt`
  // would be re-included, listed and served. It is not read, so that name stays out.
  const listed = (await enumerateGrant(folders())).paths;
  assert.ok(!listed.includes('sub/hidden.txt'), `a linked ignore file re-included a path: ${listed.join(', ')}`);
  assert.deepEqual(await grantedFile(folders(), 'sub/hidden.txt'), refused('not-granted'));
  assertNoReadLeftTheFolder(tree, ['said-by-the-link.gitignore']);
});

test('a linked .git is not read, so its exclude drops nothing', async (t) => {
  const tree = linkedMounted(t);

  // The link at `.git` names an outside repository directory whose `info/exclude` holds
  // `dropped-by-the-link.txt`; were it read, that name would vanish from the listing and be
  // refused. It is not read, so the name is listed and served.
  const listed = (await enumerateGrant(folders())).paths;
  assert.ok(listed.includes('dropped-by-the-link.txt'), `a linked .git dropped a path: ${listed.join(', ')}`);
  assert.ok(servable(await grantedFile(folders(), 'dropped-by-the-link.txt')));
  assertNoReadLeftTheFolder(tree, ['gitdir/info/exclude']);
});

// --- the bounds a walk stops at -----------------------------------------------------

/** The UTF-8 bytes of a listing's paths, counted here rather than by the code under test. */
function listedBytes(paths: readonly string[]): number {
  const encoder = new TextEncoder();
  return paths.reduce((total, path) => total + encoder.encode(path).length, 0);
}

test('a walk stops at the path count one listing carries, and says which bound it was', async (t) => {
  stub.reset();
  t.after(() => {
    stub.reset();
  });
  // One more than a listing carries, all of them shareable and in memory: the stub's working
  // copy is a map, so the bound is crossed without a hundred thousand files on a disk.
  for (let index = 0; index <= MAX_GRANT_PATHS; index += 1) {
    stub.put(`f-${index}.md`, 'x');
  }

  const listing = await enumerateGrant(folders());
  assert.equal(listing.cut, 'paths', 'the walk read past the ceiling in silence');
  assert.equal(listing.paths.length, MAX_GRANT_PATHS, 'the listing is not one ceiling wide');
  assert.equal(
    new Set(listing.paths).size,
    listing.paths.length,
    'the same path was listed twice',
  );
});

test('a walk stops when the paths it lists reach the byte bound, and says which bound it was', async (t) => {
  stub.reset();
  t.after(() => {
    stub.reset();
  });
  // 2000 names of 2100 UTF-8 bytes each: more than the 4 MiB a listing carries, in fewer files
  // than the count bound, so the byte bound is the one that binds. A character outside ASCII
  // is deliberate — the count is UTF-8 bytes and not UTF-16 code units.
  const long = 'あ'.repeat(700);
  const seeded = 2000;
  for (let index = 0; index < seeded; index += 1) {
    stub.put(`${index}-${long}.md`, 'x');
  }

  const listing = await enumerateGrant(folders());
  assert.equal(listing.cut, 'bytes', 'the walk read past the byte bound in silence');
  assert.ok(listing.paths.length > 0, 'the byte bound stopped the walk at the first path');
  assert.ok(listing.paths.length < seeded, 'every path was listed');
  const bytes = listedBytes(listing.paths);
  assert.ok(bytes <= MAX_GRANT_LISTING_BYTES, `the listing is over the bound: ${bytes}`);
  assert.ok(
    bytes + listedBytes([`0-${long}.md`]) > MAX_GRANT_LISTING_BYTES,
    `the walk stopped well short of the bound: ${bytes}`,
  );
});

test('a walk stops when its budget is spent, and says so rather than listing nothing', async (t) => {
  stub.reset();
  t.after(() => {
    stub.reset();
  });
  // The budget pays for the shareability check every candidate costs, so a folder of files too
  // large to share spends it without naming one. Two small files sort first and are listed;
  // the bound that stops the walk is the budget and not the listing.
  stub.put('a-granted.md', 'x');
  stub.put('a-granted-too.md', 'x');
  for (let index = 0; index <= MAX_GRANT_NODES; index += 1) {
    stub.put(`b-${index}.md`, 'x', { size: MAX_GRANT_FILE_BYTES + 1 });
  }

  const listing = await enumerateGrant(folders());
  assert.deepEqual(listing.paths, ['a-granted-too.md', 'a-granted.md'], 'the walk listed the wrong paths');
  assert.equal(listing.cut, 'budget', 'the walk gave up in silence');
});

test('a name a room never shares costs the walk nothing', async (t) => {
  stub.reset();
  t.after(() => {
    stub.reset();
  });
  // The defect this accounting exists for: a tree rich in assets and poor in sources. Every one
  // of these names is dropped by the name alone — a binary format a room cannot carry — so the
  // walk spends nothing on them, where charging for each entry would spend the whole budget
  // before the first shareable file and publish a listing that names none of them.
  for (let index = 0; index < MAX_GRANT_NODES; index += 1) {
    stub.put(`a-${index}.png`, 'x');
  }
  for (let index = 0; index < 5; index += 1) {
    stub.put(`z-${index}.md`, 'x');
  }

  const listing = await enumerateGrant(folders());
  assert.equal(listing.paths.length, 5, `assets starved the walk: ${listing.paths.length} listed`);
  assert.equal(listing.cut, undefined, 'a complete listing was reported as cut');
});
