/**
 * The offer drawer's rules. The API is the authority (the panel cannot be
 * trusted with a contract), but these are what the operator sees while typing,
 * so they have to agree with it field for field - and the preview has to show
 * the dated RRP a hand-entered price always becomes, because a preview that
 * quietly promises a live price is worse than no preview.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  countErrors,
  formatOfferDate,
  formatOfferPrice,
  offerPayload,
  offerPreview,
  validateOfferDraft,
  type OfferDraft,
} from './offers.ts';

const TODAY = '2026-09-18';

function draft(overrides: Partial<OfferDraft> = {}): OfferDraft {
  return {
    productName: 'Google Pixel 11 Pro',
    url: 'https://www.jbhifi.com.au/products/google-pixel-11-pro',
    price: '1699',
    currency: 'AUD',
    priceObservedOn: TODAY,
    preorder: false,
    releaseDate: '',
    merchant: 'JB Hi-Fi',
    ...overrides,
  };
}

test('a complete draft has nothing to fix', () => {
  assert.deepEqual(validateOfferDraft(draft(), TODAY), {});
});

test('every field that is wrong is reported, not only the first', () => {
  const errors = validateOfferDraft(
    draft({ url: 'jbhifi.com.au/pixel', price: '-4', preorder: true, releaseDate: '' }),
    TODAY,
  );
  assert.equal(countErrors(errors), 3);
  assert.match(errors.url!, /full URL/);
  assert.match(errors.price!, /number/);
  assert.match(errors.releaseDate!, /charged on dispatch/);
});

test('a price with no observation date is refused, the same way the API refuses it', () => {
  const errors = validateOfferDraft(draft({ priceObservedOn: '' }), TODAY);
  assert.match(errors.priceObservedOn!, /day it was seen/);
  // A link with no price at all is a legitimate record: the destination is the
  // half that cannot wait for a feed.
  assert.deepEqual(validateOfferDraft(draft({ price: '', priceObservedOn: '' }), TODAY), {});
});

test('an Associates tag pasted into the URL is refused', () => {
  const errors = validateOfferDraft(
    draft({ url: 'https://www.amazon.com.au/dp/B0FQ1234XY?tag=sleekdrops-22' }),
    TODAY,
  );
  assert.match(errors.url!, /tag=/);
});

test('a price cannot have been observed in the future', () => {
  const errors = validateOfferDraft(draft({ priceObservedOn: '2026-09-19' }), TODAY);
  assert.match(errors.priceObservedOn!, /future/);
});

test('the payload sends nulls rather than empty strings', () => {
  assert.deepEqual(offerPayload(draft({ price: '', priceObservedOn: '', merchant: '  ' })), {
    productName: 'Google Pixel 11 Pro',
    url: 'https://www.jbhifi.com.au/products/google-pixel-11-pro',
    price: null,
    currency: 'AUD',
    priceObservedOn: null,
    preorder: false,
    releaseDate: null,
    merchant: null,
  });
});

test('a release date is only sent when the offer is a pre-order', () => {
  const payload = offerPayload(draft({ preorder: false, releaseDate: '2026-10-02' }));
  assert.equal(payload.releaseDate, null);
});

test('the preview quotes a hand-entered price as a dated RRP', () => {
  const view = offerPreview(draft());
  assert.equal(view.priceLabel, 'RRP A$1,699');
  assert.equal(view.stamp, 'as at September 18, 2026');
  assert.equal(view.datedReason, "manufacturer's RRP, not a live price");
  assert.equal(view.checkLabel, 'Check current price at JB Hi-Fi');
  assert.equal(view.ctaLabel, 'View at JB Hi-Fi');
});

test('a fed price is previewed as the price it is', () => {
  const view = offerPreview(draft(), 'feed');
  assert.equal(view.priceLabel, 'A$1,699');
  assert.equal(view.stamp, null);
  assert.equal(view.datedReason, null);
});

test('a pre-order preview names the ship date and the charge', () => {
  const view = offerPreview(draft({ preorder: true, releaseDate: '2026-10-02' }));
  assert.equal(view.preorder, true);
  assert.equal(view.releaseNote, 'Ships October 2, 2026 — you are charged on dispatch, not today');
});

test('prices and dates are formatted the way the page prints them', () => {
  assert.equal(formatOfferPrice('2899.00', 'AUD'), 'A$2,899');
  assert.equal(formatOfferPrice('1199.50', 'USD'), 'US$1,199.50');
  assert.equal(formatOfferPrice(null, 'AUD'), null);
  // The site prints its dates through formatLong (en-US), so this screen has
  // to print them that way too or it is previewing a sentence nobody gets.
  assert.equal(formatOfferDate('2026-10-02'), 'October 2, 2026');
  assert.equal(formatOfferDate('not a date'), '');
});

test('a pre-order with no price is refused: the dispatch promise rides on it', () => {
  // A price-less record writes no offer onto the pick, so the page renders no
  // pre-order callout - the release date and the charge line never reach the
  // reader at all.
  const errors = validateOfferDraft(
    draft({ price: '', priceObservedOn: '', preorder: true, releaseDate: '2026-10-02' }),
    TODAY,
  );
  assert.match(errors.price!, /pre-order needs the price/);
  assert.equal(countErrors(errors), 1, 'the release date is filled in, so that is the only fault');

  const priced = validateOfferDraft(
    draft({ preorder: true, releaseDate: '2026-10-02' }),
    TODAY,
  );
  assert.equal(countErrors(priced), 0);
});

test('a price stays optional on an offer that is not a pre-order', () => {
  // The link is the point of the record; a product with no figure still
  // reaches the reader as a destination.
  assert.equal(countErrors(validateOfferDraft(draft({ price: '', priceObservedOn: '' }), TODAY)), 0);
});
