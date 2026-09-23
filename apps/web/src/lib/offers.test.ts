/**
 * What the page says about a price nobody is polling.
 *
 * The rule under test is the honest one: a figure is only ever presented as
 * live when something is actually keeping it live. A hand-entered price never
 * is, and a fed one stops being so once its observation ages out - and the
 * site is rebuilt on its own schedule, so that ageing has to be measured at
 * render time rather than trusted from the build that stamped it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { offerIsDated, offerPresentation, STALE_PRICE_DAYS } from './offers.ts';
import type { PickOfferData } from '../content/frontmatter.ts';

const TODAY = new Date('2026-09-18T00:00:00Z');

function offer(overrides: Partial<PickOfferData> = {}): PickOfferData {
  return {
    price: 'A$1,699',
    currency: 'AUD',
    asAt: '2026-09-18',
    source: 'editor',
    stale: true,
    merchant: 'JB Hi-Fi',
    ...overrides,
  };
}

test('a hand-entered price is quoted as a dated RRP, never as a live price', () => {
  const view = offerPresentation(offer(), TODAY);
  assert.equal(view.dated, true);
  assert.equal(view.priceLabel, 'RRP A$1,699');
  assert.equal(view.stamp, 'as at September 18, 2026');
  assert.equal(view.stampDate, '2026-09-18');
  assert.equal(view.checkLabel, 'Check current price at JB Hi-Fi');
});

test('a fed price inside its refresh window is shown as the price', () => {
  const view = offerPresentation(
    offer({ source: 'feed', stale: false, asAt: '2026-09-17' }),
    TODAY,
  );
  assert.equal(view.dated, false);
  assert.equal(view.priceLabel, 'A$1,699');
  assert.equal(view.stamp, null);
});

test('a fed price is re-aged at render time, not trusted from the build', () => {
  // Stamped fresh a fortnight ago; the page must not still call it current.
  const aged = offer({ source: 'feed', stale: false, asAt: '2026-09-01' });
  assert.equal(offerIsDated(aged, TODAY), true);
  assert.equal(offerPresentation(aged, TODAY).priceLabel, 'RRP A$1,699');

  const edge = offer({
    source: 'feed',
    stale: false,
    asAt: '2026-09-11', // exactly STALE_PRICE_DAYS old
  });
  assert.equal(STALE_PRICE_DAYS, 7);
  assert.equal(offerIsDated(edge, TODAY), false, 'the window is inclusive of its last day');
});

test('a pre-order says when it ships and when the reader is charged', () => {
  const view = offerPresentation(
    offer({ preorder: true, releaseDate: '2026-10-02' }),
    TODAY,
  );
  assert.equal(view.preorder, true);
  assert.equal(view.releaseDate, '2026-10-02');
  assert.equal(
    view.releaseNote,
    'Ships October 2, 2026 — you are charged on dispatch, not today',
  );
});

test('a pre-order with no release date still says the charge is on dispatch', () => {
  const view = offerPresentation(offer({ preorder: true }), TODAY);
  assert.equal(view.releaseNote, 'Pre-order — you are charged on dispatch, not today');
  assert.equal(view.releaseDate, null);
});

test('an unnamed merchant leaves the price-check link generic rather than blank', () => {
  const view = offerPresentation(offer({ merchant: undefined }), TODAY);
  assert.equal(view.checkLabel, 'Check current price');
});
