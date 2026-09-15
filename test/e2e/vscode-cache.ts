/**
 * Where the pinned VS Code build is downloaded to, and how a fresh worktree shares the cache the
 * checkout beside it already has.
 *
 * `.tmp/` is ignored, so it does not survive into a new worktree at all: without this, the first
 * run there downloads 327 MB the checkout next door is holding, which is minutes and a network
 * round trip for a build that is already on disk. It is not committed either way — the link, like
 * the cache, lives in `.tmp/`, and is made by the first run that needs it.
 */

import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

/** A worktree of a repository is `<checkout>/.worktrees/<name>`; the checkout is the one whose
 * cache is worth sharing, and a checkout that is not in one is left alone. */
const WORKTREES_DIR = '.worktrees';
const CACHE_DIR = 'vscode-test';

/** The cache directory to hand `@vscode/test-electron`, created if it is not there yet. */
export function ensureVscodeCache(root: string): string {
  const cache = resolve(root, '.tmp', CACHE_DIR);
  if (existsSync(cache)) {
    return cache;
  }
  // A link someone made by hand whose far end is gone still occupies the name; it is a broken
  // link or nothing at all here, so clearing it costs nothing that could be downloaded into.
  rmSync(cache, { force: true });
  mkdirSync(dirname(cache), { recursive: true });
  const inWorktree = basename(dirname(root)) === WORKTREES_DIR;
  const checkoutCache = resolve(root, '..', '..', '.tmp', CACHE_DIR);
  if (inWorktree && existsSync(checkoutCache)) {
    try {
      symlinkSync(checkoutCache, cache, 'dir');
      return cache;
    } catch {
      // A link that cannot be made — another filesystem, no permission — is not worth a failed
      // run: fall back to downloading here.
    }
  }
  mkdirSync(cache, { recursive: true });
  return cache;
}
