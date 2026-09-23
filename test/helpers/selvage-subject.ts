/**
 * The engine as a corpus subject: `specification/runner/subject.py`'s protocol over stdin and
 * stdout, so that the peer corpus's decision vectors run against this client.
 *
 * ```
 * node test/helpers/selvage-subject.ts
 * python3 specification/runner/run_peer.py \
 *   --subject "node test/helpers/selvage-subject.ts" --mutation-census
 * ```
 *
 * One JSON object per line in, one reply per line out, and the caller does all the waiting:
 * this side never sleeps for a decision and never speaks first, so a vector cannot read a state
 * that arrived for a different reason. What it does run is the session's own clocks, on a tick
 * of its own, because §13.7 renews a held set on one and §13.8's windows are read on it — a
 * subject that only moved when it was spoken to would renew nothing.
 *
 * It opens no socket. The decision layer's frames are handed over by the caller
 * (`{"cmd": "deliver", "frame": "<hex>"}`), which is what makes a frame-by-frame decision an
 * observable one, so `join` must say `"offline": true`.
 *
 * Every command and every tick runs through one queue: the session is a sequence of decisions
 * and two of them interleaving would be a different sequence.
 */

import { createInterface } from 'node:readline';

import { nodeCrypto } from '../../src/node/crypto.ts';
import { parseInvite, PeerSession } from '../../src/engine/peer.ts';
import type { PeerOptions } from '../../src/engine/peer.ts';
import { fromHex } from '../../src/engine/sealed.ts';

/** How often the session's clocks are run while the caller is not asking for anything. */
const TICK_MS = 10;

/** A running subject: one session and the zero of the clock it reads. */
interface Running {
  peer: PeerSession;
  start: number;
}

let running: Running | undefined;

/** §13.8's clock: this client's own monotone elapsed time from its seat. */
function clock(now: Running): number {
  return performance.now() - now.start;
}

// The session is a sequence of decisions, so nothing here runs two at once: a tick cannot fall
// between the two halves of a command.
let queue: Promise<unknown> = Promise.resolve();

function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function tick(): Promise<void> {
  return serial(async () => {
    if (running !== undefined) {
      await running.peer.tick(clock(running));
    }
  });
}

/** What a subject says about itself: §13.11's observables and nothing else. */
function report(): Record<string, unknown> {
  const empty = {
    text: {},
    documents: [],
    applied: [],
    dropped: [],
    published: 0,
    handshake: 0,
    frames: 0,
    ended: false,
    listing: [],
    holds: {},
    mutation: null,
  };
  if (running === undefined) {
    return empty;
  }
  const peer = running.peer;
  // A frame this session could not produce would leave it looking like a client with nothing to
  // say, which is the one thing a subject must never do quietly.
  if (peer.failure !== undefined) {
    throw new Error(`this session could not publish a frame: ${peer.failure}`);
  }
  const documents = peer.documents();
  const text: Record<string, string> = {};
  for (const path of documents) {
    text[path] = peer.text(path);
  }
  const holds: Record<string, string[]> = {};
  for (const [key, paths] of peer.peerHolds()) {
    holds[key] = paths;
  }
  return {
    text,
    documents,
    applied: peer.appliedFrames.map((frame) => ({ frame: frame.frame, kind: frame.kind })),
    dropped: peer.droppedFrames.map((frame) => ({ frame: frame.frame, reason: frame.reason })),
    published: peer.publishedCount,
    handshake: peer.handshakeCount,
    frames: peer.frameCount,
    ended: peer.end !== undefined,
    ending: peer.end ?? null,
    listing: [...peer.listing],
    holds,
    mutation: peer.mutationName ?? null,
  };
}

interface Command {
  [member: string]: unknown;
}

function text(command: Command, member: string): string {
  const value = command[member];
  if (typeof value !== 'string') {
    throw new Error(`a command needs a \`${member}\``);
  }
  return value;
}

function optionalText(command: Command, member: string): string | undefined {
  const value = command[member];
  return typeof value === 'string' ? value : undefined;
}

function millis(command: Command, member: string): number {
  const keepalive = command['keepalive'];
  const value =
    typeof keepalive === 'object' && keepalive !== null
      ? (keepalive as Command)[member]
      : undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`\`keepalive.${member}\` is a count of milliseconds`);
  }
  return value;
}

/** The seats a roster names, which is what §13.8 reads a state's `host` entry against. */
function seats(command: Command): string[] {
  const roster = command['roster'];
  if (!Array.isArray(roster)) {
    return [];
  }
  return roster.filter((seat): seat is string => typeof seat === 'string');
}

/** A 32-byte seed from 64 hex characters, which is the shape the corpus's fixture uses. */
function seed(value: string): Uint8Array {
  const raw = fromHex(value);
  if (raw === undefined || raw.length !== 32) {
    throw new Error(`a session key seed is 32 bytes, and ${JSON.stringify(value)} is not`);
  }
  return raw;
}

/** Seats a session: the invite's two keys, the session's clock, and the seats the relay showed. */
async function join(command: Command): Promise<void> {
  if (command['offline'] !== true) {
    throw new Error('this subject opens no socket: `join` needs `"offline": true`');
  }
  const read = parseInvite(text(command, 'invite'));
  if (!read.ok) {
    throw new Error(read.reason);
  }
  const options: PeerOptions = {
    roomId: read.invite.room,
    roomKey: read.invite.roomKey,
    hostKey: read.invite.hostKey,
    keepalive: {
      awareness_renew_ms: millis(command, 'awareness_renew_ms'),
      awareness_expire_ms: millis(command, 'awareness_expire_ms'),
      ping_interval_ms: millis(command, 'ping_interval_ms'),
    },
    crypto: nodeCrypto,
    roster: seats(command),
  };
  const seat = optionalText(command, 'seat');
  if (seat !== undefined) {
    options.seat = seat;
  }
  const role = optionalText(command, 'role');
  if (role === 'guest' || role === 'viewer') {
    options.declaredRole = role;
  }
  const fixed = command['session_key'];
  if (typeof fixed === 'string') {
    options.sessionSeed = seed(fixed);
  }
  const peer = await PeerSession.create(options);
  if (peer === undefined) {
    throw new Error('the session keypair could not be minted');
  }
  const path = optionalText(command, 'path');
  if (path !== undefined) {
    peer.open(path);
  }
  if (running !== undefined) {
    throw new Error('a session is already running');
  }
  running = { peer, start: performance.now() };
  await peer.tick(0);
}

async function serve(command: Command): Promise<unknown | undefined> {
  switch (text(command, 'cmd')) {
    case 'join':
      await join(command);
      return undefined;
    case 'deliver': {
      const raw = fromHex(text(command, 'frame'));
      if (raw === undefined) {
        throw new Error('a `deliver` frame is hex');
      }
      const now = current();
      await now.peer.deliver(clock(now), raw);
      await now.peer.tick(clock(now));
      return undefined;
    }
    case 'insert': {
      const now = current();
      const index = command['index'];
      if (typeof index !== 'number' || !Number.isInteger(index)) {
        throw new Error('an `insert` command needs an `index`');
      }
      await now.peer.insert(text(command, 'path'), index, text(command, 'text'));
      await now.peer.tick(clock(now));
      return undefined;
    }
    case 'announce': {
      // A hold: the whole held set replaced by this one path and announced (§13.7).
      const now = current();
      now.peer.release();
      now.peer.open(text(command, 'path'));
      await now.peer.tick(clock(now));
      return undefined;
    }
    case 'mutate': {
      current().peer.mutate(text(command, 'name'));
      return undefined;
    }
    case 'report':
      return undefined;
    case 'quit':
      running?.peer.destroy();
      running = undefined;
      return 'stop';
    default:
      throw new Error(`unknown command ${JSON.stringify(command['cmd'])}`);
  }
}

function current(): Running {
  if (running === undefined) {
    throw new Error('no session: `join` first');
  }
  return running;
}

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const ticker = setInterval(() => {
    void tick();
  }, TICK_MS);
  const write = (value: unknown): void => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  };
  try {
    for await (const line of lines) {
      if (line.trim() === '') {
        continue;
      }
      let command: Command;
      try {
        command = JSON.parse(line) as Command;
      } catch (error) {
        write({ ok: false, error: `a command is one JSON object per line: ${String(error)}` });
        continue;
      }
      let stop = false;
      let reply: unknown;
      try {
        reply = await serial(async () => await serve(command));
        stop = reply === 'stop';
        write({ ok: true, ...(stop ? {} : { report: report() }) });
      } catch (error) {
        // A command this side cannot take is answered and not fatal, so a caller sees which one
        // failed instead of a subject that vanished.
        write({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      if (stop) {
        break;
      }
    }
  } finally {
    clearInterval(ticker);
  }
}

await main();
