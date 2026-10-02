// The byline registry is the one place two apps have to agree: the pipeline
// writes to a beat's voice, and the site renders that beat as a tag on the
// team byline. A beat the site does not know about publishes under nothing,
// and a voice that drifts stops changing the prose - silently, because both
// halves keep working on their own. So the mirror is asserted, not commented.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTHORS,
  authorById,
  BADGE_KINDS,
  BYLINE_NAME,
  bylineFor,
  claimSchema,
  ENABLED_BADGE_KINDS,
  frontmatterSchema,
  isWebUrl,
  launchSchema,
  METHOD_VERSIONS,
  parseOffsetTimestamp,
  PROVENANCES,
  sourceSchema,
  SUB_SCORE_TOLERANCE,
  validateArticle,
} from './contract.js';
import { promptContextFromSeed } from '../agents/context.js';
import { sleekdropsSeed } from '../platform/sleekdrops/index.js';
import { beats, EDITORIAL_TEAM, listBeats } from '../../../web/src/data/authors.ts';
import * as trust from '../../../web/src/lib/trust.ts';

test('the site publishes under one byline, and the beat is a tag on it', () => {
  assert.equal(EDITORIAL_TEAM.name, BYLINE_NAME);
  assert.equal(bylineFor(AUTHORS[0]), BYLINE_NAME, 'the house voice adds no tag');
  const tech = authorById('tech');
  assert.ok(tech);
  assert.equal(bylineFor(tech), 'SleekDrops Editorial Team - Tech');
  // A named desk or a "staff" byline promises a staffed team behind it.
  for (const author of AUTHORS) {
    assert.doesNotMatch(author.label, /desk|staff/i, `"${author.label}" implies a team of its own`);
  }
});

test('the beat voices the pipeline writes to are the ones the site renders', () => {
  assert.deepEqual(
    AUTHORS.map((a) => ({ id: a.id, label: a.label, voice: a.voice })),
    listBeats().map((b) => ({ id: b.id, label: b.label, voice: b.voice })),
  );
  assert.deepEqual(Object.keys(beats), AUTHORS.map((a) => a.id));
});

test('a beat id the site cannot render never reaches frontmatter', () => {
  // The site falls back to the house voice for an id it does not know, which
  // is the right behaviour for a published post but the wrong one for an
  // assembly: a byline nobody chose would ship without anyone noticing.
  assert.equal(frontmatterSchema.shape.author.safeParse('home').success, true);
  assert.equal(frontmatterSchema.shape.author.safeParse('home-desk').success, false);
});

test('a URL the browser would execute rather than follow never reaches frontmatter', () => {
  // `z.string().url()` accepts `javascript:` and `data:`, so the field that
  // ends up in an `href` on the published page has to check the scheme
  // itself. The assembler drops such a link before it gets here; this is the
  // contract saying so, for the values that arrive any other way - an
  // operator edit, a re-assembly over prior frontmatter, a hand-written post.
  const hostile = ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd'];
  for (const url of hostile) {
    assert.equal(launchSchema.safeParse({ product: 'iPhone 18 Pro', releaseDate: '2026-09-11', sourceUrl: url }).success, false, url);
    assert.equal(sourceSchema.safeParse({ url }).success, false, url);
    const claim = { subject: 'iPhone 18 Pro', metric: 'Peak brightness', tier: 'manufacturer' as const, value: '3,000 nits', attribution: 'Apple' };
    assert.equal(claimSchema.safeParse({ ...claim, sourceUrl: url }).success, false, url);
    assert.equal(
      claimSchema.safeParse({ ...claim, claimed: { value: '3,000 nits', by: 'Apple', sourceUrl: url } }).success,
      false,
      url,
    );
    assert.equal(isWebUrl(url), false, url);
  }
  assert.equal(
    launchSchema.safeParse({ product: 'iPhone 18 Pro', releaseDate: '2026-09-11', sourceUrl: 'https://www.apple.com/au/newsroom/' }).success,
    true,
  );
  assert.equal(sourceSchema.safeParse({ url: 'http://www.gsmarena.com/x' }).success, true, 'plain http still opens');
});

test('a byline belongs to the platform publishing it', () => {
  const tech = authorById('tech');
  assert.ok(tech);
  assert.equal(bylineFor(tech, 'Testbrand Desk'), 'Testbrand Desk - Tech');
  assert.equal(bylineFor(AUTHORS[0], 'Testbrand Desk'), 'Testbrand Desk');
});

test('a time is only a time with its offset', () => {
  assert.equal(parseOffsetTimestamp('2026-07-18T19:35:00+10:00')?.toISOString(), '2026-07-18T09:35:00.000Z');
  assert.equal(parseOffsetTimestamp('2026-07-18T09:35Z')?.toISOString(), '2026-07-18T09:35:00.000Z');
  for (const value of ['2026-07-18T19:35:00', '2026-07-18', '18 July 7:35pm', '2026-13-40T99:99:00Z', '', null, 1]) {
    assert.equal(parseOffsetTimestamp(value), null, String(value));
  }
});

test('the category and post type are checked against the platform publishing the piece', () => {
  const { platform } = promptContextFromSeed(sleekdropsSeed, 'au');
  const frontmatter = {
    title: 'T',
    dek: 'D',
    category: 'Home',
    postType: 'guide',
    author: 'home',
    tags: ['t'],
    pubDate: '2026-07-13',
    readTime: 3,
    cover: 'fill-1',
  };
  assert.deepEqual(validateArticle('Body.', frontmatter, [], platform), []);
  const narrow = { ...platform, name: 'Narrow', categories: ['Tech'], postTypes: ['article'] };
  assert.deepEqual(validateArticle('Body.', frontmatter, [], narrow), [
    'frontmatter.category: "Home" is not a Narrow category (Tech)',
    'frontmatter.postType: "guide" is not a Narrow post type (article)',
  ]);
});

test("the trust vocabulary mirrors the site's", () => {
  assert.deepEqual([...METHOD_VERSIONS], trust.METHOD_VERSIONS.map((entry) => entry.version));
  assert.deepEqual([...PROVENANCES], [...trust.PROVENANCES]);
  assert.deepEqual([...BADGE_KINDS], [...trust.BADGE_KINDS]);
  assert.deepEqual(
    [...ENABLED_BADGE_KINDS],
    trust.BADGE_KINDS.filter((kind) => trust.BADGE_REGISTRY[kind].enabled),
  );
  assert.equal(SUB_SCORE_TOLERANCE, trust.SUB_SCORE_TOLERANCE);
});
