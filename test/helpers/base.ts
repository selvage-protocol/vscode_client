/**
 * A normalised session base for a test, through the engine's own reading of one.
 *
 * `SessionBase` is produced only by `sessionBase`, so a test that needs a base calls this
 * rather than asserting the brand away: a literal the engine would refuse fails the test
 * where it is written, with the text that was refused.
 */

import { sessionBase } from '../../src/engine/urls.ts';
import type { SessionBase } from '../../src/engine/urls.ts';

export function baseOf(text: string): SessionBase {
  const base = sessionBase(text);
  if (base === undefined) {
    throw new Error(`not a session base: ${text}`);
  }
  return base;
}
