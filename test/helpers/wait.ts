/** Bounded waiting: a timeout fails with the state it actually observed. */

import { setTimeout as delay } from 'node:timers/promises';

import type { SelvageEngine } from '../../src/engine/engine.ts';
import type { EngineEvent } from '../../src/engine/events.ts';
import type { OffsetSelection, Presence } from '../../src/engine/presence.ts';
import type { PeerInfo } from '../../src/engine/envelope.ts';

/** How long a test is willing to wait for a condition that should hold immediately. */
// A shared CI runner is much slower than a developer's machine, and every wait here is a poll of
// a condition that does hold — the deadline only has to be generous enough not to race a loaded
// runner. `SELVAGE_WAIT_MS` lets a slower environment say so; the default stays tight so a real
// failure is reported quickly locally.
export const WAIT_MS = Number(process.env.SELVAGE_WAIT_MS ?? 5000);

export interface WaitOptions {
  timeoutMs?: number;
  describe?: () => unknown;
}

/**
 * Polls `check` until it returns a value, with a deadline. `undefined` and `false` mean
 * "not yet"; anything else is the answer.
 */
export async function waitFor<T>(
  label: string,
  check: () => T | undefined | false,
  options: WaitOptions = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? WAIT_MS);
  for (;;) {
    const value = check();
    if (value !== undefined && value !== false) {
      return value;
    }
    if (Date.now() >= deadline) {
      const observed =
        options.describe === undefined ? undefined : options.describe();
      throw new Error(
        `timed out after ${options.timeoutMs ?? WAIT_MS}ms waiting for ${label}` +
          (observed === undefined
            ? ''
            : `; observed ${JSON.stringify(observed)}`),
      );
    }
    await delay(5);
  }
}

/** Waits until both engines hold identical text for `path`, then returns it. */
export async function converge(
  a: SelvageEngine,
  b: SelvageEngine,
  path: string,
  options: WaitOptions = {},
): Promise<string> {
  return waitFor(
    `replicas to converge on ${path}`,
    () => {
      const left = a.text(path);
      const right = b.text(path);
      return left === right ? left : false;
    },
    {
      ...options,
      describe: () => [a.text(path), b.text(path)],
    },
  );
}

/**
 * Waits until two engines hold the same text *and* the same history for it: text equality
 * alone is not convergence, the state vectors have to agree as well (spec §7).
 */
export async function catchUp(
  a: SelvageEngine,
  b: SelvageEngine,
  path: string,
  options: WaitOptions = {},
): Promise<string> {
  const text = await converge(a, b, path, options);
  await waitFor(
    `the replicas to agree on history for ${path}`,
    () => {
      const left = JSON.stringify(a.stateVector());
      const right = JSON.stringify(b.stateVector());
      return left === right ? left : false;
    },
    { ...options, describe: () => [a.stateVector(), b.stateVector()] },
  );
  return text;
}

/** Waits until `engine` can see a peer with this display name. */
export async function waitForPeer(
  engine: SelvageEngine,
  displayName: string,
): Promise<PeerInfo> {
  return waitFor(`peer ${displayName} to appear`, () => {
    const peer = engine
      .peers()
      .find((candidate) => candidate.display_name === displayName);
    return peer ?? false;
  });
}

/** Waits until `engine` sees awareness from a peer with this display name. */
export async function waitForPresence(
  engine: SelvageEngine,
  displayName: string,
): Promise<Presence> {
  return waitFor(`presence from ${displayName}`, () => {
    const presence = engine
      .presence()
      .find((candidate) => candidate.peer?.display_name === displayName);
    return presence ?? false;
  });
}

/**
 * Waits until a peer's published selection resolves, in this engine's replica, to offsets
 * `matches` accepts. Resolution is deferred (§8.1): a state can arrive before the document
 * it anchors into, and resolve on a later poll.
 */
export async function waitForSelection(
  engine: SelvageEngine,
  displayName: string,
  path: string,
  matches: (selection: OffsetSelection) => boolean = () => true,
): Promise<{ presence: Presence; selection: OffsetSelection }> {
  return waitFor(
    `a selection from ${displayName} in ${path}`,
    () => {
      for (const presence of engine.presence()) {
        if (presence.peer?.display_name !== displayName) {
          continue;
        }
        const published = presence.state?.selection;
        if (published === undefined) {
          continue;
        }
        const selection = engine.resolveSelection(path, published);
        if (selection !== undefined && matches(selection)) {
          return { presence, selection };
        }
      }
      return false;
    },
    { describe: () => engine.presence() },
  );
}

/** Records an engine's events, with waits that report what was actually seen. */
export interface Recorder {
  events: EngineEvent[];
  waitForEvent(
    label: string,
    matches: (event: EngineEvent) => boolean,
    options?: WaitOptions,
  ): Promise<EngineEvent>;
  types(): string[];
  stop(): void;
}

export function record(engine: SelvageEngine): Recorder {
  const events: EngineEvent[] = [];
  const stop = engine.on((event) => {
    events.push(event);
  });
  return {
    events,
    types: () => events.map((event) => event.type),
    waitForEvent: (label, matches, options) =>
      waitFor(label, () => events.find(matches) ?? false, {
        ...options,
        describe: () => events,
      }),
    stop,
  };
}
