// The trust surface where it actually lands: a real Postgres row in, the
// frontmatter JSONB the publisher ships to D1 out.
//
// assembler.test.ts proves the derivation in memory. It cannot prove that the
// researcher's tiered facts survive the `research` JSONB round trip, that
// `sources` and `lastReviewed` survive the `frontmatter` JSONB round trip with
// their shapes intact, or that the admin panel reads them back - and those are
// the hops between the assembler and a published page. Point DATABASE_URL at a
// throwaway server to run these.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ADMIN_TOKEN = 'test-admin-token';

const { pool, q } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { createApp } = await import('../api/server.js');
const { runAssembler } = await import('./assembler.js');
const { citedSourceIndexes } = await import('../content/sources.js');

import type { ArticleRow, ContentBrief } from '../pipeline/types.js';

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

if (reachable) await migrate();

const app = createApp();
const AUTH = { Authorization: 'Bearer test-admin-token' };

after(async () => {
  if (reachable) await pool.end();
});

/** A dossier as the researcher writes one: every fact tiered, dated and attributed. */
const research = {
  summary: 'Cordless sticks are a compromise on carpet.',
  facts: [
    {
      fact: 'Measured 210AW on the high setting.',
      sourceUrl: 'https://www.choice.com.au/vacuums',
      tier: 'expert',
      date: '2026-03-14',
      publisher: 'Choice',
    },
    {
      fact: 'Owners report brush-bar tangles on 37 of 412 reviews.',
      sourceUrl: 'https://www.productreview.com.au/shark',
      tier: 'owner',
      date: '2026-02',
      publisher: 'ProductReview.com.au',
    },
    {
      fact: 'A forum thread nobody could place.',
      sourceUrl: 'https://forum.example/thread/12',
      tier: 'unknown',
      date: null,
      publisher: null,
    },
  ],
  products: [
    {
      name: 'Shark Detect Pro',
      brand: 'Shark',
      approxPrice: 'A$1,199',
      amazonUrl: null,
      goSlug: 'shark-detect-pro',
      notes: '',
    },
  ],
  keywords: { primary: 'cordless stick vacuum', secondary: [] },
  competitorNotes: '',
  faqIdeas: [],
};

const brief: ContentBrief = {
  seoTitle: 'Best cordless stick vacuums in Australia',
  dek: 'What to buy, and what breaks first.',
  slug: `best-cordless-stick-vacuums-${randomUUID().slice(0, 8)}`,
  author: 'home',
  kind: 'Buying guide',
  searchIntent: 'Commercial Investigation',
  primaryKeyword: 'cordless stick vacuum',
  secondaryKeywords: [],
  tags: ['vacuums'],
  wordCountTarget: 1500,
  sections: [],
  faq: [],
};

/** A draft as the writer leaves it: claims attributed by marker, one of them broken. */
const draft =
  '## Our pick\n\nThe [Shark Detect Pro](/go/shark-detect-pro) held 210AW on high.[1] ' +
  'Owners report tangles.[2] One thread claims nine minutes on boost.[3] ' +
  'Nobody has published a teardown.[7]';

async function insertArticle(): Promise<ArticleRow> {
  const [inserted] = await q<ArticleRow>(
    `INSERT INTO articles (title, category, post_type, stage, status, research, outline, draft_md)
     VALUES ($1, 'Home', 'guide', 'assemble', 'running', $2, $3, $4) RETURNING *`,
    [brief.seoTitle, JSON.stringify(research), JSON.stringify(brief), draft],
  );
  return inserted;
}

test('the researcher\'s tiers and dates reach the page, through both JSONB columns', { skip }, async () => {
  const inserted = await insertArticle();
  // Read the row back rather than assembling the object we wrote: what the
  // runner hands the assembler is whatever Postgres returns.
  const [article] = await q<ArticleRow>('SELECT * FROM articles WHERE id = $1', [inserted.id]);

  const assembled = await runAssembler(article);
  await q('UPDATE articles SET draft_md = $2, frontmatter = $3 WHERE id = $1', [
    article.id,
    assembled.body,
    JSON.stringify(assembled.frontmatter),
  ]);

  const [stored] = await q<ArticleRow>('SELECT * FROM articles WHERE id = $1', [article.id]);
  assert.deepEqual(stored.frontmatter?.sources, [
    {
      url: 'https://www.choice.com.au/vacuums',
      publisher: 'Choice',
      date: '2026-03-14',
      tier: 'expert',
    },
    {
      url: 'https://www.productreview.com.au/shark',
      publisher: 'ProductReview.com.au',
      date: '2026-02',
      tier: 'owner',
    },
    { url: 'https://forum.example/thread/12', publisher: 'forum.example', tier: 'unknown' },
  ]);
  assert.equal(stored.frontmatter?.lastReviewed, new Date().toISOString().slice(0, 10));

  // Every marker left in the stored body has a source behind it, and the one
  // that pointed past the end of the list is gone.
  assert.deepEqual(citedSourceIndexes(stored.draft_md ?? ''), [1, 2, 3]);
  assert.doesNotMatch(stored.draft_md ?? '', /\[7\]/);
});

test('the panel reads the sources and the review date back off the row', { skip }, async () => {
  const inserted = await insertArticle();
  const [article] = await q<ArticleRow>('SELECT * FROM articles WHERE id = $1', [inserted.id]);
  const assembled = await runAssembler(article);
  await q('UPDATE articles SET frontmatter = $2 WHERE id = $1', [
    article.id,
    JSON.stringify(assembled.frontmatter),
  ]);

  const res = await app.fetch(
    new Request(`http://localhost/api/articles/${article.id}`, { headers: AUTH }),
  );
  assert.equal(res.status, 200);
  const { article: seen } = (await res.json()) as { article: ArticleRow };

  const sources = seen.frontmatter?.sources as Array<{ publisher: string; tier?: string }>;
  assert.equal(sources.length, 3);
  assert.deepEqual(
    sources.map((source) => source.tier),
    ['expert', 'owner', 'unknown'],
  );
  assert.match(String(seen.frontmatter?.lastReviewed), /^\d{4}-\d{2}-\d{2}$/);
});
