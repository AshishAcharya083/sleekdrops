import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cardClickProps, listViewProps } from './listing.ts';
import { scrub } from './pii.ts';

test('a list view reports the list, the cards rendered, and where in the list they are', () => {
  assert.deepEqual(listViewProps({ listId: 'deals-index', count: 12, page: 2, batch: 1 }), {
    list_id: 'deals-index',
    count: 12,
    page: 2,
    batch: 1,
  });
});

test('an unpaginated listing is page 1, batch 0 - never an absent dimension', () => {
  // Pagination rides on this event instead of being an event stream of its own,
  // so the two properties have to be present on every row for the comparison
  // "page 1 versus deeper" to be answerable at all.
  assert.deepEqual(listViewProps({ listId: 'promos-index', count: 0 }), {
    list_id: 'promos-index',
    count: 0,
    page: 1,
    batch: 0,
  });
});

test('nonsense counts and page numbers are clamped rather than reported', () => {
  assert.deepEqual(listViewProps({ listId: 'home-deals', count: -3, page: 0, batch: 1.5 }), {
    list_id: 'home-deals',
    count: 0,
    page: 1,
    batch: 0,
  });
});

test('a card click carries the same list id as its list view, plus its slot', () => {
  const view = listViewProps({ listId: 'deals-index', count: 3 });
  const click = cardClickProps({
    listId: 'deals-index',
    slug: 'ninja-blast',
    brand: 'Ninja',
    placement: 'deal-card',
    position: 2,
  });
  assert.deepEqual(click, {
    slug: 'ninja-blast',
    brand: 'Ninja',
    placement: 'deal-card',
    position: 2,
    list_id: 'deals-index',
  });
  // The join that makes click-through rate per card and per slot computable.
  assert.equal(click.list_id, view.list_id);
});

test('the first card is position 0, not 1', () => {
  const first = cardClickProps({
    listId: 'promos-index',
    slug: 'brand-15',
    brand: 'Brand',
    placement: 'promo-card',
    position: 0,
  });
  assert.equal(first.position, 0);
});

test('every listing property survives the scrub chokepoint unchanged', () => {
  // A dimension silently dropped at the chokepoint is a dimension that reads as
  // absent in the Analytics tab while the code looks correct.
  const view = listViewProps({ listId: 'home-deals', count: 3, page: 1, batch: 0 });
  assert.deepEqual(scrub(view), view);

  const click = cardClickProps({
    listId: 'home-deals',
    slug: 'ninja-blast',
    brand: 'Ninja',
    placement: 'deal-card',
    position: 1,
  });
  assert.deepEqual(scrub(click), click);
});
