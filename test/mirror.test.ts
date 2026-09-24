/**
 * The mirror on disk, against the real filesystem and a real room.
 *
 * The mirror is the one adapter module a test can drive without an editor: it is files
 * under a directory, so every assertion reads them back off disk. Roots live under
 * `<repo>/.tmp/mirror-tests/` — never `/tmp`, which is a RAM-backed tmpfs on this host —
 * and each test removes its own directory on the way out. Every guard names the mutation
 * that turns its test red: the guard removed, the clobber allowed, the adopt skipped, the
 * invite kept.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { createRequire, registerHooks } from 'node:module';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type * as vscode from 'vscode';

import { FakeServer } from './helpers/fake-server.ts';
import { waitFor } from './helpers/wait.ts';
import { LiveSession } from './helpers/live-session.ts';
import { MAX_GRANT_PATHS } from '../src/bridge/index.ts';
import * as vscodeLoader from './helpers/vscode-loader.ts';

// The adapter module loaded directly, with the editor API stubbed for its `Uri.file`.
registerHooks(vscodeLoader);
const {
  MIRROR_MARKER,
  isWorkspaceConfigPath,
  mintMirror,
  mirrorRelative,
  openMirror,
  pruneRoom,
  readMarker,
  sanitiseRoom,
} =
  await import('../src/adapter/mirror.ts');

const OPTIONS = { client: 'selvage-vscode-test/0.1.0' } as const;
const ROOT = resolve(import.meta.dirname, '..');
const CASES = join(ROOT, '.tmp', 'mirror-tests');

const stub = createRequire(import.meta.url)('./helpers/vscode-stub.cjs') as {
  Uri: { file(path: string): vscode.Uri };
};

/** A fresh storage directory, removed with the test. Never `/tmp`. */
function storage(t: TestContext): vscode.Uri {
  mkdirSync(CASES, { recursive: true });
  const dir = mkdtempSync(join(CASES, 'case-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return stub.Uri.file(dir);
}

function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

test('a listing materialises as empty files with the directories on the way', (t) => {
  const keep = storage(t);
  const mirror = mintMirror(keep, 'r-0aF1', { window: 'w-shape', pid: process.pid });
  const report = mirror.materialise(['README.md', 'notes/guide/intro.md', 'src/main.rs']);
  assert.deepEqual(report.refused, []);
  assert.deepEqual(report.mirrored.sort(), ['README.md', 'notes/guide/intro.md', 'src/main.rs']);
  for (const path of ['README.md', 'notes/guide/intro.md', 'src/main.rs']) {
    const file = join(mirror.root, ...path.split('/'));
    assert.equal(isFile(file), true, `${path} is not a file under the root`);
    assert.equal(readFileSync(file, 'utf8'), '', `${path} was not materialised empty`);
  }
  // The marker is the mirror's own: the listing did not touch it and it is still ours.
  const marker = readMarker(mirror.root);
  assert.equal(marker?.room, 'r-0aF1');
  assert.equal(marker?.window, 'w-shape');
});

test('a listing from a real room materialises', async (t) => {
  const server = await FakeServer.start({ keepalive: { awareness_renew_ms: 300, awareness_expire_ms: 900 } });
  t.after(async () => {
    await server.stop();
  });
  const host = await LiveSession.host(server.wsBase, 'Ada', OPTIONS);
  t.after(async () => {
    await host.disconnect();
  });
  await host.grant(['README.md', 'notes/guide/intro.md', 'src/main.rs']);
  const invite = host.inviteUrl();
  assert.ok(invite !== undefined, 'the host was given no invite link');
  const guest = await LiveSession.join(invite, 'Bob', OPTIONS);
  t.after(async () => {
    await guest.disconnect();
  });
  const paths = await waitFor('the grant to reach the guest', () =>
    guest.grantedPaths().length === 3 ? guest.grantedPaths() : false,
  );
  const mirror = mintMirror(storage(t), host.session().roomId, {
    window: 'w-room',
    pid: process.pid,
  });
  const report = mirror.materialise(paths);
  assert.deepEqual(report.refused, []);
  assert.deepEqual(report.mirrored.sort(), [...paths].sort());
  for (const path of paths) {
    assert.equal(isFile(join(mirror.root, ...path.split('/'))), true, `${path} is missing`);
  }
});

test('a path a listing may not carry creates nothing and is reported', async (t) => {
  const keep = storage(t);
  const mirror = mintMirror(keep, 'r-refuse', { window: 'w-refuse', pid: process.pid });
  const outside = join(keep.fsPath, 'escaped.txt');
  const bad = [
    '../x',
    '/abs',
    'a\\b',
    'a/../../b',
    '.env',
    `${'x'.repeat(4097)}.md`,
    MIRROR_MARKER,
  ];
  const report = mirror.materialise(bad);
  // Red without `isGrantedPath` at the materialiser, and without the marker guard: the
  // traversal writes outside the root and the marker name overwrites the mirror's own.
  assert.deepEqual(report.mirrored, []);
  assert.deepEqual(report.refused.sort(), [...bad].sort());
  assert.equal(existsSync(outside), false, 'a traversal escaped the root');
  assert.equal(existsSync(join(keep.fsPath, 'abs')), false, 'an absolute path was created');
  const marker = readMarker(mirror.root);
  assert.equal(marker?.room, 'r-refuse', 'the marker was clobbered by the listing');
  assert.equal(marker?.window, 'w-refuse');
});

/**
 * A guest's mirror is its window's workspace folder, so the room's `.vscode/` would be applied
 * by the editor rather than shown: a host could set a setting that names a program, or a task
 * that runs one. Red without the withholding at the materialiser: every path lands on disk.
 */
test('the room’s workspace configuration is withheld, not mirrored', (t) => {
  const keep = storage(t);
  const mirror = mintMirror(keep, 'r-config', { window: 'w-config', pid: process.pid });
  const config = [
    '.vscode/settings.json',
    '.vscode/tasks.json',
    'app/.vscode/launch.json',
    'team.code-workspace',
  ];
  const report = mirror.materialise(['README.md', ...config]);
  assert.deepEqual(report.mirrored, ['README.md']);
  assert.deepEqual(report.refused, []);
  assert.deepEqual(report.withheld.sort(), [...config].sort());
  assert.equal(existsSync(join(mirror.root, '.vscode')), false, 'a .vscode directory was created');
  assert.equal(existsSync(join(mirror.root, 'team.code-workspace')), false);
});

test('workspace configuration is recognised the way the guest’s filesystem names it', () => {
  for (const path of [
    '.vscode/settings.json',
    '.VSCode/tasks.json',
    '.vscode./settings.json',
    '.vscode /settings.json',
    'nested/.vscode/launch.json',
    'Team.Code-Workspace',
    'team.code-workspace.',
  ]) {
    assert.equal(isWorkspaceConfigPath(path), true, `${path} was not recognised`);
  }
  for (const path of [
    'README.md',
    '.vscode',
    '.vscode-test/run.js',
    'docs/vscode/settings.json',
    'src/.vscoderc',
    'code-workspace.md',
  ]) {
    assert.equal(isWorkspaceConfigPath(path), false, `${path} was withheld for no reason`);
  }
});

test('a listing past the count bound refuses its excess', (t) => {
  const keep = storage(t);
  const mirror = mintMirror(keep, 'r-count', { window: 'w-count', pid: process.pid });
  const listing = Array.from({ length: MAX_GRANT_PATHS + 1 }, (_, index) => `f-${index}.md`);
  const report = mirror.materialise(listing);
  // Red without the count bound: the excess file lands on disk unreported.
  assert.deepEqual(report.refused, ['f-5000.md']);
  assert.equal(isFile(join(mirror.root, 'f-5000.md')), false, 'the excess path was created');
  assert.equal(isFile(join(mirror.root, 'f-0.md')), true, 'the bound refused the whole listing');
  assert.equal(report.mirrored.length, MAX_GRANT_PATHS);
});

test('a symlinked directory on the way creates nothing outside the root', (t) => {
  const keep = storage(t);
  const target = join(keep.fsPath, 'target');
  mkdirSync(target, { recursive: true });
  const mirror = mintMirror(keep, 'r-link', { window: 'w-link', pid: process.pid });
  symlinkSync(target, join(mirror.root, 'linkdir'), 'dir');
  const report = mirror.materialise(['linkdir/evil.txt']);
  // Red without the per-segment directory check: the walk follows the link and the file
  // lands in the target. The guard already rejects a linked *file*; this is the shape it
  // does not catch.
  assert.deepEqual(report.mirrored, []);
  assert.deepEqual(report.refused, ['linkdir/evil.txt']);
  assert.equal(existsSync(join(target, 'evil.txt')), false, 'the walk escaped through the link');
  assert.equal(
    existsSync(join(mirror.root, 'linkdir', 'evil.txt')),
    false,
    'the refused path is reachable through the link',
  );
});

test('a symlinked leaf is refused, not listed as mirrored', (t) => {
  const keep = storage(t);
  const target = join(keep.fsPath, 'outside.txt');
  writeFileSync(target, 'the person’s own text\n');
  const mirror = mintMirror(keep, 'r-leaf', { window: 'w-leaf', pid: process.pid });
  symlinkSync(target, join(mirror.root, 'linked.txt'), 'file');
  const report = mirror.materialise(['linked.txt']);
  // Red with a link at the leaf accepted: it is listed as mirrored, the editor reads it
  // through the link and saves the room's text through it, and the file outside the mirror
  // is the one that changes.
  assert.deepEqual(report.mirrored, []);
  assert.deepEqual(report.refused, ['linked.txt']);
  assert.equal(
    readFileSync(target, 'utf8'),
    'the person’s own text\n',
    'the link’s target was written',
  );
  assert.equal(
    lstatSync(join(mirror.root, 'linked.txt')).isSymbolicLink(),
    true,
    'the link was replaced with a file of the room’s',
  );
});

test('minting under a symlinked segment is refused', (t) => {
  const keep = storage(t);
  const target = join(keep.fsPath, 'target');
  mkdirSync(target, { recursive: true });
  mkdirSync(join(keep.fsPath, 'rooms'), { recursive: true });
  symlinkSync(target, join(keep.fsPath, 'rooms', 'r-evil'), 'dir');
  // Red without the segment check: the mirror lands inside the link's target.
  assert.throws(() => mintMirror(keep, 'r-evil', { window: 'w-evil' }), /not a plain directory/);
  assert.deepEqual(readdirSync(target), [], 'the refused mint wrote through the link');
});

test('a republish never overwrites and removes only what no document holds', (t) => {
  const keep = storage(t);
  const mirror = mintMirror(keep, 'r-republish', { window: 'w-republish', pid: process.pid });
  mirror.materialise(['keep.md', 'gone.md', 'held.md']);
  writeFileSync(join(mirror.root, 'keep.md'), 'the room’s text\n');
  const report = mirror.republish(['keep.md', 'held.md'], (path) => path === 'held.md');
  // Red with the clobber allowed: the room's text is overwritten with an empty file.
  assert.equal(readFileSync(join(mirror.root, 'keep.md'), 'utf8'), 'the room’s text\n');
  // A path that left the listing is removed; one a document holds stays until it closes.
  assert.deepEqual(report.removed, ['gone.md']);
  assert.equal(existsSync(join(mirror.root, 'gone.md')), false);
  assert.equal(isFile(join(mirror.root, 'held.md')), true, 'a held file was removed');
  // The emptied directory stays: the removal pass removes files, never directories.
  assert.deepEqual(report.refused, []);
});

test('a republish that drops a nested path keeps the held file where it is', (t) => {
  const keep = storage(t);
  const mirror = mintMirror(keep, 'r-nested', { window: 'w-nested', pid: process.pid });
  mirror.materialise(['notes/a.md', 'notes/b.md']);
  const report = mirror.republish(['notes/a.md'], () => false);
  assert.deepEqual(report.removed, ['notes/b.md']);
  assert.equal(isFile(join(mirror.root, 'notes', 'a.md')), true);
});

test('the marker names the room and holds no invite once the join has landed', (t) => {
  const keep = storage(t);
  const invite = 'ws://127.0.0.1:8080/session?room=r-invite&token=t';
  const mirror = mintMirror(keep, 'r-invite', {
    window: 'w-invite',
    pid: 4242,
    invite,
    displayName: 'Bob',
  });
  const stashed = readMarker(mirror.root);
  assert.equal(stashed?.room, 'r-invite');
  assert.equal(stashed?.window, 'w-invite');
  assert.equal(stashed?.pid, 4242);
  assert.equal(stashed?.invite, invite, 'the join stashed no invite to finish with');
  assert.equal(stashed?.displayName, 'Bob', 'the join stashed no name to land with');
  // Red with either left in place: the next activation joins the room again.
  mirror.clearInvite();
  const landed = readMarker(mirror.root);
  assert.equal(landed?.invite, undefined, 'the landed join kept its invite');
  assert.equal(landed?.displayName, undefined, 'the landed join kept its name');
  assert.equal(landed?.room, 'r-invite');
  assert.equal(landed?.window, 'w-invite');
  assert.equal(landed?.pid, 4242);
  mirror.clearInvite();
});

test('opening a mirror answers only its own room and window', (t) => {
  const keep = storage(t);
  mintMirror(keep, 'r-open', { window: 'w-open', pid: process.pid });
  assert.ok(openMirror(keep, 'r-open', 'w-open') !== undefined, 'the minted mirror did not open');
  assert.equal(openMirror(keep, 'r-open', 'w-other'), undefined, 'a foreign window opened');
  assert.equal(openMirror(keep, 'r-other', 'w-open'), undefined, 'a foreign room opened');
  assert.equal(openMirror(keep, 'r-open', '../w-open'), undefined, 'a traversal opened');
  assert.equal(openMirror(keep, 'r-missing', 'w-missing'), undefined, 'nothing opened');
});

test('leave deletes the directory with everything in it', (t) => {
  const keep = storage(t);
  const mirror = mintMirror(keep, 'r-leave', { window: 'w-leave', pid: process.pid });
  mirror.materialise(['notes/a.md']);
  mirror.remove();
  assert.equal(existsSync(mirror.root), false, 'the directory survived the leave');
});

test('pruning removes dead siblings, keeps the live, and adopts the current window', (t) => {
  const keep = storage(t);
  const room = 'r-prune';
  const dead = mintMirror(keep, room, { window: 'w-dead', pid: 2147483647 });
  const live = mintMirror(keep, room, { window: 'w-live', pid: process.pid });
  const current = mintMirror(keep, room, { window: 'w-current', pid: 2147483647 });
  current.materialise(['a.md']);
  // A directory no client owns, and a marker for another room: neither is ours to delete.
  mkdirSync(join(keep.fsPath, 'rooms', sanitiseRoom(room), 'w-stray'), { recursive: true });
  const foreign = mintMirror(keep, 'r-other', { window: 'w-foreign', pid: 2147483647 });
  const removed = pruneRoom(keep, room, 'w-current', process.pid);
  // Red with the adopt skipped: the reload's own directory is pruned with the dead.
  assert.deepEqual(removed, ['w-dead']);
  assert.equal(existsSync(dead.root), false, 'a dead sibling survived');
  assert.equal(isFile(join(live.root, MIRROR_MARKER)), true, 'a live sibling was pruned');
  assert.equal(isFile(join(current.root, 'a.md')), true, 'the adopted window lost its files');
  assert.equal(readMarker(current.root)?.pid, process.pid, 'the adopted marker kept the dead pid');
  assert.equal(
    isFile(join(keep.fsPath, 'rooms', sanitiseRoom(room), 'w-stray', MIRROR_MARKER)),
    false,
    'a markerless directory was given one or removed',
  );
  assert.equal(existsSync(foreign.root), true, 'another room was pruned');
  assert.deepEqual(pruneRoom(keep, 'r-missing', 'w-current'), [], 'a missing room errored');
});

test('mirror paths compare on one separator form', () => {
  // `fsPath` uses the platform's separators and a listing never carries a backslash:
  // without the normalisation every mirror file is outside the root on Windows.
  assert.equal(mirrorRelative('C:\\mirror', 'C:\\mirror\\notes\\a.md'), 'notes/a.md');
  assert.equal(mirrorRelative('C:\\mirror\\', 'C:\\mirror\\a.md'), 'a.md');
  assert.equal(mirrorRelative('C:\\mirror', 'C:\\other\\a.md'), undefined);
  assert.equal(mirrorRelative('C:\\mirror', 'C:\\mirror'), undefined);
  assert.equal(mirrorRelative('/mirror', '/mirror/../escape.md'), undefined);
  // Empty and `.` segments name no room path, for symmetry with the grant's shape rule.
  assert.equal(mirrorRelative('/mirror', '/mirror/./a.md'), undefined);
  assert.equal(mirrorRelative('/mirror', '/mirror//a.md'), undefined);
  assert.equal(mirrorRelative('/mirror', '/mirror/a.md'), 'a.md');
});

test('a file deleted under the republish does not abort it', (t) => {
  // The `held` callback runs inside the removal pass, before each unlink: deleting the
  // pass's other files from it stages a concurrent delete deterministically, on every
  // platform and user, with no permission bits and no test double.
  const keep = storage(t);
  const mirror = mintMirror(keep, 'r-unlink', { window: 'w-unlink', pid: process.pid });
  mirror.materialise(['a.md', 'b.md']);
  const seen: string[] = [];
  const report = mirror.republish([], (path) => {
    seen.push(path);
    if (seen.length === 1) {
      for (const other of ['a.md', 'b.md']) {
        if (other !== path) {
          rmSync(join(mirror.root, other), { force: true });
        }
      }
    }
    return false;
  });
  // Red without the guard: the vanished file's unlink throws and nothing is removed.
  assert.deepEqual(report.removed, seen.slice(0, 1));
  const retry = mirror.republish([], () => false);
  assert.deepEqual(retry.removed, []);
});
