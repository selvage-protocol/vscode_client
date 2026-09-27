/**
 * `scripts/bump-version.sh` and the file set it exists to keep in step.
 *
 * The 0.5.1 bump is the case this pins: the version lives in three files, a release that moves
 * some of them is a red run or a client reporting a version it is not, and a bump done by hand
 * moved one and left another behind. So the script is run here, for real, on a copy of the
 * checkout that this file takes itself under `.tmp/` — never on the working tree, which no case
 * below can reach.
 *
 * The copy is taken with `cpSync`, so it carries no history and the test needs no `git`; what it
 * compares is the copy's own file set before and after the run, hashed, so a script that starts
 * editing a fourth file fails here rather than in someone's release.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(here, '..');

/** Every file this repository keeps its own version in, and no other. */
const CARRIES_THE_VERSION = ['package.json', 'package-lock.json', 'src/adapter/extension.ts'];

/** Never copied into the copy: dependencies, history, and the temporary area the copy lands in. */
const NOT_COPIED = new Set(['node_modules', '.git', '.tmp', '.worktrees']);

/** The version a case bumps to, which is not one this repository has ever carried. */
const BUMPED_TO = '9.8.7';

function freshCopy(name: string): string {
  const dest = join(ROOT, '.tmp', `bump-version-${name}-${String(process.pid)}`);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (NOT_COPIED.has(entry.name)) continue;
    cpSync(join(ROOT, entry.name), join(dest, entry.name), {
      recursive: true,
      filter: (source) => !relative(ROOT, source).split(sep).some((part) => NOT_COPIED.has(part)),
    });
  }
  return dest;
}

/** Every file under `root`, by path, as its content's digest. A symbolic link is its target. */
function tree(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isSymbolicLink()) {
        files.set(relative(root, path), `link -> ${readlinkSync(path)}`);
      } else {
        const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
        files.set(relative(root, path), digest);
      }
    }
  };
  walk(root);
  return files;
}

/** The files two readings of a tree disagree about, added and removed ones included. */
function changed(before: Map<string, string>, after: Map<string, string>): string[] {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((name) => before.get(name) !== after.get(name)).sort();
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  output: string;
}

/**
 * The script, as the coordinator runs it: the file itself, executed, with the repository as the
 * working directory. `bash` names the interpreter rather than the script's own `#!` line, so
 * this needs no `/usr/bin/env`.
 */
function runIn(copy: string, args: string[]): Run {
  const result = spawnSync('bash', [join(copy, 'scripts', 'bump-version.sh'), ...args], {
    cwd: copy,
    encoding: 'utf8',
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return {
    status: result.status,
    stdout,
    stderr,
    output: `exit ${String(result.status)}\n--- stdout\n${stdout}--- stderr\n${stderr}`,
  };
}

function versionOf(copy: string): string {
  const manifest = JSON.parse(readFileSync(join(copy, 'package.json'), 'utf8')) as { version?: string };
  assert.ok(typeof manifest.version === 'string', 'the copy carries no version in package.json');
  return manifest.version;
}

test('an invalid version is refused, with the tree unchanged', () => {
  const copy = freshCopy('invalid');
  try {
    const before = tree(copy);
    for (const invalid of ['', '1.2', 'v1.2.3', '1.2.3-rc1', '1.2.3.4', '1.2.x', '0.5.1/../x']) {
      const run = runIn(copy, [invalid]);
      assert.notEqual(run.status, 0, `${JSON.stringify(invalid)} was accepted:\n${run.output}`);
      assert.notEqual(run.stderr, '', `${JSON.stringify(invalid)} was refused without saying why`);
      assert.deepEqual(changed(before, tree(copy)), [], `${JSON.stringify(invalid)} moved the tree`);
    }
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test('the version the tree already carries is a no-op', () => {
  const copy = freshCopy('noop');
  try {
    const before = tree(copy);
    const run = runIn(copy, [versionOf(copy)]);
    assert.equal(run.status, 0, `bumping to the version present failed:\n${run.output}`);
    assert.deepEqual(changed(before, tree(copy)), [], 'the tree moved');
    assert.match(run.stdout, /already at/, 'the run did not report the version as already there');
    assert.doesNotMatch(run.stdout, /wrote|lagged/, 'a tree that agrees was reported as needing a write');
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test('a bump writes exactly the files that carry the version', () => {
  const copy = freshCopy('bump');
  try {
    const current = versionOf(copy);
    const before = tree(copy);
    const run = runIn(copy, [BUMPED_TO]);
    assert.equal(run.status, 0, `the bump failed:\n${run.output}`);
    assert.deepEqual(
      changed(before, tree(copy)),
      [...CARRIES_THE_VERSION].sort(),
      `the bump did not write exactly the version's homes:\n${run.output}`,
    );

    const manifest = JSON.parse(readFileSync(join(copy, 'package.json'), 'utf8')) as { version?: string };
    assert.equal(manifest.version, BUMPED_TO, 'the manifest does not carry the new version');

    const lock = readFileSync(join(copy, 'package-lock.json'), 'utf8').split('\n');
    assert.equal(lock.filter((line) => line === `  "version": "${BUMPED_TO}",`).length, 1, 'the lockfile\'s own version');
    assert.equal(
      lock.filter((line) => line === `      "version": "${BUMPED_TO}",`).length,
      1,
      'the version in the lockfile\'s `packages.""`',
    );

    const adapter = readFileSync(join(copy, 'src', 'adapter', 'extension.ts'), 'utf8');
    assert.match(adapter, new RegExp(`^const CLIENT = 'selvage-vscode/${BUMPED_TO.replaceAll('.', '\\.')}';$`, 'm'));

    // The strongest form of "and nothing else": put the old version back in the copy's file and
    // the result is this repository's own file, byte for byte.
    for (const file of CARRIES_THE_VERSION) {
      const written = readFileSync(join(copy, file), 'utf8').split(BUMPED_TO).join(current);
      assert.equal(written, readFileSync(join(ROOT, file), 'utf8'), `${file} changed beyond the version string`);
    }

    for (const file of CARRIES_THE_VERSION) {
      assert.ok(run.stdout.includes(file), `the run did not name ${file} among the files it wrote`);
    }
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test('a tree whose files disagree is repaired, not reported as already there', () => {
  const copy = freshCopy('lagging');
  try {
    // The manifest moved by hand and the files held to it left behind — the shape of the 0.5.1
    // defect one file over, which must not be reported as a tree that already carries the version.
    const manifest = join(copy, 'package.json');
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(versionOf(copy), BUMPED_TO));
    assert.equal(versionOf(copy), BUMPED_TO, 'the copy\'s manifest was not moved');

    const before = tree(copy);
    const run = runIn(copy, [BUMPED_TO]);
    assert.equal(run.status, 0, `the repair failed:\n${run.output}`);
    assert.deepEqual(
      changed(before, tree(copy)),
      ['package-lock.json', 'src/adapter/extension.ts'],
      `the repair did not write exactly the files that lagged:\n${run.output}`,
    );
    assert.match(run.stdout, /lagged/, 'the run did not say which files had lagged');

    // With the tree agreeing, the same version is the no-op it should be.
    const agreed = tree(copy);
    const again = runIn(copy, [BUMPED_TO]);
    assert.equal(again.status, 0, `the second run failed:\n${again.output}`);
    assert.deepEqual(changed(agreed, tree(copy)), [], 'the second run moved the tree');
    assert.match(again.stdout, /already at/, 'the second run did not report the tree as at the version');
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});


/**
 * A lockfile whose first `version` line belongs to a dependency instead of the root package entry
 * — legal JSON that npm does not write, arranged so a script that takes the first line at that
 * indentation can be told apart from one that walks `packages` for the empty key.
 */
function withADependencyFirst(lockfile: string, current: string): string {
  const marker = '  "packages": {\n';
  assert.ok(lockfile.includes(marker), 'the copy carries no `packages` block');
  const decoy = [
    '    "node_modules/a-decoy": {',
    '      "version": "9.9.9",',
    '      "resolved": "https://example.invalid/a-decoy",',
    '      "integrity": "sha512-a-decoy"',
    '    },',
    '',
  ].join('\n');
  const arranged = lockfile.replace(marker, marker + decoy);
  const decoyAt = arranged.indexOf('      "version": "9.9.9",');
  const rootAt = arranged.indexOf(`      "version": "${current}",`);
  assert.ok(decoyAt !== -1 && decoyAt < rootAt, 'the decoy does not precede the root package entry');
  return arranged;
}

test("the lockfile's root entry is written, not the first version line", () => {
  const copy = freshCopy('packages-root');
  try {
    const current = versionOf(copy);
    const manifest = join(copy, 'package.json');
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(current, BUMPED_TO));
    assert.equal(versionOf(copy), BUMPED_TO, 'the copy\'s manifest was not moved');

    const lockPath = join(copy, 'package-lock.json');
    const arranged = withADependencyFirst(readFileSync(lockPath, 'utf8'), current);
    writeFileSync(lockPath, arranged);

    const before = tree(copy);
    const run = runIn(copy, [BUMPED_TO]);
    assert.equal(run.status, 0, `the bump failed:\n${run.output}`);
    assert.deepEqual(
      changed(before, tree(copy)),
      ['package-lock.json', 'src/adapter/extension.ts'],
      `the bump did not write exactly the files that lagged:\n${run.output}`,
    );

    // The root entry's own lines moved and nothing else in the file did: the dependency's version
    // above them is untouched.
    const after = readFileSync(lockPath, 'utf8');
    assert.equal(after, arranged.split(current).join(BUMPED_TO), 'the lockfile changed beyond its own version');
    assert.match(after, /^      "version": "9\.9\.9",$/m, "a dependency's version was written");
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});
