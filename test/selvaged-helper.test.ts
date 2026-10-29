import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { RealServer } from './helpers/selvaged.ts';
import { waitFor } from './helpers/wait.ts';

const SCRATCH = resolve(import.meta.dirname, '..', '.tmp');
const PANIC = /fixture startup[\s\S]*thread 'tokio-runtime-worker' \(42\) panicked at fixture.rs:1:1:[\s\S]*fixture panic tail/;
const WRITE_PANIC = `
  process.stderr.write("thread 'tokio-runtime-worker' (42) pan", () => {
    process.stderr.write('icked at fixture.rs:1:1:\\n', () => {
      process.stderr.write('fixture panic tail\\n', () => { DONE });
    });
  });
`;

async function fixture(t: TestContext, options: {
  onStop?: string | null;
  onRequest?: string;
  failure?: RegExp;
} = {}): Promise<RealServer> {
  mkdirSync(SCRATCH, { recursive: true });
  const dir = mkdtempSync(join(SCRATCH, 'selvaged-helper-'));
  const binary = join(dir, 'selvaged.mjs');
  const onStop = options.onStop === undefined ? 'process.exit(0);' : options.onStop;
  writeFileSync(binary, `#!${process.execPath}
import net from 'node:net';
process.stderr.write('fixture startup\\n');
${onStop === null ? '' : `process.on('SIGTERM', () => { ${onStop} });`}
const listener = net.createServer((socket) => {
  socket.once('data', () => { ${options.onRequest ?? "socket.end('ready');"} });
});
listener.listen(0, '127.0.0.1', () => {
  console.log('ws://127.0.0.1:' + listener.address().port + '/session');
});
`);
  chmodSync(binary, 0o755);
  const previous = process.env.SELVAGE_SELVAGED;
  process.env.SELVAGE_SELVAGED = binary;
  let server: RealServer | undefined;
  t.after(async () => {
    try {
      if (server !== undefined) {
        if (options.failure !== undefined) {
          await assert.rejects(server.stop(), options.failure);
        } else {
          await server.stop();
        }
      }
    } finally {
      if (previous === undefined) {
        delete process.env.SELVAGE_SELVAGED;
      } else {
        process.env.SELVAGE_SELVAGED = previous;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
  server = await RealServer.start();
  return server;
}

async function request(server: RealServer): Promise<string> {
  const address = new URL(`tcp://${server.address}`);
  return await new Promise<string>((resolve_, reject) => {
    const socket = connect(Number(address.port), address.hostname);
    let reply = '';
    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => {
      socket.destroy(new Error('fixture did not acknowledge the stderr write in 5s'));
    });
    socket.on('connect', () => { socket.write('write'); });
    socket.on('data', (chunk: string) => { reply += chunk; });
    socket.on('error', reject);
    socket.on('close', (hadError) => {
      if (!hadError) resolve_(reply);
    });
  });
}

test('RealServer teardown rejects a post-readiness split task panic even when the child exits zero', async (t) => {
  await fixture(t, {
    onStop: WRITE_PANIC.replace('DONE', 'process.exit(0);'),
    failure: PANIC,
  });
});

test('RealServer retains a post-readiness panic from a child that keeps serving', async (t) => {
  const server = await fixture(t, {
    onRequest: WRITE_PANIC.replace('DONE', "socket.end('panic written');"),
    failure: PANIC,
  });
  assert.equal(await request(server), 'panic written');
  assert.equal(await request(server), 'panic written', 'the child still serves after its task panic');
  await assert.rejects(server.stop(), PANIC);
  await assert.rejects(server.stop(), PANIC, 'a second stop must retain the same failure');
});

test('RealServer retains the whole panic after the child has already exited zero', async (t) => {
  const server = await fixture(t, {
    onRequest: WRITE_PANIC.replace('DONE', 'socket.end(String(process.pid), () => listener.close());'),
    failure: PANIC,
  });
  const reply = await request(server);
  assert.match(reply, /^\d+$/);
  const pid = Number(reply);
  await waitFor('the fixture to exit before stop', () => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      return true;
    }
  });
  await assert.rejects(server.stop(), /code 0 signal null/);
});

for (const [name, onStop] of [
  ['zero exit', "process.stderr.end('ordinary shutdown log\\n', () => process.exit(0));"],
  ['default SIGTERM', null],
] as const) {
  test(`RealServer accepts a clean ${name} and repeated stops`, async (t) => {
    const server = await fixture(t, { onStop });
    assert.equal(await request(server), 'ready');
    await Promise.all([server.stop(), server.stop()]);
    await server.stop();
  });
}

test('RealServer teardown rejects a non-panic runtime failure', async (t) => {
  await fixture(t, {
    onStop: "process.stderr.end('fixture runtime failure\\n', () => process.exit(23));",
    failure: /code 23[\s\S]*fixture runtime failure/,
  });
});

test('RealServer teardown rejects an unexpected signal', async (t) => {
  await fixture(t, {
    onStop: "process.kill(process.pid, 'SIGKILL');",
    failure: /signal SIGKILL[\s\S]*fixture startup/,
  });
});

test('RealServer stop rejects at its deadline when an exited child leaves inherited pipes open', { timeout: 10_000 }, async (t) => {
  let pipeHolder: Socket | undefined;
  const lifetime = createServer((socket) => { pipeHolder = socket; });
  t.after(async () => {
    pipeHolder?.destroy();
    await new Promise<void>((resolve_) => { lifetime.close(() => { resolve_(); }); });
  });
  await new Promise<void>((resolve_, reject) => {
    lifetime.once('error', reject);
    lifetime.listen(0, '127.0.0.1', resolve_);
  });
  const address = lifetime.address();
  assert.ok(address !== null && typeof address !== 'string');
  const holder = `
    import { connect } from 'node:net';
    const socket = connect(${address.port}, '127.0.0.1', () => { process.send('ready'); });
    socket.on('end', () => process.exit(0));
    socket.on('error', () => process.exit(0));
    setTimeout(() => process.exit(0), 4500);
  `;
  const server = await fixture(t, {
    onRequest: `
      import('node:child_process').then(({ spawn }) => {
        const holder = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(holder)}], {
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        });
        holder.once('message', () => {
          holder.disconnect();
          holder.unref();
          socket.end('inherited pipes open');
        });
      });
    `,
    failure: /did not close within 2s[\s\S]*code 0 signal null[\s\S]*fixture startup/,
  });
  assert.equal(await request(server), 'inherited pipes open');
  assert.ok(pipeHolder, 'the pipe holder connected before acknowledging readiness');
  await assert.rejects(server.stop(), /did not close within 2s[\s\S]*code 0 signal null/);
});
