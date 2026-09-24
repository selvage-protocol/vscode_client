/** Bounded waiting: a timeout fails with the state it actually observed. */

import { setTimeout as delay } from 'node:timers/promises';

import type { EngineEvent, EngineEventListener } from '../../src/engine/events.ts';
import type { OffsetSelection, Presence, Selection } from '../../src/engine/presence.ts';
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

/** An engine as the waits below read it: the readings a test polls, and its event stream. */
interface Readable {
  text(path: string): string;
}

/** Waits until both engines hold identical text for `path`, then returns it. */
export async function converge(
  a: Readable,
  b: Readable,
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

/** Waits until `engine` can see a peer with this display name. */
export async function waitForPeer(
  engine: { peers(): PeerInfo[] },
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
  engine: { presence(): Presence[] },
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
  engine: {
    presence(): Presence[];
    resolveSelection(path: string, selection: Selection): OffsetSelection | undefined;
  },
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

export function record(engine: { on(listener: EngineEventListener): () => void }): Recorder {
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
