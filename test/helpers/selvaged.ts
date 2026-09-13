/**
 * Runs the real `selvaged`, built from `impl/`.
 *
 * The binary is taken from `SELVAGED_BIN` when that is set, and otherwise from
 * `impl/target/{debug,release}/selvaged`. A missing binary fails the test with the command
 * that produces it rather than skipping: the point of this suite is the real server.
 */

import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Readable } from 'node:stream';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');

export const BUILD_HINT =
  'nix develop ./impl --command sh -c "cd impl && cargo build -p selvaged"';

export function selvagedBinary(): string {
  const fromEnv = process.env.SELVAGED_BIN;
  if (fromEnv !== undefined && fromEnv !== '') {
    return fromEnv;
  }
  for (const profile of ['debug', 'release']) {
    const candidate = resolve(REPO_ROOT, 'impl', 'target', profile, 'selvaged');
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `no selvaged binary under ${REPO_ROOT}/impl/target; build one with:\n  ${BUILD_HINT}\nor point SELVAGED_BIN at one`,
  );
}

/** A `selvaged` on an ephemeral loopback port. */
export class RealServer {
  readonly wsBase: string;
  readonly address: string;

  private readonly child: ChildProcessByStdio<null, Readable, Readable>;
  private stopped = false;

  private constructor(
    child: ChildProcessByStdio<null, Readable, Readable>,
    address: string,
  ) {
    this.child = child;
    this.address = address;
    this.wsBase = `ws://${address}`;
  }

  static async start(): Promise<RealServer> {
    const binary = selvagedBinary();
    const child = spawn(binary, ['--listen', '127.0.0.1:0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return new Promise<RealServer>((resolve_, reject) => {
      const stderr: string[] = [];
      let stdout = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(
          new Error(
            `selvaged did not report an address in 10s\nstdout: ${stdout}\nstderr: ${stderr.join('')}`,
          ),
        );
      }, 10_000);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        const match = /ws:\/\/([0-9.]+:[0-9]+)\/session/.exec(stdout);
        if (match !== null) {
          clearTimeout(timer);
          resolve_(new RealServer(child, match[1]));
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr.push(chunk.toString());
      });
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        reject(
          new Error(
            `selvaged exited before it was ready: code ${code} signal ${signal}\n` +
              `stdout: ${stdout}\nstderr: ${stderr.join('')}`,
          ),
        );
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    const exited = new Promise<void>((resolve_) => {
      this.child.once('exit', () => {
        resolve_();
      });
    });
    this.child.kill('SIGTERM');
    const forced = setTimeout(() => {
      this.child.kill('SIGKILL');
    }, 2000);
    await exited;
    clearTimeout(forced);
  }
}
