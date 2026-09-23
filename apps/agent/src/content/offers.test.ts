// The offer rules, which three surfaces read: the API that validates a save,
// the assembler that turns a record into a destination and a price stamp, and
// the panel that shows an operator what a card can actually be monetised on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatOfferPrice,
  offerCoverage,
  offerLinkRow,
  offerPriceIsStale,
  pickOfferFrom,
  validateOfferInput,
} from './offers.js';
import type { AffiliateLinkRow, ProductOffer, ResearchDossier } from '../pipeline/types.js';

const TODAY = '2026-09-18';

function offer(overrides: Partial<ProductOffer> = {}): ProductOffer {
  return {
    id: 'a2d0f1e2-0000-4000-8000-000000000001',
    article_id: 'b2d0f1e2-0000-4000-8000-000000000002',
    go_slug: 'pixel-11-pro',
    product_name: 'Google Pixel 11 Pro',
    url: 'https://www.jbhifi.com.au/products/google-pixel-11-pro',
    price: '1699.00',
    currency: 'AUD',
    price_observed_on: '2026-09-18',
    preorder: false,
    release_date: null,
    merchant: 'JB Hi-Fi',
    source: 'editor',
    entered_by: 'operator',
    note: null,
    created_at: '2026-09-18T01:00:00Z',
    updated_at: '2026-09-18T01:00:00Z',
    ...overrides,
  };
}

test('a price is formatted the way the reader is shown it', () => {
  assert.equal(formatOfferPrice('2899.00', 'AUD'), 'A$2,899');
  assert.equal(formatOfferPrice('1199.50', 'USD'), 'US$1,199.50');
  assert.equal(formatOfferPrice('99', 'JPY'), 'JPY 99');
  assert.equal(formatOfferPrice(null, 'AUD'), null);
  assert.equal(formatOfferPrice('not a price', 'AUD'), null);
});

test('a hand-entered price is always dated, because nothing is polling it', () => {
  assert.equal(offerPriceIsStale({ source: 'editor', price_observed_on: TODAY }, TODAY), true);
});

test('a fed price is current until its observation ages out', () => {
  assert.equal(offerPriceIsStale({ source: 'feed', price_observed_on: '2026-09-15' }, TODAY), false);
  assert.equal(offerPriceIsStale({ source: 'feed', price_observed_on: '2026-09-01' }, TODAY), true);
  // Undated is stale by definition: nothing says it is current.
  assert.equal(offerPriceIsStale({ source: 'api', price_observed_on: null }, TODAY), true);
});

test('the pick carries the price, the day it was seen and the pre-order promise', () => {
  const pick = pickOfferFrom(
    offer({ preorder: true, release_date: '2026-10-02', price: '2899.00' }),
    TODAY,
  );
  assert.deepEqual(pick, {
    price: 'A$2,899',
    currency: 'AUD',
    asAt: '2026-09-18',
    source: 'editor',
    stale: true,
    merchant: 'JB Hi-Fi',
    preorder: true,
    releaseDate: '2026-10-02',
  });
});

test('an offer with no price ships no stamp rather than an empty one', () => {
  assert.equal(pickOfferFrom(offer({ price: null, price_observed_on: null }), TODAY), null);
});

test('the affiliate row keeps the human destination whole and marks it manual', () => {
  const row = offerLinkRow(offer(), 'pixel-11-buying-guide');
  assert.deepEqual(row.regions_json, null, 'nothing rebuilds a URL a person chose');
  assert.equal(row.default_url, 'https://www.jbhifi.com.au/products/google-pixel-11-pro');
  assert.equal(row.manual, true);
  assert.match(row.note!, /editor-attached offer, A\$1,699 as at 2026-09-18/);
});

test('an Amazon product URL becomes the ASIN the resolver can tag', () => {
  // Stored literally it would go out untagged, which is a click we earn
  // nothing on - the exact failure the record exists to remove.
  const row = offerLinkRow(
    offer({ url: 'https://www.amazon.com.au/dp/B0FQ1234XY' }),
    'pixel-11-buying-guide',
  );
  assert.deepEqual(row.regions_json, {
    network: 'amazon',
    search: 'Google Pixel 11 Pro',
    asins: { au: 'B0FQ1234XY' },
  });
  assert.equal(row.default_url, 'https://www.amazon.com.au/s?k=Google%20Pixel%2011%20Pro');
  assert.equal(row.manual, true);
  assert.match(row.note!, /ASIN B0FQ1234XY on au/);
});

test('a save needs a URL, and refuses one carrying an Associates credential', () => {
  const base = { goSlug: 'pixel-11-pro', price: '1699', priceObservedOn: TODAY };
  assert.match(
    (validateOfferInput({ ...base, url: '' }, TODAY) as { error: string }).error,
    /affiliate URL is required/,
  );
  assert.match(
    (validateOfferInput({ ...base, url: 'http://example.com/p' }, TODAY) as { error: string }).error,
    /https/,
  );
  assert.match(
    (
      validateOfferInput(
        { ...base, url: 'https://www.amazon.com.au/dp/B0FQ1234XY?tag=sleekdrops-22' },
        TODAY,
      ) as { error: string }
    ).error,
    /tag=/,
  );
});

test('a price without the day it was seen is exactly what this feature refuses', () => {
  const parsed = validateOfferInput(
    { goSlug: 'pixel-11-pro', url: 'https://example.com.au/p', price: '1699' },
    TODAY,
  );
  assert.equal(parsed.ok, false);
  assert.match((parsed as { error: string }).error, /date it was observed/);
});

test('a pre-order needs its release date', () => {
  const parsed = validateOfferInput(
    { goSlug: 'pixel-11-pro', url: 'https://example.com.au/p', preorder: true },
    TODAY,
  );
  assert.equal(parsed.ok, false);
  assert.match((parsed as { error: string }).error, /release date/);
});

test('a valid save normalises the record the database stores', () => {
  const parsed = validateOfferInput(
    {
      goSlug: 'pixel-11-pro',
      productName: '  Google Pixel 11 Pro  ',
      url: '  https://www.jbhifi.com.au/products/google-pixel-11-pro  ',
      price: '1699',
      currency: 'aud',
      priceObservedOn: '2026-09-17',
      preorder: true,
      releaseDate: '2026-10-02',
      merchant: 'JB Hi-Fi',
    },
    TODAY,
  );
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok && parsed.value, {
    goSlug: 'pixel-11-pro',
    productName: 'Google Pixel 11 Pro',
    url: 'https://www.jbhifi.com.au/products/google-pixel-11-pro',
    price: '1699.00',
    currency: 'AUD',
    priceObservedOn: '2026-09-17',
    preorder: true,
    releaseDate: '2026-10-02',
    merchant: 'JB Hi-Fi',
    source: 'editor',
    enteredBy: 'operator',
  });
});

test('a price cannot have been observed in the future', () => {
  const parsed = validateOfferInput(
    {
      goSlug: 'pixel-11-pro',
      url: 'https://example.com.au/p',
      price: '10',
      priceObservedOn: '2026-09-19',
    },
    TODAY,
  );
  assert.equal(parsed.ok, false);
  assert.match((parsed as { error: string }).error, /future/);
});

const research = {
  summary: '',
  facts: [],
  products: [
    {
      name: 'Google Pixel 11 Pro',
      brand: 'Google',
      approxPrice: 'about A$1,699',
      amazonUrl: null,
      goSlug: 'pixel-11-pro',
      notes: '',
    },
    {
      name: 'Samsung Galaxy S27',
      brand: 'Samsung',
      approxPrice: 'about A$1,899',
      amazonUrl: 'https://www.amazon.com.au/dp/B0FQ1234XY',
      goSlug: 'samsung-galaxy-s27',
      notes: '',
    },
    {
      name: 'Nothing Phone 4',
      brand: 'Nothing',
      approxPrice: '',
      amazonUrl: null,
      goSlug: 'nothing-phone-4',
      notes: '',
    },
  ],
  failureModes: [],
  whoShouldNotBuy: [],
  ownerComplaints: [],
  priceObservations: [],
  testedClaims: [],
  keywords: { primary: 'best phone 2026', secondary: [] },
  competitorNotes: '',
  faqIdeas: [],
} as unknown as ResearchDossier;

const body =
  'The [Google Pixel 11 Pro](/go/pixel-11-pro) leads, the ' +
  '[Samsung Galaxy S27](/go/samsung-galaxy-s27) is the alternative, and the ' +
  '[Nothing Phone 4](/go/nothing-phone-4) is the cheap one.';

test('coverage reads in the order the assembler resolves', () => {
  const coverage = offerCoverage(
    { draft_md: body, research, affiliate_links: null, frontmatter: null },
    [offer()],
    TODAY,
  );
  assert.deepEqual(
    coverage.rows.map((row) => [row.goSlug, row.provenance]),
    [
      ['pixel-11-pro', 'editor'],
      ['samsung-galaxy-s27', 'resolved'],
      ['nothing-phone-4', 'none'],
    ],
  );
  assert.equal(coverage.covered, 2);
  assert.equal(coverage.total, 3);
  assert.deepEqual(coverage.counts, { editor: 1, resolved: 1, healed: 0, none: 1 });
  assert.equal(coverage.rows[0].price, 'A$1,699');
  assert.equal(coverage.rows[0].stale, true);
});

test('an attached offer outranks a resolved ASIN in the coverage the panel shows', () => {
  const links: AffiliateLinkRow[] = [
    {
      slug: 'samsung-galaxy-s27',
      default_url: 'https://www.amazon.com.au/s?k=Samsung%20Galaxy%20S27',
      regions_json: { network: 'amazon', search: 'Samsung Galaxy S27', asins: { au: 'B0FQ1234XY' } },
    },
  ];
  const coverage = offerCoverage(
    { draft_md: body, research, affiliate_links: links, frontmatter: null },
    [offer({ go_slug: 'samsung-galaxy-s27', product_name: 'Samsung Galaxy S27' })],
    TODAY,
  );
  const row = coverage.rows.find((r) => r.goSlug === 'samsung-galaxy-s27')!;
  assert.equal(row.provenance, 'editor');
  assert.equal(row.destination, 'https://www.jbhifi.com.au/products/google-pixel-11-pro');
});

test('a healed row reads as a search link, not as an offer', () => {
  const links: AffiliateLinkRow[] = [
    {
      slug: 'nothing-phone-4',
      default_url: 'https://www.amazon.com.au/s?k=Nothing%20Phone%204',
      regions_json: { network: 'amazon', search: 'Nothing Phone 4' },
      healed: true,
    },
  ];
  const coverage = offerCoverage(
    { draft_md: body, research, affiliate_links: links, frontmatter: null },
    [],
    TODAY,
  );
  const row = coverage.rows.find((r) => r.goSlug === 'nothing-phone-4')!;
  assert.equal(row.provenance, 'healed');
  assert.match(row.destinationNote!, /healed from the draft/);
  assert.equal(coverage.covered, 1, 'a search link is not an offer for that product');
});

test('a detached offer still on the built page is named, and flagged for rebuild', () => {
  const attached = offer();
  // What assembly left behind: the editor's destination, and the stamp the
  // pick carried. The record itself is gone.
  const links: AffiliateLinkRow[] = [
    { slug: 'pixel-11-pro', default_url: attached.url, regions_json: null, manual: true },
  ];
  const coverage = offerCoverage(
    {
      draft_md: body,
      research,
      affiliate_links: links,
      frontmatter: { picks: [{ goSlug: 'pixel-11-pro', offer: pickOfferFrom(attached, TODAY) }] },
    },
    [],
    TODAY,
  );
  const row = coverage.rows[0];
  assert.equal(row.provenance, 'none', 'nothing is attached to it any more');
  assert.equal(row.label, 'Detached offer');
  assert.equal(row.destination, attached.url, 'which is still where a reader lands');
  assert.doesNotMatch(row.destinationNote!, /search/, 'the note has to match the URL beside it');
  assert.match(row.destinationNote!, /detached/);
  assert.equal(row.pending, true, 'the only thing that puts the page right is a rebuild');
  assert.equal(row.price, null, 'no record, no price to quote');
  assert.equal(coverage.covered, 1, 'and the product counts as uncovered');
});

test('a card never assembled has nothing left behind to rebuild', () => {
  const coverage = offerCoverage(
    { draft_md: body, research, affiliate_links: null, frontmatter: null },
    [],
    TODAY,
  );
  assert.deepEqual(
    coverage.rows.map((row) => [row.provenance, row.pending]),
    [
      ['none', false],
      ['resolved', false],
      ['none', false],
    ],
  );
});

test('an offer saved after the card was assembled is flagged as not on the page yet', () => {
  const attached = offer();
  const links: AffiliateLinkRow[] = [
    {
      slug: 'pixel-11-pro',
      default_url: 'https://www.amazon.com.au/s?k=Google%20Pixel%2011%20Pro',
      regions_json: { network: 'amazon', search: 'Google Pixel 11 Pro' },
    },
  ];
  const before = offerCoverage(
    { draft_md: body, research, affiliate_links: links, frontmatter: { picks: [] } },
    [attached],
    TODAY,
  );
  assert.equal(before.rows[0].pending, true);

  const rebuilt = offerCoverage(
    {
      draft_md: body,
      research,
      affiliate_links: [{ ...links[0], default_url: attached.url, manual: true }],
      frontmatter: {
        picks: [{ goSlug: 'pixel-11-pro', offer: pickOfferFrom(attached, TODAY) }],
      },
    },
    [attached],
    TODAY,
  );
  assert.equal(rebuilt.rows[0].pending, false);
});
