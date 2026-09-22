// Retry-forward against a real Postgres, driven through the API the panel
// actually calls: real verbs, real bearer, real JSON bodies.
//
// The whole point of the feature is what it does NOT do - re-bill the stages
// before the failure, leave downstream output derived from input that no
// longer exists, or fork a second article row - and none of that is provable
// against an in-memory fake. Point DATABASE_URL at a throwaway server to run
// these.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ADMIN_TOKEN = 'test-admin-token';
/** A credential in this process's environment, which is the environment every
 *  agent's child process inherits. Nothing reads it - it is here to be leaked
 *  into an agent failure message, and redacted out of it again. */
process.env.SLE104_TEST_TOKEN = 'sk-ant-oat01-not-a-real-credential';

const { pool, q } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { createApp } = await import('../api/server.js');
const { stageBudgetSeconds } = await import('./budgets.js');
const { STAGE_ORDER } = await import('./types.js');
const { runStage } = await import('./runner.js');
const { STAGE_LEASE_SECONDS } = await import('./lease.js');

import type { ArticleRow, ContentBrief, Stage } from './types.js';

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

if (reachable) await migrate();

const app = createApp();
const AUTH = { Authorization: 'Bearer test-admin-token', 'Content-Type': 'application/json' };
const created: string[] = [];

after(async () => {
  if (reachable && created.length > 0) {
    await q('DELETE FROM articles WHERE id = ANY($1)', [created]);
  }
  await pool.end();
});

const research = {
  summary: 'Cordless sticks are a compromise on carpet.',
  facts: [],
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

const keywordPlan = { primaryKeyword: 'cordless stick vacuum', intent: 'Commercial Investigation' };

const brief: ContentBrief = {
  seoTitle: 'Best cordless stick vacuums in Australia',
  dek: 'What to buy, and what breaks first.',
  slug: 'best-cordless-stick-vacuums',
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

/** A draft as the writer leaves one - it has to carry the /go/ link the
 *  assembler validates, since the assembler is what the test-stage path runs. */
const draft = 'Our pick is the [Shark Detect Pro](/go/shark-detect-pro).';

const seoReview = { score: 82, pass: true, issues: [], summary: 'good enough' };

interface ArticleFields {
  [column: string]: unknown;
}

/** An article part-way down the pipeline, with every upstream column filled. */
async function seed(fields: ArticleFields = {}): Promise<string> {
  const row: ArticleFields = {
    title: brief.seoTitle,
    slug: `retry-test-${randomUUID().slice(0, 8)}`,
    category: 'Home',
    post_type: 'guide',
    stage: 'seo_review',
    status: 'failed',
    research: JSON.stringify(research),
    keyword_plan: JSON.stringify(keywordPlan),
    outline: JSON.stringify(brief),
    draft_md: draft,
    ...fields,
  };
  const columns = Object.keys(row);
  const [inserted] = await q<{ id: string }>(
    `INSERT INTO articles (${columns.join(', ')})
     VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    columns.map((column) => row[column]),
  );
  created.push(inserted.id);
  return inserted.id;
}

/** A finished pipeline session, the way the runner leaves one. */
async function session(
  articleId: string,
  agent: string,
  endedMinutesAgo: number,
  extra: { attempt?: number; kind?: string; status?: string } = {},
): Promise<void> {
  await q(
    `INSERT INTO agent_sessions
       (article_id, agent, model, status, summary, kind, attempt, cost_usd, started_at, ended_at)
     VALUES ($1, $2, 'claude-opus-5', $3, $2 || ' ran', $4, $5, 0.5,
             now() - make_interval(mins => $6 + 1), now() - make_interval(mins => $6))`,
    [
      articleId,
      agent,
      extra.status ?? 'done',
      extra.kind ?? 'pipeline',
      extra.attempt ?? 1,
      endedMinutesAgo,
    ],
  );
}

interface ApiCall {
  status: number;
  body: Record<string, unknown>;
}

async function post(path: string, body?: unknown): Promise<ApiCall> {
  const res = await app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: AUTH,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function detail(id: string): Promise<Record<string, any>> {
  const res = await app.fetch(new Request(`http://localhost/api/articles/${id}`, { headers: AUTH }));
  assert.equal(res.status, 200);
  return (await res.json()) as Record<string, any>;
}

async function row(id: string): Promise<Record<string, any>> {
  const [article] = await q('SELECT * FROM articles WHERE id = $1', [id]);
  return article;
}

// ── Retry from each stage ──────────────────────────────────────────────────

test('retry from research re-queues at the top of the run', { skip }, async () => {
  const id = await seed({ stage: 'write', status: 'failed' });

  const { status, body } = await post(`/api/articles/${id}/retry-stage`, { stage: 'research' });

  assert.equal(status, 200);
  assert.deepEqual(body.article, {
    id,
    stage: 'research',
    status: 'queued',
    attempt: 2,
    stale_from_stage: 'research',
  });
  const after = await row(id);
  assert.equal(after.error, null);
  assert.equal(after.claimed_by, null);
});

test('retry from write keeps the research it already paid for', { skip }, async () => {
  const id = await seed({ stage: 'seo_review', status: 'failed' });

  const { status } = await post(`/api/articles/${id}/retry-stage`, { stage: 'write' });

  assert.equal(status, 200);
  const after = await row(id);
  assert.equal(after.stage, 'write');
  assert.equal(after.status, 'queued');
  assert.equal(after.attempt, 2);
  // The retry-forward guarantee: the stages before the retried one are read,
  // never re-run, so their stored output has to survive untouched.
  assert.equal(after.research.summary, research.summary);
  assert.equal(after.keyword_plan.primaryKeyword, keywordPlan.primaryKeyword);
  assert.equal(after.outline.seoTitle, brief.seoTitle);
});

test('retry from seo_review runs the reviewer again against the stored draft', { skip }, async () => {
  const id = await seed({
    stage: 'assemble',
    status: 'failed',
    seo_review: JSON.stringify(seoReview),
  });

  const { status } = await post(`/api/articles/${id}/retry-stage`, { stage: 'seo_review' });

  assert.equal(status, 200);
  const after = await row(id);
  assert.equal(after.stage, 'seo_review');
  assert.equal(after.stale_from_stage, 'seo_review');
  assert.equal(after.draft_md, draft, 'the draft under review is upstream - it must not move');
});

test('retry from publish re-enters the publisher without touching the draft', { skip }, async () => {
  const id = await seed({
    stage: 'publish',
    status: 'failed',
    seo_review: JSON.stringify(seoReview),
    frontmatter: JSON.stringify({ title: brief.seoTitle }),
  });
  await session(id, 'writer', 30);
  await session(id, 'seo_reviewer', 20);

  const { status, body } = await post(`/api/articles/${id}/retry-stage`, { stage: 'publish' });

  assert.equal(status, 200);
  assert.equal((body.article as { stage: string }).stage, 'publish');
  assert.equal((await row(id)).draft_md, draft);
});

// ── Downstream staleness ───────────────────────────────────────────────────

test('stages after the retried one are reported out of date, then drop out as the run re-passes them', { skip }, async () => {
  const id = await seed({
    stage: 'image',
    status: 'failed',
    seo_review: JSON.stringify(seoReview),
  });

  await post(`/api/articles/${id}/retry-stage`, { stage: 'write' });
  const queued = await detail(id);
  assert.deepEqual(queued.outOfDateStages, [
    'seo_review',
    'edit',
    'assemble',
    'image',
    'publish',
  ] satisfies Stage[]);

  // The run moves forward: write regenerates the draft, seo_review regenerates
  // its verdict off that draft. Both columns are overwritten in place - one
  // article, not a second row - and both stages stop being out of date.
  await q(
    `UPDATE articles SET draft_md = $2, stage = 'seo_review', status = 'queued' WHERE id = $1`,
    [id, `${draft} Rewritten.`],
  );
  assert.deepEqual((await detail(id)).outOfDateStages, [
    'seo_review',
    'edit',
    'assemble',
    'image',
    'publish',
  ]);

  await q(
    `UPDATE articles SET seo_review = $2, stage = 'assemble', status = 'queued' WHERE id = $1`,
    [id, JSON.stringify({ ...seoReview, score: 91 })],
  );
  const regenerated = await detail(id);
  assert.deepEqual(regenerated.outOfDateStages, ['assemble', 'image', 'publish']);
  assert.equal(regenerated.article.draft_md, `${draft} Rewritten.`);
  assert.equal(regenerated.article.seo_review.score, 91);
  assert.equal(regenerated.article.stale_from_stage, 'write', 'the marker is never cleared by hand');
});

test('an article that was never retried has nothing out of date', { skip }, async () => {
  const id = await seed();
  assert.deepEqual((await detail(id)).outOfDateStages, []);
});

/**
 * Take the claim a worker would take, for this article only. `claimNext()`
 * picks the longest-waiting queued row in the whole table and these suites
 * share one database, so scoping the claim is what keeps the run deterministic
 * without reaching into another file's article.
 */
async function claimForWorker(id: string): Promise<ArticleRow> {
  const [claimed] = await q<ArticleRow>(
    `UPDATE articles
        SET status = 'running', claimed_by = 'retry-test-worker', claimed_at = now(),
            heartbeat_at = now(), lease_expires_at = now() + make_interval(secs => $2),
            updated_at = now()
      WHERE id = $1 AND status = 'queued'
      RETURNING *`,
    [id, STAGE_LEASE_SECONDS],
  );
  assert.ok(claimed, 'the retry left a queued article for the worker to claim');
  return claimed;
}

test('the run picked up after a retry regenerates the downstream output under the new attempt', { skip }, async () => {
  // assemble and image are the two stages that need no model, so the real
  // runner can carry this one forward here: the retry re-queues at assemble,
  // the runner overwrites the frontmatter the last pass left, routes on to
  // image, and the out-of-date list shrinks behind it.
  const id = await seed({
    stage: 'image',
    status: 'failed',
    seo_review: JSON.stringify(seoReview),
    frontmatter: JSON.stringify({ title: 'left by the pass that failed' }),
    hero_image_url: 'https://example.com/hero.jpg',
  });

  assert.equal((await post(`/api/articles/${id}/retry-stage`, { stage: 'assemble' })).status, 200);
  assert.deepEqual((await detail(id)).outOfDateStages, ['image', 'publish']);

  await runStage(await claimForWorker(id));

  const assembled = await row(id);
  assert.equal(assembled.stage, 'image', 'the run continues forward rather than stopping');
  assert.equal(assembled.frontmatter.title, brief.seoTitle, 'the stale frontmatter was replaced');
  assert.equal(assembled.claimed_by, null, 'and the claim is released between stages');

  await runStage(await claimForWorker(id));

  const imaged = await row(id);
  assert.equal(imaged.stage, 'publish');
  assert.equal(imaged.status, 'waiting_approval');
  assert.equal(imaged.attempt, 2, 'one article, one row - the retry did not fork it');
  assert.deepEqual((await detail(id)).outOfDateStages, ['publish'], 'image is no longer out of date');

  // Both stages ran under the retry's attempt: that tagging is what turns a
  // flat session log into the per-stage history the panel renders.
  const attempts = (await detail(id)).attempts as Array<{
    stage: string;
    runs: Array<{ attempt: number; status: string; kind: string }>;
  }>;
  assert.deepEqual(
    attempts.map((group) => [group.stage, group.runs.map((run) => run.attempt)]),
    [['assemble', [2]], ['image', [2]]],
  );
  assert.ok(attempts.every((group) => group.runs.every((run) => run.status === 'done')));
});

// ── One article, one history ───────────────────────────────────────────────

test('retries accumulate on one article as attempt history, not as new rows', { skip }, async () => {
  const id = await seed({ stage: 'seo_review', status: 'failed' });
  await session(id, 'writer', 40, { attempt: 1 });
  await session(id, 'seo_reviewer', 35, { attempt: 1, status: 'failed' });

  await post(`/api/articles/${id}/retry-stage`, { stage: 'seo_review' });
  await session(id, 'seo_reviewer', 5, { attempt: 2 });

  const seen = await detail(id);
  assert.equal(seen.article.attempt, 2);
  assert.equal(
    (await q('SELECT count(*) n FROM articles WHERE slug = $1', [(await row(id)).slug]))[0].n,
    '1',
  );

  const review = (seen.attempts as Array<{ stage: string; agent: string; runs: unknown[] }>).find(
    (group) => group.stage === 'seo_review',
  )!;
  assert.equal(review.agent, 'seo_reviewer');
  assert.deepEqual(
    review.runs.map((run) => (run as { attempt: number; status: string }).attempt),
    [1, 2],
  );
  assert.deepEqual(
    review.runs.map((run) => (run as { status: string }).status),
    ['failed', 'done'],
  );
  const [firstRun] = review.runs as Array<Record<string, unknown>>;
  assert.equal(firstRun.kind, 'pipeline');
  assert.equal(firstRun.costUsd, 0.5);
  assert.equal(typeof firstRun.durationMs, 'number');
  // Grouped in pipeline order, so the panel renders the board top to bottom.
  assert.deepEqual(
    (seen.attempts as Array<{ stage: string }>).map((group) => group.stage),
    ['write', 'seo_review'],
  );
});

// ── Guards ─────────────────────────────────────────────────────────────────

test('a mid-stage article must be cancelled before it can be retried', { skip }, async () => {
  const id = await seed({ stage: 'write', status: 'running' });
  await q("UPDATE articles SET lease_expires_at = now() + interval '5 minutes' WHERE id = $1", [id]);

  const retry = await post(`/api/articles/${id}/retry-stage`, { stage: 'write' });
  assert.equal(retry.status, 409);
  assert.equal(retry.body.error, 'the article is mid-stage - cancel it first, then retry');

  const rerun = await post(`/api/articles/${id}/rerun-all`);
  assert.equal(rerun.status, 409);
  assert.equal(rerun.body.error, 'the article is mid-stage - cancel it first');

  // Cancel expires the lease, so the worker unwinds and the retry is allowed.
  const cancel = await post(`/api/articles/${id}/cancel`);
  assert.equal(cancel.status, 200);
  assert.deepEqual(cancel.body, { ok: true, pending: true });
  const cancelled = await row(id);
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.lease_expires_at <= new Date(), 'the lease is released, not left running');

  const afterCancel = await post(`/api/articles/${id}/retry-stage`, { stage: 'write' });
  assert.equal(afterCancel.status, 200);
  const requeued = await row(id);
  assert.equal(requeued.claimed_by, null);
  assert.equal(requeued.claimed_at, null);
  // The lease of the run that was cancelled goes with the claim: a queued
  // article holding an expiry describes a claim nobody holds, and the panel
  // reads those columns straight off the row.
  assert.equal(requeued.heartbeat_at, null);
  assert.equal(requeued.lease_expires_at, null);
});

test('a running article whose lease has already expired is retryable', { skip }, async () => {
  const id = await seed({ stage: 'write', status: 'running' });
  await q("UPDATE articles SET lease_expires_at = now() - interval '1 minute' WHERE id = $1", [id]);

  const { status } = await post(`/api/articles/${id}/retry-stage`, { stage: 'write' });
  assert.equal(status, 200);
});

test('a finished article cannot be retried forward by accident', { skip }, async () => {
  const id = await seed({ stage: 'done', status: 'done' });

  const { status, body } = await post(`/api/articles/${id}/retry-stage`, { stage: 'write' });
  assert.equal(status, 409);
  assert.equal(
    body.error,
    'only a failed, timed out, cancelled or awaiting-approval article can be retried',
  );
});

test('a timed out or awaiting-approval article is retryable', { skip }, async () => {
  const timedOut = await seed({ stage: 'seo_review', status: 'timed_out' });
  assert.equal((await post(`/api/articles/${timedOut}/retry-stage`, { stage: 'seo_review' })).status, 200);
  // The plain re-queue action takes the new terminal state too.
  await q("UPDATE articles SET status = 'timed_out' WHERE id = $1", [timedOut]);
  assert.equal((await post(`/api/articles/${timedOut}/retry`)).status, 200);

  const waiting = await seed({ stage: 'publish', status: 'waiting_approval' });
  assert.equal((await post(`/api/articles/${waiting}/retry-stage`, { stage: 'image' })).status, 200);
});

test('the stage body param is validated before anything is re-queued', { skip }, async () => {
  const id = await seed();

  assert.deepEqual(await post(`/api/articles/${id}/retry-stage`), {
    status: 400,
    body: { error: 'stage required' },
  });
  assert.deepEqual(await post(`/api/articles/${id}/retry-stage`, { stage: 'polish' }), {
    status: 400,
    body: { error: 'unknown stage "polish"' },
  });
  assert.deepEqual(await post(`/api/articles/${id}/retry-stage`, { stage: 'done' }), {
    status: 400,
    body: { error: 'done is not a runnable stage' },
  });
  assert.equal((await row(id)).attempt, 1);
});

test('retrying to publish an article that was never assembled is refused by name', { skip }, async () => {
  // No frontmatter: the publisher would read one off a null column and fail
  // with a message about a property, which tells an operator nothing about
  // which stage they actually have to re-run.
  const id = await seed({ stage: 'assemble', status: 'failed' });

  const { status, body } = await post(`/api/articles/${id}/retry-stage`, { stage: 'publish' });

  assert.equal(status, 409);
  assert.equal(body.error, 'this article has no assembled draft to publish - retry from an earlier stage');
  assert.equal((await row(id)).attempt, 1);
});

test('retrying a stage of an article that does not exist is a 404', { skip }, async () => {
  const { status, body } = await post(
    `/api/articles/${randomUUID()}/retry-stage`,
    { stage: 'write' },
  );
  assert.equal(status, 404);
  assert.equal(body.error, 'not found');
});

// ── Full re-run ────────────────────────────────────────────────────────────

test('rerun-all sends the article back to research', { skip }, async () => {
  const id = await seed({ stage: 'image', status: 'failed', error: 'boom' });

  const { status, body } = await post(`/api/articles/${id}/rerun-all`);

  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true });
  const after = await row(id);
  assert.equal(after.stage, 'research');
  assert.equal(after.status, 'queued');
  assert.equal(after.attempt, 2);
  assert.equal(after.stale_from_stage, 'research');
  assert.equal(after.error, null);
});

// ── Cancel ─────────────────────────────────────────────────────────────────

test('cancelling a queued article needs no unwinding', { skip }, async () => {
  const id = await seed({ status: 'queued' });

  const { status, body } = await post(`/api/articles/${id}/cancel`);

  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, pending: false });
  assert.equal((await row(id)).status, 'cancelled');
  assert.equal((await row(id)).lease_expires_at, null, 'a queued row never held a lease');
});

test('an article that is already done is not cancellable', { skip }, async () => {
  const id = await seed({ stage: 'done', status: 'done' });
  assert.deepEqual(await post(`/api/articles/${id}/cancel`), {
    status: 409,
    body: { error: 'not cancellable' },
  });
});

// ── Stale review ───────────────────────────────────────────────────────────

/** A review that has been superseded: the writer ran again after it. */
async function seedStaleReview(stage: string, status: string): Promise<string> {
  const id = await seed({ stage, status, seo_review: JSON.stringify(seoReview) });
  await session(id, 'seo_reviewer', 30);
  await session(id, 'writer', 10);
  return id;
}

test('publish approval is refused while the review is stale', { skip }, async () => {
  const id = await seedStaleReview('publish', 'waiting_approval');

  const seen = await detail(id);
  assert.equal(seen.reviewStale, true);
  assert.equal(seen.article.review_stale, true);
  assert.equal(
    seen.reviewStaleReason,
    'the draft was regenerated after the last seo_review - re-run seo_review',
  );

  const { status, body } = await post(`/api/articles/${id}/approve-publish`);
  assert.equal(status, 409);
  assert.equal(
    body.error,
    'seo_review must re-run before this article can publish - the draft changed after the last review',
  );
  assert.equal((await row(id)).status, 'waiting_approval', 'the article is left where it was');
});

test('approval goes through once the reviewer has seen the current draft', { skip }, async () => {
  const id = await seedStaleReview('publish', 'waiting_approval');
  // The operator retried seo_review; it ran after the writer this time.
  await session(id, 'seo_reviewer', 1);

  const seen = await detail(id);
  assert.equal(seen.reviewStale, false);
  assert.equal(seen.reviewStaleReason, null);

  const { status } = await post(`/api/articles/${id}/approve-publish`);
  assert.equal(status, 200);
  assert.equal((await row(id)).status, 'queued');
});

test('retrying straight to publish is refused while the review is stale', { skip }, async () => {
  const id = await seedStaleReview('done', 'failed');

  const { status, body } = await post(`/api/articles/${id}/retry-stage`, { stage: 'publish' });

  assert.equal(status, 409);
  assert.equal(body.error, 'seo_review must re-run before this article can publish');
  assert.equal((await row(id)).attempt, 1, 'nothing was re-queued');
});

test('a newer draft inside the write-review-edit loop is not stale', { skip }, async () => {
  const id = await seedStaleReview('seo_review', 'queued');
  assert.equal((await detail(id)).reviewStale, false);
});

test('retrying to publish from inside the loop is refused too', { skip }, async () => {
  // The case the guard exists for: a retry regenerated the draft and the run
  // then stopped inside the write/review/edit loop, where a newer draft is the
  // expected state. The article is not stale where it stands - but the stage
  // being asked for is publish, and that draft has never been reviewed.
  const id = await seedStaleReview('edit', 'failed');
  assert.equal((await detail(id)).reviewStale, false, 'not stale for the stage it is on');

  const { status, body } = await post(`/api/articles/${id}/retry-stage`, { stage: 'publish' });

  assert.equal(status, 409);
  assert.equal(body.error, 'seo_review must re-run before this article can publish');
  const after = await row(id);
  assert.equal(after.attempt, 1, 'nothing was re-queued');
  assert.equal(after.stale_from_stage, null);
  assert.equal(after.stage, 'edit', 'and the article is left where the run stopped');
});

test('retrying to an earlier stage is still allowed while the review is stale', { skip }, async () => {
  // Only publish is refused: re-running the reviewer is exactly the fix the
  // refusal asks for, so the retry that resolves it must go through.
  const id = await seedStaleReview('publish', 'failed');

  const { status } = await post(`/api/articles/${id}/retry-stage`, { stage: 'seo_review' });

  assert.equal(status, 200);
  assert.equal((await row(id)).stage, 'seo_review');
});

test('an isolated test run of the writer does not make the review stale', { skip }, async () => {
  const id = await seed({ stage: 'publish', status: 'waiting_approval', seo_review: JSON.stringify(seoReview) });
  await session(id, 'writer', 30);
  await session(id, 'seo_reviewer', 20);
  await session(id, 'writer', 1, { kind: 'test' });

  assert.equal((await detail(id)).reviewStale, false, 'a test writes nothing, so it changes nothing');
});

// ── Isolated stage test ────────────────────────────────────────────────────

test('test-stage runs the agent, records the spend and writes nothing', { skip }, async () => {
  const id = await seed({ stage: 'assemble', status: 'failed' });
  await post(`/api/articles/${id}/retry-stage`, { stage: 'assemble' });
  const before = await row(id);

  // The assembler is the one stage that is deterministic and LLM-free, so the
  // shared agent path can be driven here without a model.
  const { status, body } = await post(`/api/articles/${id}/test-stage`, { stage: 'assemble' });

  assert.equal(status, 200);
  assert.equal(body.stage, 'assemble');
  assert.equal(body.agent, 'assembler');
  assert.equal(body.model, null);
  assert.equal(typeof body.costUsd, 'number');
  assert.equal(typeof body.durationMs, 'number');
  const output = body.output as { body: string; frontmatter: Record<string, unknown> };
  assert.equal(typeof output.body, 'string');
  assert.equal(output.frontmatter.title, brief.seoTitle);

  const after = await row(id);
  for (const column of ['draft_md', 'frontmatter', 'affiliate_links', 'stage', 'status', 'attempt']) {
    assert.deepEqual(after[column], before[column], `test-stage must not write ${column}`);
  }

  const [recorded] = await q<{ kind: string; attempt: number; agent: string; status: string }>(
    'SELECT kind, attempt, agent, status FROM agent_sessions WHERE id = $1',
    [body.sessionId],
  );
  assert.deepEqual(recorded, { kind: 'test', attempt: 2, agent: 'assembler', status: 'done' });

  // A test session is spend, so it stays visible - but it is not pipeline
  // history, so it never counts as a stage having run.
  const seen = await detail(id);
  const assemble = (seen.attempts as Array<{ stage: string; runs: Array<{ kind: string }> }>).find(
    (group) => group.stage === 'assemble',
  )!;
  assert.deepEqual(assemble.runs.map((run) => run.kind), ['test']);
});

test('the publisher can never be reached by a test run', { skip }, async () => {
  const id = await seed({ stage: 'publish', status: 'waiting_approval' });

  assert.deepEqual(await post(`/api/articles/${id}/test-stage`, { stage: 'publish' }), {
    status: 400,
    body: { error: 'the publish stage cannot be tested in isolation' },
  });
  // 'done' is refused the same way publish is: for a test the question is
  // which stages may be run in isolation, not which stages a run can restart
  // from, so both get the one sentence.
  assert.deepEqual(await post(`/api/articles/${id}/test-stage`, { stage: 'done' }), {
    status: 400,
    body: { error: 'the publish stage cannot be tested in isolation' },
  });
});

test('a mid-stage article is not tested underneath the worker', { skip }, async () => {
  const id = await seed({ stage: 'assemble', status: 'running' });

  const { status, body } = await post(`/api/articles/${id}/test-stage`, { stage: 'assemble' });
  assert.equal(status, 409);
  assert.equal(body.error, 'the article is mid-stage - try again when it finishes');
});

test('a failing agent message is redacted before it is stored or served', { skip }, async () => {
  // The article's own category reaches the assembler's validation message, so
  // this is an agent failure carrying a string from outside the code - which
  // is what an SDK error about the child process it just ran is too, except
  // that one carries the child's environment.
  const leaked = process.env.SLE104_TEST_TOKEN!;
  const id = await seed({ stage: 'assemble', status: 'failed', category: leaked });

  const { status, body } = await post(`/api/articles/${id}/test-stage`, { stage: 'assemble' });

  assert.equal(status, 500);
  const served = body.error as string;
  assert.ok(served.includes('[redacted SLE104_TEST_TOKEN]'), served);
  assert.ok(!served.includes(leaked), 'the 500 body is what the panel renders verbatim');

  const [recorded] = await q<{ error: string }>(
    "SELECT error FROM agent_sessions WHERE article_id = $1 AND kind = 'test'",
    [id],
  );
  assert.ok(recorded.error.includes('[redacted SLE104_TEST_TOKEN]'), recorded.error);
  assert.ok(!recorded.error.includes(leaked), 'and the session row keeps no copy of it');
});

test('a failing test run still records what it spent', { skip }, async () => {
  // No outline and no draft: the assembler throws on the row it is handed.
  const id = await seed({ stage: 'assemble', status: 'failed', outline: null, draft_md: null });

  const { status, body } = await post(`/api/articles/${id}/test-stage`, { stage: 'assemble' });

  assert.equal(status, 500);
  assert.equal(typeof body.error, 'string');
  const [recorded] = await q<{ status: string; kind: string; error: string }>(
    "SELECT status, kind, error FROM agent_sessions WHERE article_id = $1 AND kind = 'test'",
    [id],
  );
  assert.equal(recorded.status, 'failed');
  assert.equal(typeof recorded.error, 'string');
});

// ── List payload ───────────────────────────────────────────────────────────

test('the board carries the retry state so the panel derives nothing', { skip }, async () => {
  const id = await seedStaleReview('publish', 'waiting_approval');
  await post(`/api/articles/${id}/retry-stage`, { stage: 'write' });

  const res = await app.fetch(new Request('http://localhost/api/articles', { headers: AUTH }));
  assert.equal(res.status, 200);
  const { articles } = (await res.json()) as { articles: Array<Record<string, unknown>> };
  const listed = articles.find((article) => article.id === id)!;

  assert.equal(listed.attempt, 2);
  assert.equal(listed.stale_from_stage, 'write');
  assert.equal(listed.review_stale, false, 'back inside the write loop, a newer draft is expected');
  assert.ok('claimed_at' in listed && 'heartbeat_at' in listed && 'lease_expires_at' in listed);
});

test('both article payloads carry the stage budgets the panel measures against', { skip }, async () => {
  const id = await seed();
  const expected = Object.fromEntries(STAGE_ORDER.map((stage) => [stage, stageBudgetSeconds(stage)]));

  const res = await app.fetch(new Request('http://localhost/api/articles', { headers: AUTH }));
  const list = (await res.json()) as { stageBudgets: Record<string, number> };
  assert.deepEqual(list.stageBudgets, expected);
  // Whether a run is slow or stuck is this number against the elapsed time, so
  // the detail view cannot be left to guess it either.
  assert.deepEqual((await detail(id)).stageBudgets, expected);
  assert.equal(typeof list.stageBudgets.write, 'number');
  assert.equal(typeof (await detail(id)).stageBudgets.seo_review, 'number');

  // The same numbers under the name the panel reads them by, so it prints the
  // limit a stage is actually running under instead of its built-in fallback.
  const { budgets } = (await detail(id)) as {
    budgets: { default_seconds: number; per_stage: Record<string, number> };
  };
  assert.equal(budgets.per_stage.seo_review, stageBudgetSeconds('seo_review'));
  assert.equal(typeof budgets.default_seconds, 'number');
});

// ── Republish ──────────────────────────────────────────────────────────────

test('the cheap republish door is closed while the review is stale too', { skip }, async () => {
  const id = await seedStaleReview('done', 'done');
  await q(`UPDATE articles SET frontmatter = '{"title": "t"}'::jsonb WHERE id = $1`, [id]);

  const refused = await post(`/api/articles/${id}/republish`);
  assert.equal(refused.status, 409);
  assert.equal(
    refused.body.error,
    'seo_review must re-run before this article can publish - the draft changed after the last review',
  );
  assert.equal((await row(id)).stage, 'done', 'nothing was queued for the publisher');

  // Re-run the reviewer and the same call goes through.
  await session(id, 'seo_reviewer', 1);
  assert.equal((await post(`/api/articles/${id}/republish`)).status, 200);
  assert.equal((await row(id)).stage, 'publish');
});
