/**
 * The peer corpus, read the way `specification/runner/run_peer.py` reads it: the fixture, the
 * canonical bytes of a recipe, and the subject protocol (`runner/subject.py`) as a client.
 *
 * The corpus lives in the sibling `specification` checkout, and this is where a test finds it.
 * The two drivers of the decision layer are deliberate: `run_peer.py` drives any subject from
 * Python, and this drives this repository's own from `node --test`, so the corpus is evidence
 * in this repository's suite and not only wherever the Python runner is pointed by hand.
 */

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { FrameCrypto } from '../../src/engine/crypto.ts';
import { encodeKey, frameKey, fromHex, hex, keyId, seal } from '../../src/engine/sealed.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

/** Where the corpus is read from; a sibling checkout unless a caller says otherwise. */
export function corpusDir(): string {
  return resolve(
    process.env['SELVAGE_SPECIFICATION'] ?? resolve(REPO_ROOT, '..', 'specification'),
    'vectors',
  );
}

export const CORPUS_HINT =
  'the peer corpus lives in the sibling `specification` checkout; point SELVAGE_SPECIFICATION at one';

export function requireCorpus(): string {
  const dir = corpusDir();
  if (!existsSync(resolve(dir, 'peer'))) {
    throw new Error(`no peer corpus under ${dir}: ${CORPUS_HINT}`);
  }
  return dir;
}

/** One fixture keypair, with the two spellings the corpus names a key by. */
export interface FixtureKey {
  name: string;
  public: Uint8Array;
  private: Uint8Array;
  /** The key's canonical base64url spelling, which a state's `peers` names it by. */
  spelling: string;
  /** The key's id in hex, which a report names a key by where no state does. */
  hexId: string;
}

export interface Fixture {
  roomId: string;
  roomKey: Uint8Array;
  /** The frame key every vector's frame is sealed under, derived once (§6.1). */
  frameKey: Uint8Array;
  keys: Map<string, FixtureKey>;
  host: FixtureKey;
}

/**
 * The fixture every peer vector names, re-derived rather than trusted.
 *
 * `key_id` in the file is checked against the derivation §6.1 fixes, so a vector whose key
 * column drifted from its key is a failure here rather than a mystery later.
 */
export async function loadFixture(crypto: FrameCrypto): Promise<Fixture> {
  const path = resolve(requireCorpus(), 'fixture', 'keys.json');
  const document = JSON.parse(readFileSync(path, 'utf8')) as {
    room: { id: string; key: string; host: string };
    keys: Record<string, { public: string; private: string; key_id: string }>;
  };
  const keys = new Map<string, FixtureKey>();
  for (const [name, entry] of Object.entries(document.keys)) {
    const publicKey = fromHex(entry.public);
    const privateKey = fromHex(entry.private);
    if (publicKey === undefined || privateKey === undefined) {
      throw new Error(`${path}: ${name} is not a keypair`);
    }
    const id = hex(await keyId(crypto, publicKey));
    if (id !== entry.key_id) {
      throw new Error(`${path}: ${name}'s key id is ${entry.key_id} and its key derives ${id}`);
    }
    keys.set(name, {
      name,
      public: publicKey,
      private: privateKey,
      spelling: encodeKey(publicKey),
      hexId: id,
    });
  }
  const host = keys.get(document.room.host);
  const roomKey = fromHex(document.room.key);
  if (host === undefined || roomKey === undefined) {
    throw new Error(`${path}: the room names no host key it carries`);
  }
  const derived = await frameKey(crypto, document.room.id, roomKey);
  if (derived === undefined) {
    throw new Error(`${path}: the room key derives no frame key`);
  }
  return { roomId: document.room.id, roomKey, frameKey: derived, keys, host };
}

export function fixtureKey(fixture: Fixture, name: unknown): FixtureKey {
  const key = typeof name === 'string' ? fixture.keys.get(name) : undefined;
  if (key === undefined) {
    throw new Error(`the fixture has no key ${JSON.stringify(name)}`);
  }
  return key;
}

/** Hex, with or without the spaces a vector writes between bytes. */
export function bytesOf(text: unknown): Uint8Array {
  const raw = typeof text === 'string' ? fromHex(text) : undefined;
  if (raw === undefined) {
    throw new Error(`${JSON.stringify(text)} is not an even number of hex digits`);
  }
  return raw;
}

/** One byte string as a vector writes it: lowercase hex with a space between bytes. */
export function spaced(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

/**
 * The canonical bytes of a JSON value (`CANONICAL.md` §2): members ascending by name, no
 * whitespace, and a string written as `JSON.stringify` already writes one.
 *
 * A vector's `payload` is written for a reader and not for the wire — its member order is the
 * file's — so a producer canonicalises it before sealing.
 */
export function canonicalJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalText(value));
}

function canonicalText(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalText).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const members = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, member]) => `${JSON.stringify(name)}:${canonicalText(member)}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** One vector's recipe, sealed: the bytes the relay would hand over. */
export async function sealRecipe(
  fixture: Fixture,
  crypto: FrameCrypto,
  recipe: Record<string, unknown>,
): Promise<Uint8Array> {
  const signer = fixtureKey(fixture, recipe['sign']);
  const plaintext =
    recipe['plaintext'] === undefined
      ? canonicalJson(recipe['payload'])
      : bytesOf(recipe['plaintext']);
  const bytes = await seal(
    crypto,
    {
      roomId: fixture.roomId,
      frameKey: fixture.frameKey,
      kind: Number(recipe['kind']),
      // A recipe writes `epoch` only where it is not the version's own `0`; the vector that
      // pins `unknown_epoch` is the one that does.
      epoch: recipe['epoch'] === undefined ? 0 : Number(recipe['epoch']),
      counter: Number(recipe['counter']),
      nonce: bytesOf(recipe['nonce']),
      signer: { seed: signer.private, public: signer.public },
    },
    plaintext,
  );
  if (bytes === undefined) {
    throw new Error(`the recipe signed by ${signer.name} could not be sealed`);
  }
  return bytes;
}

// --- the subject protocol -------------------------------------------------------

/** What a subject says about itself, as `runner/subject.py` reads one. */
export interface SubjectReport {
  text: Record<string, string>;
  documents: string[];
  applied: Array<{ frame: number; kind: number }>;
  dropped: Array<{ frame: number; reason: string }>;
  published: number;
  handshake: number;
  frames: number;
  ended: boolean;
  listing: string[];
  holds: Record<string, string[]>;
  mutation: string | null;
}

/**
 * A subject process, and the line protocol the runner drives it with.
 *
 * One JSON object per line in, one reply per line out, and the caller does all the waiting: a
 * deadline here is what keeps a subject that stops answering from hanging the suite.
 */
export class Subject {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private stderr = '';
  private waiter: (() => void) | undefined;
  private stopped = false;
  private readonly timeout: number;

  constructor(command: string[], timeout: number) {
    this.timeout = timeout;
    this.child = spawn(command[0] ?? 'node', command.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: REPO_ROOT,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.waiter?.();
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
    });
  }

  /** One command, one reply. */
  async request(command: Record<string, unknown>, wait = this.timeout): Promise<SubjectReport> {
    if (this.stopped) {
      throw new Error('the subject has stopped');
    }
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
    const reply = JSON.parse(await this.line(wait)) as {
      ok?: boolean;
      error?: string;
      report?: unknown;
    };
    if (reply.ok !== true) {
      throw new Error(`the subject refused \`${String(command['cmd'])}\`: ${reply.error ?? ''}`);
    }
    return readReport(reply.report, this.stderr);
  }

  async join(options: Record<string, unknown>): Promise<SubjectReport> {
    return await this.request({ cmd: 'join', ...options });
  }

  async deliver(frame: Uint8Array): Promise<SubjectReport> {
    return await this.request({ cmd: 'deliver', frame: hex(frame) });
  }

  async report(): Promise<SubjectReport> {
    return await this.request({ cmd: 'report' });
  }

  async mutate(name: string): Promise<SubjectReport> {
    return await this.request({ cmd: 'mutate', name });
  }

  /** One line of stdout, or a failure naming what the subject was doing. */
  private async line(wait: number): Promise<string> {
    const deadline = Date.now() + wait;
    for (;;) {
      const end = this.buffer.indexOf('\n');
      if (end !== -1) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        return line;
      }
      if (this.child.exitCode !== null || this.stopped) {
        throw new Error(
          `the subject closed its stdout with ${String(this.child.exitCode)}: ${this.stderr.trim()}`,
        );
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new Error(`the subject did not answer within ${wait} ms: ${this.stderr.trim()}`);
      }
      await new Promise<void>((settle) => {
        const timer = setTimeout(() => {
          this.waiter = undefined;
          settle();
        }, left);
        this.waiter = () => {
          clearTimeout(timer);
          this.waiter = undefined;
          settle();
        };
      });
    }
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.child.stdin.end();
    this.child.kill('SIGKILL');
  }

  async quit(): Promise<void> {
    if (!this.stopped) {
      try {
        await this.request({ cmd: 'quit' });
      } catch {
        // A subject that exits without answering has still done what was asked.
      }
    }
    this.stop();
  }
}

/** A report, with the shape `runner/subject.py` refuses a subject for getting wrong. */
function readReport(value: unknown, stderr: string): SubjectReport {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`a report is an object, not ${JSON.stringify(value)}: ${stderr.trim()}`);
  }
  const report = value as Record<string, unknown>;
  const count = (name: string): number => {
    const member = report[name];
    if (typeof member !== 'number' || !Number.isInteger(member) || member < 0) {
      throw new Error(`a report's \`${name}\` is a count, not ${JSON.stringify(member)}`);
    }
    return member;
  };
  if (typeof report['ended'] !== 'boolean') {
    throw new Error('a report\'s `ended` is a boolean');
  }
  const text = report['text'];
  if (typeof text !== 'object' || text === null) {
    throw new Error('a report maps `text` from a path to a string');
  }
  return {
    text: text as Record<string, string>,
    documents: (report['documents'] ?? []) as string[],
    applied: (report['applied'] ?? []) as Array<{ frame: number; kind: number }>,
    dropped: (report['dropped'] ?? []) as Array<{ frame: number; reason: string }>,
    published: count('published'),
    handshake: count('handshake'),
    frames: count('frames'),
    ended: report['ended'],
    listing: (report['listing'] ?? []) as string[],
    holds: (report['holds'] ?? {}) as Record<string, string[]>,
    mutation: (report['mutation'] ?? null) as string | null,
  };
}

/** Bounded polling of a real predicate, with the deadline the caller gave. */
export async function until(
  label: string,
  check: () => Promise<string[]>,
  withinMs: number,
): Promise<void> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    const failures = await check();
    if (failures.length === 0) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`${label}: ${failures.join('; ')}`);
    }
    await delay(20);
  }
}
