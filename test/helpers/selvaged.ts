/**
 * Runs the real `selvaged`, built from the sibling `reference_server` checkout.
 *
 * The binary is taken from `SELVAGE_SELVAGED` when that is set, and otherwise from
 * `../reference_server/target/{debug,release}/selvaged`. A missing binary fails the test with
 * the command that produces it rather than skipping: the point of this suite is the real server.
 */

import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Readable } from 'node:stream';

import type { SessionBase } from '../../src/engine/urls.ts';
import { baseOf } from './base.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const REFERENCE_SERVER = resolve(REPO_ROOT, '..', 'reference_server');

export const BUILD_HINT =
  "nix develop ../reference_server -c sh -c 'cd ../reference_server && cargo build -p selvaged'";

export function selvagedBinary(): string {
  const fromEnv = process.env.SELVAGE_SELVAGED;
  if (fromEnv !== undefined && fromEnv !== '') {
    return fromEnv;
  }
  for (const profile of ['debug', 'release']) {
    const candidate = resolve(REFERENCE_SERVER, 'target', profile, 'selvaged');
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `no selvaged binary under ${REFERENCE_SERVER}/target; build one from ${REPO_ROOT} with:\n  ${BUILD_HINT}\nor point SELVAGE_SELVAGED at one`,
  );
}

/** A `selvaged` on an ephemeral loopback port. */
export class RealServer {
  readonly wsBase: SessionBase;
  readonly address: string;

  private readonly child: ChildProcessByStdio<null, Readable, Readable>;
  private stopped = false;

  private constructor(
    child: ChildProcessByStdio<null, Readable, Readable>,
    address: string,
  ) {
    this.child = child;
    this.address = address;
    this.wsBase = baseOf(`ws://${address}`);
  }

  /**
   * Starts a server on an ephemeral loopback port. `serveVersion2` adds `--serve-version-2`,
   * which seats `selvage/2` too and advertises both versions from `/meta`; a room is pinned to
   * the version that minted it either way.
   */
  static async start(options: { serveVersion2?: boolean } = {}): Promise<RealServer> {
    const binary = selvagedBinary();
    const args = ['--listen', '127.0.0.1:0'];
    if (options.serveVersion2 === true) {
      args.push('--serve-version-2');
    }
    const child = spawn(binary, args, {
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
    // Already gone: `exit` has fired, so waiting for it again would wait for ever.
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }
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
