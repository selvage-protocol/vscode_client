/**
 * The timers the engine arms, and the one thing they must never do: hold a process open.
 *
 * `y-protocols`' `Awareness` arms an interval when it is constructed, which `PeerSession` clears
 * at once because §8.2 runs on the session's own clocks, and `RelaySession` runs those clocks on
 * a timer of its own (`§13.8`), cleared when the relay is destroyed. Every timer the engine starts
 * is `unref`ed, so a caller that forgets costs nothing: the process still ends.
 *
 * The proof is a real process, one for each clock: `test/helpers/undestroyed-session.ts` opens a
 * guest and a host, `test/helpers/undestroyed-relay.ts` seats a relay, and neither destroys
 * anything or has to end on its own. A timer that keeps the event loop alive leaves that child
 * running until the deadline here, which is the red test.
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const FIXTURE = resolve(import.meta.dirname, 'helpers', 'undestroyed-session.ts');
const RELAY_FIXTURE = resolve(import.meta.dirname, 'helpers', 'undestroyed-relay.ts');

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
function runFixture(fixture: string = FIXTURE): Promise<Outcome> {
  return new Promise<Outcome>((resolve_, reject) => {
    const child = spawn(process.execPath, [fixture], { stdio: ['ignore', 'pipe', 'pipe'] });
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
    // `close` and not `exit`: the child's pipes are drained by then, and a `ready` still in
    // the pipe when `exit` fires would read as a fixture that never opened its sessions.
    child.on('close', (code, signal) => {
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

test('a relay nobody disconnects lets its process end', async () => {
  const result = await runFixture(RELAY_FIXTURE);
  assert.equal(
    result.timedOut,
    false,
    `the fixture was still running after ${DEADLINE_MS}ms, so the relay's own clock is holding ` +
      `the event loop open — a timer a session starts and does not unref.\n` +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  assert.match(result.stdout, /ready/, 'the fixture seated its relay before it ended');
  assert.equal(result.code, 0, `the fixture exited ${result.code}: ${result.stderr}`);
});
