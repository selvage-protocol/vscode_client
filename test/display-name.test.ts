/**
 * The display-name bound, pinned.
 *
 * A name is at most 32 UTF-16 code units — the protocol's unit, so an astral character costs
 * two — and the counting is `String.prototype.length`, which is exactly that number.
 * `[...name].length` counts code points and agrees with it for everything except an astral
 * character, which it calls one where the room charges two; the emoji below is the case that
 * separates the two, and it is the reason this file exists.
 *
 * A name over the bound is refused, never truncated, and the refusal names both counts. What the
 * question *looks* like is not covered by anything in this repository — there is no editor here —
 * so what is pinned is the option object it hands to `showInputBox`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_DISPLAY_NAME_UNITS,
  displayNameInput,
  displayNameRefusal,
  displayNameUnits,
} from '../src/adapter/display-name.ts';

/** An astral character: one code point, two UTF-16 code units, two of the protocol's units. */
const EMOJI = '\u{1f600}';

test('a display name is counted in UTF-16 code units, so an astral character costs two', () => {
  assert.equal(MAX_DISPLAY_NAME_UNITS, 32);
  assert.equal(displayNameUnits('Ada'), 3);
  assert.equal(displayNameUnits(EMOJI), 2);
  assert.equal([...EMOJI].length, 1, 'the emoji is one code point; the room charges two units');
  assert.notEqual(displayNameUnits(EMOJI), [...EMOJI].length);

  // The neighbouring cases, because "code units" is only right if it is right for these too: a
  // combining mark is a code unit of its own, and a lone surrogate is one, not half of a pair.
  assert.equal(displayNameUnits('e\u0301'), 2);
  assert.equal(displayNameUnits('\ud83d'), 1);
  assert.equal(displayNameUnits(''), 0);
});

test('a name at the bound is accepted and one unit over it is refused', () => {
  const exact = 'a'.repeat(MAX_DISPLAY_NAME_UNITS);
  assert.equal(displayNameRefusal(exact), undefined);

  const refusal = displayNameRefusal(`${exact}b`);
  assert.equal(
    refusal,
    'this name is 33 UTF-16 code units and the limit is 32; a name is refused rather than shortened.',
    'the refusal is not the sentence the Neovim client sends',
  );
});

test('the count is the units the room charges, not the number of characters typed', () => {
  // 31 ASCII characters and one astral character: 32 code points, 33 UTF-16 code units.
  const name = `${'a'.repeat(31)}${EMOJI}`;
  assert.equal([...name].length, 32, 'by code point this name is exactly at the bound…');
  assert.equal(displayNameUnits(name), 33, '…and by the protocol’s unit it is over it');

  const refusal = displayNameRefusal(name);
  assert.ok(refusal !== undefined, 'a name the protocol refuses was accepted here');
  assert.match(refusal, /33 UTF-16 code units/);

  // One code point shorter is inside the bound, so the difference is the counting and not a
  // blanket refusal of astral characters.
  assert.equal(displayNameRefusal(`${'a'.repeat(30)}${EMOJI}`), undefined);
});

test('a blank name is refused before it is sent', () => {
  assert.equal(displayNameRefusal(''), 'a name is needed.');
  assert.equal(displayNameRefusal('   '), 'a name is needed.');
  // Trimmed before it is counted, so the spaces around a name are not part of what it costs.
  assert.equal(displayNameRefusal(' Ada '), undefined);
  assert.match(displayNameRefusal(` ${'a'.repeat(33)} `) ?? '', /33 UTF-16 code units/);
});

test('the question states the bound and refuses an over-long answer while it is typed', () => {
  const options = displayNameInput({ title: 't', value: 'Ada', current: 'Ada' });
  assert.match(options.prompt ?? '', /At most 32 characters/);
  assert.match(options.prompt ?? '', /some emoji and accented characters count as more than one/);
  assert.doesNotMatch(options.prompt ?? '', /UTF-16/);
  assert.match(options.prompt ?? '', /The name others see is "Ada"/);
  assert.equal(options.value, 'Ada');
  assert.equal(options.ignoreFocusOut, true);

  const validate = options.validateInput as (value: string) => string | undefined;
  assert.equal(validate('Ada'), undefined);
  assert.equal(validate('a'.repeat(MAX_DISPLAY_NAME_UNITS)), undefined);
  assert.match(validate('a'.repeat(33)) ?? '', /33 UTF-16 code units/);
  assert.match(validate(EMOJI.repeat(17)) ?? '', /34 UTF-16 code units/);
  // A flag is one displayed character and four of the room's units: the prompt must not
  // promise that every emoji costs two.
  assert.match(validate(`${'a'.repeat(29)}\u{1f1fa}\u{1f1f8}`) ?? '', /33 UTF-16 code units/);
  // Enter cannot accept a refusal: what comes back is a message and the box stays open.
  assert.match(validate('   ') ?? '', /a name is needed/);
});

test('a question with no name in force reports nothing about one', () => {
  const options = displayNameInput({ title: 't', value: '' });
  assert.match(options.prompt ?? '', /At most 32 characters/);
  assert.doesNotMatch(options.prompt ?? '', /UTF-16/);
  assert.doesNotMatch(options.prompt ?? '', /The name others see is/);
});
