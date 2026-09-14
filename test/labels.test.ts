/**
 * The label attachment, pinned.
 *
 * A peer's name is drawn by the editor out of one option object, and the whole difference
 * between a label that reads as an annotation, one that reads as the document's own text, and
 * nothing at all is which option object — if any — the editor is handed. Nothing else here can
 * see it: there is no editor in this suite, and the two-instance proof asserts that documents
 * converge, not that anything was painted.
 *
 * So this file pins the decision — that the default draws no name, that a drawn name is clipped
 * to a bound, and the exact option object each opt-in produces — and stops there. **The pixels
 * are not covered by any test in this repository**; the only check on how a floating label looks
 * is a person opening a real editor.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_LABEL_MODE, LABEL_LIMIT, boundedLabel, labelAttachment, labelMode } from '../src/adapter/labels.ts';

const CURSOR = { label: 'Ada', colour: '#e06c75' } as const;

/** A name long enough to be clipped, the shape the setting exists to keep out of the buffer. */
const LONG = 'justaverylongnvimuserhehehehehehehehe';

test('no name is drawn with the default setting', () => {
  // The whole point of the change: a window that is configured with nothing must not put a
  // peer-controlled string over the code. The caret, its hover and the status bar remain.
  assert.equal(DEFAULT_LABEL_MODE, 'none');
  assert.equal(labelMode(undefined), 'none');
  assert.equal(labelAttachment(CURSOR, 'none'), undefined);
});

test('a drawn name is clipped to the limit, with an ellipsis', () => {
  assert.equal(boundedLabel(LONG), `${LONG.slice(0, LABEL_LIMIT - 1)}\u2026`);
  assert.equal([...boundedLabel(LONG)].length, LABEL_LIMIT);
  assert.ok(boundedLabel(LONG).endsWith('\u2026'));
  // A name that already fits is left exactly as it is, ellipsis and all.
  assert.equal(boundedLabel('Ada'), 'Ada');
  assert.equal(boundedLabel('\u2026'), '\u2026');
  // Both drawn modes carry the clipped text, so neither can be a way around the bound.
  assert.equal(labelAttachment({ ...CURSOR, label: LONG }, 'floating')?.contentText, boundedLabel(LONG));
  assert.equal(labelAttachment({ ...CURSOR, label: LONG }, 'chip')?.contentText, ` ${boundedLabel(LONG)} `);
});

test('the clip is by code point, never through a surrogate pair', () => {
  // A name is peer-controlled and may hold astral characters. Clipping by UTF-16 unit could
  // leave half of a surrogate pair, which is a lone surrogate in the string: text no editor
  // can draw and no strict JSON consumer accepts.
  const emoji = '\u{1F600}'.repeat(LABEL_LIMIT + 4);
  const clipped = boundedLabel(emoji);
  assert.equal([...clipped].length, LABEL_LIMIT);
  assert.ok(!clipped.includes('\uFFFD'));
  for (let index = 0; index < clipped.length; index += 1) {
    const unit = clipped.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = clipped.charCodeAt(index + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff, 'a high surrogate was left without its low half');
      index += 1;
    } else {
      assert.ok(unit < 0xdc00 || unit > 0xdfff, 'a low surrogate was left without its high half');
    }
  }
});

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

test('the setting selects the mode, and nothing but the two opt-ins draws a name', () => {
  assert.equal(labelMode('chip'), 'chip');
  assert.equal(labelMode('floating'), 'floating');
  assert.equal(labelMode('none'), 'none');
  // Anything unrecognised is the default, and the default draws nothing.
  assert.equal(labelMode(undefined), DEFAULT_LABEL_MODE);
  assert.equal(labelMode('nonsense'), DEFAULT_LABEL_MODE);
  assert.equal(DEFAULT_LABEL_MODE, 'none');
});
