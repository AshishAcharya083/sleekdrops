/**
 * The offer screens' layout decisions, guarded the way the panel's other
 * layout suites are: no component harness exists here (a .tsx cannot be
 * imported by node's type stripping), so what is asserted is the declarations
 * and the markup that the fixes actually consist of.
 *
 * Each of these was a measured defect, not a preference:
 *  - the action column was clipped at 1280 and 834 because automatic table
 *    layout let an un-wrapped product title compete for its width;
 *  - the last-good rows after a failed poll were dimmed to 75%, which pushed
 *    11px slug text below AA while the banner already said they were stale;
 *  - the price-check underline was an inset shadow on a 44px padded box, so it
 *    floated well below the words it belonged to;
 *  - the pre-order price stamp sat in a full-width row of its own under the
 *    release line, leaving a void in the middle of the card.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const styles = read('./offers.css');
const screen = read('./pages/Offers.tsx');

function rule(selector: string): string {
  const match = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
  ).exec(styles);
  assert.ok(match, `offers.css no longer has a ${selector} rule`);
  return match[1];
}

test('the offer table keeps the action column its own share of the width', () => {
  assert.match(rule('.offers-surface .offer-table'), /table-layout:\s*fixed/);
  assert.match(rule('.offers-surface .offer-table col.c-product'), /width:\s*36%/);
  assert.match(rule('.offers-surface .offer-table col.c-offer'), /width:\s*28%/);
  assert.match(rule('.offers-surface .offer-table col.c-price'), /width:\s*14%/);
  assert.match(rule('.offers-surface .offer-table col.c-act'), /width:\s*22%/);
  assert.match(screen, /<colgroup>/, 'fixed layout needs the columns declared');
});

test('the context column is capped so the panel gets the width the table needs', () => {
  assert.match(
    rule('.offers-surface .stage'),
    /grid-template-columns:\s*minmax\(0,\s*300px\)\s+minmax\(560px,\s*1fr\)/,
  );
});

test('a long destination truncates on one line instead of widening its column', () => {
  const token = rule('.offers-surface .offer-table .tok,\n.offers-surface .offer-card-item .oc-dest .tok');
  assert.match(token, /text-overflow:\s*ellipsis/);
  assert.match(token, /white-space:\s*nowrap/);
  assert.match(token, /max-width:\s*100%/);
  assert.match(screen, /className="tok" title=\{row\.destination\}/, 'the full value stays readable');
});

test('last-good rows after a failed poll keep full contrast', () => {
  assert.match(rule('.offers-surface .stale-rows'), /opacity:\s*1/);
  assert.match(screen, /className="badge amber">not refreshed/, 'staleness is carried in words');
});

test('every tap target on these screens clears 44px', () => {
  assert.match(rule('.offers-surface .btn'), /min-height:\s*44px/);
  const mobile = /@media \(max-width: 680px\) \{([\s\S]*?)\n\}/.exec(styles);
  assert.ok(mobile, 'the phone breakpoint is still there');
  assert.match(mobile[1], /\.btn\.small\s*\{[^}]*min-height:\s*44px/);
  assert.match(mobile[1], /\.close-x\s*\{[^}]*min-height:\s*44px/);
});

test('the pre-order checkbox and its label stay on one line', () => {
  // Two classes plus the element, so it outranks `.field > label{flex-wrap:wrap}`
  // in the shipped stylesheet rather than tying with it.
  assert.match(rule('.offers-surface .field > label.check'), /flex-wrap:\s*nowrap/);
  assert.match(screen, /<label className="check"/);
});

test('the standalone status spinner has a size of its own', () => {
  const spinner = rule('.offers-surface .spinner');
  assert.match(spinner, /width:\s*13px/);
  assert.match(spinner, /height:\s*13px/);
  assert.match(spinner, /animation:\s*offers-spin/);
});

test('the price-check underline hugs the words, not the tap target', () => {
  assert.match(rule('.offers-surface .check-link'), /min-height:\s*44px/);
  assert.match(rule('.offers-surface .check-link .lbl'), /box-shadow:\s*inset 0 -1px 0 var\(--ember\)/);
  assert.match(screen, /<span className="lbl">/, 'the label carries the rule, the link carries the padding');
});

test('the pre-order stamp is grouped with the price and the button', () => {
  assert.match(rule('.offers-surface .reader-callout .cta .price-stamp'), /margin:\s*0/);
  const cta = screen.indexOf('<div className="cta">');
  const stamp = screen.indexOf('className="price-stamp"', cta);
  const preorderLine = screen.indexOf('className="preorder-line"', cta);
  assert.ok(cta !== -1 && stamp !== -1 && preorderLine !== -1);
  assert.ok(stamp < preorderLine, 'the stamp is inside .cta, above the closing release row');
  assert.match(
    rule('.offers-surface .reader-callout .preorder-line'),
    /grid-column:\s*1 \/ -1/,
    'the release line is the single closing full-width row',
  );
});

test('below 680px the table and the history become stacked cards', () => {
  assert.match(rule('.offers-surface .offer-cards'), /display:\s*none/);
  assert.match(rule('.offers-surface .history-cards'), /display:\s*none/);
  const mobile = /@media \(max-width: 680px\) \{([\s\S]*?)\n\}/g;
  const blocks = [...styles.matchAll(mobile)].map((m) => m[1]).join('\n');
  assert.match(blocks, /\.offer-cards\s*\{\s*display:\s*block/);
  assert.match(blocks, /\.offer-table-card\s*\{\s*display:\s*none/);
  assert.match(blocks, /\.history-cards\s*\{\s*display:\s*block/);
  assert.match(blocks, /\.history-table-card\s*\{\s*display:\s*none/);
  assert.match(screen, /className="offer-cards"/);
  assert.match(screen, /className="history-cards"/);
});

test('the lane header count and the list it shows agree', () => {
  assert.match(screen, /more not shown \(/, 'products past the third are named, not dropped');
});

test('nothing on these screens claims the table scrolls sideways', () => {
  // The table fits at 1280 and 834 now; the scroll wrapper stays as a
  // defensive fallback, but the persistent hint that told operators to scroll
  // would be telling them to do something there is no need to do.
  assert.doesNotMatch(screen, /scrolls sideways|scroll-hint/);
  assert.match(screen, /className="card table-scroll"/, 'the fallback wrapper stays');
});
