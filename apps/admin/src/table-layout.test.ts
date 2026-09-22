/**
 * Every wide table in the panel (agent sessions is 8-9 columns) is wider than
 * a phone viewport as soon as it holds a row. Until this fix nothing between
 * the table and the document scrolled, so the whole panel slid sideways -
 * v0.10.0's header fix removed that symptom from an empty database and this
 * one removes it from a populated one. The panel has no layout harness (the
 * fix was measured in Chromium at 390x844 and 768x1024), so this guards the
 * declarations and the markup that let a table scroll inside its own card.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const styles = read('./styles.css');
const pageDir = fileURLToPath(new URL('./pages', import.meta.url));
const pages = readdirSync(pageDir)
  .filter((f) => f.endsWith('.tsx'))
  .map((f) => ({ name: f, source: readFileSync(`${pageDir}/${f}`, 'utf8') }));

function rule(selector: string): string {
  const match = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(styles);
  assert.ok(match, `styles.css no longer has a ${selector} rule`);
  return match[1];
}

test('a table card scrolls horizontally instead of widening the page', () => {
  const scroll = rule('.card.table-scroll');
  assert.match(scroll, /overflow-x:\s*auto/, 'the card must scroll its own overflow');
  assert.match(scroll, /padding:\s*0/, 'a table card keeps the flush edges the markup used to inline as padding: 0');
});

/**
 * The two scroll containers in the panel: a table card, and the per-stage
 * attempt history inside a `details` (which cannot be a card - it is already
 * inside one region and has its own summary row).
 */
const SCROLLERS = ['card table-scroll', 'abody'];
const openingTag = (className: string): RegExp =>
  new RegExp(`<div className="${className}"[^>]*>`, 'g');

test('the scroll container is reachable and visible to keyboard users', () => {
  assert.match(rule('.card.table-scroll:focus-visible'), /outline:/, 'a focusable region needs a focus ring');
  assert.match(rule('.abody:focus-visible'), /outline:/, 'an attempt table is a region of its own');
  assert.match(rule('.abody'), /overflow-x:\s*auto/, 'the attempt table scrolls inside its details');
  for (const { name, source } of pages) {
    for (const scroller of SCROLLERS) {
      for (const opening of source.match(openingTag(scroller)) ?? []) {
        assert.match(opening, /tabIndex=\{0\}/, `${name}: a scrollable region must be keyboard-focusable`);
        assert.match(opening, /role="region"/, `${name}: the region needs a role`);
        assert.match(opening, /aria-label=[{"]/, `${name}: the region needs a name`);
      }
    }
  }
});

test('every table sits in a scrolling container', () => {
  for (const { name, source } of pages) {
    for (const table of source.matchAll(/<table[\s>]/g)) {
      const enclosing = Math.max(
        ...SCROLLERS.map((scroller) => source.slice(0, table.index).lastIndexOf(`<div className="${scroller}"`)),
        source.slice(0, table.index).lastIndexOf('<div className="card'),
      );
      assert.notEqual(enclosing, -1, `${name}: a table outside a container cannot scroll`);
      assert.ok(
        SCROLLERS.some((scroller) => source.slice(enclosing).startsWith(`<div className="${scroller}"`)),
        `${name}: this table's container cannot scroll`,
      );
    }
  }
});
