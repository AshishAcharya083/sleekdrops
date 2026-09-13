// What a /go/ link's anchor text is worth as a destination.
//
// An affiliate slug with nothing behind it used to be deleted from the body,
// which threw away the one piece of evidence that could rebuild it: the words
// the writer put on the link are the product's name. These are the cases that
// decide whether a link gets healed or dropped, and both directions cost
// something - a dropped link loses a real product, and a link healed from
// "check the price" sends a reader to a search for nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { goLinkAnchors, goSlugsIn } from './contract.js';

test('each /go/ link is keyed by its slug and carries its anchor text', () => {
  const body =
    'The [Samsung Galaxy Z Fold 8](/go/samsung-galaxy-z-fold-8) folds flat, and the ' +
    '[Samsung Galaxy Z Flip 8](/go/samsung-galaxy-z-flip-8) fits a pocket.';

  assert.deepEqual(
    [...goLinkAnchors(body)],
    [
      ['samsung-galaxy-z-fold-8', 'Samsung Galaxy Z Fold 8'],
      ['samsung-galaxy-z-flip-8', 'Samsung Galaxy Z Flip 8'],
    ],
  );
});

test('markdown emphasis and stray punctuation are not part of the name', () => {
  const body = 'The [**Miele Triflex HX2** —](/go/miele-triflex-hx2) is the quiet one.';
  assert.equal(goLinkAnchors(body).get('miele-triflex-hx2'), 'Miele Triflex HX2');
});

test('a slug linked twice is taken from the first anchor that names something', () => {
  const body =
    'Start with [the one we like](/go/dyson-v15-detect). The ' +
    '[Dyson V15 Detect](/go/dyson-v15-detect) is the upgrade.';
  assert.equal(goLinkAnchors(body).get('dyson-v15-detect'), 'the one we like');

  const shopFirst =
    '[Check the price](/go/dyson-v15-detect) — the [Dyson V15 Detect](/go/dyson-v15-detect) is the upgrade.';
  assert.equal(goLinkAnchors(shopFirst).get('dyson-v15-detect'), 'Dyson V15 Detect');
});

test('anchor text that only shops names nothing to search for', () => {
  for (const anchor of [
    'Check the price',
    'see it on Amazon',
    'here',
    'buy now',
    'the best deal',
    'LATEST PRICE',
    '**click here**',
    '→',
  ]) {
    const body = `Worth it. [${anchor}](/go/todays-best-deal)`;
    assert.equal(
      goLinkAnchors(body).has('todays-best-deal'),
      false,
      `"${anchor}" should not become a search term`,
    );
  }
});

test('a price or a symbol is not a name, however specific it looks', () => {
  // "Grab it for [A$1,199](/go/x)" is a real shape, and an Amazon search for
  // "A$1,199" returns nothing: the reader clicked a product and landed on an
  // empty results page, which is worse than the sentence without a link.
  for (const anchor of ['A$1,199', '$899', '2026', '→', 'A$1,199 today']) {
    const body = `Grab it for [${anchor}](/go/dyson-v15-detect).`;
    assert.equal(
      goLinkAnchors(body).has('dyson-v15-detect'),
      false,
      `"${anchor}" should not become a search term`,
    );
  }

  // A model number carrying its own letters still names the thing.
  assert.equal(
    goLinkAnchors('The [WH-1000XM6](/go/sony-wh-1000xm6) is it.').get('sony-wh-1000xm6'),
    'WH-1000XM6',
  );
});

test('a shopping phrase wrapped around a real name still names it', () => {
  const body = 'Worth it: [check the Dyson V15 price](/go/dyson-v15-detect).';
  assert.equal(goLinkAnchors(body).get('dyson-v15-detect'), 'check the Dyson V15 price');
});

test('a bare /go/ reference is a slug with no anchor text behind it', () => {
  const body = 'See /go/miele-triflex for the quiet one.';
  assert.deepEqual(goSlugsIn(body), ['miele-triflex']);
  assert.equal(goLinkAnchors(body).size, 0);
});
