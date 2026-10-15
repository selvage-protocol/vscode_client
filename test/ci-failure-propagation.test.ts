/**
 * `scripts/ci-local.sh`'s `all` mode, and the one thing about it a reader cannot see: a job that
 * fails part-way through has to stop the run.
 *
 * `all` runs the same jobs the `lint`, `client` and `links` modes do. Each job is a shell
 * function, and a function that is the only command of its mode — or the last element of an `&&`
 * list — has `set -e` active inside it, so a command that fails ends the script. A function
 * invoked *before* the last element of an `&&` list is the exception: bash suspends `set -e`
 * inside it, it runs on to its own last command, and the list sees only that last command's
 * status. A failure in the middle of such a job is therefore swallowed and `all` reports success
 * over a red job, which is exactly what a CI control flow must never do.
 *
 * The fix is that the jobs are separate statements, so each keeps `set -e` and a mid-job failure
 * stops the run. This file pins it: it runs the real script, byte for byte, from a throwaway
 * fixture under `.tmp/`, with every external tool — `nix`, `npm`, `actionlint`, `lychee` — a mock
 * on `PATH`. No Nix, npm, Node package, link checker or workflow linter is executed; the script's
 * control flow is the whole subject.
 *
 * A mock appends the invocation it received to a log and returns the status the case names, so a
 * case asserts both that the failure was actually injected and which commands ran after it. The
 * `&&`-chained original fails the mid-job cases and passes the rest; the separate-statement
 * version passes every case.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(here, '..');

/**
 * The absolute `bash` the fixture's mocks name in their `#!` line. They are executed directly,
 * and a hermetic build has no `/usr/bin/env`, so the interpreter is resolved once here — before
 * any fixture puts the mocks on `PATH` — by asking the `bash` on the current `PATH` for itself.
 */
function bashPath(): string {
  const found = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8', timeout: 10_000 });
  const path = (found.stdout ?? '').trim();
  if (found.status !== 0 || path === '') {
    throw new Error(`bash is not on PATH: ${found.stderr ?? ''}`);
  }
  return path;
}

const BASH = bashPath();

/**
 * The external commands the script reaches for, each replaced by one that logs its invocation and
 * returns a status the case chooses. `nix` answers `eval` with a system name and, for `shell`,
 * runs the wrapped command from the mock `PATH`, the way the real one would.
 */
const MOCKS: Record<string, string> = {
  nix: [
    `#!${BASH}`,
    'set -euo pipefail',
    'if [ "${1:-}" = eval ]; then printf "x86_64-linux\\n"; exit 0; fi',
    'line="nix $*"',
    'printf "%s\\n" "$line" >>"$MOCK_LOG"',
    'if [ -n "${MOCK_FAIL:-}" ] && [ "$line" = "$MOCK_FAIL" ]; then exit "${MOCK_FAIL_STATUS:-37}"; fi',
    'if [ "${1:-}" = shell ]; then',
    '  shift',
    '  while [ "$#" -gt 0 ] && [ "$1" != -c ]; do shift; done',
    '  shift',
    '  exec "$@"',
    'fi',
    'exit 0',
    '',
  ].join('\n'),
  npm: [
    `#!${BASH}`,
    'set -euo pipefail',
    'line="npm $*"',
    'printf "%s\\n" "$line" >>"$MOCK_LOG"',
    'if [ -n "${MOCK_FAIL:-}" ] && [ "$line" = "$MOCK_FAIL" ]; then exit "${MOCK_FAIL_STATUS:-37}"; fi',
    'exit 0',
    '',
  ].join('\n'),
  actionlint: [
    `#!${BASH}`,
    'set -euo pipefail',
    'printf "actionlint\\n" >>"$MOCK_LOG"',
    'if [ -n "${MOCK_FAIL:-}" ] && [ "actionlint" = "$MOCK_FAIL" ]; then exit "${MOCK_FAIL_STATUS:-37}"; fi',
    'exit 0',
    '',
  ].join('\n'),
  lychee: [
    `#!${BASH}`,
    'set -euo pipefail',
    'line="lychee $*"',
    'printf "%s\\n" "$line" >>"$MOCK_LOG"',
    'if [ -n "${MOCK_FAIL:-}" ] && [ "$line" = "$MOCK_FAIL" ]; then exit "${MOCK_FAIL_STATUS:-37}"; fi',
    'exit 0',
    '',
  ].join('\n'),
};

/** The script under test, byte for byte, in a fixture that is otherwise only mocks. */
function fixture(name: string): string {
  const dir = join(ROOT, '.tmp', `ci-propagation-${name}-${String(process.pid)}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'ci-local.sh'), readFileSync(join(ROOT, 'scripts', 'ci-local.sh')));
  mkdirSync(join(dir, 'bin'), { recursive: true });
  for (const [tool, body] of Object.entries(MOCKS)) {
    const path = join(dir, 'bin', tool);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }
  return dir;
}

interface Run {
  status: number | null;
  lines: string[];
  output: string;
}

/** Run the fixture's script in `mode`, optionally making one mock invocation fail. */
function runScript(dir: string, mode: string, fail?: { command: string; status: number }): Run {
  const log = join(dir, 'mock.log');
  writeFileSync(log, '');
  const result = spawnSync(BASH, [join(dir, 'scripts', 'ci-local.sh'), mode], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
      MOCK_LOG: log,
      MOCK_FAIL: fail?.command ?? '',
      MOCK_FAIL_STATUS: String(fail?.status ?? 37),
    },
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const lines = readFileSync(log, 'utf8').split('\n').filter((line) => line !== '');
  return {
    status: result.status,
    lines,
    output: `exit ${String(result.status)}\n--- stdout\n${stdout}--- stderr\n${stderr}`,
  };
}

function remove(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

test('all runs every job, in order, when each tool succeeds', () => {
  const dir = fixture('all-green');
  try {
    const run = runScript(dir, 'all');
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(
      run.lines,
      [
        'nix shell nixpkgs#actionlint -c actionlint',
        'actionlint',
        'nix build .#checks.x86_64-linux.dry-run-gating --no-link --print-build-logs',
        'npm ci --no-audit --no-fund',
        'npm run typecheck',
        'npm run build',
        'npm run test:fast',
        'lychee --config lychee.toml --no-progress README.md docs',
      ],
      run.output,
    );
  } finally {
    remove(dir);
  }
});

test('a failure in the middle of the client job stops all before the later commands', () => {
  const dir = fixture('typecheck-fails');
  try {
    const run = runScript(dir, 'all', { command: 'npm run typecheck', status: 37 });
    assert.ok(
      run.lines.includes('npm run typecheck'),
      `the failure was not injected: ${run.lines.join(', ')}`,
    );
    assert.equal(run.status, 37, run.output);
    assert.ok(
      !run.lines.includes('npm run build'),
      `build ran after the failure: ${run.lines.join(', ')}`,
    );
    assert.ok(
      !run.lines.includes('npm run test:fast'),
      `the server-free suite ran after the failure: ${run.lines.join(', ')}`,
    );
    assert.ok(
      !run.lines.some((line) => line.startsWith('lychee')),
      `the link job ran after the failure: ${run.lines.join(', ')}`,
    );
  } finally {
    remove(dir);
  }
});

test('a failure in the last command of the client job also stops all', () => {
  const dir = fixture('suite-fails');
  try {
    const run = runScript(dir, 'all', { command: 'npm run test:fast', status: 37 });
    assert.ok(
      run.lines.includes('npm run test:fast'),
      `the failure was not injected: ${run.lines.join(', ')}`,
    );
    assert.equal(run.status, 37, run.output);
    assert.ok(
      !run.lines.some((line) => line.startsWith('lychee')),
      `the link job ran after the failure: ${run.lines.join(', ')}`,
    );
  } finally {
    remove(dir);
  }
});

test('the same mid-job failure is load-bearing in the client mode alone', () => {
  const dir = fixture('client-mode');
  try {
    const run = runScript(dir, 'client', { command: 'npm run typecheck', status: 37 });
    assert.ok(
      run.lines.includes('npm run typecheck'),
      `the failure was not injected: ${run.lines.join(', ')}`,
    );
    assert.equal(run.status, 37, run.output);
    assert.ok(
      !run.lines.includes('npm run build'),
      `build ran after the failure: ${run.lines.join(', ')}`,
    );
    assert.ok(
      !run.lines.includes('npm run test:fast'),
      `the server-free suite ran after the failure: ${run.lines.join(', ')}`,
    );
  } finally {
    remove(dir);
  }
});
