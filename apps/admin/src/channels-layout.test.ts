/**
 * The Channels screen's layout promises, guarded the way table-layout.test.ts
 * guards the rest of the panel: the panel has no layout harness, so these pin
 * the declarations and markup the behaviour rests on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const styles = read('./styles.css');
const page = read('./pages/Channels.tsx');

function rule(selector: string): string {
  const match = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(styles);
  assert.ok(match, `styles.css no longer has a ${selector} rule`);
  return match[1];
}

test('the recovery actions stay pinned while the rest of the row scrolls', () => {
  const pinned = rule('.queue-card th:last-child, .queue-card td:last-child');
  assert.match(pinned, /position:\s*sticky/);
  assert.match(pinned, /right:\s*0/);
  assert.match(pinned, /background:\s*var\(--panel\)/, 'an opaque cell, so scrolled text does not show through');
  assert.match(rule('.queue-card thead th:last-child'), /z-index:\s*1/);
  assert.match(page, /<th>Actions<\/th>\s*<\/tr>/, 'Actions is the last column');
});

test('a stale channel row is hatched, never faded', () => {
  const stale = rule('.chan-row.stale');
  assert.match(stale, /repeating-linear-gradient/);
  assert.match(stale, /dashed/);
  assert.doesNotMatch(stale, /opacity/, 'fading the text would drop it below AA');
  assert.doesNotMatch(page, /opacity:\s*['"]?\.?\d/, 'no inline fade on the list either');
});

test('the outcome toast wraps its message, not its icon', () => {
  const message = rule('.bulk-toast .bt-msg');
  assert.match(message, /flex:\s*1 1 220px/);
  assert.match(message, /min-width:\s*0/);
});

test('the queue lands with nothing selected and the bulk bar closed', () => {
  assert.match(page, /useState<Set<string>>\(new Set\(\)\)/, 'the selection starts empty');
  assert.doesNotMatch(page, /defaultChecked/, 'no row is pre-ticked');
  assert.match(page, /\{summary\.total > 0 && \(\s*<div className="bulkbar"/, 'the bar only opens on a tick');
  assert.match(
    page,
    /aria-label="Select all held and failed items shown by the current filter"/,
    'the header select-all is named for what it selects',
  );
});

test('the new motion honours reduced motion', () => {
  const reduced = styles.slice(styles.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.chan-row, \.chip, \.placement-option \{ transition: none; \}/);
});
