/**
 * `scripts/bump-version.sh` and the file set it exists to keep in step.
 *
 * The script takes a bump word — `major`, `minor` or `patch` — reads the version `package.json`
 * carries, moves it, and prints the resulting version as the last line of stdout, which is what
 * the release workflow names the tag and the Release from. `--dry-run` prints the same version
 * and writes nothing; anything that is not one of the three words, the `X.Y.Z` form included, is
 * refused with the tree unchanged.
 *
 * The version lives in three files, and a release that moves some of them is a red run or a
 * client reporting a version it is not. So the script is run here, for real, on a copy of the
 * checkout that this file takes itself under `.tmp/` — never on the working tree, which no case
 * below can reach.
 *
 * The copy is taken with `cpSync`, so it carries no history and the test needs no `git`; what it
 * compares is the copy's own file set before and after the run, hashed, so a script that starts
 * editing a fourth file fails here rather than in someone's release.
 *
 * Every case that asserts a version seeds the one it starts from (`seedVersion`) rather than
 * inheriting the version this checkout carries: the suite holds at 0.5.1, at 0.5.2 and at any
 * version after them, and a release can therefore run it on the tree its own bump has just written.
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

/** The last line of stdout, ignoring the newline a well-formed write ends with. */
function lastLine(stdout: string): string {
  const lines = stdout.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length === 0 ? '' : lines[lines.length - 1];
}

/** Put a version into the copy's manifest, leaving the files held to it alone to be the laggards. */
function seedManifest(copy: string, version: string): void {
  const path = join(copy, 'package.json');
  const text = readFileSync(path, 'utf8');
  assert.match(text, /^  "version": "[^"]*",$/m, 'the copy carries no top-level version in package.json');
  const replaced = text.replace(/^  "version": "[^"]*",$/m, `  "version": "${version}",`);
  writeFileSync(path, replaced);
  assert.equal(versionOf(copy), version, "the copy's manifest was not seeded");
}

/**
 * The line the lockfile's `packages.""` entry carries its version on, walked the way the script
 * walks it: to the empty key under `packages`, never to the first line at that indentation, which
 * can belong to a dependency.
 */
function lockPackageLine(lines: string[]): number | undefined {
  let packages = false;
  let root = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (!packages) {
      if (lines[i] === '  "packages": {') packages = true;
      continue;
    }
    if (!root) {
      if (lines[i] === '    "": {') root = true;
      continue;
    }
    if (/^      "version": "[^"]*",$/.test(lines[i])) return i;
    if (lines[i] === '    },') return undefined;
  }
  return undefined;
}

/** The lockfile's second copy of the manifest version, in the root package entry `packages.""`. */
function lockPackageVersion(lock: string): string | undefined {
  const lines = lock.split('\n');
  const line = lockPackageLine(lines);
  return line === undefined ? undefined : /^      "version": "([^"]*)",$/.exec(lines[line])?.[1];
}

/**
 * Put a version into every file that carries one, so a case starts from the version it names
 * instead of the one this checkout happens to carry. The suite then holds at 0.5.1, at 0.5.2 and at
 * every version after them, which is what lets a release run it on the tree its own bump wrote.
 */
function seedVersion(copy: string, version: string): void {
  seedManifest(copy, version);

  const lockPath = join(copy, 'package-lock.json');
  const lock = readFileSync(lockPath, 'utf8').split('\n');
  const rootLine = lock.findIndex((line) => /^  "version": "[^"]*",$/.test(line));
  assert.notEqual(rootLine, -1, 'the copy carries no top-level version in package-lock.json');
  const packageLine = lockPackageLine(lock);
  assert.ok(packageLine !== undefined, 'the copy carries no version in packages.""');
  lock[rootLine] = `  "version": "${version}",`;
  lock[packageLine] = `      "version": "${version}",`;
  writeFileSync(lockPath, lock.join('\n'));

  const adapterPath = join(copy, 'src', 'adapter', 'extension.ts');
  const adapter = readFileSync(adapterPath, 'utf8');
  assert.match(adapter, /^const CLIENT = 'selvage-vscode\/[^']*';$/m, 'the copy carries no CLIENT string');
  writeFileSync(
    adapterPath,
    adapter.replace(
      /^const CLIENT = 'selvage-vscode\/[^']*';$/m,
      `const CLIENT = 'selvage-vscode/${version}';`,
    ),
  );

  assert.deepEqual(
    carriedVersions(copy),
    {
      'package.json': version,
      'package-lock.json': version,
      'package-lock.json:packages.""': version,
      'src/adapter/extension.ts': version,
    },
    'the copy was not seeded',
  );
}

/** The version each spot the script owns carries, under the key that carries it. */
function carriedVersions(copy: string): Record<string, string | undefined> {
  const manifest = readFileSync(join(copy, 'package.json'), 'utf8').match(/^  "version": "([^"]*)",$/m);
  const lock = readFileSync(join(copy, 'package-lock.json'), 'utf8');
  const adapter = readFileSync(join(copy, 'src', 'adapter', 'extension.ts'), 'utf8');
  return {
    'package.json': manifest?.[1],
    'package-lock.json': lock.match(/^  "version": "([^"]*)",$/m)?.[1],
    "package-lock.json:packages.\"\"": lockPackageVersion(lock),
    'src/adapter/extension.ts': adapter.match(
      /^const CLIENT = 'selvage-vscode\/([^']*)';$/m,
    )?.[1],
  };
}

test('a word that is not a bump is refused, with the tree unchanged', () => {
  const copy = freshCopy('refused');
  try {
    const before = tree(copy);
    // The `X.Y.Z` form is here on purpose: this script takes a bump word, never a version.
    const refusals: string[][] = [
      [],
      [''],
      ['1.2.3'],
      ['v1.2.3'],
      ['1.2'],
      ['1.2.3.4'],
      ['1.2.x'],
      ['0.5.1/../x'],
      ['latest'],
      ['Major'],
      ['major '],
      ['--dry-run'],
      ['patch', '--write'],
      ['patch', '--dry-run', 'extra'],
    ];
    for (const args of refusals) {
      const run = runIn(copy, args);
      assert.notEqual(run.status, 0, `${JSON.stringify(args)} was accepted:\n${run.output}`);
      assert.notEqual(run.stderr, '', `${JSON.stringify(args)} was refused without saying why`);
      assert.deepEqual(changed(before, tree(copy)), [], `${JSON.stringify(args)} moved the tree`);
    }
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test('a component too large to increment is refused, with the tree unchanged', () => {
  const copy = freshCopy('overflow');
  try {
    // 19 digits or more wraps the shell's signed 64-bit arithmetic; the largest component that
    // still increments is 18 nines.
    const tooLarge: Array<{ from: string; word: string }> = [
      { from: '1.2.9223372036854775807', word: 'patch' },
      { from: '1.2.9999999999999999999', word: 'patch' },
      { from: '1.9999999999999999999.2', word: 'minor' },
      { from: '9223372036854775807.0.0', word: 'major' },
    ];
    for (const { from, word } of tooLarge) {
      seedManifest(copy, from);
      const before = tree(copy);
      for (const args of [[word], [word, '--dry-run']]) {
        const run = runIn(copy, args);
        assert.notEqual(run.status, 0, `${from} + ${args.join(' ')} was accepted:\n${run.output}`);
        assert.notEqual(run.stderr, '', `${from} + ${args.join(' ')} was refused without saying why`);
        assert.deepEqual(changed(before, tree(copy)), [], `${from} + ${args.join(' ')} moved the tree`);
      }
    }

    seedManifest(copy, '1.2.999999999999999999');
    const run = runIn(copy, ['patch']);
    assert.equal(run.status, 0, `the boundary bump failed:\n${run.output}`);
    assert.equal(
      lastLine(run.stdout),
      '1.2.1000000000000000000',
      `the boundary did not land where expected:\n${run.output}`,
    );
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

/**
 * Each bump word, applied to the version the manifest carries, including the carries a digit
 * boundary makes: `0.5.9` + `patch` is `0.5.10`, and `9.99.99` + `major` is `10.0.0`.
 */
const BUMPS: Array<{ from: string; word: string; to: string }> = [
  { from: '0.5.1', word: 'patch', to: '0.5.2' },
  { from: '0.5.1', word: 'minor', to: '0.6.0' },
  { from: '0.5.1', word: 'major', to: '1.0.0' },
  { from: '0.5.9', word: 'patch', to: '0.5.10' },
  { from: '0.9.99', word: 'minor', to: '0.10.0' },
  { from: '0.99.99', word: 'minor', to: '0.100.0' },
  { from: '0.99.99', word: 'major', to: '1.0.0' },
  { from: '9.99.99', word: 'major', to: '10.0.0' },
];

test('each bump word moves the version the manifest carries, and lands every file on it', () => {
  for (const { from, word, to } of BUMPS) {
    const copy = freshCopy(`word-${word}-${from}`);
    try {
      seedVersion(copy, from);
      const before = tree(copy);
      const run = runIn(copy, [word]);
      assert.equal(run.status, 0, `${from} + ${word} failed:\n${run.output}`);
      assert.equal(lastLine(run.stdout), to, `the last line is not ${to}:\n${run.output}`);
      assert.deepEqual(
        changed(before, tree(copy)),
        [...CARRIES_THE_VERSION].sort(),
        `${from} + ${word} did not write exactly the version's homes:\n${run.output}`,
      );
      assert.deepEqual(
        carriedVersions(copy),
        {
          'package.json': to,
          'package-lock.json': to,
          "package-lock.json:packages.\"\"": to,
          'src/adapter/extension.ts': to,
        },
        `${from} + ${word} left a home on the wrong version`,
      );
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }
});

test('--dry-run writes nothing and prints the version the write mode does', () => {
  const copy = freshCopy('dry-run');
  try {
    seedVersion(copy, '0.5.1');
    const before = tree(copy);
    const dry = runIn(copy, ['patch', '--dry-run']);
    assert.equal(dry.status, 0, `the dry run failed:\n${dry.output}`);
    assert.deepEqual(changed(before, tree(copy)), [], 'the dry run wrote to the tree');
    for (const file of CARRIES_THE_VERSION) {
      assert.ok(dry.stdout.includes(file), `the dry run did not name ${file} among the files it would write`);
    }

    const written = runIn(copy, ['patch']);
    assert.equal(written.status, 0, `the write failed:\n${written.output}`);
    assert.equal(
      lastLine(dry.stdout),
      lastLine(written.stdout),
      'the dry run and the write disagree about the version',
    );
    assert.equal(lastLine(written.stdout), '0.5.2', `the write did not end on the version:\n${written.output}`);
    assert.deepEqual(
      changed(before, tree(copy)),
      [...CARRIES_THE_VERSION].sort(),
      `the write did not write exactly the version's homes:\n${written.output}`,
    );
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test('a bump writes exactly the files that carry the version, and nothing else', () => {
  const copy = freshCopy('bump');
  try {
    seedVersion(copy, '0.5.1');
    const was = new Map(CARRIES_THE_VERSION.map((file) => [file, readFileSync(join(copy, file), 'utf8')]));
    const before = tree(copy);
    const run = runIn(copy, ['patch']);
    assert.equal(run.status, 0, `the bump failed:\n${run.output}`);
    assert.deepEqual(
      changed(before, tree(copy)),
      [...CARRIES_THE_VERSION].sort(),
      `the bump did not write exactly the version's homes:\n${run.output}`,
    );

    const manifest = JSON.parse(readFileSync(join(copy, 'package.json'), 'utf8')) as { version?: string };
    assert.equal(manifest.version, '0.5.2', 'the manifest does not carry the new version');

    const lock = readFileSync(join(copy, 'package-lock.json'), 'utf8').split('\n');
    assert.equal(lock.filter((line) => line === '  "version": "0.5.2",').length, 1, "the lockfile's own version");
    assert.equal(
      lock.filter((line) => line === '      "version": "0.5.2",').length,
      1,
      'the version in the lockfile\'s `packages.""`',
    );

    const adapter = readFileSync(join(copy, 'src', 'adapter', 'extension.ts'), 'utf8');
    assert.match(adapter, /^const CLIENT = 'selvage-vscode\/0\.5\.2';$/m);

    // The strongest form of "and nothing else": the copy's own file before the run, with the
    // version string moved, is the whole of the file after it.
    for (const file of CARRIES_THE_VERSION) {
      const original = was.get(file);
      assert.ok(original !== undefined, `${file} was not read before the run`);
      const written = readFileSync(join(copy, file), 'utf8');
      assert.equal(written, original.split('0.5.1').join('0.5.2'), `${file} changed beyond the version string`);
    }

    for (const file of CARRIES_THE_VERSION) {
      assert.ok(run.stdout.includes(file), `the run did not name ${file} among the files it wrote`);
    }
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test('a tree whose files disagree is brought to the next version, and every file it writes is named', () => {
  const copy = freshCopy('disagreeing');
  try {
    // The manifest moved by hand and the files held to it left behind: this must not be
    // reported as a tree that already carries a version.
    seedManifest(copy, '9.8.7');

    const before = tree(copy);
    const run = runIn(copy, ['patch']);
    assert.equal(run.status, 0, `the repair failed:\n${run.output}`);
    assert.deepEqual(
      changed(before, tree(copy)),
      [...CARRIES_THE_VERSION].sort(),
      `the repair did not write exactly the files that needed it:\n${run.output}`,
    );
    assert.equal(lastLine(run.stdout), '9.8.8', `the repair did not end on the next version:\n${run.output}`);
    assert.deepEqual(
      carriedVersions(copy),
      {
        'package.json': '9.8.8',
        'package-lock.json': '9.8.8',
        "package-lock.json:packages.\"\"": '9.8.8',
        'src/adapter/extension.ts': '9.8.8',
      },
      'a file that had fallen behind was left there',
    );
    for (const file of CARRIES_THE_VERSION) {
      assert.ok(run.stdout.includes(file), `the run did not name the file it repaired: ${file}`);
    }
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test('a spot already at the next version is left alone while a laggard is written and named', () => {
  const copy = freshCopy('lagging');
  try {
    seedVersion(copy, '0.5.1');
    // `patch` from 0.5.1 lands on 0.5.2; the adapter is put there by hand, so only the manifest
    // and the lockfile have to move. The lockfile is the laggard and must be named.
    const adapterPath = join(copy, 'src', 'adapter', 'extension.ts');
    const adapter = readFileSync(adapterPath, 'utf8');
    const moved = adapter.replace("'selvage-vscode/0.5.1'", "'selvage-vscode/0.5.2'");
    assert.notEqual(moved, adapter, 'the adapter was not moved to the target');
    writeFileSync(adapterPath, moved);

    const before = tree(copy);
    const run = runIn(copy, ['patch']);
    assert.equal(run.status, 0, `the repair failed:\n${run.output}`);
    assert.deepEqual(
      changed(before, tree(copy)),
      ['package-lock.json', 'package.json'],
      `the repair did not write exactly the files that lagged:\n${run.output}`,
    );
    assert.ok(run.stdout.includes('package-lock.json'), 'the laggard was not named among the files written');
    assert.ok(!run.stdout.includes('src/adapter/extension.ts'), 'a file already at the version was written');
    assert.equal(lastLine(run.stdout), '0.5.2', `the run did not end on the next version:\n${run.output}`);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test('a tree whose shape has moved is refused before anything is written', () => {
  const copy = freshCopy('shape-moved');
  try {
    seedVersion(copy, '0.5.1');
    // Remove the lockfile's `packages.""` version, which the script locates last; the manifest is
    // already located and would be written first by a script that wrote as it went.
    const lockPath = join(copy, 'package-lock.json');
    const lock = readFileSync(lockPath, 'utf8');
    const removed = lock.replace('    "": {\n      "name": "selvage",\n      "version": "0.5.1",\n', '    "": {\n      "name": "selvage",\n');
    assert.notEqual(removed, lock, 'the root package entry was not arranged');
    writeFileSync(lockPath, removed);

    const before = tree(copy);
    const run = runIn(copy, ['patch']);
    assert.notEqual(run.status, 0, `a tree with no packages."" version was accepted:\n${run.output}`);
    assert.notEqual(run.stderr, '', 'the refusal said nothing');
    assert.deepEqual(changed(before, tree(copy)), [], 'the refusal wrote to the tree');
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
    seedVersion(copy, '0.5.1');
    const lockPath = join(copy, 'package-lock.json');
    const arranged = withADependencyFirst(readFileSync(lockPath, 'utf8'), '0.5.1');
    writeFileSync(lockPath, arranged);

    const before = tree(copy);
    const run = runIn(copy, ['patch']);
    assert.equal(run.status, 0, `the bump failed:\n${run.output}`);
    assert.deepEqual(
      changed(before, tree(copy)),
      [...CARRIES_THE_VERSION].sort(),
      `the bump did not write exactly the version's homes:\n${run.output}`,
    );

    // The root entry's own lines moved and nothing else in the file did: the dependency's version
    // above them is untouched.
    const after = readFileSync(lockPath, 'utf8');
    assert.equal(after, arranged.split('0.5.1').join('0.5.2'), 'the lockfile changed beyond its own version');
    assert.match(after, /^      "version": "9\.9\.9",$/m, "a dependency's version was written");
    assert.equal(
      carriedVersions(copy)["package-lock.json:packages.\"\""],
      '0.5.2',
      'the root package entry did not move',
    );
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

/**
 * The release workflow's `inputs:` block under `on.workflow_dispatch`: the input names it declares,
 * in order. This repository's dependency set carries no YAML parser, so the block is taken by
 * indentation; the caller checks that it read inputs before reading them.
 */
function workflowInputs(workflow: string): string[] {
  const lines = workflow.split('\n');
  const start = lines.indexOf('    inputs:');
  assert.notEqual(start, -1, 'no `inputs:` under `on.workflow_dispatch`');
  const body = lines.slice(start + 1);
  const end = body.findIndex((line) => /^ {0,4}\S/.test(line));
  const block = end === -1 ? body : body.slice(0, end);
  return block.filter((line) => /^ {6}\S/.test(line)).map((line) => line.trim().replace(/:$/, ''));
}

/** One input's own block from that list, up to the next input at the same indentation. */
function inputBlock(workflow: string, name: string): string {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`      ${name}:`);
  assert.notEqual(start, -1, `no \`${name}\` input under \`on.workflow_dispatch.inputs\``);
  const body = lines.slice(start + 1);
  const end = body.findIndex((line) => /^ {6}\S/.test(line));
  return (end === -1 ? body : body.slice(0, end)).join('\n');
}

test('the release workflow takes the bump word and carries no version of its own', () => {
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.deepEqual(
    workflowInputs(workflow),
    ['bump', 'dry_run'],
    'the release workflow takes inputs other than the bump word and dry_run',
  );
  const input = inputBlock(workflow, 'bump');
  assert.match(input, /^\s*description:/m, 'the block read is not a workflow input');
  assert.match(
    input,
    /^\s*required:\s*true\s*$/m,
    'the bump input is not required, so a dispatch could reach the workflow without naming one',
  );
  assert.match(
    input,
    /^\s*type:\s*choice\s*$/m,
    'the bump input is not a choice, so a dispatch could name something that is not a bump word',
  );
  const options = (input.match(/^\s*-\s*(\S+)\s*$/gm) ?? []).map((line) => line.trim().slice(2));
  assert.deepEqual(
    options,
    ['patch', 'minor', 'major'],
    'the bump input does not offer exactly patch, minor and major, in that order',
  );
  assert.doesNotMatch(
    input,
    /^\s*default:/m,
    'the bump input carries a default: which component a release moves would be decided here',
  );
});

test('the release workflow creates the tag and never moves one', () => {
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(
    workflow,
    /git push origin "v\$\{RELEASE_VERSION\}"/,
    'the tag push this test is about is not in the file it read',
  );
  assert.doesNotMatch(
    workflow,
    /git tag -f|git push --force/,
    'the workflow moves a tag: a version whose tag is at another commit has to fail the run, since the version a dispatch computes is a new one',
  );
});
