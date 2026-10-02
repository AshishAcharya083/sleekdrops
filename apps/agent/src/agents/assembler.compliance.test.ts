// The compliance gate at assembly: what the assembler does with an edition's
// footer, a platform's blocked domains and a preview's picks table. SleekDrops
// carries none of that data, so its output must come through untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAssembler } from './assembler.js';
import { promptContextFromSeed } from './context.js';
import { peakoddsSeed } from '../platform/peakodds/index.js';
import { AU_FOOTER, GLOBAL_FOOTER } from '../platform/peakodds/footers.js';
import { sleekdropsSeed } from '../platform/sleekdrops/index.js';
import type { ArticleRow, ContentBrief } from '../pipeline/types.js';

const au = promptContextFromSeed(peakoddsSeed, 'au');
const global = promptContextFromSeed(peakoddsSeed, 'global');

const brief: ContentBrief = {
  seoTitle: 'Swans v Lions tips: round 4 preview',
  dek: 'A ruck-less Lions side, and why the line is the lean rather than the head to head.',
  slug: 'swans-v-lions-round-4-preview',
  author: 'desk',
  kind: 'match preview',
  searchIntent: 'informational',
  primaryKeyword: 'swans v lions tips',
  secondaryKeywords: [],
  tags: ['afl', 'swans', 'lions'],
  wordCountTarget: 900,
  sections: [],
  faq: [],
};

const PICKS = `| Market | Selection | Indicative odds (decimal) | As at |
| --- | --- | --- | --- |
| Line | Swans -6.5 | 1.90 | 2026-10-01 14:00 AEST |
| Head to head | Swans | 1.65 | 2026-10-01 02:30 UTC |`;

function previewBody(picks = PICKS, extra = ''): string {
  return `- Swans v Lions, Saturday 4 October, 19:30 AEST.
- The Lions have lost their first-choice ruck.
- The lean: Swans at the line.

## The picks

${picks}

## Why the Swans at the line

Their midfield won the contested ball by 18 in the last meeting.${extra}

## Verdict

A lean, not a certainty: the Swans' pressure game suits a ruck-less Lions side, and the prices are subject to change.`;
}

function article(overrides: Partial<ArticleRow> = {}): ArticleRow {
  return {
    id: '7b0e2f1a-9c4d-4e8b-a1f2-3c4d5e6f7a80',
    topic_id: null,
    platform_id: 'peakodds',
    edition_id: 'au',
    event_starts_at: new Date('2026-10-04T09:30:00Z'),
    odds_as_at: null,
    profile_version: null,
    title: brief.seoTitle,
    slug: brief.slug,
    category: 'AFL',
    post_type: 'preview',
    stage: 'assemble',
    status: 'running',
    revision_round: 0,
    research: null,
    outline: brief,
    draft_md: previewBody(),
    seo_review: null,
    frontmatter: null,
    affiliate_links: null,
    hero_image_url: null,
    hero_alt: null,
    feedback: null,
    error: null,
    published_at: null,
    created_at: '2026-09-30T00:00:00Z',
    updated_at: '2026-09-30T00:00:00Z',
    ...overrides,
  } as ArticleRow;
}

test('an Australian preview gets the AU footer and the stalest As at as odds_as_at', async () => {
  const assembled = await runAssembler(au, article());
  assert.ok(assembled.body.startsWith(previewBody()));
  assert.ok(assembled.body.includes(AU_FOOTER));
  assert.ok(!assembled.body.includes(GLOBAL_FOOTER));
  // 14:00 AEST is 04:00 UTC, so the 02:30 UTC row is the older price.
  assert.equal(assembled.oddsAsAt, '2026-10-01T02:30:00.000Z');
  assert.equal(assembled.frontmatter.currency, 'AUD');
});

test('a Global preview gets the Global footer and states no currency', async () => {
  const assembled = await runAssembler(global, article({ edition_id: 'global' }));
  assert.ok(assembled.body.includes(GLOBAL_FOOTER));
  assert.ok(!assembled.body.includes(AU_FOOTER));
  assert.equal('currency' in assembled.frontmatter, false);
});

test('re-assembly keeps one footer, not two', async () => {
  const once = await runAssembler(au, article());
  const twice = await runAssembler(au, article({ draft_md: once.body, frontmatter: once.frontmatter }));
  assert.equal(twice.body, once.body);
});

test('an article linking a bookmaker fails assembly', async () => {
  await assert.rejects(
    runAssembler(au, article({ draft_md: previewBody(PICKS, ' [Compare](https://www.sportsbet.com.au/afl)') })),
    /assembly validation failed:[\s\S]*blocked domain[\s\S]*sportsbet\.com\.au/,
  );
});

test('certainty and inducement language fail assembly', async () => {
  await assert.rejects(
    runAssembler(au, article({ draft_md: previewBody(PICKS, ' This is a lock, and new customers get a bonus bet.') })),
    (error: Error) => /certainty language/.test(error.message) && /inducement terms/.test(error.message),
  );
});

test('a preview with no valid picks table fails assembly', async () => {
  const withBookmakerColumn = `| Market | Selection | Bookmaker | Indicative odds (decimal) | As at |
| --- | --- | --- | --- | --- |
| Line | Swans -6.5 | Someone | 1.90 | 2026-10-01 14:00 AEST |`;
  await assert.rejects(
    runAssembler(au, article({ draft_md: previewBody(withBookmakerColumn) })),
    /forbidden column: "Bookmaker"/,
  );
  await assert.rejects(
    runAssembler(au, article({ draft_md: previewBody(PICKS.replace('1.90', '9/10')) })),
    /"9\/10" is not a decimal price/,
  );
});

test('a PeakOdds explainer is checked but carries no odds_as_at', async () => {
  const assembled = await runAssembler(
    au,
    article({
      post_type: 'article',
      event_starts_at: null,
      draft_md: '## What a line bet is\n\nA handicap applied to the favourite.',
    }),
  );
  assert.equal(assembled.oddsAsAt, null);
  assert.ok(assembled.body.includes(AU_FOOTER));
});

test('SleekDrops output is unchanged: no footer, no odds_as_at, no blocked domains', async () => {
  const sleekdrops = promptContextFromSeed(sleekdropsSeed, 'au');
  // A domain PeakOdds blocks, and a word its phrase rules reject, mean nothing here.
  const draft = '## Our pick\n\nThe Ninja is a lock for most kitchens. Seen on sportsbet.com.au ads.';
  const assembled = await runAssembler(
    sleekdrops,
    article({
      platform_id: 'sleekdrops',
      category: 'Home',
      post_type: 'guide',
      event_starts_at: null,
      draft_md: draft,
      outline: { ...brief, kind: 'buying guide', slug: 'best-budget-air-fryers' },
    }),
  );
  assert.equal(assembled.body, draft);
  assert.equal(assembled.oddsAsAt, null);
});
