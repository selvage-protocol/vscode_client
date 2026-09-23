/**
 * Drives the Rust client as a guest: `reference_server`'s `interop_peer` example, which is
 * built on the same `selvage-client` a shipped client uses, spoken to over stdin and
 * stdout — one JSON object per line, one reply per command.
 *
 * The binary is taken from `SELVAGE_INTEROP_PEER` when that is set, and otherwise from
 * `../reference_server/target/{debug,release}/examples/interop_peer`. A missing binary
 * fails the test with the command that produces it rather than skipping: the point of this
 * suite is a real second implementation, not a modeled one.
 */

import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import { WAIT_MS } from './wait.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const REFERENCE_SERVER = resolve(REPO_ROOT, '..', 'reference_server');

export const BUILD_HINT =
  "nix develop ../reference_server -c sh -c 'cd ../reference_server && cargo build -p selvage-harness --example interop_peer'";

/**
 * Joining two processes is slower than one round trip; only the first report gets this.
 *
 * Exported because it is a bound a caller may reason from rather than a number to keep a copy
 * of: a window that must outlast the peer's startup is that window plus this budget, and a
 * startup that crosses it fails here instead of reaching a caller's assertion.
 */
export const START_MS = 30_000;

export function interopPeerBinary(): string {
  const fromEnv = process.env.SELVAGE_INTEROP_PEER;
  if (fromEnv !== undefined && fromEnv !== '') {
    return fromEnv;
  }
  for (const profile of ['debug', 'release']) {
    const candidate = resolve(
      REFERENCE_SERVER,
      'target',
      profile,
      'examples',
      'interop_peer',
    );
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `no interop_peer binary under ${REFERENCE_SERVER}/target; build one from ${REPO_ROOT} with:\n  ${BUILD_HINT}\nor point SELVAGE_INTEROP_PEER at one`,
  );
}

export interface PeerRecord {
  peer_id: string;
  display_name: string;
  role: string;
  /** `null` when the server said nothing about this peer's awareness clock. */
  awareness_client_id: number | null;
}

/** A peer's presence as the Rust replica holds it: the anchor it was sent, and the offsets
 * it resolved that anchor to. */
export interface PeerPresence {
  client_id: number;
  /** A member this client could not read is `null`, the two outcomes §8.1 makes one. */
  display_name: string | null;
  role: string | null;
  path: string | null;
  anchors: { anchor: unknown; head: unknown } | null;
  resolved: { anchor: number; head: number } | null;
}

export interface PeerReport {
  event: string;
  /** What the handshake reply said, as this client read it. */
  session: {
    room: string;
    role: string;
    peer_id: string;
    documents: string[];
    peers: PeerRecord[];
  };
  path: string;
  /** This replica's own text, not a value fetched from the server. */
  text: string;
  documents: string[];
  peers: PeerRecord[];
  presence: PeerPresence[];
  state_vector: Array<[number, number]>;
}

export interface PeerOptions {
  invite: string;
  path: string;
  name: string;
  /**
   * Makes the wire version explicit. The link is still what decides it: `--version 2` on a
   * link with no fragment, and `--version 1` on a link that carries one, are refused before a
   * socket is opened rather than overriding the reading.
   */
  version?: 1 | 2;
}

interface Waiter {
  resolve: (line: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class RustPeer {
  private readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
  private readonly errors: string[] = [];
  private buffered = '';
  private arrived: string[] = [];
  private waiter: Waiter | null = null;
  private finished: string | undefined;
  private stopped = false;

  private constructor(child: ChildProcessByStdio<Writable, Readable, Readable>) {
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.take(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.errors.push(chunk);
    });
    // A write to a peer that is already gone raises here; `exit` carries the reason.
    child.stdin.on('error', () => undefined);
    child.on('exit', (code, signal) => {
      this.exit(`the peer exited before it answered: code ${code} signal ${signal}`);
    });
    child.on('error', (error) => {
      this.exit(`the peer could not be started: ${error.message}`);
    });
  }

  static async start(options: PeerOptions): Promise<RustPeer> {
    const args = [
      '--invite',
      options.invite,
      '--path',
      options.path,
      '--name',
      options.name,
    ];
    if (options.version !== undefined) {
      args.push('--version', String(options.version));
    }
    const child = spawn(interopPeerBinary(), args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const peer = new RustPeer(child);
    // It answers its first command only once it has joined, so this is the readiness gate —
    // and a peer that never got there is killed here rather than left behind.
    try {
      await peer.report(START_MS);
    } catch (error) {
      await peer.stop();
      throw error;
    }
    return peer;
  }

  async report(timeoutMs: number = WAIT_MS): Promise<PeerReport> {
    const value = await this.request(
      { op: 'report' },
      'the peer to report its state',
      timeoutMs,
    );
    if (value.event !== 'report') {
      throw new Error(`the peer answered ${JSON.stringify(value)} to a report`);
    }
    return value as unknown as PeerReport;
  }

  /** Applies an insert and answers with the peer's own text afterwards. */
  async insert(index: number, text: string): Promise<string> {
    return (await this.insertReply(index, text)).text;
  }

  /**
   * Applies an insert and answers with the whole reply, because `selvage/2` says whether the
   * frame went out. `published: false` is §13.1's step 4 holding an edit until a state commits
   * this connection's key, which is not a refusal; `selvage/1` has no such member, so a driver
   * that wants it is a driver that knows which link it handed in.
   */
  async insertReply(
    index: number,
    text: string,
  ): Promise<{ text: string; published: boolean | undefined }> {
    const value = await this.request(
      { op: 'insert', index, text },
      'the peer to insert',
      WAIT_MS,
    );
    if (value.event !== 'text') {
      throw new Error(`the peer answered ${JSON.stringify(value)} to an insert`);
    }
    return {
      text: String(value.text),
      published:
        typeof value.published === 'boolean' ? value.published : undefined,
    };
  }

  async select(selection: { anchor: number; head: number }): Promise<void> {
    const value = await this.request(
      { op: 'select', ...selection },
      'the peer to publish a selection',
      WAIT_MS,
    );
    if (value.event !== 'ok') {
      throw new Error(`the peer answered ${JSON.stringify(value)} to a select`);
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.finished !== undefined) {
      return;
    }
    const exited = new Promise<void>((settle) => {
      this.child.once('exit', () => {
        settle();
      });
    });
    this.child.stdin.write('{"op":"quit"}\n');
    const forced = setTimeout(() => {
      this.child.kill('SIGKILL');
    }, 2000);
    await exited;
    clearTimeout(forced);
  }

  private async request(
    command: unknown,
    label: string,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
    const line = await this.nextLine(label, timeoutMs);
    return JSON.parse(line) as Record<string, unknown>;
  }

  private nextLine(label: string, timeoutMs: number): Promise<string> {
    const queued = this.arrived.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    if (this.finished !== undefined) {
      return Promise.reject(new Error(this.finished));
    }
    if (this.waiter !== null) {
      return Promise.reject(
        new Error(`a second command was sent while waiting for ${label}`),
      );
    }
    return new Promise<string>((settle, fail) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        fail(
          new Error(
            `timed out after ${timeoutMs}ms waiting for ${label}${this.stderr()}`,
          ),
        );
      }, timeoutMs);
      this.waiter = { resolve: settle, reject: fail, timer };
    });
  }

  private stderr(): string {
    const seen = this.errors.join('');
    return seen === '' ? '' : `\nstderr: ${seen}`;
  }

  private take(chunk: string): void {
    this.buffered += chunk;
    for (;;) {
      const end = this.buffered.indexOf('\n');
      if (end === -1) {
        return;
      }
      const line = this.buffered.slice(0, end);
      this.buffered = this.buffered.slice(end + 1);
      if (line.trim() === '') {
        continue;
      }
      this.deliver(line);
    }
  }

  private deliver(line: string): void {
    const waiting = this.waiter;
    if (waiting === null) {
      this.arrived.push(line);
      return;
    }
    this.waiter = null;
    clearTimeout(waiting.timer);
    waiting.resolve(line);
  }

  private exit(reason: string): void {
    if (this.finished !== undefined) {
      return;
    }
    this.finished = `${reason}${this.stderr()}`;
    const waiting = this.waiter;
    if (waiting !== null) {
      this.waiter = null;
      clearTimeout(waiting.timer);
      waiting.reject(new Error(this.finished));
    }
  }
}

/**
 * Polls the peer's own report until `matches` accepts it, with a deadline that says what
 * the peer last held. The predicate is the only thing worth waiting on here: every answer
 * comes from the peer's replica, so a report that is not there yet is a report to ask for
 * again.
 */
export async function waitForReport(
  peer: RustPeer,
  label: string,
  matches: (report: PeerReport) => boolean,
  timeoutMs: number = WAIT_MS,
): Promise<PeerReport> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const report = await peer.report();
    if (matches(report)) {
      return report;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${label}; the peer reported ${JSON.stringify(report)}`,
      );
    }
    await delay(5);
  }
}
