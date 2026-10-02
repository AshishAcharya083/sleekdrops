import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brandSuppliedCount, scoreSummary } from './about-stats.ts';

test('the average score is counted from the scored posts, with how many there are', () => {
  const summary = scoreSummary([
    { product: { rating: 4.4 } },
    { product: { rating: 3.9 } },
    { product: { rating: 4.8 } },
    {},
  ]);
  assert.deepEqual(summary, { scored: 3, average: 4.4 });
});

test('the average is given to one decimal place, as scores are', () => {
  const summary = scoreSummary([{ product: { rating: 4.0 } }, { product: { rating: 4.1 } }, { product: { rating: 4.1 } }]);
  assert.deepEqual(summary, { scored: 3, average: 4.1 });
});

test('with nothing scored there is no average to print', () => {
  assert.equal(scoreSummary([]), null);
  assert.equal(scoreSummary([{}, { reviewUnit: { acquisition: 'none' } }]), null);
});

test('a loaned unit and a brand sample both count as brand-supplied', () => {
  assert.equal(
    brandSuppliedCount([
      { reviewUnit: { acquisition: 'loan' } },
      { provenance: 'brand-sample' },
      { reviewUnit: { acquisition: 'retail' } },
      { reviewUnit: { acquisition: 'none' } },
      { provenance: 'not-hands-on' },
      { provenance: 'retail' },
      {},
    ]),
    2,
  );
});

test('a post recording both a loan and a brand sample is one product, counted once', () => {
  assert.equal(brandSuppliedCount([{ reviewUnit: { acquisition: 'loan' }, provenance: 'brand-sample' }]), 1);
});
