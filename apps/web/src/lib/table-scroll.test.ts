/**
 * The wide-table scroll rule. Worth testing as a rule because both failure
 * modes are silent: a table clipped mid-column with no hint reads as a broken
 * table, and a hint under a table that fits reads as a broken hint.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OVERFLOW_TOLERANCE, TABLE_SCROLL_HINT, overflowsSideways } from './table-scroll.ts';

test('a table wider than its column overflows', () => {
  assert.equal(overflowsSideways(820, 390), true);
  assert.equal(overflowsSideways(760, 692), true);
});

test('a table that fits its column does not', () => {
  assert.equal(overflowsSideways(600, 600), false);
  assert.equal(overflowsSideways(400, 692), false);
});

test('sub-pixel rounding does not raise a hint', () => {
  // Both widths are rounded independently, so an exactly-fitting table can
  // report a pixel of overflow it does not have.
  assert.equal(overflowsSideways(691 + OVERFLOW_TOLERANCE, 691), false);
  assert.equal(overflowsSideways(691 + OVERFLOW_TOLERANCE + 1, 691), true);
});

test('an unmeasurable table raises no hint', () => {
  // A detached or display:none table reports zeroes, and jsdom-free callers can
  // hand over NaN; neither is evidence of anything to scroll to.
  assert.equal(overflowsSideways(0, 0), false);
  assert.equal(overflowsSideways(Number.NaN, 390), false);
  assert.equal(overflowsSideways(820, Number.NaN), false);
});

test('the hint names the gesture and the thing it applies to', () => {
  assert.match(TABLE_SCROLL_HINT, /sideways/i);
  assert.match(TABLE_SCROLL_HINT, /table/i);
});
