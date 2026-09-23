// The readiness gate, against pages rather than against a live site.
//
// This is the guard between "the publisher asked GitHub to rebuild" and "an
// audience is pointed at a URL". The site is a static build, so for roughly 90
// seconds after publish the slug either 404s or still serves the piece that
// was there before - and whatever a network fetches on its first look is the
// link preview it caches.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/unreachable';
process.env.SITE_URL = 'https://sleekdrops.com';

const {
  checkReadiness,
  evaluateReadiness,
  readinessWindowExpired,
  READINESS_WINDOW_SECONDS,
} = await import('./readiness.js');

import type { RenderedPayload } from './types.js';

const expected: RenderedPayload['expected'] = {
  ogTitle: 'The headphones for a quiet commute',
  ogImage: 'https://storage.googleapis.com/images/heroes/quiet-commutes.png',
};

/** The tags apps/web's SEOHead actually renders, in its own order. */
function page(
  overrides: { title?: string; image?: string | null } = {},
): string {
  const title = overrides.title ?? `${expected.ogTitle} | SleekDrops`;
  const image = overrides.image === undefined ? expected.ogImage : overrides.image;
  return [
    '<html><head>',
    `<title>${title}</title>`,
    '<meta property="og:type" content="article" />',
    `<meta property="og:title" content="${title}" />`,
    '<meta property="og:description" content="Four weeks on the 7:12, ranked." />',
    image ? `<meta property="og:image" content="${image}" />` : '',
    '</head><body></body></html>',
  ].join('\n');
}

test('the gate opens on the published page, site-name suffix and all', () => {
  assert.deepEqual(evaluateReadiness({ status: 200, body: page() }, expected), { ready: true });
});

test('a slug the rebuild has not reached yet is not ready', () => {
  const result = evaluateReadiness({ status: 404, body: '<html>Not found</html>' }, expected);
  assert.deepEqual(result, { ready: false, reason: 'HTTP 404' });
});

test('a stale build still serving the previous piece is not ready', () => {
  const result = evaluateReadiness(
    { status: 200, body: page({ title: 'The last thing we published | SleekDrops' }) },
    expected,
  );
  assert.equal(result.ready, false);
  assert.match(result.ready ? '' : result.reason, /og:title is still "The last thing we published/);
});

test('the hero the post was rendered against has to be the hero the page serves', () => {
  const missing = evaluateReadiness({ status: 200, body: page({ image: null }) }, expected);
  assert.equal(missing.ready, false);
  assert.match(missing.ready ? '' : missing.reason, /no og:image/);

  const other = evaluateReadiness(
    { status: 200, body: page({ image: 'https://storage.googleapis.com/images/heroes/old.png' }) },
    expected,
  );
  assert.equal(other.ready, false);

  // A cache buster on the same file is the same hero.
  assert.deepEqual(
    evaluateReadiness(
      { status: 200, body: page({ image: `${expected.ogImage}?v=2` }) },
      expected,
    ),
    { ready: true },
  );
});

test('an article with no hero waits only on its title', () => {
  assert.deepEqual(
    evaluateReadiness(
      { status: 200, body: page({ image: null }) },
      { ogTitle: expected.ogTitle, ogImage: null },
    ),
    { ready: true },
  );
});

test('an escaped headline is compared as a reader sees it', () => {
  const title = 'Sony &amp; Bose, tested &#8212; the 7:12 verdict';
  const result = evaluateReadiness(
    { status: 200, body: page({ title: `${title} | SleekDrops` }) },
    { ogTitle: 'Sony & Bose, tested — the 7:12 verdict', ogImage: null },
  );
  assert.deepEqual(result, { ready: true });
});

test('a headline with an apostrophe still opens the gate', () => {
  // Astro escapes only `&` and `"` in an attribute value, so `Don't` reaches
  // the page with the apostrophe literal:
  //   <meta property="og:title" content="Don't buy these | SleekDrops" />
  // Reading that value with a `[^"']*` class stops at the apostrophe, so the
  // gate compared against "Don", never opened, and failed the item after the
  // whole window for a rebuild that had actually finished. Apostrophes are
  // ordinary in headlines, so this was most of them.
  const title = "Don't buy these noise-cancelling headphones";
  assert.deepEqual(
    evaluateReadiness(
      { status: 200, body: page({ title: `${title} | SleekDrops`, image: null }) },
      { ogTitle: title, ogImage: null },
    ),
    { ready: true },
  );
});

test('a literal angle bracket in a headline does not hide the tag', () => {
  // `<` and `>` are not escaped either, and a `>` inside a quoted value must
  // not be read as the end of the tag that carries it.
  const title = 'Sony > Bose, and <Insert Brand> is nowhere';
  assert.deepEqual(
    evaluateReadiness(
      { status: 200, body: page({ title: `${title} | SleekDrops`, image: null }) },
      { ogTitle: title, ogImage: null },
    ),
    { ready: true },
  );
});

test('the tag is matched on its property, not on its position', () => {
  // twitter:title carries the same text one tag later, and og:description sits
  // between them. Whichever order they render in, og:title is the one read.
  const body = [
    '<meta name="twitter:title" content="A different headline | SleekDrops">',
    "<meta content='The real headline | SleekDrops' property='og:title'>",
    '<meta property="og:description" content="Four weeks on the 7:12, ranked." />',
  ].join('\n');
  assert.deepEqual(
    evaluateReadiness({ status: 200, body }, { ogTitle: 'The real headline', ogImage: null }),
    { ready: true },
  );
});

test('a page with no meta tags at all is not mistaken for a rendered one', () => {
  const result = evaluateReadiness({ status: 200, body: '<html><body>ok</body></html>' }, expected);
  assert.deepEqual(result, { ready: false, reason: 'page serves no og:title yet' });
});

test('a fetch that throws is a closed gate, not a crashed worker', async () => {
  const result = await checkReadiness('https://sleekdrops.com/blog/x', expected, async () => {
    throw new Error('ECONNRESET');
  });
  assert.equal(result.ready, false);
  assert.match(result.ready ? '' : result.reason, /page fetch failed: ECONNRESET/);
});

test('the window covers a slow rebuild and then gives up', () => {
  const started = new Date('2026-09-23T00:00:00Z');
  const at = (seconds: number) => new Date(started.getTime() + seconds * 1000);

  assert.equal(readinessWindowExpired(started.toISOString(), at(90)), false, 'a ~90s rebuild fits');
  assert.equal(readinessWindowExpired(started.toISOString(), at(READINESS_WINDOW_SECONDS - 1)), false);
  assert.equal(readinessWindowExpired(started.toISOString(), at(READINESS_WINDOW_SECONDS)), true);
  assert.ok(
    READINESS_WINDOW_SECONDS >= 180,
    'the window has to cover a rebuild that queued behind another one',
  );
});
