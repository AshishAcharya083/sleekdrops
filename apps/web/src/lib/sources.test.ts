/**
 * What a reader is shown about an article's evidence.
 *
 * The rules pinned here are the ones a trust surface fails on quietly: the
 * numbering has to survive untouched (the body's citation markers point at it),
 * a missing date or an unattributed source has to stay visible rather than being
 * tidied away, and a review date has to be a review date rather than the
 * publication date wearing a different label.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  agoLabel,
  displayUrl,
  FAST_REVIEW_INTERVAL_DAYS,
  formatSourceDate,
  reviewIntervalDays,
  reviewStatus,
  REVIEW_INTERVAL_DAYS,
  sourceCountLabel,
  toSourceEntries,
  unverifiedCount,
} from './sources.ts';
import { buildArticleSchema } from './seo.ts';
import type { BlogPost } from './posts.ts';
import type { Author } from '@data/authors';
import { beats } from '../data/authors.ts';

const sources = [
  {
    url: 'https://www.choice.com.au/vacuums',
    publisher: 'Choice',
    date: '2026-03-14',
    tier: 'expert' as const,
  },
  { url: 'https://www.productreview.com.au/shark', publisher: 'ProductReview', date: '2026-02' },
  { url: 'https://forum.example/thread/12', publisher: 'forum.example', tier: 'unknown' as const },
  { url: 'https://sony.com.au/spec/' },
];

test('the rows keep the order and numbering the citation markers point at', () => {
  const entries = toSourceEntries(sources);

  assert.deepEqual(
    entries.map((entry) => entry.index),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    entries.map((entry) => entry.url),
    sources.map((source) => source.url),
  );
});

test('every row is attributed, dated where the source dated itself, and labelled', () => {
  const [choice, productReview, forum, sony] = toSourceEntries(sources);

  assert.equal(choice.publisher, 'Choice');
  assert.equal(choice.dateLabel, 'Mar 14, 2026');
  assert.equal(choice.tierLabel, 'Independent testing');
  assert.equal(choice.caution, null);

  assert.equal(productReview.dateLabel, 'Feb 2026');
  assert.equal(productReview.tierLabel, null, 'a source with no tier claims none');

  // The publisher falls back to the host, so no row is left unattributed.
  assert.equal(sony.publisher, 'sony.com.au');
  assert.equal(sony.linkLabel, 'sony.com.au/spec');

  // The two states that must stay visible rather than being tidied away, each
  // named for what is missing and each saying what it does not support.
  assert.equal(forum.tierLabel, 'Publisher not identified');
  assert.match(forum.caution ?? '', /could not confirm who publishes this page/);
  assert.match(forum.caution ?? '', /nothing here rests on it alone/);
  assert.match(sony.caution ?? '', /no publication or update date/);
  assert.match(sony.caution ?? '', /does not count toward this article/);
});

test('the count above the list says how many rows are marked', () => {
  // A reader should meet the gaps in the summary rather than find them after
  // scrolling - an unannounced weak row reads as something we tried to bury.
  assert.equal(unverifiedCount(toSourceEntries(sources)), 2);
  assert.equal(unverifiedCount(toSourceEntries([sources[0]])), 0);
});

test('a year-only date is shown as a year, and nonsense as no date at all', () => {
  assert.equal(formatSourceDate('2026'), '2026');
  assert.equal(formatSourceDate(undefined), null);
  assert.equal(formatSourceDate('yesterday'), null);
});

test('an article with no sources renders no rows rather than a placeholder row', () => {
  assert.deepEqual(toSourceEntries(), []);
  assert.deepEqual(toSourceEntries([]), []);
});

test('the count reads as a count', () => {
  assert.equal(sourceCountLabel(1), '1 source');
  assert.equal(sourceCountLabel(7), '7 sources');
});

test('a source link is shown as its address, without the scheme noise', () => {
  assert.equal(displayUrl('https://www.rtings.com/headphones/'), 'rtings.com/headphones');
  assert.equal(displayUrl('http://example.com'), 'example.com');
});

// ── The review stamp ────────────────────────────────────────────────────────

const pubDate = new Date('2026-01-10T00:00:00Z');

test('the review date is the logged review, not the publication date', () => {
  const status = reviewStatus(
    {
      pubDate,
      updatedDate: new Date('2026-02-01T00:00:00Z'),
      lastReviewed: new Date('2026-09-04T00:00:00Z'),
    },
    new Date('2026-09-11T00:00:00Z'),
  );

  assert.equal(status.date.toISOString().slice(0, 10), '2026-09-04');
  assert.equal(status.inferred, false);
  assert.equal(status.due, false);
  assert.equal(status.daysSince, 7);
});

test('a post with no logged review says so instead of claiming one', () => {
  // Every post published before the assembler stamped a review date is in this
  // case, and the component changes its wording on `inferred` — claiming a
  // review nobody recorded is the failure this surface exists to prevent.
  const status = reviewStatus(
    { pubDate, updatedDate: new Date('2026-02-01T00:00:00Z') },
    new Date('2026-09-11T00:00:00Z'),
  );

  assert.equal(status.inferred, true);
  assert.equal(status.date.toISOString().slice(0, 10), '2026-02-01');
});

test('a review older than the published cadence reads as due', () => {
  const now = new Date('2026-09-11T00:00:00Z');
  const stale = new Date(now.getTime() - (REVIEW_INTERVAL_DAYS + 1) * 24 * 60 * 60 * 1000);
  const fresh = new Date(now.getTime() - REVIEW_INTERVAL_DAYS * 24 * 60 * 60 * 1000);

  assert.equal(reviewStatus({ pubDate, lastReviewed: stale }, now).due, true);
  assert.equal(reviewStatus({ pubDate, lastReviewed: fresh }, now).due, false);
});

test('the cadence a piece is held to is its category\'s, not one interval for the site', () => {
  // The commitment is published per category, so the same date is current in
  // Home and overdue in Tech - and each piece derives its own next-check date.
  const now = new Date('2026-09-11T00:00:00Z');
  const lastReviewed = new Date(now.getTime() - 200 * 24 * 60 * 60 * 1000);

  assert.equal(reviewIntervalDays('Tech'), FAST_REVIEW_INTERVAL_DAYS);
  assert.equal(reviewIntervalDays('Home'), REVIEW_INTERVAL_DAYS);
  assert.equal(reviewIntervalDays(undefined), REVIEW_INTERVAL_DAYS);

  assert.equal(reviewStatus({ pubDate, lastReviewed, category: 'Tech' }, now).due, true);
  assert.equal(reviewStatus({ pubDate, lastReviewed, category: 'Home' }, now).due, false);

  const home = reviewStatus({ pubDate, lastReviewed, category: 'Home' }, now);
  assert.equal(
    home.nextDue.toISOString().slice(0, 10),
    new Date(lastReviewed.getTime() + REVIEW_INTERVAL_DAYS * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10),
  );
});

test('an overdue piece states how long ago it was checked rather than warning', () => {
  // The stamp keeps its colour past the cadence and swaps in a specific figure:
  // a vague warning lowers trust without telling a shopper anything to act on.
  assert.equal(agoLabel(0), '0 days ago');
  assert.equal(agoLabel(1), '1 day ago');
  assert.equal(agoLabel(35), '1 month ago');
  assert.equal(agoLabel(425), '14 months ago');
  assert.equal(agoLabel(800), '2 years ago');
});

// ── The visible list and the emitted markup are one list ─────────────────────

const author: Author = {
  id: 'desk',
  name: 'SleekDrops Editorial Team',
  role: 'Editorial team',
  bio: 'Research-led coverage.',
  voice: beats.desk.voice,
};

function post(): BlogPost {
  return {
    slug: 'best-cordless-stick-vacuums',
    body: 'Choice measured 210AW.[1] Owners report tangles.[2]',
    data: {
      title: 'The best cordless stick vacuums in Australia',
      dek: 'Three worth buying.',
      category: 'Home',
      postType: 'guide',
      author: 'desk',
      tags: ['vacuums'],
      pubDate,
      lastReviewed: new Date('2026-09-04T00:00:00Z'),
      readTime: 9,
      cover: 'fill-2',
      currency: 'AUD',
      sources,
      featured: false,
      draft: false,
    },
  } as unknown as BlogPost;
}

test('the sources a reader sees are the sources the page cites in its markup', () => {
  // The block and the JSON-LD `citation` are two renderings of one list; if
  // they ever diverge, the visible list has stopped being the evidence.
  const graph = (buildArticleSchema(post(), author) as { '@graph': Array<Record<string, unknown>> })[
    '@graph'
  ];
  const article = graph.find((node) => node['@type'] === 'Article');
  const cited = (article?.citation as Array<{ url: string }>).map((citation) => citation.url);

  assert.deepEqual(
    toSourceEntries(post().data.sources).map((entry) => entry.url),
    cited,
  );
});
