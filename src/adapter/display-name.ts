/**
 * The display name: the bound the protocol puts on one, and the question that asks for one.
 *
 * A name is at most 32 **UTF-16 code units** — the protocol's unit, so an astral character
 * costs two — and a name over that bound is *refused*, never truncated: a name must be the one
 * its owner chose. The server refuses the `session.hello` an over-long name would arrive in, so
 * the refusal has to happen here, before it is typed, rather than as a round trip afterwards.
 *
 * There are exactly three places a name can come from, and all three check it: the
 * `selvage.displayName` setting, the question a host or join asks, and the value about to be
 * handed to `SelvageEngine.host`/`join` — which is the only thing that carries a name anywhere
 * (`PROTOCOL.md` §5).
 *
 * The counting is `String.prototype.length`, which *is* the number of UTF-16 code units.
 * `[...name].length` is the number of code points and is wrong here: an emoji would cost one
 * where the room charges two. `test/display-name.test.ts` pins the difference with one.
 *
 * This module imports `vscode` for its types alone, so a test can reach it with no editor.
 */

import type { InputBoxOptions } from 'vscode';

import { MAX_DISPLAY_NAME_UNITS } from '../engine/envelope.ts';

export { MAX_DISPLAY_NAME_UNITS };

/** How many UTF-16 code units a name costs: two for an astral character, one for the rest. */
export function displayNameUnits(name: string): number {
  return name.length;
}

/**
 * Why this name cannot be sent, or `undefined` when it can. The name is trimmed first, so the
 * count is the count of what would go on the wire, and the over-long reason names both counts —
 * the units used and the units allowed — because a refusal that does not say why is a bug report
 * waiting to happen. Both reasons are whole sentences, the ones the Neovim client sends, so the
 * two clients refuse a name in the same words.
 */
export function displayNameRefusal(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed === '') {
    return 'a name is needed.';
  }
  const units = displayNameUnits(trimmed);
  if (units > MAX_DISPLAY_NAME_UNITS) {
    return `this name is ${units} UTF-16 code units and the limit is ${MAX_DISPLAY_NAME_UNITS}; a name is refused rather than shortened.`;
  }
  return undefined;
}

/**
 * The question that asks for one, as `showInputBox` options.
 *
 * The bound is in the `prompt`, before anything is typed, in plain words — the refusal behind
 * `validateInput` still names the protocol's unit, because that sentence is shared with the
 * sibling client and has to say what the room charges. `value` is what the box starts with,
 * and `current`, when given, is the name in force: the entry point reports it, which is what
 * `:SelvageDisplayName` without a name does.
 */
export function displayNameInput(options: {
  title: string;
  value: string;
  current?: string;
}): InputBoxOptions {
  const reported =
    options.current === undefined || options.current === ''
      ? ''
      : ` The name others see is "${options.current}".`;
  return {
    title: options.title,
    prompt: `At most ${MAX_DISPLAY_NAME_UNITS} characters; some emoji and accented characters count as more than one.${reported}`,
    value: options.value,
    ignoreFocusOut: true,
    validateInput: (value: string) => displayNameRefusal(value),
  };
}
