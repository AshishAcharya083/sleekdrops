/**
 * The GA4 naming contract - the rules that decide whether an event this site
 * fires is counted by Google or silently discarded by it.
 *
 * GA4 answers a malformed hit with a 2xx and drops it, so every failure this
 * file guards against looks in the browser exactly like a working integration
 * and shows up only as an event that nobody ever fired. That is the whole reason
 * the mapping is pure and lives behind `./ga` rather than being spelled out at a
 * `gtag()` call site.
 *
 * The parity test at the end is the important one: it reads the real `EVENTS`
 * map out of `analytics.ts` (the `taxonomy.test.ts` trick - that module cannot be
 * imported under the bare `node --test` runner, since it pulls in the DevTeam SDK
 * and Vite's `import.meta.env`) and asserts every name in it survives the
 * derivation. A taxonomy event added later therefore has to reach GA4 or fail the
 * build; it cannot go missing from one sink while the other keeps counting it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { gaEventName, gaEventParams, gaParamName, snakeCase } from './ga.ts';
import { measurementId } from './ga-env.ts';

const analyticsSource = (): string =>
  readFileSync(fileURLToPath(new URL('./analytics.ts', import.meta.url)), 'utf8');

/** Every event name in the `EVENTS` map, read out of the module source. */
function eventNames(source: string): string[] {
  const map = /export const EVENTS = \{([\s\S]*?)\} as const;/.exec(source);
  assert.ok(map, 'no `export const EVENTS = { ... } as const;` map in src/lib/analytics.ts');
  return [...map[1].matchAll(/^\s*\w+:\s*'([^']+)',?\s*$/gm)].map((m) => m[1]);
}

test('a measurement id is validated, not merely trimmed', () => {
  assert.equal(measurementId('  G-8B65NZ3BD4  '), 'G-8B65NZ3BD4');
  assert.equal(measurementId(undefined), '');
  assert.equal(measurementId(''), '');
  assert.equal(measurementId('   '), '');
  // The shapes a wrong value actually takes: a Universal Analytics property, a
  // Tag Manager container, a stream id, a lowercase paste, a bare container id.
  // Every one of them would load a tag that can only report into nothing.
  ['UA-12345-1', 'GTM-ABC123', 'G_8B65NZ3BD4', 'g-8b65nz3bd4', '8B65NZ3BD4', 'G-'].forEach(
    (value) => assert.equal(measurementId(value), '', `${value} must not be accepted`),
  );
});

test('a Title Case event name becomes the GA4 spelling of itself', () => {
  assert.equal(snakeCase('Deal Card Clicked'), 'deal_card_clicked');
  assert.equal(snakeCase('TOC Link Clicked'), 'toc_link_clicked');
  assert.equal(snakeCase('Image Lightbox Opened'), 'image_lightbox_opened');
});

test('the site page view arrives as GA4 own page_view, not beside it', () => {
  // `page_view` is the event every standard GA4 report is built on. The site
  // dispatches its page view once per document per path, with the dimensions the
  // taxonomy gives it, so that dispatch has to *be* GA4's page view - which is
  // also why the tag is configured with send_page_view: false.
  assert.equal(gaEventName('Page Viewed'), 'page_view');
});

test('the platform events lose the $ prefix GA4 will not accept', () => {
  assert.equal(gaEventName('$experiment_viewed'), 'experiment_viewed');
  assert.equal(gaEventName('$client_error'), 'client_error');
});

test('a name GA4 reserves is refused rather than sent to be discarded', () => {
  // `error` is reserved, which is why $client_error is mapped to `client_error`
  // and not transliterated; `session_start` and `user_engagement` are GA4's own.
  ['Error', 'Session Start', 'User Engagement', 'First Visit'].forEach((event) =>
    assert.equal(gaEventName(event), null, `${event} must not be forwarded`),
  );
  // So is anything under a reserved prefix, whatever it spells.
  assert.equal(gaEventName('Google Thing Happened'), null);
  assert.equal(gaEventName('GA Thing Happened'), null);
});

test('a name GA4 cannot parse at all is refused', () => {
  assert.equal(gaEventName(''), null);
  assert.equal(gaEventName('123 Go'), null, 'a GA4 name must start with a letter');
  assert.equal(gaEventName('A'.repeat(41)), null, 'a GA4 name is at most 40 characters');
});

test('a sticky experiment stamp keeps its identity through the rename', () => {
  // The $ is the only thing GA4 objects to. Without stripping it, every
  // experiment on the site would be measurable in DevTeam and invisible in GA4.
  assert.equal(gaParamName('$exp_hero_cta_copy'), 'exp_hero_cta_copy');
  assert.equal(gaParamName('slug'), 'slug');
  assert.equal(gaParamName('$'), null);
  assert.equal(gaParamName('google_thing'), null);
});

test('parameters are shaped to GA4 rules, and only after the PII scrub', () => {
  const params = gaEventParams({
    slug: 'a-deal',
    position: 3,
    handled: true,
    $exp_nav: 'treatment',
    // A value past GA4's limit is truncated rather than dropped - a truncated
    // dimension still groups, a dropped one loses the event's context.
    title: 'x'.repeat(150),
  });
  assert.deepEqual(params, {
    slug: 'a-deal',
    position: 3,
    handled: 'true',
    exp_nav: 'treatment',
    title: 'x'.repeat(100),
  });
  assert.deepEqual(gaEventParams(null), {});
  assert.deepEqual(gaEventParams(undefined), {});
});

test('surplus parameters drop experiment stamps, never funnel dimensions', () => {
  // GA4 keeps 25 parameters and discards the rest, and a visitor can hold up to
  // 32 sticky stamps at once. `./analytics` builds the payload with the site's
  // own properties first and the stamps last, so the cap has to bite in that
  // order or a deal's slug could be evicted by an experiment it is unrelated to.
  const stamps = Object.fromEntries(
    Array.from({ length: 32 }, (_, i) => [`$exp_e${i}`, `v${i}`]),
  );
  const params = gaEventParams({ slug: 'a-deal', placement: 'sidebar', ...stamps });
  assert.equal(Object.keys(params).length, 25);
  assert.equal(params.slug, 'a-deal');
  assert.equal(params.placement, 'sidebar');
});

test('every event in the taxonomy has a GA4 name, and no two share one', () => {
  const names = eventNames(analyticsSource());
  assert.ok(names.length > 0, 'parsed no events out of the EVENTS map');
  const mapped = names.map((event) => [event, gaEventName(event)] as const);

  assert.deepEqual(
    mapped.filter(([, ga]) => ga === null).map(([event]) => event),
    [],
    'these taxonomy events have no GA4 name and would be dropped before Google saw them',
  );
  // A collision would merge two funnel steps into one number in GA4 while
  // DevTeam still reported them separately - the two sinks disagreeing silently.
  const ga4 = mapped.map(([, ga]) => ga);
  assert.equal(new Set(ga4).size, ga4.length, `two taxonomy events map to one GA4 name: ${ga4}`);
});
