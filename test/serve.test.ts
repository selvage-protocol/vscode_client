/**
 * The serve path's bound: a peer names a path, and the host reads its own disk for it.
 * Every shape that tries to leave the shared folder is refused — a `..`, an absolute
 * path, a symlinked directory on the way, a leaf that is itself a link, a name the grant
 * excludes, a path the folder's own ignore files leave out — while a granted file is still
 * served and still listed.
 *
 * Two halves are tested here. `grantedFile` answers the URI this window's editor opens a peer's
 * path through, and it is checked against the editor stub's working copy: what it answers is a
 * name, so the editor resolves that name again, which is `grantedFile`'s stated residual and not
 * a check it can make. The read a peer asks for is `readGrantedText`, and it is checked against a
 * *real* tree on disk, because it opens each component inside the descriptor of the component
 * before it: a working copy of names cannot show a descriptor being held, and only a real
 * symbolic link can be swapped for a real directory.
 *
 * The adapter is loaded directly with the editor stubbed. `put` seeds the stub's working copy for
 * the `grantedFile` half; `readTree` writes the real tree the read half needs, and swapping a
 * directory or a leaf in it for a link is how a name that resolved once stops being the object it
 * named.
 *
 * Those real trees live under `<repo>/.tmp/` — never `/tmp`, which is a RAM-backed tmpfs on this
 * host — and the mounted tests read them through the window's own file system too: `readPaths` is
 * every path `workspace.fs.readFile` was asked for, and `openedPaths` is the real file each
 * mounted read actually opened with its links followed. A read through a link is asked for under
 * the link's own name, so only `openedPaths` can say that nothing outside the shared folder — and
 * nothing behind a link — was ever opened.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { createRequire, registerHooks } from 'node:module';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Uri } from 'vscode';
import type { GrantRefusal } from '../src/bridge/bridge.ts';
import { MAX_GRANT_FILE_BYTES, MAX_GRANT_NODES, MAX_GRANT_PATHS } from '../src/bridge/index.ts';
import { afterLstat } from './helpers/peer-read-seam.ts';
import * as vscodeLoader from './helpers/vscode-loader.ts';

/** The module a peer's read is written in, whose own `node:fs/promises` import the seam answers. */
const GRANT = pathToFileURL(join(import.meta.dirname, '..', 'src', 'adapter', 'grant.ts')).href;
const PEER_READ_SEAM = pathToFileURL(
  join(import.meta.dirname, 'helpers', 'peer-read-seam.ts'),
).href;

// `grant.ts`'s own `node:fs/promises` is the seam module, so a test can land a rename inside the
// window of one read; every other module reads the real one. See `helpers/peer-read-seam.ts`.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'node:fs/promises' && context.parentURL === GRANT) {
      return { url: PEER_READ_SEAM, shortCircuit: true };
    }
    return vscodeLoader.resolve(specifier, context, next);
  },
});
const vscode = await import('vscode');
const { enumerateGrant, grantedFile, isShareableFile, readGrantedText } = await import(
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
  /** Every path `workspace.fs.readDirectory` was asked for since the last reset, in order. */
  listedPaths(): string[];
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
  const tree = readTree(t, (put, outside) => {
    writeFileSync(join(outside, 'secret.txt'), 'outside\n');
    put('plain.txt', 'inside\n');
  });
  symlinkSync(join(tree.outside, 'secret.txt'), join(tree.folder, 'leaf.txt'), 'file');

  // The refusal is the read's own: the leaf is opened `O_NOFOLLOW`, so a link standing where the
  // room's file should be is refused by the open itself rather than followed to its target, which
  // here is a file outside the folder the guest never named.
  const editor = new WorkspaceEditor({
    role: 'host',
    folders: folders(),
    report: () => undefined,
  });
  assert.deepEqual(await editor.readGrantedFile('leaf.txt'), unreadable('not-a-file'));
  assert.deepEqual(await editor.readGrantedFile('plain.txt'), {
    kind: 'text',
    text: 'inside\n',
  });
  editor.dispose();
});

test('a file whose name declares a binary format is refused as binary, and not listed', async (t) => {
  readTree(t, (put) => {
    put('logo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a]));
    put('latin1.txt', new Uint8Array([0x63, 0x61, 0x66, 0xe9]));
    put('notes.txt', 'notes\n');
  });

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

/**
 * A tree on the real disk for the read a peer asks for: the window's folder and a directory
 * beside it that only a link reaches, with the window's folders pointed at the tree and the
 * window's own file system mounted on it so both halves of the adapter read the same tree.
 *
 * Every piece is real — a real symbolic link, a real directory a link can replace — because that
 * read opens each component through a descriptor and refuses a link where a directory has to be
 * *by the open itself*, which a working copy of names cannot show. `build` writes inside the
 * folder and outside it; the tests plant links and replace names afterwards, since nothing here
 * reads anything until the test asks.
 */
function readTree(
  t: TestContext,
  build: (put: (rel: string, content: string | Uint8Array) => void, outside: string) => void,
): { root: string; folder: string; outside: string } {
  mkdirSync(CASES, { recursive: true });
  const root = mkdtempSync(join(CASES, 'grant-read-'));
  const folder = join(root, 'folder');
  const outside = join(root, 'outside');
  mkdirSync(folder, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const put = (rel: string, content: string | Uint8Array): void => {
    const path = join(folder, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  build(put, outside);
  t.after(() => {
    stub.reset();
    rmSync(root, { recursive: true, force: true });
  });
  stub.mount(root);
  stub.setWorkspaceFolders([folder]);
  return { root, folder, outside };
}

/**
 * The window's file system as a *provider*: a store this process has no path into, which is what a
 * folder on any scheme but `file:` is read through.
 *
 * A virtual workspace is the editor's view of a store elsewhere (`vscode-vfs://`, a container, a
 * repository the window reads through the editor), so there is no component of it this process can
 * resolve: the folder is listed through the window, and a read is the window's own `stat` and
 * `readFile` rather than a descriptor. The store is seeded relative to the folder, and a path it
 * does not hold is `FileNotFound`, which is how a provider answers for a name it has not got.
 *
 * The key is the URI's path with its leading slashes gone: the stub's `Uri.joinPath` names a child
 * by joining its parent's path (it answers a `file:` URI either way), so that is what a folder and
 * its children agree on. A path outside the folder is an error rather than a missing file, so a
 * read that reached past the store fails the test instead of passing it vacuously.
 */
function servedWindow(
  t: TestContext,
  folder: { readonly path: string },
  files: Record<string, string | Uint8Array>,
): void {
  const key = (uri: unknown): string => String((uri as { path: unknown }).path).replace(/^\/+/, '');
  const root = key(folder);
  const held = new Map<string, Uint8Array>(
    Object.entries(files).map(([name, content]) => [
      `${root}/${name}`,
      typeof content === 'string' ? new TextEncoder().encode(content) : content,
    ]),
  );
  const isDirectory = (path: string): boolean =>
    path === root || [...held.keys()].some((one) => one.startsWith(`${path}/`));
  const listing = (path: string): Array<[string, number]> => {
    const names = new Map<string, number>();
    for (const one of held.keys()) {
      const rest = one.startsWith(`${path}/`) ? one.slice(path.length + 1) : undefined;
      if (rest === undefined) {
        continue;
      }
      const slash = rest.indexOf('/');
      if (slash === -1) {
        names.set(rest, vscode.FileType.File);
      } else if (!names.has(rest.slice(0, slash))) {
        names.set(rest.slice(0, slash), vscode.FileType.Directory);
      }
    }
    return [...names.entries()];
  };
  const missing = (path: string): Error => new Error(`vscode-vfs: no such entry: ${path}`);

  const fs = vscode.workspace.fs as unknown as Record<string, unknown>;
  const original = { ...fs };
  Object.assign(fs, {
    readDirectory: (uri: unknown) => {
      const path = key(uri);
      return isDirectory(path)
        ? Promise.resolve(listing(path))
        : Promise.reject(missing(path));
    },
    stat: (uri: unknown) => {
      const path = key(uri);
      const bytes = held.get(path);
      const type = bytes === undefined ? vscode.FileType.Directory : vscode.FileType.File;
      if (bytes === undefined && !isDirectory(path)) {
        return Promise.reject(missing(path));
      }
      return Promise.resolve({ type, ctime: 0, mtime: 0, size: bytes?.length ?? 0 });
    },
    readFile: (uri: unknown) => {
      const bytes = held.get(key(uri));
      return bytes === undefined ? Promise.reject(missing(key(uri))) : Promise.resolve(bytes);
    },
  });
  t.after(() => {
    Object.assign(fs, original);
  });
}

/**
 * How much a file outside the folder pads itself: far past what the files of the folder cost
 * together, so that a read of the outside one cannot hide in the bytes this process read.
 */
const PADDING_BYTES = 128 * 1024;

/**
 * The bytes this process has read through `read` calls, from the kernel's own accounting, or
 * `undefined` where the kernel publishes no such count.
 *
 * A file's bytes cannot be read without moving this number, and it is the only way an in-process
 * test can see the opens a read makes for itself: the count is of bytes read, so a listing, an
 * `lstat` and an open that reads nothing do not move it.
 */
function bytesRead(): number | undefined {
  if (!existsSync('/proc/self/io')) {
    return undefined;
  }
  const line = readFileSync('/proc/self/io', 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith('rchar:'));
  return line === undefined ? undefined : Number(line.slice('rchar:'.length).trim());
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

// --- the read a peer asks for: resolved and read in one step -------------------------

test('a peer reads a real file through a real directory, one descriptor at a time', async (t) => {
  readTree(t, (put) => {
    put('notes.txt', 'notes\n');
    put('src/deep/main.rs', 'fn main() {}\n');
  });

  // The read the bridge asks for, so the answer the room sees is the one the adapter gives for a
  // plain file of the folder.
  const editor = new WorkspaceEditor({
    role: 'host',
    folders: folders(),
    report: () => undefined,
  });
  assert.deepEqual(await editor.readGrantedFile('notes.txt'), { kind: 'text', text: 'notes\n' });
  editor.dispose();

  // And a leaf two real directories down, read through the descriptor of the last of them.
  assert.deepEqual(await readGrantedText(folders(), 'src/deep/main.rs'), {
    kind: 'text',
    text: 'fn main() {}\n',
  });
});

test('a path through a symlinked directory is refused, and nothing behind it is read', async (t) => {
  const tree = readTree(t, (put, outside) => {
    writeFileSync(join(outside, 'secret.txt'), 'outside\n');
    put('real/inner.txt', 'inside\n');
  });
  symlinkSync(tree.outside, join(tree.folder, 'link'), 'dir');

  // The step is opened `O_NOFOLLOW` and has to be a directory, so the link is refused by that
  // open: the file behind it is never named, and never read. The link itself is not a leaf a
  // session carries either.
  assert.deepEqual(await readGrantedText(folders(), 'link/secret.txt'), unreadable('not-a-file'));
  assert.deepEqual(await readGrantedText(folders(), 'link'), unreadable('not-a-file'));
  assert.deepEqual(await readGrantedText(folders(), 'real/inner.txt'), {
    kind: 'text',
    text: 'inside\n',
  });
});

test('a directory swapped for a link after it was accepted stops being served', async (t) => {
  const tree = readTree(t, (put, outside) => {
    writeFileSync(join(outside, 'inner.txt'), 'outside\n');
    put('swap/inner.txt', 'inside\n');
  });
  assert.deepEqual(await readGrantedText(folders(), 'swap/inner.txt'), {
    kind: 'text',
    text: 'inside\n',
  });

  // A build or a branch switch replaces the directory: the name that resolved a moment ago names
  // a link to elsewhere now. The next read resolves the step again and refuses it in the same step
  // it opens, rather than serving what the earlier resolution saw.
  rmSync(join(tree.folder, 'swap'), { recursive: true });
  symlinkSync(tree.outside, join(tree.folder, 'swap'), 'dir');
  assert.deepEqual(await readGrantedText(folders(), 'swap/inner.txt'), unreadable('not-a-file'));
});

test('a file swapped for a link after it was read stops being served', async (t) => {
  const tree = readTree(t, (put, outside) => {
    writeFileSync(join(outside, 'leaf.txt'), 'outside\n');
    put('leaf.txt', 'inside\n');
  });
  assert.deepEqual(await readGrantedText(folders(), 'leaf.txt'), {
    kind: 'text',
    text: 'inside\n',
  });

  // A link standing where the file was is not a leaf this window serves: the name is looked up
  // with its own last component unresolved, so the link is what the answer is about rather than
  // its target, which is a file outside the folder the guest never named.
  rmSync(join(tree.folder, 'leaf.txt'));
  symlinkSync(join(tree.outside, 'leaf.txt'), join(tree.folder, 'leaf.txt'), 'file');
  assert.deepEqual(await readGrantedText(folders(), 'leaf.txt'), unreadable('not-a-file'));
});

test('a leaf swapped for a link between the name and the read is refused', async (t) => {
  const tree = readTree(t, (put, outside) => {
    writeFileSync(join(outside, 'leaf.txt'), 'outside\n');
    put('leaf.txt', 'inside\n');
  });

  // The claim the read has to keep is about one read, so no second call of this test's can land in
  // the window: the lookup above the read is what a swap has to get behind. `afterLstat` runs as
  // that lookup answers — where a concurrent writer's rename lands — so what is under test is the
  // step that follows the name rather than a check of it.
  let swapped = false;
  afterLstat((path) => {
    if (!path.endsWith('/leaf.txt')) {
      return;
    }
    swapped = true;
    rmSync(join(tree.folder, 'leaf.txt'));
    symlinkSync(join(tree.outside, 'leaf.txt'), join(tree.folder, 'leaf.txt'), 'file');
  });
  t.after(() => {
    afterLstat(undefined);
  });

  // The open is `O_NOFOLLOW`, so the swap is refused by the open itself: the bytes of the file
  // outside the folder are never this host's to hand over, and the guest is refused rather than
  // served what a link happens to point at.
  assert.deepEqual(await readGrantedText(folders(), 'leaf.txt'), unreadable('not-a-file'));
  assert.ok(swapped, 'the leaf was not looked up through the seam: this test covers nothing');
});

test('a leaf grown past the bound between the name and the read is refused', async (t) => {
  const tree = readTree(t, (put) => {
    put('leaf.txt', 'small\n');
  });

  // The type and the size are read from the descriptor the bytes come from, not from the name a
  // moment earlier, so a file grown after the lookup cannot get a peer past the bound: the size
  // the read is held to is the size of the object being read.
  let swapped = false;
  afterLstat((path) => {
    if (!path.endsWith('/leaf.txt') || swapped) {
      return;
    }
    swapped = true;
    writeFileSync(join(tree.folder, 'leaf.txt'), 'x'.repeat(MAX_GRANT_FILE_BYTES + 1));
  });
  t.after(() => {
    afterLstat(undefined);
  });

  assert.deepEqual(await readGrantedText(folders(), 'leaf.txt'), unreadable('too-large'));
  assert.ok(swapped, 'the leaf was not looked up through the seam: this test covers nothing');
});

test('a peer read of a file this window cannot open is `missing`, not a shape it is not', async (t) => {
  const tree = readTree(t, (put) => {
    put('locked.txt', 'secret\n');
  });
  if (process.getuid?.() === 0) {
    return; // A root process opens anything, so there is no unreadable file here to ask for.
  }

  // `missing` is the vocabulary's word for a file that is absent, deleted since the listing, or
  // unreadable, and this is the third: the answer says nothing was read, which is true, rather
  // than that what is there is not a plain file, which would not be.
  chmodSync(join(tree.folder, 'locked.txt'), 0o000);
  assert.deepEqual(await readGrantedText(folders(), 'locked.txt'), unreadable('missing'));
  assert.deepEqual(await readGrantedText(folders(), 'absent.txt'), unreadable('missing'));
});

test('a variant spelling of a leaf or a directory is refused before it resolves', async (t) => {
  // The portable half of the hole, on any host: U+FFFD is what Node decodes a directory entry to,
  // and a lone surrogate is a different string whose own UTF-8 encoding is U+FFFD's bytes — so the
  // request names no entry and still resolves to one. A file system that folds case or ignores
  // Unicode normalization is the same shape with the alias that platform provides.
  const listed = '\ufffd';
  const variant = '\ud800';
  readTree(t, (put) => {
    put(`${listed}.txt`, 'the leaf the listing names\n');
    put(`${listed}/inside.txt`, 'the directory the listing names\n');
    put('src/main.rs', 'the listed spelling\n');
    put('ignored/secret.txt', 'under an ignored directory\n');
    put('.gitignore', 'ignored/\n');
  });

  // The case variants are refused because the name is not there at all on a host that does not
  // fold; the surrogate ones because the entry check is the whole of what refuses them, which is
  // the same rule a folding mount needs. A variant directory and a variant leaf are separate call
  // sites, so both are named.
  for (const path of [
    'SRC/main.rs',
    'src/MAIN.rs',
    'IGNORED/secret.txt',
    `${variant}.txt`,
    `${variant}/inside.txt`,
  ]) {
    assert.deepEqual(
      await readGrantedText(folders(), path),
      unreadable('missing'),
      `${path} was served`,
    );
  }

  // The spellings the listing does carry still resolve, and the ignore rule still binds.
  assert.deepEqual(await readGrantedText(folders(), `${listed}.txt`), {
    kind: 'text',
    text: 'the leaf the listing names\n',
  });
  assert.deepEqual(await readGrantedText(folders(), `${listed}/inside.txt`), {
    kind: 'text',
    text: 'the directory the listing names\n',
  });
  assert.deepEqual(await readGrantedText(folders(), 'src/main.rs'), {
    kind: 'text',
    text: 'the listed spelling\n',
  });
  assert.deepEqual(
    await readGrantedText(folders(), 'ignored/secret.txt'),
    unreadable('not-granted'),
  );
});

test('a peer read refuses what escapes, what the grant excludes, and what is over the bounds', async (t) => {
  readTree(t, (put) => {
    put('.env', 'SECRET=1\n');
    put('.git/config', 'secret\n');
    put('id_rsa', 'secret\n');
    put('notes.txt', 'notes\n');
    put('big.txt', 'x'.repeat(MAX_GRANT_FILE_BYTES + 1));
    put('nul.bin', new Uint8Array([0x61, 0x00, 0x62]));
  });

  // A path that leaves the folder is the grant's own no, before any name of it is resolved.
  for (const path of ['../etc/passwd', 'src/../../etc/passwd', '/etc/passwd', '']) {
    assert.deepEqual(
      await readGrantedText(folders(), path),
      unreadable('not-granted'),
      `${path} was served`,
    );
  }
  // So is a name the grant deliberately leaves out, whatever the disk holds under it.
  for (const path of ['.env', '.git/config', 'id_rsa']) {
    assert.deepEqual(
      await readGrantedText(folders(), path),
      unreadable('not-granted'),
      `${path} was served`,
    );
  }
  assert.deepEqual(await readGrantedText(folders(), 'absent.txt'), unreadable('missing'));
  assert.deepEqual(await readGrantedText(folders(), 'big.txt'), unreadable('too-large'));
  assert.deepEqual(await readGrantedText(folders(), 'nul.bin'), unreadable('binary'));
  assert.deepEqual(await readGrantedText(folders(), 'notes.txt'), { kind: 'text', text: 'notes\n' });
});

test('a peer read reads the folder\u2019s own ignore files, and never a linked one', async (t) => {
  const tree = readTree(t, (put, outside) => {
    // The link's target names `kept.txt`, which the folder's own rules keep: were it read, a file
    // the peer never named would vanish under `sub/`. It pads itself far past what the folder
    // reads, so the bytes this process read say whether it was read at all.
    writeFileSync(
      join(outside, 'said-by-the-link.gitignore'),
      `# ${'x'.repeat(PADDING_BYTES)}\nkept.txt\n`,
    );
    mkdirSync(join(outside, 'gitdir', 'info'), { recursive: true });
    writeFileSync(join(outside, 'gitdir', 'info', 'exclude'), 'notes.txt\n');
    put('.gitignore', 'hidden.txt\n');
    put('hidden.txt', 'ignored by the folder\n');
    put('sub/kept.txt', 'kept\n');
    put('sub/hidden.txt', 'ignored by the folder too\n');
    put('notes.txt', 'kept unless the linked .git is read\n');
  });
  symlinkSync(
    join(tree.outside, 'said-by-the-link.gitignore'),
    join(tree.folder, 'sub', '.gitignore'),
    'file',
  );

  const before = bytesRead();
  assert.deepEqual(await readGrantedText(folders(), 'sub/kept.txt'), {
    kind: 'text',
    text: 'kept\n',
  });
  assert.deepEqual(await readGrantedText(folders(), 'sub/hidden.txt'), unreadable('not-granted'));
  const after = bytesRead();
  if (before !== undefined && after !== undefined) {
    assert.ok(
      after - before < PADDING_BYTES / 4,
      `${after - before} bytes were read, where the folder's own ignore file is tens of bytes: a linked one was read`,
    );
  }

  // The repository exclude a linked `.git` would supply is not this folder's rule either: it is
  // opened `O_NOFOLLOW` where a directory has to be, so nothing of it is read.
  symlinkSync(join(tree.outside, 'gitdir'), join(tree.folder, '.git'), 'dir');
  assert.deepEqual(await readGrantedText(folders(), 'notes.txt'), {
    kind: 'text',
    text: 'kept unless the linked .git is read\n',
  });
});

test('a folder the window holds over another scheme is read through the window', async (t) => {
  // A virtual workspace is the editor's own view of a store this process cannot descend: the
  // listing still names what it holds, and a read has no component to resolve, so it goes through
  // the window's own file system, with the grant's checks in front of it as for a folder of this
  // machine's disk. `servedWindow` is that store: the bytes below are what the window serves.
  const virtual = vscode.Uri.parse('vscode-vfs://host/folder');
  servedWindow(t, virtual, {
    'notes.txt': 'notes\n',
    'sub/inside.txt': 'a directory down\n',
    '.gitignore': 'ignored.txt\n',
    'ignored.txt': 'dropped by the folder’s own rule\n',
    '.env': 'SECRET=1\n',
    'latin1.txt': new Uint8Array([0x63, 0x61, 0x66, 0xe9]),
    'big.txt': 'x'.repeat(MAX_GRANT_FILE_BYTES + 1),
  });
  const windowOn = (uri: Uri) => [{ uri, name: 'folder', index: 0 }];

  assert.deepEqual(await readGrantedText(windowOn(virtual), 'notes.txt'), {
    kind: 'text',
    text: 'notes\n',
  });
  assert.deepEqual(await readGrantedText(windowOn(virtual), 'sub/inside.txt'), {
    kind: 'text',
    text: 'a directory down\n',
  });

  // The grant's own rules bind it before the window is asked for any bytes, and the folder's own
  // ignore file is read for the path rather than whatever the provider would say about it.
  for (const path of ['ignored.txt', '.env', '../etc/passwd']) {
    assert.deepEqual(
      await readGrantedText(windowOn(virtual), path),
      unreadable('not-granted'),
      `${path} was served`,
    );
  }

  // And the read's own answers are the ones a folder of this disk gives: a name the window has not
  // got, something that is not a plain file, and the two bounds a session carries.
  assert.deepEqual(await readGrantedText(windowOn(virtual), 'absent.txt'), unreadable('missing'));
  assert.deepEqual(await readGrantedText(windowOn(virtual), 'sub'), unreadable('not-a-file'));
  assert.deepEqual(await readGrantedText(windowOn(virtual), 'big.txt'), unreadable('too-large'));
  assert.deepEqual(await readGrantedText(windowOn(virtual), 'latin1.txt'), unreadable('binary'));
});

// --- the bounds a walk stops at -----------------------------------------------------

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

test('a name a room never shares costs the walk nothing', async (t) => {
  stub.reset();
  t.after(() => {
    stub.reset();
  });
  // A tree rich in assets and poor in sources: every one of these names is dropped by the name
  // alone — a binary format a room cannot carry — so the walk spends nothing on them. Charging
  // for each entry would spend the whole budget before the first shareable file and publish a
  // listing that names none of them.
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

test('a walk lists the folder once, and takes its exclude from the entries it read', async (t) => {
  stub.reset();
  t.after(() => {
    stub.reset();
  });
  stub.put('.git/info/exclude', 'dropped.tmp\n');
  stub.put('.gitignore', 'also-dropped.tmp\n');
  stub.put('dropped.tmp', 'dropped by the repository exclude\n');
  stub.put('also-dropped.tmp', 'dropped by the ignore file\n');
  stub.put('kept.txt', 'kept\n');

  // The repository exclude is the root's own ignore source, and it is read from the entries the
  // walk already holds rather than by listing the root again. Both rules are in force, so both
  // sources were read.
  assert.deepEqual((await enumerateGrant(folders())).paths, ['.gitignore', 'kept.txt']);

  const listed = stub.listedPaths();
  const roots = listed.filter((path) => path === '/workspace');
  assert.equal(roots.length, 1, `the folder was listed ${roots.length} times`);
  // `.git` and `info` are the only other directories read, and they are not the folder: at the
  // ceiling a second listing of the root is another 100 000-entry enumeration per publish.
  assert.ok(listed.includes('/workspace/.git'), 'the repository directory was never read');
  assert.ok(listed.includes('/workspace/.git/info'), 'the repository exclude was never looked for');
});
