/**
 * The panel header holds the title, six tabs and the two connection fields on
 * one flex row. Until v0.10.0 nothing in that row could shrink or wrap, so its
 * natural width (~1000px) simply pushed past the viewport and the whole page
 * scrolled sideways on anything narrower. The panel has no layout harness -
 * the fix was measured in Chromium from 320px to 1440px - so this guards the
 * declarations that let the row reflow at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const styles = read('./styles.css');
const app = read('./App.tsx');

function rule(selector: string): string {
  const match = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(styles);
  assert.ok(match, `styles.css no longer has a ${selector} rule`);
  return match[1];
}

test('the header rows wrap instead of widening the page', () => {
  assert.match(rule('.topbar'), /flex-wrap:\s*wrap/, '.topbar must wrap');
  assert.match(rule('.tabs'), /flex-wrap:\s*wrap/, 'the six tabs must wrap');
  assert.match(rule('.topbar .conn'), /flex-wrap:\s*wrap/, 'the connection fields must wrap');
});

test('the connection inputs shrink rather than hold a fixed width', () => {
  const input = rule('.topbar input');
  assert.doesNotMatch(input, /(?<!max-|min-)width:\s*\d/, 'a fixed width cannot shrink');
  assert.match(input, /min-width:\s*0/, 'min-width: 0 lets a flex item shrink below its content');
  assert.match(input, /max-width:\s*\d+px/, 'a max-width keeps the fields from stretching');
});

test('the header markup sets no fixed pixel widths of its own', () => {
  // App.tsx is the shell: the header and the tab switch, nothing else - so an
  // inline width anywhere in it is one of the header's own, overriding the rule.
  assert.match(app, /className="topbar"/, 'App.tsx no longer renders the header');
  assert.doesNotMatch(app, /width:\s*\d/, 'an inline width would override the responsive rule');
});
