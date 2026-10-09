/**
 * The adapter's own view of `node:fs/promises`, with one point where a test can observe a name
 * after it was looked up and before the step that uses it.
 *
 * The read a peer asks for resolves each path component and holds the descriptor it found, so the
 * window a name can change in is *inside* one call and no second call of the test's can land in
 * it. `serve.test.ts` answers that by resolving `grant.ts`'s own `node:fs/promises` import to this
 * module, which calls the real `lstat` and then hands the path to whatever `afterLstat` holds: a
 * test swaps the name there and the guard that refuses the swap is the one under test.
 *
 * Everything but `lstat` is the real thing, re-exported, so the adapter's other reads are
 * untouched. A test that swaps nothing gets the real `lstat` and the real behaviour.
 */

import { lstat as realLstat, open, readdir } from 'node:fs/promises';

export { open, readdir };

let seen: ((path: string) => void) | undefined;

/** Runs `observer` on the path of every `lstat` once the lookup has answered; `undefined` clears it. */
export function afterLstat(observer: ((path: string) => void) | undefined): void {
  seen = observer;
}

/** The real `lstat`, with the observation point after it. */
export async function lstat(
  path: Parameters<typeof realLstat>[0],
  options?: Parameters<typeof realLstat>[1],
): Promise<Awaited<ReturnType<typeof realLstat>>> {
  const info = await realLstat(path, options);
  seen?.(String(path));
  return info;
}
