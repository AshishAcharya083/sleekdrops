// The evidence gate as the worker actually reaches it: runStage on a claimed
// article row, against a real Postgres, then the same row read back through
// the admin API the panel calls.
//
// The unit tests in agents/evidence.test.ts prove the gate's arithmetic. They
// cannot prove that a thin dossier is stored before the stage throws, that the
// article lands on 'failed' with the shortfall on it, or that the panel can
// see which stratum was thin - all of which only happen in SQL. Point
// DATABASE_URL at a throwaway server to run these.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ADMIN_TOKEN = 'test-admin-token';

const { pool, q, setSetting } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { runStage } = await import('./runner.js');
const { createApp } = await import('../api/server.js');
const { normaliseDossier } = await import('../agents/evidence.js');

import type { ArticleRow, ResearchDossier } from './types.js';
import type { Researcher } from './runner.js';

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

const app = createApp();
const AUTH = { Authorization: 'Bearer test-admin-token' };

before(async () => {
  if (!reachable) return;
  await migrate();
  // Keep the stage off the Claude engine: modelFor refuses to start a Claude
  // stage without a credential, and this test is about the gate, not the model.
  await setSetting('models', { researcher: 'gemini-2.5-flash' });
});

after(async () => {
  if (reachable) await pool.end();
});

/** A dossier that clears the guide bar, minus whatever the caller strips. */
function richDossier(): ResearchDossier {
  const fact = (n: number, tier: 'primary' | 'expert' | 'owner') => ({
    fact: `${tier} fact ${n}`,
    sourceUrl: `https://example.com/${tier}/${n}`,
    tier,
    date: '2026-04-01',
  });
  return normaliseDossier({
    summary: 'Which cordless stick vacuum to buy, and which to walk away from.',
    facts: [
      fact(1, 'primary'), fact(2, 'primary'), fact(3, 'primary'), fact(4, 'primary'),
      fact(1, 'expert'), fact(2, 'expert'), fact(3, 'expert'),
      fact(1, 'owner'), fact(2, 'owner'), fact(3, 'owner'),
    ],
    products: [
      { name: 'Dyson V15 Detect', brand: 'Dyson', approxPrice: 'RRP A$1,549',
        amazonUrl: null, goSlug: 'dyson-v15-detect', notes: '' },
    ],
    failureModes: [1, 2, 3].map((n) => ({
      product: 'Dyson V15 Detect', failure: `clutch slips ${n}`,
      timeframe: 'after 6-12 months', sourceUrl: `https://productreview.com.au/f/${n}`, tier: 'owner',
    })),
    whoShouldNotBuy: [1, 2].map((n) => ({
      audience: `buyer ${n}`, reason: 'run time does not cover a three-bedroom house',
      sourceUrl: `https://productreview.com.au/w/${n}`,
    })),
    ownerComplaints: [1, 2, 3, 4].map((n) => ({
      product: 'Dyson V15 Detect', complaint: `battery drops to nine minutes ${n}`,
      volume: 'recurring', recency: '2026-03', sourceUrl: `https://reddit.com/r/vacuums/${n}`,
    })),
    priceObservations: [1, 2, 3].map((n) => ({
      product: 'Dyson V15 Detect', value: 1149 + n, currency: 'AUD',
      retailer: 'The Good Guys', dateChecked: '2026-09-01', sourceUrl: `https://thegoodguys.com.au/p/${n}`,
    })),
    testedClaims: [1, 2].map((n) => ({
      claim: `suction measured at ${n}00AW on carpet`, source: 'Choice', year: 2026,
      sourceUrl: `https://choice.com.au/t/${n}`,
    })),
    keywords: { primary: 'best cordless stick vacuum australia', secondary: [] },
    competitorNotes:
      'The top three pages rank the same five machines on RRP and run time, and none mention the clutch failures.',
    faqIdeas: [],
  });
}

/** A claimed article sitting at the research stage, exactly as the worker leaves it. */
async function claimedArticle(postType = 'guide'): Promise<ArticleRow> {
  const [row] = await q<ArticleRow>(
    `INSERT INTO articles (title, category, post_type, stage, status, claimed_by, claimed_at)
     VALUES ($1, 'Home', $2, 'research', 'running', 'test-worker', now()) RETURNING *`,
    [`Best cordless stick vacuums ${randomUUID().slice(0, 8)}`, postType],
  );
  return row;
}

const researcherReturning =
  (dossier: ResearchDossier): Researcher =>
  async () =>
    // A fresh copy per call: runStage stamps `sufficiency` onto what it gets.
    JSON.parse(JSON.stringify(dossier)) as ResearchDossier;

async function reload(id: string): Promise<ArticleRow> {
  return (await q<ArticleRow>('SELECT * FROM articles WHERE id = $1', [id]))[0];
}

test('a thin dossier fails the article instead of reaching the writer', { skip }, async () => {
  const article = await claimedArticle('guide');
  const specsOnly = {
    ...richDossier(),
    failureModes: [],
    whoShouldNotBuy: [],
    ownerComplaints: [],
    priceObservations: [],
    testedClaims: [],
  };

  await runStage(article, researcherReturning(specsOnly));

  const failed = await reload(article.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.stage, 'research', 'a failed gate must not advance the stage');
  assert.match(failed.error ?? '', /Evidence is too thin to write a guide from/);
  assert.match(failed.error ?? '', /owner complaints 0\/4/);
  assert.match(failed.error ?? '', /productreview\.com\.au/i);
  assert.equal(failed.claimed_by ?? null, null, 'the claim is released so retry can pick it up');

  // The dossier is stored even though the stage failed - that is what makes
  // the shortfall inspectable instead of only "research failed".
  assert.equal(failed.research?.sufficiency?.pass, false);
  assert.equal(failed.research?.sufficiency?.counts.primaryFacts, 4);
  assert.equal(failed.research?.sufficiency?.counts.ownerComplaints, 0);
  assert.ok(
    failed.research?.sufficiency?.shortfalls.some((s) => s.stratum === 'price'),
    'the price stratum shortfall is recorded',
  );

  const [session] = await q<{ status: string; error: string }>(
    `SELECT status, error FROM agent_sessions WHERE article_id = $1 AND agent = 'researcher'`,
    [article.id],
  );
  assert.equal(session.status, 'failed');
  assert.match(session.error, /Evidence is too thin/);
});

test('a stratified dossier passes the gate and moves to the keyword stage', { skip }, async () => {
  const article = await claimedArticle('guide');

  await runStage(article, researcherReturning(richDossier()));

  const passed = await reload(article.id);
  assert.equal(passed.status, 'queued');
  assert.equal(passed.stage, 'keyword');
  assert.equal(passed.error ?? null, null);
  assert.equal(passed.research?.sufficiency?.pass, true);
  assert.deepEqual(passed.research?.sufficiency?.shortfalls, []);
  assert.equal(passed.research?.ownerComplaints.length, 4);
  assert.equal(passed.research?.priceObservations[0].currency, 'AUD');

  const [session] = await q<{ status: string; summary: string }>(
    `SELECT status, summary FROM agent_sessions WHERE article_id = $1 AND agent = 'researcher'`,
    [article.id],
  );
  assert.equal(session.status, 'done');
  assert.match(session.summary, /4 primary \/ 3 expert \/ 3 owner \/ 0 untiered/);
  assert.match(session.summary, /4 owner complaint\(s\)/);
});

test('the same dossier is enough for an article and not for a guide', { skip }, async () => {
  const trendPiece = {
    ...richDossier(),
    failureModes: [],
    whoShouldNotBuy: [],
    priceObservations: [],
    testedClaims: [],
    ownerComplaints: richDossier().ownerComplaints.slice(0, 1),
  };

  const asArticle = await claimedArticle('article');
  await runStage(asArticle, researcherReturning(trendPiece));
  assert.equal((await reload(asArticle.id)).stage, 'keyword');

  const asGuide = await claimedArticle('guide');
  await runStage(asGuide, researcherReturning(trendPiece));
  assert.equal((await reload(asGuide.id)).status, 'failed');
});

test('the panel can read why the article failed on evidence', { skip }, async () => {
  const article = await claimedArticle('guide');
  await runStage(article, researcherReturning({ ...richDossier(), ownerComplaints: [] }));

  const res = await app.fetch(
    new Request(`http://localhost/api/articles/${article.id}`, { headers: AUTH }),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { article: ArticleRow };

  assert.equal(body.article.status, 'failed');
  const sufficiency = body.article.research?.sufficiency;
  assert.ok(sufficiency, 'the dossier the panel renders carries the gate verdict');
  assert.equal(sufficiency.pass, false);
  assert.equal(sufficiency.postType, 'guide');
  assert.deepEqual(
    sufficiency.shortfalls.map((s) => [s.stratum, s.have, s.need]),
    [['owner', 0, 4]],
  );
  assert.match(sufficiency.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
});
