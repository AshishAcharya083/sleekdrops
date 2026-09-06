import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ANCHOR_SCROLL_EPSILON,
  ANCHOR_SCROLL_OFFSET,
  resolveAnchorScrollTop,
} from './anchor-scroll.ts';

/** A tall document, so nothing in these cases is clamped by the page end. */
const TALL_PAGE = { maxScrollY: 10_000 };

test('an off-screen target scrolls to sit below the fixed header', () => {
  assert.equal(
    resolveAnchorScrollTop({ targetTop: 2400, scrollY: 0, ...TALL_PAGE }),
    2400 - ANCHOR_SCROLL_OFFSET,
  );
});

test('a target already on screen but a real distance away still scrolls', () => {
  // The article-TOC regression: a heading at 400px down an 800px viewport is
  // fully visible, and clicking its TOC entry must still bring it to the top of
  // the reading area rather than only flashing an outline.
  const scrollY = 1000;
  const targetTop = scrollY + 400;
  assert.equal(
    resolveAnchorScrollTop({ targetTop, scrollY, ...TALL_PAGE }),
    targetTop - ANCHOR_SCROLL_OFFSET,
  );
});

test('a target just under the header scrolls up to clear it', () => {
  const scrollY = 1000;
  assert.equal(
    resolveAnchorScrollTop({ targetTop: scrollY + 40, scrollY, ...TALL_PAGE }),
    scrollY + 40 - ANCHOR_SCROLL_OFFSET,
  );
});

test('a target already at the landing position asks for no scroll', () => {
  assert.equal(
    resolveAnchorScrollTop({ targetTop: 1090, scrollY: 1000, ...TALL_PAGE }),
    null,
  );
});

test('sub-pixel layout rounding counts as landed, a perceptible gap does not', () => {
  const settled = ANCHOR_SCROLL_EPSILON - 1;
  assert.equal(
    resolveAnchorScrollTop({ targetTop: 1090 + settled, scrollY: 1000, ...TALL_PAGE }),
    null,
  );
  assert.notEqual(
    resolveAnchorScrollTop({
      targetTop: 1090 + ANCHOR_SCROLL_EPSILON,
      scrollY: 1000,
      ...TALL_PAGE,
    }),
    null,
  );
});

test('a target near the top of the document never asks to scroll above it', () => {
  // offsetTop - offset is negative here; the browser would clamp it to 0 anyway,
  // and at scrollY 0 that is a scroll of no distance at all.
  assert.equal(resolveAnchorScrollTop({ targetTop: 40, scrollY: 0, ...TALL_PAGE }), null);
  assert.equal(resolveAnchorScrollTop({ targetTop: 40, scrollY: 600, ...TALL_PAGE }), 0);
});

test('a target the page cannot lift any higher reports landed at the page end', () => {
  // The last section of an article: the document has no more scroll to give, so
  // requesting one would be the zero-distance scroll the flash exists to replace.
  const maxScrollY = 1500;
  assert.equal(resolveAnchorScrollTop({ targetTop: 2400, scrollY: maxScrollY, maxScrollY }), null);
  assert.equal(resolveAnchorScrollTop({ targetTop: 2400, scrollY: 0, maxScrollY }), maxScrollY);
});

test('a document too short to scroll always reports landed', () => {
  assert.equal(resolveAnchorScrollTop({ targetTop: 500, scrollY: 0, maxScrollY: -100 }), null);
});
