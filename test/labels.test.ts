/**
 * The label attachment, pinned.
 *
 * A peer's name is drawn by the editor out of one option object, and the whole difference
 * between a label that reads as an annotation and one that reads as the document's own text is
 * whether that object carries declarations the decoration API has no fields for. Nothing else
 * here can see it: there is no editor in this suite, and the two-instance proof asserts that
 * documents converge, not that anything was painted.
 *
 * So this file pins the object — the exact strings, for both modes, and which setting value
 * selects which — and stops there. **The pixels are not covered by any test in this
 * repository**; the only check on how the floating label looks is a person opening a real
 * editor.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_LABEL_MODE, labelAttachment, labelMode } from '../src/adapter/labels.ts';

const CURSOR = { label: 'Ada', colour: '#e06c75' } as const;

test('the floating label carries the declarations that lift it out of the line', () => {
  assert.deepEqual(labelAttachment(CURSOR, 'floating'), {
    contentText: 'Ada',
    backgroundColor: '#e06c75',
    color: '#000000',
    // Everything below `none;` rides a field documented as one CSS declaration; dropping it
    // silently puts the label back in the line, which is what this assertion is for.
    textDecoration:
      'none; position: absolute; display: inline-block; z-index: 10; pointer-events: none; ' +
      'font-size: 0.7em; font-weight: bold; border-radius: 0.15rem; padding: 0 0.5ch; ' +
      'top: -1.3em;',
  });
});

test('the floating declarations begin by closing the declaration the field is meant to be', () => {
  // The value is substituted into `text-decoration:{0};`, so a string that does not lead with
  // a complete declaration makes the whole rule invalid and the label loses its box.
  const declarations = labelAttachment(CURSOR, 'floating').textDecoration ?? '';
  assert.ok(
    declarations.startsWith('none; '),
    `textDecoration must start with a whole declaration, got: ${declarations}`,
  );
  for (const needed of ['position: absolute', 'top:', 'pointer-events: none']) {
    assert.ok(declarations.includes(needed), `the floating label no longer sets ${needed}`);
  }
});

test('the chip is documented fields only', () => {
  assert.deepEqual(labelAttachment(CURSOR, 'chip'), {
    contentText: ' Ada ',
    backgroundColor: '#e06c75',
    color: '#000000',
    fontWeight: 'bold',
    border: '1px solid #000000',
    margin: '0 0.4ch',
  });
  // The fallback's whole point: if the undocumented route stops working, this mode is what is
  // left, so it must not carry any of it.
  assert.equal(
    labelAttachment(CURSOR, 'chip').textDecoration,
    undefined,
    'the chip smuggles declarations after all',
  );
});

test('the setting selects the mode, and anything unrecognised is the floating label', () => {
  assert.equal(labelMode('chip'), 'chip');
  assert.equal(labelMode('floating'), 'floating');
  assert.equal(labelMode(undefined), DEFAULT_LABEL_MODE);
  assert.equal(labelMode('nonsense'), DEFAULT_LABEL_MODE);
  assert.equal(DEFAULT_LABEL_MODE, 'floating');
});
