// finalizeReview is where a draft is actually cleared to publish, so it must
// hold without a live model: the deterministic voice scan has to be able to
// veto a model that liked the draft, and the merge must not lose the model's
// own issues while doing it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeReview, runSeoReviewer } from './seoReviewer.js';
import { runEditor } from './editor.js';
import { config } from '../config.js';
import { DEFAULT_CORPUS_LIMIT } from '../content/corpus.js';
import { pool } from '../db/pool.js';
import { clearLlmSettingsCache, UsageTracker } from '../llm/index.js';
import { detectSlop } from '../content/slop.js';
import type { ArticleRow, SeoReview } from '../pipeline/types.js';

const CLEAN = 'The Ninja AF160 costs $229 at Amazon Australia. It holds 5.7 litres.';
const SLOPPY = 'This robust solution seamlessly delves into the audio landscape.';

/** A model verdict that would pass on its own. */
function verdict(overrides: Partial<SeoReview> = {}): SeoReview {
  return {
    score: 88,
    pass: true,
    issues: [],
    summary: 'Strong draft.',
    dimensions: { seo: 90, geo: 86, voice: 90, eeat: 88, links: 92 },
    ...overrides,
  };
}

test('a clean draft keeps the model verdict and records the scan', () => {
  const review = finalizeReview(verdict(), detectSlop(CLEAN));
  assert.equal(review.pass, true);
  assert.equal(review.score, 88);
  assert.equal(review.issues.length, 0);
  assert.deepEqual(review.slop, { score: 100, words: 12, findings: 0 });
});

test('the voice scan vetoes a passing verdict', () => {
  const review = finalizeReview(verdict(), detectSlop(SLOPPY));
  assert.equal(review.pass, false, 'banned vocabulary must block the pass');
  assert.ok(review.issues.some((i) => i.severity === 'high'));
  assert.ok(review.issues.every((i) => i.issue.startsWith('Voice scan —')));
});

test('the scan caps the voice dimension and the overall score', () => {
  const slop = detectSlop(SLOPPY);
  const review = finalizeReview(verdict(), slop);
  assert.equal(review.dimensions!.voice, slop.score);
  assert.ok(review.score <= slop.score, `${review.score} should be capped by ${slop.score}`);
  // Dimensions the scan says nothing about are left alone.
  assert.equal(review.dimensions!.seo, 90);
});

test('a weak link dimension caps the score too — the affiliate contract is load-bearing', () => {
  const review = finalizeReview(
    verdict({ dimensions: { seo: 90, geo: 86, voice: 90, eeat: 88, links: 40 } }),
    detectSlop(CLEAN),
  );
  assert.equal(review.score, 40);
  assert.equal(review.pass, false);
});

test("the model's own issues survive the merge, scan issues are appended", () => {
  const review = finalizeReview(
    verdict({
      pass: false,
      score: 62,
      issues: [{ severity: 'medium', issue: 'No comparison table', fix: 'Add one.' }],
    }),
    detectSlop(SLOPPY),
  );
  assert.equal(review.issues[0].issue, 'No comparison table');
  assert.ok(review.issues.length > 1);
});

test('scan issues carry the line number and an example', () => {
  const review = finalizeReview(verdict(), detectSlop(`Fine opening line.\n\n${SLOPPY}`));
  const issue = review.issues.find((i) => i.issue.includes('delves'));
  assert.ok(issue, 'expected a finding for "delves"');
  assert.match(issue!.issue, /"delves"/);
  assert.match(issue!.issue, /line 3/);
  assert.match(issue!.fix, /Replace with/);
});

test('a high-severity model issue blocks a pass even with a clean scan', () => {
  const review = finalizeReview(
    verdict({ issues: [{ severity: 'high', issue: 'Invented a price', fix: 'Cut it.' }] }),
    detectSlop(CLEAN),
  );
  assert.equal(review.pass, false);
});

test('a score below 80 never passes, whatever the model claims', () => {
  assert.equal(finalizeReview(verdict({ score: 79 }), detectSlop(CLEAN)).pass, false);
});

test('a malformed model verdict degrades instead of throwing', () => {
  const review = finalizeReview({} as SeoReview, detectSlop(CLEAN));
  assert.equal(review.pass, false);
  assert.equal(review.score, 0);
  assert.deepEqual(review.issues, []);
  assert.equal(review.dimensions!.geo, 0);
});

test('dimensions fall back to the overall score when the model omits them', () => {
  const review = finalizeReview(
    { score: 84, pass: true, issues: [], summary: '' } as SeoReview,
    detectSlop(CLEAN),
  );
  assert.equal(review.dimensions!.seo, 84);
  assert.equal(review.dimensions!.geo, 84);
  assert.equal(review.score, 84);
  assert.equal(review.pass, true);
});

// --------------------------------------------------------------------------
// The stage as the runner calls it. finalizeReview above is the merge; this is
// the wiring around it - the corpus has to be loaded, and loaded for THIS
// article, before the model is ever consulted.
// --------------------------------------------------------------------------

/** The row the runner hands the stage; only the fields it reads are set. */
function articleRow(overrides: Partial<ArticleRow> = {}): ArticleRow {
  return {
    id: 'a1',
    title: 'Best cordless stick vacuums in Australia',
    slug: 'best-cordless-stick-vacuums',
    category: 'home',
    post_type: 'roundup',
    stage: 'seo_review',
    status: 'running',
    revision_round: 0,
    draft_md: CLEAN,
    ...overrides,
  } as ArticleRow;
}

interface D1Call {
  sql: string;
  params: unknown[];
}

/**
 * Run `fn` with D1 answering `rows` and the LLM unreachable by construction:
 * no credential in config and no settings row, so the Claude engine reports
 * itself unconfigured instead of calling out. The stage therefore runs exactly
 * as far as the model boundary, which is the part under test.
 */
async function withStubbedStage(
  rows: unknown[],
  fn: () => Promise<unknown>,
): Promise<{ calls: D1Call[]; error: unknown }> {
  const calls: D1Call[] = [];
  const original = {
    fetch: globalThis.fetch,
    query: pool.query,
    d1: config.d1,
    claude: config.claude,
    warn: console.warn,
  };
  config.d1 = { accountId: 'test-account', databaseId: 'test-database', token: 'test-token' };
  config.claude = { ...config.claude, oauthToken: '', apiKey: '' };
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)) as D1Call);
    return new Response(JSON.stringify({ success: true, result: [{ results: rows }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  pool.query = (async () => ({ rows: [] })) as unknown as typeof pool.query;
  console.warn = () => {};

  let error: unknown = null;
  try {
    await fn();
  } catch (err) {
    error = err;
  } finally {
    globalThis.fetch = original.fetch;
    pool.query = original.query;
    config.d1 = original.d1;
    config.claude = original.claude;
    console.warn = original.warn;
    clearLlmSettingsCache();
  }
  return { calls, error };
}

const publishedRow = {
  slug: 'best-air-fryers',
  title: 'Best air fryers',
  body_md: 'The Ninja AF160 holds 5.7 litres and costs $229 at RRP.',
  pub_date: '2026-03-01',
};

test('both stages load the corpus for this article before they consult the model', async () => {
  const article = articleRow({ slug: 'best-cordless-stick-vacuums' });
  const stages: Array<[string, () => Promise<unknown>]> = [
    ['reviewer', () => runSeoReviewer(article, 'claude-opus-5', new UsageTracker())],
    ['editor', () => runEditor(article, 'claude-opus-5', new UsageTracker())],
  ];

  for (const [name, run] of stages) {
    const { calls, error } = await withStubbedStage([publishedRow], run);
    assert.match(String(error), /not configured/, `${name} stopped at the model, not earlier`);
    assert.equal(calls.length, 1, `${name} queries the corpus once`);
    assert.match(calls[0].sql, /FROM posts/);
    // excludeSlug is this article: a republish must not read as a
    // near-duplicate of the copy of itself already in the corpus.
    assert.deepEqual(calls[0].params, ['best-cordless-stick-vacuums', DEFAULT_CORPUS_LIMIT]);
  }
});

test('a corpus D1 cannot answer leaves the stage running, not failing', async () => {
  const article = articleRow({ slug: null });
  const { calls, error } = await withStubbedStage([], () =>
    runSeoReviewer(article, 'claude-opus-5', new UsageTracker()),
  );
  // A null slug is a pre-publish article: it still asks, and an empty corpus
  // simply means the cross-corpus metrics are skipped.
  assert.deepEqual(calls[0].params, ['', DEFAULT_CORPUS_LIMIT]);
  assert.match(String(error), /not configured/);
});
