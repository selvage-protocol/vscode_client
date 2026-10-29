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
  "cd ../reference_server && nix develop . -c cargo build -p selvaged";

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
  private stopping: Promise<void> | undefined;
  private readonly stderr: string[];
  private readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  private constructor(
    child: ChildProcessByStdio<null, Readable, Readable>,
    address: string,
    stderr: string[],
    closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  ) {
    this.child = child;
    this.address = address;
    this.wsBase = baseOf(`ws://${address}`);
    this.stderr = stderr;
    this.closed = closed;
  }

  /**
   * Starts a server on an ephemeral loopback port. It seats `selvage/2`, the one wire version,
   * which is what `/meta` advertises.
   */
  static async start(): Promise<RealServer> {
    const binary = selvagedBinary();
    const args = ['--listen', '127.0.0.1:0'];
    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((settle) => {
      child.once('close', (code, signal) => {
        settle({ code, signal });
      });
    });
    return new Promise<RealServer>((resolve_, reject) => {
      const stderr: string[] = [];
      child.stderr.setEncoding('utf8');
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
          resolve_(new RealServer(child, match[1], stderr, closed));
        }
      });
      child.stderr.on('data', (chunk: string) => {
        stderr.push(chunk);
      });
      child.on('close', (code, signal) => {
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
    this.stopping ??= this.stopOnce();
    await this.stopping;
  }

  private async stopOnce(): Promise<void> {
    const requestedStop = this.child.exitCode === null && this.child.signalCode === null;
    if (requestedStop) {
      this.child.kill('SIGTERM');
    }
    let forced: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      forced = setTimeout(() => {
        reject(new Error(
          `selvaged did not close within 2s: code ${this.child.exitCode} signal ${this.child.signalCode}\n` +
            `stderr: ${this.stderr.join('')}`,
        ));
        this.child.kill('SIGKILL');
        this.child.stdout.destroy();
        this.child.stderr.destroy();
      }, 2000);
    });
    try {
      // `close` drains both pipes, but an inherited pipe can outlive the child.
      const { code, signal } = await Promise.race([this.closed, deadline]);
      const stderr = this.stderr.join('');
      if (/\bpanicked (?:at|with)\b/.test(stderr) ||
          (code !== 0 && !(requestedStop && signal === 'SIGTERM'))) {
        throw new Error(`selvaged failed: code ${code} signal ${signal}\nstderr: ${stderr}`);
      }
    } finally {
      clearTimeout(forced);
    }
  }
}
