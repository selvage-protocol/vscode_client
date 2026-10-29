import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { stopServerAndEditors } from './e2e/cleanup.ts';

const CLEANUP_URL = new URL('./e2e/cleanup.ts', import.meta.url).href;

test('E2E cleanup stops owned editors even when the server stop rejects', async () => {
  const failure = new Error('fixture Rust task panic');
  const events: string[] = [];
  await assert.rejects(stopServerAndEditors({
    async stop() {
      events.push('server stop');
      throw failure;
    },
  }, () => { events.push('owned editors stopped'); }, 1000), (error) => error === failure);
  assert.deepEqual(events, ['server stop', 'owned editors stopped']);
});

test('E2E cleanup stops owned editors even when the server stop throws synchronously', async () => {
  const failure = new Error('fixture synchronous stop failure');
  let stopped = false;
  await assert.rejects(stopServerAndEditors({
    stop() { throw failure; },
  }, () => { stopped = true; }, 1000), (error) => error === failure);
  assert.equal(stopped, true);
});

test('E2E cleanup stops owned editors after a successful server stop or without a server', async () => {
  const events: string[] = [];
  await stopServerAndEditors({
    async stop() { events.push('server stopped'); },
  }, () => { events.push('owned editors stopped'); }, 1000);
  await stopServerAndEditors(undefined, () => { events.push('no server: editors stopped'); }, 1000);
  assert.deepEqual(events, ['server stopped', 'owned editors stopped', 'no server: editors stopped']);
});

test('E2E cleanup bounds a server stop that never settles and still stops owned editors', async () => {
  let stopped = false;
  await stopServerAndEditors({
    stop: () => new Promise<void>(() => {}),
  }, () => { stopped = true; }, 0);
  assert.equal(stopped, true);
});

for (const code of [0, 1, 143]) {
  test(`E2E fire-and-forget shutdown reports a server failure and exits ${code || 1} after editor cleanup`, () => {
    const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', `
      import { exitAfterCleanup, stopServerAndEditors } from ${JSON.stringify(CLEANUP_URL)};
      process.on('unhandledRejection', () => {
        console.error('UNHANDLED REJECTION');
        process.exit(99);
      });
      void exitAfterCleanup(${code}, () => stopServerAndEditors({
        async stop() { throw new Error('fixture Rust task panic'); },
      }, () => { console.log('owned editors stopped'); }, 1000));
    `], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, code || 1, result.stderr);
    assert.equal(result.stdout, 'owned editors stopped\n');
    assert.match(result.stderr, /\[e2e\] cleanup FAILED:[\s\S]*fixture Rust task panic/);
    assert.doesNotMatch(result.stderr, /UNHANDLED REJECTION|triggerUncaughtException/);
  });
}

test('E2E shutdown exits nonzero if editor cleanup itself fails', () => {
  const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', `
    import { exitAfterCleanup, stopServerAndEditors } from ${JSON.stringify(CLEANUP_URL)};
    void exitAfterCleanup(0, () => stopServerAndEditors(undefined, () => {
      throw new Error('fixture editor cleanup failure');
    }, 1000));
  `], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /\[e2e\] cleanup FAILED:[\s\S]*fixture editor cleanup failure/);
});

test('E2E shutdown keeps a successful exit after successful cleanup', () => {
  const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', `
    import { exitAfterCleanup, stopServerAndEditors } from ${JSON.stringify(CLEANUP_URL)};
    void exitAfterCleanup(0, () => stopServerAndEditors(undefined, () => {
      console.log('owned editors stopped');
    }, 1000));
  `], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'owned editors stopped\n');
  assert.equal(result.stderr, '');
});
