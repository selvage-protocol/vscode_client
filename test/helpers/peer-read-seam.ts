/**
 * The adapter's own view of `node:fs/promises`, with three points where a test can land a rename
 * between a name being looked up and the step that uses it, and a fourth where it can land a write
 * between a descriptor being measured and the bytes being read through it.
 *
 * The read a peer asks for resolves each path component and holds the descriptor it found, so the
 * window a name can change in is *inside* one call and no second call of the test's can land in
 * it. `serve.test.ts` answers that by resolving `grant.ts`'s own `node:fs/promises` import to this
 * module, which hands the path to whatever an observer holds: after an `lstat` answered, after a
 * `readdir` answered, and just before an `open` resolves the name. A test swaps the name there and
 * the guard that refuses the swap is the one under test.
 *
 * The functions are the real ones, called through, so the adapter's reads are its own. A test that
 * swaps nothing gets the real `lstat`, `readdir` and `open`, and the real behaviour.
 */

import {
  lstat as realLstat,
  open as realOpen,
  readdir as realReaddir,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

let seen: ((path: string) => void) | undefined;
let listed: (() => void) | undefined;
let opening: ((path: string) => void) | undefined;
let measuring: ((path: string) => void) | undefined;

/** Runs `observer` on the path of every `lstat` once the lookup has answered; `undefined` clears it. */
export function afterLstat(observer: ((path: string) => void) | undefined): void {
  seen = observer;
}

/** Runs `observer` once every `readdir` has answered, where a name that appears after the listing lands. */
export function afterReaddir(observer: (() => void) | undefined): void {
  listed = observer;
}

/** Runs `observer` on the path of every `open` once the name is about to be resolved; `undefined` clears it. */
export function beforeOpen(observer: ((path: string) => void) | undefined): void {
  opening = observer;
}

/**
 * Runs `observer` on the path of every descriptor whose own `stat` has answered, which is where a
 * file's size is measured before the bytes are read through it; `undefined` clears it.
 */
export function afterStat(observer: ((path: string) => void) | undefined): void {
  measuring = observer;
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

/** The real `readdir`, with the observation point after it answered. */
export async function readdir(
  ...args: Parameters<typeof realReaddir>
): Promise<Awaited<ReturnType<typeof realReaddir>>> {
  const entries = await realReaddir(...args);
  listed?.();
  return entries;
}

/**
 * The real `open`, with the observation point before the name is resolved, and the descriptor's own
 * `stat` watched after the name resolved.
 */
export async function open(...args: Parameters<typeof realOpen>): Promise<FileHandle> {
  const path = String(args[0]);
  opening?.(path);
  const handle = await realOpen(...args);
  if (measuring === undefined) {
    return handle;
  }
  const stat = handle.stat.bind(handle) as (...rest: unknown[]) => Promise<unknown>;
  Object.assign(handle, {
    stat: async (...rest: unknown[]) => {
      const info = await stat(...rest);
      measuring?.(path);
      return info;
    },
  });
  return handle;
}
