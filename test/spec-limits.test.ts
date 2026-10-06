/**
 * The specification's own numbers, read rather than remembered.
 *
 * `specification/schema/limits.json` publishes the numeric bounds the protocol owns, one entry
 * each with the unit the document writes and the section that owns it, and it is vendored at
 * `test/fixtures/limits.json` — the copy check compares the two, and this suite is what makes a
 * drift a red test in between the checks. The engine's constants are the ones a frame is
 * actually held to, so a number that moved in the specification and not here would be enforced
 * as the old one with nothing to say so.
 *
 * The file is read, never restated: a copy of `32` in this suite would drift exactly like the
 * constants it is meant to pin. A missing file or a missing entry is a failure with the name in
 * it, never a skip and never a default.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { MAX_GRANT_PATH_BYTES } from '../src/bridge/grant.ts';
import { MAX_DISPLAY_NAME_UNITS, close } from '../src/engine/envelope.ts';
import { MAX_LISTING_BYTES, MAX_LISTING_PATHS } from '../src/engine/limits.ts';
import { MAX_PATH_BYTES } from '../src/engine/sealed.ts';

/** One bound as `schema/limits.json` carries it. */
interface SpecLimit {
  name: string;
  value: number;
  unit: string;
  section: string;
}

const VENDORED = resolve(import.meta.dirname, 'fixtures', 'limits.json');

const MIB = 1024 * 1024;

/**
 * The vendored bounds by name. Throws when the file is not there — `readFileSync`'s own error
 * names the path — and when it carries no `limits` array, so a check that reached nothing
 * cannot report clean.
 */
function readLimits(location: string = VENDORED): Map<string, SpecLimit> {
  const parsed = JSON.parse(readFileSync(location, 'utf8')) as { limits?: SpecLimit[] };
  assert.ok(Array.isArray(parsed.limits), `${location} carries no \`limits\` array`);
  return new Map(parsed.limits.map((entry) => [entry.name, entry]));
}

function entry(limits: Map<string, SpecLimit>, name: string): SpecLimit {
  const found = limits.get(name);
  assert.ok(found !== undefined, `the specification publishes no \`${name}\` bound`);
  assert.equal(typeof found.value, 'number', `\`${name}\` is published without a number`);
  return found;
}

/** A bound's value in the unit its entry declares, refusing an entry published in another one. */
function valueIn(limits: Map<string, SpecLimit>, name: string, unit: string): number {
  const found = entry(limits, name);
  assert.equal(found.unit, unit, `\`${name}\` is published in ${found.unit}, not ${unit}`);
  return found.value;
}

/** A bound published in MiB, as the bytes the engine counts in. */
function valueInMiB(limits: Map<string, SpecLimit>, name: string): number {
  return valueIn(limits, name, 'MiB') * MIB;
}

test('a listing is held to the bounds the specification publishes', () => {
  const limits = readLimits();
  assert.equal(MAX_LISTING_PATHS, valueIn(limits, 'listing_paths', 'paths'));
  assert.equal(MAX_LISTING_BYTES, valueInMiB(limits, 'listing_path_bytes_total'));
});

test('one path is held to the specification\'s byte bound', () => {
  const limits = readLimits();
  assert.equal(MAX_PATH_BYTES, valueIn(limits, 'listing_path_bytes', 'bytes'));
  // The grant keeps a second literal for the same bound, and this is where the two are held
  // together: a listing that refused at one and accepted at the other would cut a path in
  // silence.
  assert.equal(MAX_GRANT_PATH_BYTES, MAX_PATH_BYTES, 'the grant keeps a second path-byte bound');
});

test('a display name is held to the specification\'s length bound', () => {
  const limits = readLimits();
  assert.equal(MAX_DISPLAY_NAME_UNITS, valueIn(limits, 'display_name_length', 'UTF-16 code units'));
});

test('the close codes are the specification\'s, inside its range', () => {
  const limits = readLimits();
  const lowest = valueIn(limits, 'close_code_min', 'close code');
  const highest = valueIn(limits, 'close_code_max', 'close code');
  assert.ok(lowest <= highest, `the specification's close range runs ${lowest} to ${highest}`);
  assert.equal(close.protocolError, lowest, 'the protocol\'s own close is not the lowest code');
  assert.equal(close.roomGone, highest, 'the last refusal is not the highest code');
  for (const [name, number] of Object.entries(close)) {
    assert.ok(
      number >= lowest && number <= highest,
      `\`close.${name}\` (${number}) is outside ${lowest}–${highest}`,
    );
  }
});

test('a missing file or entry fails by name, not by default', () => {
  const limits = readLimits();
  assert.ok(limits.size > 0, 'the vendored file names no bound at all');
  assert.throws(
    () => entry(limits, 'no_such_bound'),
    /publishes no `no_such_bound` bound/,
    'an entry that is not there is read as one that is',
  );
  assert.throws(
    () => readLimits(resolve(import.meta.dirname, 'fixtures', 'no-such-limits.json')),
    /ENOENT/,
    'a file that is not there is read as an empty set of bounds',
  );
});
