// The evidence gate where it actually lands: a real Postgres row, and the
// admin API the operator panel reads it back through.
//
// The unit tests in content/evidence.test.ts prove the gate's arithmetic and
// that a thin dossier throws. They cannot prove that the throw becomes a
// failed card with the shortfall on it, or that a stratified dossier survives
// the JSONB round trip with its tiers, dates and publishers intact - both of
// those only happen in SQL. Point DATABASE_URL at a throwaway server to run
// these.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ADMIN_TOKEN = 'test-admin-token';
// Before config.js is loaded: the stage below is driven to failure by a Claude
// model with no credential, and an inherited token would turn that into a live
// model call from a test suite that must never make one.
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { getSetting, pool, q, setSetting } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { runStage } = await import('./runner.js');
const { createApp } = await import('../api/server.js');
const { assertEvidenceSufficient, checkEvidence, normaliseDossier } = await import(
  '../content/evidence.js'
);

import type { ArticleRow, ResearchDossier } from './types.js';

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

/** The admin panel can store a Claude token too; if one is there, stand down. */
const credentialled =
  reachable && (await getSetting<{ claude_token?: string }>('llm', {})).claude_token;
const modelSkip = credentialled
  ? 'the database carries a Claude token - this test must not reach a live model'
  : skip;

const app = createApp();
const AUTH = { Authorization: 'Bearer test-admin-token' };

before(async () => {
  if (!reachable) return;
  await migrate();
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
    publisher: tier === 'primary' ? 'Dyson' : 'Choice',
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
        amazonUrl: 'https://thegoodguys.com.au/dyson-v15', goSlug: 'Dyson V15 Detect!', notes: '' },
    ],
    failureModes: [1, 2, 3].map((n) => ({
      product: 'Dyson V15 Detect', failure: `clutch slips ${n}`,
      timeframe: 'after 6-12 months', sourceUrl: `https://productreview.com.au/f/${n}`, tier: 'owner',
    })),
    whoShouldNotBuy: [
      { audience: 'anyone vacuuming a three-storey townhouse',
        reason: 'the run time does not cover a three-bedroom house in one charge',
        sourceUrl: 'https://productreview.com.au/w/1' },
    ],
    ownerComplaints: [1, 2, 3, 4].map((n) => ({
      product: 'Dyson V15 Detect', complaint: `battery drops to nine minutes ${n}`,
      volume: 'recurring', recency: '2026-03', denominator: `${n}7 of 412 reviews`,
      kind: 'quoted', sourceUrl: `https://reddit.com/r/vacuums/${n}`,
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

async function insertArticle(fields: Record<string, unknown> = {}): Promise<ArticleRow> {
  const keys = ['title', 'category', 'post_type', ...Object.keys(fields)];
  const values = [
    `Best cordless stick vacuums ${randomUUID().slice(0, 8)}`,
    'Home',
    'guide',
    ...Object.values(fields),
  ];
  const [row] = await q<ArticleRow>(
    `INSERT INTO articles (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    values,
  );
  return row;
}

async function reload(id: string): Promise<ArticleRow> {
  return (await q<ArticleRow>('SELECT * FROM articles WHERE id = $1', [id]))[0];
}

test('a stage that throws leaves the card failed, explained and unclaimed', { skip: modelSkip }, async () => {
  // This is the route the gate's EvidenceGateError takes out of runResearcher:
  // runStage has no second failure path, so what an operator sees on a thin
  // dossier is whatever the thrown message says. Driving it with a stage that
  // refuses to start (a Claude model with no credential) proves that route
  // against a real row without a live model or a live Tavily.
  await setSetting('models', { researcher: 'claude-opus-4-6' });
  const article = await insertArticle({
    stage: 'research', status: 'running', claimed_by: 'test-worker', claimed_at: new Date(),
  });

  try {
    await runStage(article);
  } finally {
    await setSetting('models', {});
  }

  const failed = await reload(article.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.stage, 'research', 'a failed stage must not advance the article');
  assert.match(
    failed.error ?? '',
    /researcher is set to run on claude-opus-4-6/,
    'the thrown message reaches the card verbatim',
  );
  assert.equal(failed.claimed_by ?? null, null, 'the claim is released so retry can pick it up');

  const [session] = await q<{ status: string; error: string }>(
    `SELECT status, error FROM agent_sessions WHERE article_id = $1 AND agent = 'researcher'`,
    [article.id],
  );
  assert.equal(session.status, 'failed');
  assert.equal(session.error, failed.error);
});

test('the message a failed card carries names the thin stratum and the fix', { skip }, async () => {
  // What the operator would actually read, written to the column the panel
  // renders. The gate produces it; runStage only relays it.
  const specsOnly = {
    ...richDossier(),
    failureModes: [], whoShouldNotBuy: [], ownerComplaints: [],
    priceObservations: [], testedClaims: [],
  };
  const gate = checkEvidence(specsOnly, 'guide', 'Home');
  const article = await insertArticle({
    stage: 'research', status: 'failed', error: gate.message,
  });

  const res = await app.fetch(
    new Request(`http://localhost/api/articles/${article.id}`, { headers: AUTH }),
  );
  assert.equal(res.status, 200);
  const { article: seen } = (await res.json()) as { article: ArticleRow };

  assert.equal(seen.status, 'failed');
  assert.match(seen.error ?? '', /Evidence is too thin to write a guide from/);
  assert.match(seen.error ?? '', /owner complaints with a named source and a denominator 0\/4/);
  assert.match(seen.error ?? '', /dated price observations 0\/3/);
  assert.match(seen.error ?? '', /ProductReview\.com\.au/i);
});

test('a stratified dossier survives JSONB with its tiers, dates and publishers', { skip }, async () => {
  // The panel and (once it lands) the sources block read these keys back out
  // of the column. A round trip that quietly drops `publisher` or flattens
  // `sufficiency` would only ever show up here.
  const dossier = assertEvidenceSufficient(richDossier(), 'guide', 'Home');
  const article = await insertArticle({
    stage: 'keyword', status: 'queued', research: JSON.stringify(dossier),
  });

  const res = await app.fetch(
    new Request(`http://localhost/api/articles/${article.id}`, { headers: AUTH }),
  );
  const { article: seen } = (await res.json()) as { article: ArticleRow };
  const research = seen.research;

  assert.ok(research);
  assert.deepEqual(research.facts[0], {
    fact: 'primary fact 1',
    sourceUrl: 'https://example.com/primary/1',
    tier: 'primary',
    date: '2026-04-01',
    publisher: 'Dyson',
  });
  assert.equal(research.ownerComplaints.length, 4);
  assert.equal(research.ownerComplaints[0].denominator, '17 of 412 reviews');
  assert.equal(research.priceObservations[0].currency, 'AUD');

  const gate = research.sufficiency;
  assert.ok(gate, 'the dossier the panel renders carries the gate verdict');
  assert.equal(gate.pass, true);
  assert.equal(gate.postType, 'guide');
  assert.deepEqual(gate.shortfalls, []);
  assert.equal(gate.counts.attributedOwnerComplaints, 4);
  assert.equal(gate.counts.datedPriceObservations, 3);
  assert.match(gate.checkedAt, /^\d{4}-\d{2}-\d{2}T/);

  // The two behaviours the assembler and SLE-62's picks depend on, through
  // the same round trip: a normalised slug, and a non-Amazon URL dropped.
  assert.equal(research.products[0].goSlug, 'dyson-v15-detect');
  assert.equal(research.products[0].amazonUrl, null);
  assert.match(research.products[0].notes, /non-Amazon URL dropped/);
});
