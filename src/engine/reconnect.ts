/**
 * The bounded reconnect policy both wire versions share (`PROTOCOL.md` §9.1).
 *
 * §9.1 asks for the *shape* and not the numbers: a retry **MUST** be bounded, giving up **MUST**
 * be observable, a refusal **MUST NOT** be retried, and a client that knows the room's grace
 * **SHOULD** keep retrying at least until that window has passed. Both engines keep that shape,
 * and both size the attempt budget from the advertised grace the same way; the version-1 engine
 * (`engine.ts`) and the version-2 relay (`relay.ts`) read the same policy from here so the two
 * cannot drift.
 */

/** Bounded reconnect (spec §9.1): a dropped socket is re-helloed, under a new peer identity. */
export interface ReconnectPolicy {
  enabled: boolean;
  initialDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
}

/**
 * The reference client's numbers, which §9.1 calls policy rather than wire: 500 ms doubling to a
 * 10 s ceiling, five attempts. Seven attempts, ≈35 s, is what `attemptsForGrace` derives for the
 * 30 s default grace below, and these five are what a server that advertises no grace gets.
 */
export const DEFAULT_RECONNECT: ReconnectPolicy = {
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  maxAttempts: 5,
};

/**
 * The most attempts a grace-derived budget asks for: an hour of the default backoff. A retry
 * loop has to end, and a server that advertises a grace past this one is advertising a window
 * the client does not keep retrying through — the budget is capped rather than unbounded, which
 * is the shape §9.1 fixes for every policy.
 */
export const MAX_GRACE_ATTEMPTS = 360;

/**
 * How many attempts a policy needs before the wait in front of them adds up to `graceMs`
 * (§9.1). The grace is the room's own deadline and the backoff is what the policy fixes, so
 * this is the count of delays whose sum first reaches it; the count is capped, so a policy
 * with a tiny delay cannot turn a large advertised grace into an unbounded loop.
 */
export function attemptsForGrace(graceMs: number, policy: ReconnectPolicy): number {
  const initial = Math.max(policy.initialDelayMs, 1);
  const ceiling = Math.max(policy.maxDelayMs, 1);
  let waited = 0;
  let attempts = 0;
  while (waited < graceMs && attempts < MAX_GRACE_ATTEMPTS) {
    waited += Math.min(initial * 2 ** attempts, ceiling);
    attempts += 1;
  }
  return attempts;
}
