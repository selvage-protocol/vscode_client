/**
 * The test's own clock and timers, for stepping a relay's automatic tick through a window
 * without real time passing and reading back the delay it armed.
 *
 * `RelaySession` reads `performance.now` and arms its timer with the global `setTimeout`. This
 * installs a pair in their place: the clock moves only when the test says so, and every callback
 * runs at the moment it was scheduled for, which is what a real timer does and what mocking
 * `setTimeout` alone cannot give while the clock stays the process's own. The process's timers
 * are restored in a `t.after` the test registers.
 *
 * Nothing here is a source seam: the relay is untouched, and what the test reads — the delay it
 * armed, the number of attempts a window drew — is what a real clock would have produced.
 * A timer callback returns void, so `advance` claims nothing about the asynchronous work one
 * starts: the test observes that, read-only, through `settled` or a poll of its own.
 */

import { WAIT_MS } from './wait.ts';

/** The handle `setTimeout` answers with, as `unrefTimer` reads it. */
export interface FakeTimerHandle {
  unref(): void;
}

interface Armed {
  at: number;
  run: () => void;
}

/** What an `advance` waits for between the callbacks it runs. */
export interface AdvanceOptions {
  /**
   * Polled, read-only, after each callback: whether the work that callback started has reached a
   * state the test can see — the attempt it made, the completion it reached, the delay it armed.
   * Nothing in the predicate may release a barrier, move the clock or change a crypto seam; a
   * predicate that has to cause the event it waits for cannot observe it.
   *
   * Omitted, `advance` waits for nothing and says so: there is no number of turns that proves a
   * void callback's asynchronous work finished.
   */
  settled?: () => boolean;
  /** What the timeout names, so a failure says which proof stage stalled. */
  label?: string;
  timeoutMs?: number;
}

export class FakeTimers {
  private current: number;
  private readonly armed = new Map<FakeTimerHandle, Armed>();
  private readonly realPerformance: Performance = globalThis.performance;
  private readonly realSetTimeout = globalThis.setTimeout;
  private readonly realClearTimeout = globalThis.clearTimeout;

  constructor() {
    // The relay only reads elapsed time from its own seat, so starting at zero is exact and
    // keeps every delay the test asserts on an integer.
    this.current = 0;
  }

  /** Installs the fake clock and timers in place of the process's own. */
  install(): void {
    const fake = Object.create(this.realPerformance) as Performance;
    Object.defineProperty(fake, 'now', { value: () => this.current, configurable: true });
    Object.defineProperty(globalThis, 'performance', {
      value: fake,
      configurable: true,
      writable: true,
    });
    globalThis.setTimeout = ((run: () => void, delay?: number) =>
      this.arm(run, delay)) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((handle?: FakeTimerHandle) => {
      if (handle !== undefined) {
        this.armed.delete(handle);
      }
    }) as unknown as typeof clearTimeout;
  }

  /** Puts the process's own clock and timers back. */
  restore(): void {
    Object.defineProperty(globalThis, 'performance', {
      value: this.realPerformance,
      configurable: true,
      writable: true,
    });
    globalThis.setTimeout = this.realSetTimeout;
    globalThis.clearTimeout = this.realClearTimeout;
  }

  /** The clock the relay reads, in the same domain it read before the fake was installed. */
  get now(): number {
    return this.current;
  }

  /**
   * How many timers are armed right now. A test that reads the earliest delay cannot see a timer
   * armed past it, so a leak is read here: the count a call leaves is the count it found, unless
   * it armed something.
   */
  get scheduled(): number {
    return this.armed.size;
  }

  /** The delay the earliest armed timer is due after the current clock, or `undefined`. */
  nextDelay(): number | undefined {
    let soonest: number | undefined;
    for (const { at } of this.armed.values()) {
      const delay = at - this.current;
      if (soonest === undefined || delay < soonest) {
        soonest = delay;
      }
    }
    return soonest;
  }

  /**
   * Runs every timer due within `ms`, each at its scheduled moment, and moves the clock to the
   * end of the span. A timer a callback arms synchronously inside the span runs too. Returns how
   * many ran.
   *
   * With `settled`, the wait after each callback is a bounded poll of that read-only predicate,
   * so a test that has one to observe — the attempt, the completion, the re-arm — gets each due
   * timer judged on work that finished rather than on a guess about how many turns it needed.
   */
  async advance(ms: number, options: AdvanceOptions = {}): Promise<number> {
    const target = this.current + ms;
    let ran = 0;
    for (;;) {
      const due = this.earliest(target);
      if (due === undefined) {
        break;
      }
      this.current = due.at;
      due.run();
      ran += 1;
      if (options.settled !== undefined) {
        await this.observe(options.settled, options.label ?? `the timer scheduled at ${due.at}`, options.timeoutMs);
      }
    }
    this.current = target;
    return ran;
  }

  private async observe(settled: () => boolean, label: string, timeoutMs?: number): Promise<void> {
    const bound = timeoutMs ?? WAIT_MS;
    const deadline = Date.now() + bound;
    for (;;) {
      if (settled()) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out after ${bound}ms waiting for ${label}`);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  private arm(run: () => void, delay = 0): FakeTimerHandle {
    const handle: FakeTimerHandle = { unref: () => {} };
    this.armed.set(handle, { at: this.current + Math.max(0, delay), run });
    return handle;
  }

  private earliest(limit: number): Armed | undefined {
    let best: (Armed & { handle: FakeTimerHandle }) | undefined;
    for (const [handle, armed] of this.armed) {
      if (armed.at > limit) {
        continue;
      }
      if (best === undefined || armed.at < best.at) {
        best = { ...armed, handle };
      }
    }
    if (best !== undefined) {
      this.armed.delete(best.handle);
    }
    return best;
  }
}
