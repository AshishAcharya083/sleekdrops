// The timeout machinery where it lands: real article rows, real sessions, and
// the admin route the panel retries through.
//
// The 2702-minute seo_reviewer row is the case under test. Nothing bounded how
// long a stage could run, and the only code that noticed a stranded claim ran
// at boot - so a wedged run survived until someone restarted the container.
// Two things have to be true here: a stage that never settles is stopped by
// its own budget, and a claim nobody is renewing is reaped by a worker that is
// already running.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_TOKEN = 'test-admin-token';
// A stage that never settles has to be stopped in a second here, not in an
// hour. Set before config.js reads it.
process.env.AGENT_RUN_TIMEOUT_SECONDS = '1';
// The stages below run with an injected body, but a planted credential is what
// the scrubbing assertions are about - and no test may reach a live model.
process.env.CLAUDE_CODE_OAUTH_TOKEN = `sk-ant-oat01-${'Tk7'.repeat(20)}`;
delete process.env.ANTHROPIC_API_KEY;

const PLANTED_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;

const { pool, q } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { createApp } = await import('../api/server.js');
const { config } = await import('../config.js');
const { runStage } = await import('./runner.js');
const { renewLease, STAGE_LEASE_SECONDS } = await import('./lease.js');
const { noteLlmCall } = await import('../llm/callTrace.js');
const { claimNext, isReapTick, reapExpiredLeases, recoverStranded } = await import('./worker.js');

import type { ArticleRow } from './types.js';

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

if (reachable) await migrate();

const app = createApp();
const AUTH = { Authorization: 'Bearer test-admin-token' };
const created: string[] = [];

after(async () => {
  if (reachable && created.length > 0) {
    await q('DELETE FROM agent_sessions WHERE article_id = ANY($1)', [created]);
    await q('DELETE FROM articles WHERE id = ANY($1)', [created]);
  }
  if (reachable) await pool.end();
});

const DRAFT = '## Half a draft\n\nThe stage got this far before it stopped.';

/**
 * An article claimed for the assemble stage. Deterministic on purpose: the
 * assembler needs no model, so the run reaches its budget rather than failing
 * on a missing credential first.
 */
async function claimedArticle(leaseSecondsFromNow = STAGE_LEASE_SECONDS): Promise<ArticleRow> {
  const [row] = await q<ArticleRow>(
    `INSERT INTO articles (title, category, post_type, stage, status, claimed_by, claimed_at,
                           heartbeat_at, lease_expires_at, attempt, draft_md)
     VALUES ('Lease test card', 'Tech', 'guide', 'assemble', 'running', 'test-worker', now(),
             now(), now() + make_interval(secs => $1), 1, $2)
     RETURNING *`,
    [leaseSecondsFromNow, DRAFT],
  );
  created.push(row.id);
  return row;
}

async function reload(id: string): Promise<ArticleRow> {
  return (await q<ArticleRow>('SELECT * FROM articles WHERE id = $1', [id]))[0];
}

async function sessionsFor(id: string) {
  return q<{ status: string; error: string | null; attempt: number }>(
    'SELECT status, error, attempt FROM agent_sessions WHERE article_id = $1 ORDER BY started_at',
    [id],
  );
}

/** A stage body that never settles - the failure every guard here is for. */
const neverSettles = () => new Promise<never>(() => {});

/**
 * The same body, having started a model call first. `noteLlmCall` is what
 * chat() itself calls on every attempt, so this is the real path by which the
 * stage's last call reaches the message - without a live model.
 */
const hangsOnAModel = () => {
  noteLlmCall({
    model: 'claude-opus-5',
    search: true,
    attempt: 2,
    attemptsAllowed: 3,
    startedAt: Date.now(),
  });
  return neverSettles();
};

test('a stage that never settles is stopped at its budget and marked timed_out', { skip }, async () => {
  const article = await claimedArticle();

  await runStage(article, hangsOnAModel);

  const stopped = await reload(article.id);
  assert.equal(stopped.status, 'timed_out');
  assert.equal(stopped.stage, 'assemble', 'it stops where it was, it does not advance');
  assert.equal(stopped.draft_md, DRAFT, 'partial output is kept as a draft');
  assert.equal(stopped.claimed_by, null);
  assert.equal(stopped.lease_expires_at, null, 'a stopped run holds no lease');

  assert.match(stopped.error ?? '', /assembler/);
  assert.match(stopped.error ?? '', /assemble stage/);
  assert.match(stopped.error ?? '', /1 second/);
  assert.match(
    stopped.error ?? '',
    /Last LLM call attempted: claude-opus-5 with web search, retry 1 of 2, still in flight/,
    'the message names what the stage was waiting on',
  );
  assert.match(stopped.error ?? '', /saved as a draft/);

  const [session] = await sessionsFor(article.id);
  assert.equal(session.status, 'timed_out', 'a timeout is not a failure');
  assert.equal(session.error, stopped.error);
  assert.equal(session.attempt, 1, 'the session records which attempt it ran under');
});

test('no credential reaches a persisted error string', { skip }, async () => {
  const article = await claimedArticle();
  const sdkError = () =>
    Promise.reject(
      new Error(
        'Claude Code process exited with code 1\n' +
          `  spawn env: {"CLAUDE_CODE_OAUTH_TOKEN":"${PLANTED_TOKEN}"}`,
      ),
    );

  await runStage(article, sdkError);

  const failed = await reload(article.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error?.includes(PLANTED_TOKEN), false);
  assert.match(failed.error ?? '', /\[redacted CLAUDE_CODE_OAUTH_TOKEN\]/);
  const [session] = await sessionsFor(article.id);
  assert.equal(session.error?.includes(PLANTED_TOKEN), false);
});

test('a lease that stops being refreshed is reaped on the tick, not on a restart', { skip }, async () => {
  const lapsed = await claimedArticle();
  const live = await claimedArticle(600);
  await q("INSERT INTO agent_sessions (article_id, agent, status) VALUES ($1, 'assembler', 'running')", [
    lapsed.id,
  ]);
  await q("INSERT INTO agent_sessions (article_id, agent, status) VALUES ($1, 'assembler', 'running')", [
    live.id,
  ]);

  // The worker runs this on every Nth poll rather than only at boot.
  assert.equal(isReapTick(config.reaperEveryTicks), true);
  assert.equal(isReapTick(config.reaperEveryTicks - 1), false);
  // Let the lease lapse immediately before the sweep: this database is shared
  // with the other db test files, and a row left expired is a row another
  // file's boot recovery may legitimately pick up first.
  await q("UPDATE articles SET lease_expires_at = now() - interval '1 minute' WHERE id = $1", [
    lapsed.id,
  ]);
  assert.ok((await reapExpiredLeases()) >= 1);

  const reaped = await reload(lapsed.id);
  assert.equal(reaped.status, 'timed_out');
  assert.equal(reaped.stage, 'assemble');
  assert.equal(reaped.draft_md, DRAFT);
  assert.equal(reaped.lease_expires_at, null);
  assert.match(reaped.error ?? '', /stopped reporting progress/);
  assert.match(reaped.error ?? '', /assembler/);
  const [reapedSession] = await sessionsFor(lapsed.id);
  assert.equal(reapedSession.status, 'timed_out');
  assert.equal(reapedSession.error, reaped.error);

  const untouched = await reload(live.id);
  assert.equal(untouched.status, 'running', 'a renewed lease is left alone');
  const [liveSession] = await sessionsFor(live.id);
  assert.equal(liveSession.status, 'running');

  await q("UPDATE articles SET status = 'cancelled' WHERE id = $1", [live.id]);
  await q("UPDATE agent_sessions SET status = 'done' WHERE article_id = $1", [live.id]);
});

test('renewing a lease pushes it forward, and only while the claim is live', { skip }, async () => {
  const article = await claimedArticle(-60);

  assert.equal(await renewLease(article.id), true);
  const renewed = await reload(article.id);
  assert.ok(new Date(renewed.lease_expires_at!).getTime() > Date.now(), 'the lease moved forward');
  assert.ok(new Date(renewed.heartbeat_at!).getTime() >= new Date(article.heartbeat_at!).getTime());

  await q("UPDATE articles SET status = 'cancelled' WHERE id = $1", [article.id]);
  assert.equal(await renewLease(article.id), false, 'a claim that is gone cannot be renewed');
});

test('recoverStranded re-queues a lapsed claim at boot and leaves a live one alone', { skip }, async () => {
  const lapsed = await claimedArticle(-60);
  const live = await claimedArticle(600);
  await q("INSERT INTO agent_sessions (article_id, agent, status) VALUES ($1, 'assembler', 'running')", [
    lapsed.id,
  ]);

  await recoverStranded();

  const requeued = await reload(lapsed.id);
  assert.equal(requeued.status, 'queued', 'a process that died never spent the budget');
  assert.equal(requeued.claimed_by, null);
  assert.equal(requeued.lease_expires_at, null);
  const [session] = await sessionsFor(lapsed.id);
  assert.equal(session.status, 'failed');
  assert.match(session.error ?? '', /re-queued/);

  assert.equal((await reload(live.id)).status, 'running', 'another instance is still working');

  await q("UPDATE articles SET status = 'cancelled' WHERE id = ANY($1)", [[lapsed.id, live.id]]);
});

test('POST /api/articles/:id/retry re-queues a timed-out article', { skip }, async () => {
  const article = await claimedArticle();
  await runStage(article, neverSettles);
  assert.equal((await reload(article.id)).status, 'timed_out');

  const res = await app.fetch(
    new Request(`http://localhost/api/articles/${article.id}/retry`, {
      method: 'POST',
      headers: AUTH,
    }),
  );
  assert.equal(res.status, 200);

  const retried = await reload(article.id);
  assert.equal(retried.status, 'queued');
  assert.equal(retried.stage, 'assemble', 'it retries from the stage that stopped');
  assert.equal(retried.error, null);
  assert.equal(retried.draft_md, DRAFT, 'the partial draft is still there to retry from');

  await q("UPDATE articles SET status = 'cancelled' WHERE id = $1", [article.id]);
});

test('claiming an article takes its lease and counts the attempt', { skip }, async () => {
  // Dated to the epoch so this row is the longest-waiting one in the table and
  // the claim is deterministic on a database shared with the other test files.
  const [queued] = await q<ArticleRow>(
    `INSERT INTO articles (title, category, post_type, stage, status, updated_at)
     VALUES ('Lease claim test card', 'Tech', 'guide', 'research', 'queued', '1970-01-01')
     RETURNING *`,
  );
  created.push(queued.id);
  assert.equal(queued.attempt, 0);

  const claimed = await claimNext();

  assert.equal(claimed?.id, queued.id, 'the longest-waiting queued article');
  assert.equal(claimed?.status, 'running');
  assert.ok(claimed?.claimed_by?.startsWith('worker-'));
  assert.equal(claimed?.attempt, 1, 'the claim is the attempt');
  const leaseMs = new Date(claimed!.lease_expires_at!).getTime() - Date.now();
  assert.ok(leaseMs > 0 && leaseMs <= STAGE_LEASE_SECONDS * 1000, `lease of ${leaseMs}ms`);
  assert.ok(claimed?.heartbeat_at, 'and the heartbeat starts with it');

  await q("UPDATE articles SET status = 'cancelled' WHERE id = $1", [queued.id]);
});

test('a reaped run that finishes late does not land on the claim that replaced it', { skip }, async () => {
  const article = await claimedArticle();
  // The retry's own claim, taken while the first run is still in flight.
  await q("UPDATE articles SET attempt = attempt + 1, status = 'running' WHERE id = $1", [
    article.id,
  ]);

  // The first run finally answers, routing the article to the next stage.
  await runStage(article, async () => ({
    next: { stage: 'image', status: 'queued' },
    summary: 'late answer from a run nobody is waiting for',
  }));

  const current = await reload(article.id);
  assert.equal(current.stage, 'assemble', 'the live claim keeps the stage it is working');
  assert.equal(current.status, 'running');

  await q("UPDATE articles SET status = 'cancelled' WHERE id = $1", [article.id]);
});
