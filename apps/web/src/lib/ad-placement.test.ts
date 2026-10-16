/**
 * The ad placement rules - which block the mid-article unit goes before, which
 * cell the in-feed unit takes, and when a body is too thin to carry one at all.
 *
 * Worth testing as rules rather than as rendering because both failure modes are
 * silent and expensive: a unit placed two blocks from the end is an "in-article"
 * impression competing with the end-of-article one for the same reader, and a
 * unit dropped into a four-paragraph post is the content-to-ads ratio that
 * AdSense actions a site for. Neither looks wrong in a browser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_ARTICLE_BLOCKS,
  MIN_FEED_CARDS,
  inFeedIndex,
  midArticleIndex,
} from './ad-placement.ts';

/** A body of `count` blocks with `h2`s at the given indices. */
function body(count: number, headings: number[] = []): string[] {
  return Array.from({ length: count }, (_, i) => (headings.includes(i) ? 'h2' : 'p'));
}

test('a short article carries no mid unit at all', () => {
  for (let count = 0; count < MIN_ARTICLE_BLOCKS; count++) {
    assert.equal(midArticleIndex(body(count)), null, `${count} blocks must not be broken`);
  }
  // And the threshold itself does place one, so the guard is a floor and not a
  // rule that happens to reject everything.
  assert.notEqual(midArticleIndex(body(MIN_ARTICLE_BLOCKS)), null);
});

test('the mid unit lands on the section break nearest the middle', () => {
  // Headings at 1, 5 and 9 of twelve blocks (midpoint 6). 1 is an ad one
  // paragraph in; 9 is three-quarters down, already the end unit's reader. 5 is
  // the break a reader experiences as the middle of the piece.
  assert.equal(midArticleIndex(body(12, [1, 5, 9])), 5);
});

test('the nearest break is taken even when it sits above the midpoint', () => {
  // The trap in "first heading past halfway": with the only back-half heading at
  // three-quarters, that rule walks past a break one block above the midpoint to
  // reach it. Distance decides, not direction.
  assert.equal(midArticleIndex(body(20, [9, 15])), 9);
});

test('a heading too close to either end is not used', () => {
  // The only heading is the last block - taking it would put the "mid-article"
  // unit directly above the end-of-article one.
  const placed = midArticleIndex(body(10, [9]));
  assert.notEqual(placed, 9);
  assert.ok(placed !== null && placed >= 2 && placed <= 8);
});

test('an article with no section break still places the unit mid-body', () => {
  // Unbroken prose - a single-section explainer. There is no break to land on,
  // so the midpoint is used rather than the unit being dropped.
  assert.equal(midArticleIndex(body(10)), 5);
  assert.equal(midArticleIndex(body(9)), 5);
});

test('the mid unit always has content above and below it', () => {
  // The property that matters, asserted across shapes rather than at one size:
  // an ad at index 0 is an ad above the article, and one at the last index is
  // the end-of-article slot wearing the wrong name.
  for (let count = MIN_ARTICLE_BLOCKS; count <= 40; count++) {
    for (const headings of [[], [0], [1], [count - 1], [2, count - 2], [0, 1, 2]]) {
      const index = midArticleIndex(body(count, headings));
      assert.ok(index !== null, `${count} blocks should place a unit`);
      assert.ok(index >= 2, `index ${index} leaves no content above it (${count} blocks)`);
      assert.ok(index <= count - 2, `index ${index} leaves no content below it (${count} blocks)`);
    }
  }
});

test('a small grid keeps every cell for content', () => {
  for (let count = 0; count < MIN_FEED_CARDS; count++) {
    assert.equal(inFeedIndex(count), null, `${count} cards must not give one away`);
  }
  assert.notEqual(inFeedIndex(MIN_FEED_CARDS), null);
});

test('the in-feed unit opens the second row rather than interrupting the first', () => {
  // Three cards across at desktop, so index 3 is the first cell of row two.
  assert.equal(inFeedIndex(9), 3);
  assert.equal(inFeedIndex(4), 3);
});

test('the in-feed index is always a real cell in the grid', () => {
  for (let count = MIN_FEED_CARDS; count <= 60; count++) {
    const index = inFeedIndex(count);
    assert.ok(index !== null && index >= 0 && index <= count, `index ${index} of ${count}`);
  }
});
