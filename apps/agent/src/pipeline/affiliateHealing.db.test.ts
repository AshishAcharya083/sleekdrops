// The Z Fold 8 card, reproduced where it actually failed: a real Postgres row
// at the assemble stage, driven through runStage, read back through the admin
// API the panel renders.
//
// The card reached assemble with a dossier carrying no products at all, which
// the keyword-stage gate is supposed to prevent. It is not a guarantee: the
// admin feedback route (POST /api/articles/:id/feedback) re-queues a piece at
// stage 'edit', so edit → seo_review → assemble runs again without the keyword
// stage ever being re-entered, and every card written before that gate landed
// carries the same shape. Either way the assembler is the last line, and
// stripping the three named foldables out of the body and then failing
// *because* nothing resolved is the behaviour under test here.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ADMIN_TOKEN = 'test-admin-token';

const { pool, q } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { createApp } = await import('../api/server.js');
const { runStage } = await import('./runner.js');
const { withDiscoveredProducts } = await import('../content/evidence.js');

import type { AffiliateLinkRow, ArticleRow, ContentBrief } from './types.js';

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

/** The dossier as the card carried it: real facts, and no products at all. */
const research = {
  summary: 'Samsung folded the crease flat and finally shipped a usable cover screen.',
  facts: [
    {
      fact: 'The Z Fold 8 measures 8.9mm folded.',
      sourceUrl: 'https://www.samsung.com/au/smartphones/galaxy-z-fold8/',
      tier: 'primary',
      date: '2026-08',
      publisher: 'Samsung',
    },
  ],
  products: [],
  keywords: { primary: 'samsung galaxy z fold 8', secondary: [] },
  competitorNotes: 'The ranking pages all recycle the press release.',
  faqIdeas: [],
};

const keywordPlan = {
  intent: 'Commercial Investigation',
  primaryKeyword: 'best samsung foldable 2026',
  difficulty: 'Moderate',
  zeroClickRisk: 'Medium',
  wordCountTarget: 1600,
  contentGaps: [],
  entities: ['Samsung'],
};

const brief: ContentBrief = {
  seoTitle: 'Which Samsung foldable to buy in 2026',
  dek: 'Three folding phones, one worth the money.',
  slug: `samsung-foldables-${randomUUID().slice(0, 8)}`,
  author: 'desk',
  kind: 'Buying guide',
  searchIntent: 'Commercial Investigation',
  primaryKeyword: 'best samsung foldable 2026',
  secondaryKeywords: [],
  tags: ['foldables'],
  wordCountTarget: 1600,
  sections: [],
  faq: [],
};

/** The draft as the writer left it: three real products, each one linked. */
const draft =
  '## The one to buy\n\n' +
  'The [Samsung Galaxy Z Fold 8](/go/samsung-galaxy-z-fold-8) is the one most people should ' +
  'buy. The [Samsung Galaxy Z Fold 8 Ultra](/go/samsung-galaxy-z-fold-8-ultra) costs another ' +
  'A$800 for a brighter cover screen, and the [Samsung Galaxy Z Flip 8](/go/samsung-galaxy-z-flip-8) ' +
  'is the one to buy if you want a foldable that fits a pocket.';

async function insertAtAssemble(): Promise<ArticleRow> {
  const [row] = await q<ArticleRow>(
    `INSERT INTO articles (title, category, post_type, stage, status, claimed_by, claimed_at,
                           research, keyword_plan, outline, draft_md)
     VALUES ($1, 'Tech', 'guide', 'assemble', 'running', 'test-worker', now(), $2, $3, $4, $5)
     RETURNING *`,
    [
      brief.seoTitle,
      JSON.stringify(research),
      JSON.stringify(keywordPlan),
      JSON.stringify(brief),
      draft,
    ],
  );
  return row;
}

async function reload(id: string): Promise<ArticleRow> {
  return (await q<ArticleRow>('SELECT * FROM articles WHERE id = $1', [id]))[0];
}

test('a draft naming three real products publishes on healed search links', { skip }, async () => {
  const article = await insertAtAssemble();
  await runStage(await reload(article.id));

  const assembled = await reload(article.id);
  assert.equal(assembled.status, 'queued', assembled.error ?? '');
  assert.equal(assembled.stage, 'image', 'the card moves on rather than failing');

  const links = assembled.affiliate_links ?? [];
  assert.deepEqual(
    links.map((link) => link.slug),
    ['samsung-galaxy-z-fold-8', 'samsung-galaxy-z-fold-8-ultra', 'samsung-galaxy-z-flip-8'],
  );
  for (const link of links) {
    assert.match(link.default_url, /^https:\/\/www\.amazon\.com\.au\/s\?k=/);
    assert.match(link.note, /healed from anchor text/);
  }
  assert.equal(
    links[0].default_url,
    'https://www.amazon.com.au/s?k=Samsung%20Galaxy%20Z%20Fold%208',
  );

  // Every /go/ link the writer put in the body is still a link.
  assert.match(assembled.draft_md ?? '', /\[Samsung Galaxy Z Fold 8\]\(\/go\/samsung-galaxy-z-fold-8\)/);
  assert.match(assembled.draft_md ?? '', /\(\/go\/samsung-galaxy-z-flip-8\)/);

  const [session] = await q<{ status: string; summary: string }>(
    `SELECT status, summary FROM agent_sessions WHERE article_id = $1 AND agent = 'assembler'`,
    [article.id],
  );
  assert.equal(session.status, 'done');
  assert.match(session.summary, /3 healed from the draft/);
});

test('the panel reads the healed rows back off the card', { skip }, async () => {
  const article = await insertAtAssemble();
  await runStage(await reload(article.id));

  const res = await app.fetch(
    new Request(`http://localhost/api/articles/${article.id}`, { headers: AUTH }),
  );
  assert.equal(res.status, 200);
  const { article: seen } = (await res.json()) as { article: ArticleRow };

  const links = (seen.affiliate_links ?? []) as AffiliateLinkRow[];
  assert.equal(links.length, 3);
  assert.equal(links[0].regions_json.network, 'amazon');
  assert.equal(links[0].regions_json.search, 'Samsung Galaxy Z Fold 8');
  assert.equal('asins' in links[0].regions_json, false, 'a healed row ships no ASIN');
  // The publisher reads this flag back off the card to decide that the row may
  // not overwrite another article's resolved one, so it has to survive JSONB.
  assert.equal(links[0].healed, true);
});

test('a card with nothing nameable behind its links still fails, and says so', { skip }, async () => {
  const [article] = await q<ArticleRow>(
    `INSERT INTO articles (title, category, post_type, stage, status, claimed_by, claimed_at,
                           research, keyword_plan, outline, draft_md)
     VALUES ($1, 'Tech', 'guide', 'assemble', 'running', 'test-worker', now(), $2, $3, $4, $5)
     RETURNING *`,
    [
      brief.seoTitle,
      JSON.stringify(research),
      JSON.stringify(keywordPlan),
      JSON.stringify({ ...brief, slug: `samsung-foldables-${randomUUID().slice(0, 8)}` }),
      '## The one to buy\n\nSamsung has three. [Check the price](/go/best-deal) before you commit.',
    ],
  );

  await runStage(await reload(article.id));

  const failed = await reload(article.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.stage, 'assemble');
  assert.match(failed.error ?? '', /healing recovered 0 of 1/);
  assert.doesNotMatch(failed.error ?? '', /earn nothing/);
});

test('what the keyword stage rediscovers resolves as a dossier product', { skip }, async () => {
  // The other half of the epic: the keyword stage no longer fails a productless
  // commercial piece outright, it runs a discovery pass and writes the result
  // back into `research`. This is that write, through the JSONB column, read
  // by the stage that actually consumes it - a healed link is the fallback,
  // and a rediscovered product should not need it.
  const repaired = withDiscoveredProducts(research as never, [
    { name: 'Samsung Galaxy Z Fold 8', brand: 'Samsung', approxPrice: 'about A$2,899',
      amazonUrl: null, goSlug: 'samsung-galaxy-z-fold-8', notes: 'found by the discovery pass' },
  ]);

  const [inserted] = await q<ArticleRow>(
    `INSERT INTO articles (title, category, post_type, stage, status, claimed_by, claimed_at,
                           research, keyword_plan, outline, draft_md)
     VALUES ($1, 'Tech', 'guide', 'assemble', 'running', 'test-worker', now(), $2, $3, $4, $5)
     RETURNING *`,
    [
      brief.seoTitle,
      JSON.stringify(repaired),
      JSON.stringify(keywordPlan),
      JSON.stringify({ ...brief, slug: `samsung-foldables-${randomUUID().slice(0, 8)}` }),
      '## The one to buy\n\nThe [Samsung Galaxy Z Fold 8](/go/samsung-galaxy-z-fold-8) is the one.',
    ],
  );

  await runStage(await reload(inserted.id));
  const assembled = await reload(inserted.id);

  assert.equal(assembled.status, 'queued', assembled.error ?? '');
  const [link] = assembled.affiliate_links ?? [];
  assert.equal(link.slug, 'samsung-galaxy-z-fold-8');
  assert.match(link.note, /^Samsung Galaxy Z Fold 8 . search link \(no verified ASIN\)/);
  assert.doesNotMatch(link.note, /healed/);

  // The evidence the research pass filed is still there to be written from.
  assert.equal(assembled.research?.facts.length, 1);
  assert.deepEqual(assembled.frontmatter?.picks, [
    { name: 'Samsung Galaxy Z Fold 8', brand: 'Samsung', price: 'about A$2,899',
      goSlug: 'samsung-galaxy-z-fold-8', evidence: 'researched' },
  ]);
});
