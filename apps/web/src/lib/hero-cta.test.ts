import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DEALS_ARCHIVE_HREF,
  DROP_PANEL_ID,
  resolveDropPanelAction,
  resolveHeroSecondaryCta,
} from './hero-cta.ts';

const HERO_ANCHOR = `#${DROP_PANEL_ID}`;

test('an active drop resolves to the in-page anchor at the drop panel', () => {
  const cta = resolveHeroSecondaryCta({ hasActiveDrop: true, archivedDealCount: 3 });
  assert.equal(cta.kind, 'anchor');
  assert.equal(cta.kind === 'anchor' && cta.href, HERO_ANCHOR);
});

test('an active drop with nothing else live still resolves to the anchor', () => {
  // The panel renders from todaysDrop, not from the archive, so an empty
  // archive must not take the anchor away from a drop that is on the page.
  const cta = resolveHeroSecondaryCta({ hasActiveDrop: true, archivedDealCount: 0 });
  assert.equal(cta.kind, 'anchor');
});

test('no active drop never resolves to an in-page anchor', () => {
  // The defect this module exists to prevent: #today is emitted only by the
  // active-drop panel, so without one the anchor variant has no target.
  for (const archivedDealCount of [0, 1, 5]) {
    const cta = resolveHeroSecondaryCta({ hasActiveDrop: false, archivedDealCount });
    assert.notEqual(cta.kind, 'anchor');
    assert.notEqual(cta.kind === 'none' ? undefined : cta.href, HERO_ANCHOR);
    assert.ok(cta.kind === 'none' || !cta.href.startsWith('#'));
  }
});

test('no active drop but a non-empty archive routes to /deals', () => {
  const cta = resolveHeroSecondaryCta({ hasActiveDrop: false, archivedDealCount: 2 });
  assert.equal(cta.kind, 'link');
  assert.equal(cta.kind === 'link' && cta.href, DEALS_ARCHIVE_HREF);
});

test('no drop and no archive omits the CTA rather than duplicating the primary one', () => {
  // Today's shipped state: dailyDeals is empty. /deals would only show its own
  // empty state, and a second hero button is worse than no second hero button.
  assert.deepEqual(resolveHeroSecondaryCta({ hasActiveDrop: false, archivedDealCount: 0 }), {
    kind: 'none',
  });
});

test('with no hero CTA the panel carries the one real next step', () => {
  const cta = resolveHeroSecondaryCta({ hasActiveDrop: false, archivedDealCount: 0 });
  assert.deepEqual(resolveDropPanelAction(cta), {
    href: DEALS_ARCHIVE_HREF,
    label: 'Browse past drops',
  });
});

test('the panel never repeats a route the hero CTA already offers', () => {
  // Both pointing at /deals would put two identical buttons in one hero.
  const archiveCta = resolveHeroSecondaryCta({ hasActiveDrop: false, archivedDealCount: 4 });
  assert.equal(archiveCta.kind === 'link' && archiveCta.href, DEALS_ARCHIVE_HREF);
  assert.equal(resolveDropPanelAction(archiveCta), undefined);

  const anchorCta = resolveHeroSecondaryCta({ hasActiveDrop: true, archivedDealCount: 4 });
  assert.equal(resolveDropPanelAction(anchorCta), undefined);
});

test('the homepage renders the resolved CTA rather than a hardcoded anchor', () => {
  // The resolver only helps if index.astro actually consumes it; a hardcoded
  // href="#today" reintroduces the dead button without failing any unit test.
  const page = readFileSync(new URL('../pages/index.astro', import.meta.url), 'utf8');
  assert.ok(
    page.includes('resolveHeroSecondaryCta'),
    'index.astro no longer resolves its secondary hero CTA from deal state',
  );
  assert.ok(
    !new RegExp(`href="${HERO_ANCHOR}"`).test(page),
    `index.astro hardcodes href="${HERO_ANCHOR}" again`,
  );
});

test('DropPanel emits the anchor id only in the active-drop branch', () => {
  // The anchor variant is safe only because the id is tied to `todaysDrop`.
  // An id on the empty state would resurrect the dead anchor.
  const panel = readFileSync(
    new URL('../components/affiliate/DropPanel.astro', import.meta.url),
    'utf8',
  );
  const template = panel.slice(panel.indexOf('---', 3) + 3);
  const ids = (template.match(/\sid=(\{[^}]*\}|"[^"]*")/g) ?? []).map((s) => s.trim());
  assert.deepEqual(ids, ['id={DROP_PANEL_ID}']);
  const emptyBranch = template.slice(template.indexOf('drop-panel--empty'));
  assert.ok(!/\sid=/.test(emptyBranch), 'the no-drop panel must not carry an id');
});
