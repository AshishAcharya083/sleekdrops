/**
 * The two layout rules in OfferCallout that a reader actually feels, guarded
 * as declarations because a .astro file cannot be rendered from node's test
 * runner (the same approach apps/admin/src/offer-layout.test.ts takes).
 *
 * Both were measured defects, not preferences:
 *  - "Check current price at Amazon AU" is 347px wide and the strip's content
 *    box on a 390px phone is 306px, so an unbreakable label ran off the card
 *    and took the whole document into horizontal scroll with it;
 *  - the pre-order stamp and its check link wrap onto two lines at that width,
 *    and the separator between them was left dangling on the end of the first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const component = readFileSync(
  fileURLToPath(new URL('./OfferCallout.astro', import.meta.url)),
  'utf8',
);

function rule(selector: string): string {
  const match = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
  ).exec(component);
  assert.ok(match, `OfferCallout.astro no longer has a ${selector} rule`);
  return match[1];
}

test('the strip’s check link wraps rather than running off the card', () => {
  assert.doesNotMatch(rule('.offer-strip .check'), /white-space:\s*nowrap/);
});

test('a wrapped check label keeps its rule under every line', () => {
  assert.match(rule('.check .lbl'), /box-decoration-break:\s*clone/);
});

test('nothing separates the pre-order stamp from its link but the gap', () => {
  assert.doesNotMatch(component, /class="sep"/, 'a separator can be left dangling by a wrap');
  assert.match(rule('.cta .price-stamp'), /gap:\s*0 14px/);
  assert.match(rule('.cta .price-stamp'), /flex-wrap:\s*wrap/);
});
