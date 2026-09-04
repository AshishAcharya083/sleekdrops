/**
 * Click-id threading through the affiliate network builders.
 *
 * The sub-id slot is the only thread from a click to the sale a network reports
 * 24-72 hours later, so each builder either puts the id in the slot that
 * network reads or is proven to leave the URL exactly as it was. A silent
 * failure here does not break the site - it makes every imported sale
 * unattributable, months after the fact.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NETWORKS,
  awinUrl,
  cfjumpUrl,
  networkFor,
  regionFor,
  resolve,
} from '../../functions/_lib/affiliates.mjs';

const CLICK_ID = '3f6b1c22-9b1a-4f0e-8c2a-2b4f7d1e5a90';

test('Amazon carries the click id in ascsubtag, alongside the region tag', () => {
  const row = { network: 'amazon', asins: { us: 'B08XYZ' }, search: 'ninja blast' };
  assert.equal(
    NETWORKS.amazon(row, 'us', CLICK_ID),
    `https://www.amazon.com/dp/B08XYZ?tag=sleekdrops-20&ascsubtag=${CLICK_ID}`,
  );
  // A region with no captured ASIN still gets the tag and the sub-id.
  assert.equal(
    NETWORKS.amazon(row, 'au', CLICK_ID),
    `https://www.amazon.com.au/s?k=ninja%20blast&tag=sleekdrops-22&ascsubtag=${CLICK_ID}`,
  );
});

test('Awin carries the click id in clickref', () => {
  assert.equal(
    awinUrl('4242', 1234, 'https://merchant.example/p', CLICK_ID),
    `https://www.awin1.com/cread.php?awinmid=1234&awinaffid=4242&clickref=${CLICK_ID}` +
      '&ued=https%3A%2F%2Fmerchant.example%2Fp',
  );
});

test('Commission Factory carries the click id in UniqueId', () => {
  assert.equal(
    cfjumpUrl('99', 1027, 'https://merchant.example/p', CLICK_ID),
    `https://t.cfjump.com/99/t/1027?Url=https%3A%2F%2Fmerchant.example%2Fp&UniqueId=${CLICK_ID}`,
  );
});

test('a builder with no credentials yields nothing, exactly as before', () => {
  assert.equal(awinUrl('', 1234, 'https://merchant.example/p', CLICK_ID), null);
  assert.equal(cfjumpUrl('', 1027, 'https://merchant.example/p', CLICK_ID), null);
  assert.equal(awinUrl('4242', undefined, 'https://merchant.example/p', CLICK_ID), null);
});

test('no click id means no empty sub-id parameter is appended', () => {
  // An empty sub-id is reported by the network as an empty sub-id, which is a
  // row nothing can be joined to - worse than an absent one.
  assert.equal(
    NETWORKS.amazon({ network: 'amazon', asins: { us: 'B08XYZ' } }, 'us', undefined),
    'https://www.amazon.com/dp/B08XYZ?tag=sleekdrops-20',
  );
  assert.equal(
    awinUrl('4242', 1234, 'https://merchant.example/p', undefined),
    'https://www.awin1.com/cread.php?awinmid=1234&awinaffid=4242&ued=https%3A%2F%2Fmerchant.example%2Fp',
  );
});

test('a direct row resolves byte-identically with and without a click id', () => {
  // Direct links have no sub-id slot: adding a parameter would change a
  // merchant URL we do not own.
  const row = { default: 'https://merchant.example/legacy', au: 'https://merchant.example/au' };
  assert.equal(resolve(row, 'AU', CLICK_ID), resolve(row, 'AU'));
  assert.equal(resolve(row, 'AU', CLICK_ID), 'https://merchant.example/au');
});

test('a row falling back past its builder resolves to the untagged default', () => {
  // Awin has no publisher id configured, so the builder yields nothing and the
  // row falls back to its literal default - unchanged by the click id.
  const row = { network: 'awin', merchant: 1234, url: 'https://merchant.example/p', default: 'https://merchant.example/' };
  assert.equal(resolve(row, 'US', CLICK_ID), 'https://merchant.example/');
});

test('the reported network is the builder that ran, and unknown networks read as direct', () => {
  assert.equal(networkFor({ network: 'amazon' }), 'amazon');
  assert.equal(networkFor({ default: 'https://merchant.example/' }), 'direct');
  assert.equal(networkFor({ network: 'not-a-network' }), 'direct');
  assert.equal(networkFor(undefined), 'direct');
});

test('a row naming an inherited Object property is not treated as a builder', () => {
  // `entry.network in NETWORKS` would find Object.prototype.constructor here,
  // call it with the row, get the row back (truthy), and redirect the visitor to
  // "[object Object]". The lookup is own-property only for exactly this reason.
  const row = { network: 'constructor', default: 'https://merchant.example/' };
  assert.equal(networkFor(row), 'direct');
  assert.equal(resolve(row, 'US', CLICK_ID), 'https://merchant.example/');
});

test('an unmapped country resolves to the default storefront region', () => {
  assert.equal(regionFor('NZ'), 'au');
  assert.equal(regionFor(undefined), 'us');
  assert.equal(regionFor('ZZ'), 'us');
});
