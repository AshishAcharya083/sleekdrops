import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dailyDeals } from './deals.ts';
import { badgeProblems } from '../lib/trust.ts';

test('every deal badge is a registry badge that would print as entered', () => {
  // Deals are code-as-data, so this is where a malformed or switched-off
  // badge is caught before deploy rather than silently dropped from the card.
  for (const deal of dailyDeals) {
    if (deal.badge === undefined) continue;
    assert.deepEqual(badgeProblems(deal.badge), [], `deal "${deal.slug}"`);
  }
});
