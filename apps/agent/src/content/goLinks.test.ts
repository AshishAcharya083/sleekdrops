// What a /go/ link is worth as a destination when the dossier cannot account
// for it.
//
// An affiliate slug with nothing behind it used to be deleted from the body,
// which threw away the two pieces of evidence that could rebuild it: the words
// the writer put on the link, and the slug itself, which is a product name
// kebab-cased. These are the cases that decide whether a link gets healed or
// dropped, and both directions cost something - a dropped link loses a real
// product, and a link healed from "check the price" sends a reader to a search
// for nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { goLinkSearchTerms, goSlugsIn } from './contract.js';

/** The search term alone - provenance is asserted where it is the point. */
const termFor = (body: string, slug: string): string | undefined =>
  goLinkSearchTerms(body).get(slug)?.term;

test('each /go/ link is keyed by its slug and carries its anchor text', () => {
  const body =
    'The [Samsung Galaxy Z Fold 8](/go/samsung-galaxy-z-fold-8) folds flat, and the ' +
    '[Samsung Galaxy Z Flip 8](/go/samsung-galaxy-z-flip-8) fits a pocket.';

  assert.deepEqual(
    [...goLinkSearchTerms(body)],
    [
      ['samsung-galaxy-z-fold-8', { term: 'Samsung Galaxy Z Fold 8', source: 'anchor text' }],
      ['samsung-galaxy-z-flip-8', { term: 'Samsung Galaxy Z Flip 8', source: 'anchor text' }],
    ],
  );
});

test('markdown emphasis and stray punctuation are not part of the name', () => {
  const body = 'The [**Miele Triflex HX2** —](/go/miele-triflex-hx2) is the quiet one.';
  assert.equal(termFor(body, 'miele-triflex-hx2'), 'Miele Triflex HX2');
});

test('the anchor that names the slug wins, wherever it sits in the body', () => {
  // The link contract puts a "Where to buy" column in the comparison table,
  // which in a "best X" guide sits above the per-product sections - so the
  // first anchor for a slug is routinely a call to action, not the name.
  const ctaFirst =
    '| Dyson V15 | [Check price on Amazon](/go/dyson-v15-detect) |\n\n' +
    'The [Dyson V15 Detect](/go/dyson-v15-detect) is the upgrade.';
  assert.equal(termFor(ctaFirst, 'dyson-v15-detect'), 'Dyson V15 Detect');

  const nameFirst =
    'The [Dyson V15 Detect](/go/dyson-v15-detect) is the upgrade.\n\n' +
    '[See today’s price on Amazon](/go/dyson-v15-detect)';
  assert.equal(termFor(nameFirst, 'dyson-v15-detect'), 'Dyson V15 Detect');
});

test('the anchor sharing the most of the slug wins', () => {
  const body =
    'Start with [the one we like](/go/dyson-v15-detect). The [Dyson V15](/go/dyson-v15-detect) ' +
    'is fine, but the [Dyson V15 Detect Absolute](/go/dyson-v15-detect) is the upgrade.';
  assert.equal(termFor(body, 'dyson-v15-detect'), 'Dyson V15 Detect Absolute');
});

test('a link whose every anchor only shops falls back to its own slug', () => {
  // Every one of these is a phrasing LINK_PLACEMENT_RULES prescribes, so no
  // list of anchor phrasings could be trusted to catch them. The slug names
  // the product, and searching Amazon for the CTA's own words would land the
  // reader on a results page for nothing.
  for (const anchor of [
    'Check price on Amazon',
    'See today’s price on Amazon',
    "Check the latest price on Amazon AU",
    'view at Amazon AU',
    'see it on Amazon',
    'Where to buy',
    'our top pick',
    'this model',
    'the cheaper Flip',
    'A$1,199',
  ]) {
    const body = `Worth it. [${anchor}](/go/samsung-galaxy-z-fold-8)`;
    assert.deepEqual(
      goLinkSearchTerms(body).get('samsung-galaxy-z-fold-8'),
      { term: 'samsung galaxy z fold 8', source: 'its /go/ slug' },
      `"${anchor}" should not become the search term`,
    );
  }
});

test('a link that names nothing on either side is left to be stripped', () => {
  for (const anchor of ['Check the price', 'here', 'buy now', 'the best deal', '→']) {
    for (const slug of ['todays-best-deal', 'best-deal', 'check-the-price-on-amazon-au']) {
      const body = `Worth it. [${anchor}](/go/${slug})`;
      assert.equal(
        goLinkSearchTerms(body).has(slug),
        false,
        `"${anchor}" → /go/${slug} should not become a search term`,
      );
    }
  }
});

test('a price is not a name, however specific it looks', () => {
  // "Grab it for [A$1,199](/go/x)" is a real shape, and an Amazon search for
  // "A$1,199" returns nothing: the reader clicked a product and landed on an
  // empty results page, which is worse than the sentence without a link.
  for (const anchor of ['A$1,199', '$899', '2026', '→', 'A$1,199 today']) {
    const body = `Grab it for [${anchor}](/go/dyson-v15-detect).`;
    assert.deepEqual(
      goLinkSearchTerms(body).get('dyson-v15-detect'),
      { term: 'dyson v15 detect', source: 'its /go/ slug' },
      `"${anchor}" should not become the search term`,
    );
  }

  // A model number carrying its own letters still names the thing.
  assert.equal(
    termFor('The [WH-1000XM6](/go/sony-wh-1000xm6) is it.', 'sony-wh-1000xm6'),
    'WH-1000XM6',
  );
});

test('a shopping phrase wrapped around a real name still names it', () => {
  const body = 'Worth it: [check the Dyson V15 price](/go/dyson-v15-detect).';
  assert.equal(termFor(body, 'dyson-v15-detect'), 'check the Dyson V15 price');
});

test('a bare /go/ reference is a slug with no link to heal', () => {
  const body = 'See /go/miele-triflex for the quiet one.';
  assert.deepEqual(goSlugsIn(body), ['miele-triflex']);
  assert.equal(goLinkSearchTerms(body).size, 0);
});
