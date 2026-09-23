/**
 * The timers a session starts, and the one thing they must never do: hold a process open.
 *
 * `PeerSession` runs `y-protocols`' awareness clock, which is an interval — the same clock
 * `§8.2`'s renewal and expiry are read on. A session that is destroyed clears it, and a caller
 * that forgets used to be a process that never ends: two sessions left behind by an ad-hoc
 * script held a shell for half an hour with nothing to show for it. Every timer a session starts
 * is `unref`ed now, so forgetting costs nothing.
 *
 * The proof is a real process: `test/helpers/undestroyed-session.ts` opens a guest and a host,
 * destroys neither, and has to end on its own. A session that keeps the event loop alive leaves
 * that child running until the deadline here, which is the red test.
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const FIXTURE = resolve(import.meta.dirname, 'helpers', 'undestroyed-session.ts');

/** How long the fixture may take to end. It only has to open two sessions and print. */
const DEADLINE_MS = Number(process.env['SELVAGE_TIMER_DEADLINE_MS'] ?? 10_000);

interface Outcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs the fixture, killing it at the deadline, and reports what it did. */
function runFixture(): Promise<Outcome> {
  return new Promise<Outcome>((resolve_, reject) => {
    const child = spawn(process.execPath, [FIXTURE], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, DEADLINE_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(deadline);
      resolve_({ code, signal, stdout, stderr, timedOut });
    });
  });
}

test('a session nobody destroys lets its process end', async () => {
  const result = await runFixture();
  assert.equal(
    result.timedOut,
    false,
    `the fixture was still running after ${DEADLINE_MS}ms, so something it opened is holding ` +
      `the event loop open — a timer a session starts and does not unref.\n` +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  assert.match(result.stdout, /ready/, 'the fixture opened its sessions before it ended');
  assert.equal(result.code, 0, `the fixture exited ${result.code}: ${result.stderr}`);
});
