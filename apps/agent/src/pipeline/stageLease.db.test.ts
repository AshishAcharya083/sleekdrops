// The timeout machinery where it lands: real article rows, real sessions.
//
// The 2702-minute seo_reviewer row is the case under test. Nothing bounded how
// long a stage could run, and the only code that noticed a stranded claim ran
// at boot - so a wedged run survived until someone restarted the container.
// Three things have to be true here: a stage that never settles is stopped by
// its own budget, a claim nobody is renewing is re-queued by a worker that is
// already running, and the run that lost its claim cannot then write over it.
//
// SLE-132: a lapsed claim used to be reaped to a terminal 'timed_out'. A lease
// only lapses when the process holding it has stopped - a redeploy, a memory
// kill, a scale-in - so it is re-queued now, up to a cap, the same way boot
// recovery always treated it, and a shutdown hands its claims back itself.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

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
const { config } = await import('../config.js');
const { runStage, updateArticle } = await import('./runner.js');
const { LEASE_LOST_MESSAGE, renewLease, startHeartbeat, STAGE_LEASE_SECONDS } = await import(
  './lease.js'
);
const { noteLlmCall } = await import('../llm/callTrace.js');
const {
  claimIdentity,
  claimNext,
  isReapTick,
  LEASE_REQUEUED_MESSAGE,
  MAX_LEASE_REQUEUES,
  reapExpiredLeases,
  recoverStranded,
  releaseHeldClaims,
  SHUTDOWN_RELEASED_MESSAGE,
  workerId,
  workerIdentity,
  workerStoppedRepeatedlyMessage,
} = await import('./worker.js');
const { retryFromStage } = await import('./retry.js');

import type { ArticleRow } from './types.js';

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

if (reachable) await migrate();

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
const HOLDER = 'test-worker';

async function claimedArticle(leaseSecondsFromNow = STAGE_LEASE_SECONDS): Promise<ArticleRow> {
  const [row] = await q<ArticleRow>(
    `INSERT INTO articles (platform_id, edition_id, title, category, post_type, stage, status, claimed_by, claimed_at,
                           heartbeat_at, lease_expires_at, attempt, draft_md)
     VALUES ('sleekdrops', 'au', 'Lease test card', 'Tech', 'guide', 'assemble', 'running', 'test-worker', now(),
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

test('a lease that stops being refreshed is re-queued on the tick, not on a restart', { skip }, async () => {
  const lapsed = await claimedArticle();
  const live = await claimedArticle(600);
  await q("INSERT INTO agent_sessions (platform_id, article_id, agent, status) VALUES ('sleekdrops', $1, 'assembler', 'running')", [
    lapsed.id,
  ]);
  await q("INSERT INTO agent_sessions (platform_id, article_id, agent, status) VALUES ('sleekdrops', $1, 'assembler', 'running')", [
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

  const requeued = await reload(lapsed.id);
  // Cancelled at once: a queued row on the shared database is a row another
  // file's claimNext may take.
  await q("UPDATE articles SET status = 'cancelled' WHERE id = $1", [lapsed.id]);
  assert.equal(requeued.status, 'queued', 'the worker is gone, so the stage runs again');
  assert.equal(requeued.stage, 'assemble', 'the same stage');
  assert.equal(requeued.draft_md, DRAFT, 'with the draft it had');
  assert.equal(requeued.attempt, 1, 'on the same attempt');
  assert.equal(requeued.lease_requeues, 1, 'and the re-queue is counted');
  assert.equal(requeued.error, null, 'nothing failed, so nothing is reported as an error');
  assert.equal(requeued.claimed_by, null);
  assert.equal(requeued.claimed_at, null);
  assert.equal(requeued.heartbeat_at, null);
  assert.equal(requeued.lease_expires_at, null);
  const [requeuedSession] = await sessionsFor(lapsed.id);
  assert.equal(requeuedSession.status, 'failed');
  assert.equal(requeuedSession.error, LEASE_REQUEUED_MESSAGE);
  assert.equal(requeuedSession.error, 'worker instance stopped mid-stage; stage re-queued');

  const untouched = await reload(live.id);
  assert.equal(untouched.status, 'running', 'a renewed lease is left alone');
  const [liveSession] = await sessionsFor(live.id);
  assert.equal(liveSession.status, 'running');

  await q("UPDATE articles SET status = 'cancelled' WHERE id = $1", [live.id]);
  await q("UPDATE agent_sessions SET status = 'done' WHERE article_id = $1", [live.id]);
});

test('past its re-queue cap a lapsed claim fails, keeping the stage and draft for a retry', { skip }, async () => {
  assert.equal(MAX_LEASE_REQUEUES, 2);
  const lastChance = await claimedArticle(-60);
  const exhausted = await claimedArticle(-60);
  await q('UPDATE articles SET lease_requeues = 1 WHERE id = $1', [lastChance.id]);
  await q('UPDATE articles SET lease_requeues = 2 WHERE id = $1', [exhausted.id]);
  await q("INSERT INTO agent_sessions (platform_id, article_id, agent, status) VALUES ('sleekdrops', $1, 'assembler', 'running')", [
    exhausted.id,
  ]);

  assert.ok((await reapExpiredLeases()) >= 2);

  const second = await reload(lastChance.id);
  await q("UPDATE articles SET status = 'cancelled' WHERE id = $1", [lastChance.id]);
  assert.equal(second.status, 'queued', 'the second re-queue is still automatic');
  assert.equal(second.lease_requeues, 2);

  const failed = await reload(exhausted.id);
  assert.equal(failed.status, 'failed', 'the third lapse is not re-queued');
  assert.equal(failed.stage, 'assemble', 'the stage is kept for Retry from this stage');
  assert.equal(failed.draft_md, DRAFT, 'and so is the draft');
  assert.equal(failed.failure_class, 'transient', 'nothing about the content failed');
  assert.equal(failed.lease_requeues, 2);
  assert.equal(failed.claimed_by, null);
  assert.equal(failed.lease_expires_at, null);
  assert.equal(failed.error, workerStoppedRepeatedlyMessage('assemble'));
  assert.match(failed.error ?? '', /worker instance running the assemble stage/);
  assert.match(failed.error ?? '', /stopped 3 times/);
  assert.match(failed.error ?? '', /Retry from this stage/);
  const [session] = await sessionsFor(exhausted.id);
  assert.equal(session.status, 'failed');
  assert.equal(session.error, failed.error);

  // The cap is per attempt: the operator's retry starts the count again.
  const retried = await retryFromStage(exhausted.id, 'assemble');
  assert.equal(retried.ok, true);
  const again = await reload(exhausted.id);
  await q("UPDATE articles SET status = 'cancelled' WHERE id = $1", [exhausted.id]);
  assert.equal(again.status, 'queued');
  assert.equal(again.attempt, 2);
  assert.equal(again.lease_requeues, 0, 'a retry resets the automatic re-queue count');
  assert.equal(again.draft_md, DRAFT);
});

test('renewing a lease pushes it forward, and only for the claim that took it', { skip }, async () => {
  const article = await claimedArticle(-60);

  assert.equal(await renewLease(article.id, HOLDER), true);
  const renewed = await reload(article.id);
  assert.ok(new Date(renewed.lease_expires_at!).getTime() > Date.now(), 'the lease moved forward');
  assert.ok(new Date(renewed.heartbeat_at!).getTime() >= new Date(article.heartbeat_at!).getTime());

  assert.equal(
    await renewLease(article.id, 'another-worker'),
    false,
    'a worker cannot renew the claim that replaced its own',
  );

  await q("UPDATE articles SET status = 'cancelled' WHERE id = $1", [article.id]);
  assert.equal(await renewLease(article.id, HOLDER), false, 'a claim that is gone cannot be renewed');
});

test('recoverStranded re-queues a lapsed claim at boot and leaves a live one alone', { skip }, async () => {
  const lapsed = await claimedArticle(-60);
  const live = await claimedArticle(600);
  await q("INSERT INTO agent_sessions (platform_id, article_id, agent, status) VALUES ('sleekdrops', $1, 'assembler', 'running')", [
    lapsed.id,
  ]);

  await recoverStranded();

  const requeued = await reload(lapsed.id);
  const untouched = await reload(live.id);
  await q("UPDATE articles SET status = 'cancelled' WHERE id = ANY($1)", [[lapsed.id, live.id]]);
  assert.equal(requeued.status, 'queued', 'a process that died never spent the budget');
  assert.equal(requeued.claimed_by, null);
  assert.equal(requeued.lease_expires_at, null);
  assert.equal(requeued.lease_requeues, 1, 'boot counts the re-queue exactly as the reaper does');
  const [session] = await sessionsFor(lapsed.id);
  assert.equal(session.status, 'failed');
  assert.equal(session.error, LEASE_REQUEUED_MESSAGE);

  assert.equal(untouched.status, 'running', 'another instance is still working');
});

test('boot recovery and the tick reaper reach the same state for the same lapsed claim', { skip }, async () => {
  // Two identical rows at each count: one for each path.
  const outcomes: Record<string, unknown>[] = [];
  for (const requeues of [0, MAX_LEASE_REQUEUES]) {
    const byReaper = await claimedArticle(-60);
    const byBoot = await claimedArticle(-60);
    await q('UPDATE articles SET lease_requeues = $2 WHERE id = ANY($1)', [
      [byReaper.id, byBoot.id],
      requeues,
    ]);
    await q(
      "INSERT INTO agent_sessions (platform_id, article_id, agent, status) SELECT 'sleekdrops', unnest($1::uuid[]), 'assembler', 'running'",
      [[byReaper.id, byBoot.id]],
    );

    // Each path is given only its own row: the other one is briefly live.
    await q("UPDATE articles SET lease_expires_at = now() + interval '1 hour' WHERE id = $1", [byBoot.id]);
    await reapExpiredLeases();
    await q("UPDATE articles SET lease_expires_at = now() - interval '1 minute' WHERE id = $1", [byBoot.id]);
    await recoverStranded();

    const shape = async (id: string) => {
      const row = await reload(id);
      const [session] = await sessionsFor(id);
      return {
        status: row.status,
        stage: row.stage,
        draft_md: row.draft_md,
        error: row.error,
        failure_class: row.failure_class,
        lease_requeues: row.lease_requeues,
        claimed_by: row.claimed_by,
        lease_expires_at: row.lease_expires_at,
        session_status: session.status,
        session_error: session.error,
      };
    };
    const reaped = await shape(byReaper.id);
    const recovered = await shape(byBoot.id);
    await q("UPDATE articles SET status = 'cancelled' WHERE id = ANY($1)", [[byReaper.id, byBoot.id]]);
    assert.deepEqual(recovered, reaped, `the two paths agree at ${requeues} prior re-queue(s)`);
    outcomes.push(reaped);
  }
  assert.equal(outcomes[0].status, 'queued');
  assert.equal(outcomes[1].status, 'failed', 'and both honour the cap');
});

test('the worker id names the Cloud Run revision it runs on', () => {
  assert.equal(workerIdentity('sleekdrops-agent-00042-xyz', 'ab12cd34'), 'worker-sleekdrops-agent-00042-xyz-ab12cd34');
  assert.equal(workerIdentity('', 'ab12cd34'), 'worker-ab12cd34', 'and stays short off Cloud Run');
  assert.ok(claimIdentity().startsWith(`${workerId}/`), 'every claim carries it');
});

test('a shutdown hands its claims back, and the run it abandoned writes nothing afterwards', { skip }, async () => {
  const mine = await claimedArticle();
  await q('UPDATE articles SET claimed_by = $2 WHERE id = $1', [mine.id, claimIdentity()]);
  const theirs = await claimedArticle();
  await q('UPDATE articles SET claimed_by = $2 WHERE id = $1', [
    theirs.id,
    `worker-another-instance/${randomUUID()}`,
  ]);
  const held = await reload(mine.id);

  let released: () => void = () => {};
  const shutdownDone = new Promise<void>((resolve) => {
    released = resolve;
  });
  let lateWrite: unknown;
  // The run is mid-stage when the process is told to stop: it wrote half a
  // draft under its claim, and is still working when the claim goes back.
  const run = runStage(held, async () => {
    await updateArticle(held, { draft_md: DRAFT + '\n\nMore, still under the claim.' });
    await shutdownDone;
    lateWrite = await updateArticle(held, { draft_md: '## Written after the shutdown' }).catch(
      (err: unknown) => err,
    );
    return { next: { stage: 'image', status: 'queued' }, summary: 'late answer' };
  });

  // Let the body reach its first write before the shutdown lands.
  await waitFor('the in-flight write', async () =>
    ((await reload(mine.id)).draft_md ?? '').includes('still under the claim'),
  );
  assert.equal(await releaseHeldClaims(), 1, 'only the claim this process holds');
  const requeued = await reload(mine.id);
  released();
  await run;

  const settled = await reload(mine.id);
  const other = await reload(theirs.id);
  await q("UPDATE articles SET status = 'cancelled' WHERE id = ANY($1)", [[mine.id, theirs.id]]);
  assert.equal(requeued.status, 'queued');
  assert.equal(requeued.claimed_by, null);
  assert.equal(requeued.lease_expires_at, null);
  assert.equal(requeued.lease_requeues, 0, 'a clean hand-back is not a lost claim');
  assert.match(requeued.draft_md ?? '', /still under the claim/, 'what it wrote under the claim is kept');

  assert.ok(lateWrite instanceof Error && /lease lost/.test(lateWrite.message));
  assert.equal(settled.status, 'queued', 'the abandoned run never overwrites the re-queued row');
  assert.equal(settled.stage, 'assemble', 'nor moves it on');
  assert.equal(settled.draft_md, requeued.draft_md, 'nor writes its late output');

  const [session] = await sessionsFor(mine.id);
  assert.equal(session.status, 'failed');
  assert.equal(session.error, SHUTDOWN_RELEASED_MESSAGE);

  assert.equal(other.status, 'running', "another instance's claim is not this shutdown's to release");
});

test('claiming an article takes its lease without spending an attempt', { skip }, async () => {
  // Dated to the epoch so this row is the longest-waiting one in the table and
  // the claim is deterministic on a database shared with the other test files.
  const [queued] = await q<ArticleRow>(
    `INSERT INTO articles (platform_id, edition_id, title, category, post_type, stage, status, updated_at)
     VALUES ('sleekdrops', 'au', 'Lease claim test card', 'Tech', 'guide', 'research', 'queued', '1970-01-01')
     RETURNING *`,
  );
  created.push(queued.id);
  assert.equal(queued.attempt, 1, 'the first pipeline pass is attempt 1');

  const claimed = await claimNext(['sleekdrops']);

  assert.equal(claimed?.id, queued.id, 'the longest-waiting queued article');
  assert.equal(claimed?.status, 'running');
  assert.ok(claimed?.claimed_by?.startsWith('worker-'));
  assert.equal(claimed?.attempt, 1, 'a claim is not a retry - only a retry spends an attempt');
  const leaseMs = new Date(claimed!.lease_expires_at!).getTime() - Date.now();
  assert.ok(leaseMs > 0 && leaseMs <= STAGE_LEASE_SECONDS * 1000, `lease of ${leaseMs}ms`);
  assert.ok(claimed?.heartbeat_at, 'and the heartbeat starts with it');

  await q("UPDATE articles SET status = 'cancelled' WHERE id = $1", [queued.id]);
});

/** Poll `until` for up to a second - the heartbeat under test renews in 20ms. */
async function waitFor(what: string, until: () => boolean | Promise<boolean>): Promise<void> {
  for (let waited = 0; waited < 1000; waited += 20) {
    if (await until()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test('a heartbeat renews while the claim is live and reports the moment it is not', { skip }, async () => {
  const article = await claimedArticle();
  const lost: true[] = [];
  const errors: unknown[] = [];
  const stop = startHeartbeat(
    article.id,
    HOLDER,
    { onLost: () => lost.push(true), onError: (err) => errors.push(err) },
    20,
  );

  try {
    await waitFor('the lease to be renewed', async () => {
      const now = await reload(article.id);
      return new Date(now.heartbeat_at!).getTime() > new Date(article.heartbeat_at!).getTime();
    });

    // The claim is taken away - a reap, or SLE-104's cancel expiring the lease.
    await q("UPDATE articles SET status = 'timed_out', claimed_by = NULL WHERE id = $1", [
      article.id,
    ]);
    await waitFor('the lost claim to be reported', () => lost.length > 0);

    const settled = await reload(article.id);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(
      new Date((await reload(article.id)).updated_at).getTime(),
      new Date(settled.updated_at).getTime(),
      'and it stops renewing rather than reporting the loss over and over',
    );
    assert.equal(lost.length, 1);
    assert.deepEqual(errors, []);
  } finally {
    stop();
  }
});

test('a heartbeat that fires more than twice its interval late says so, with the lag', { skip }, async () => {
  const article = await claimedArticle();
  // The clock the heartbeat reads: steady beats, then one that arrives a full
  // second after the last - a process that was frozen or starved of CPU.
  const beats = [0, 20, 40, 1040, 1060];
  let reads = 0;
  const clock = () => beats[Math.min(reads++, beats.length - 1)];
  const warned: string[] = [];
  const realWarn = console.warn;
  console.warn = (line: unknown) => {
    warned.push(String(line));
  };
  const stop = startHeartbeat(
    article.id,
    HOLDER,
    { onLost: () => {}, onError: () => {} },
    20,
    clock,
  );
  try {
    await waitFor('every scripted beat', () => reads >= beats.length);
  } finally {
    stop();
    console.warn = realWarn;
  }

  const late = warned.filter((line) => line.includes('"heartbeat_late"'));
  assert.equal(late.length, 1, 'on time beats say nothing');
  const fields = JSON.parse(late[0]);
  assert.equal(fields.level, 'warn');
  assert.equal(fields.article_id, article.id);
  assert.equal(fields.interval_ms, 20);
  assert.equal(fields.lag_ms, 980, 'the time past the interval the beat should have fired at');
});

test('a run whose claim was re-queued stops, writes nothing and says the lease is gone', { skip }, async () => {
  const article = await claimedArticle(-60);
  assert.equal(await reapExpiredLeases(), 1);
  const reaped = await reload(article.id);
  assert.equal(reaped.status, 'queued');

  // The reaped worker only finds out when it next tries to renew, which is
  // what starting the stage does first.
  await runStage(article, async () => ({
    next: { stage: 'image', status: 'queued' },
    summary: 'late answer from a run nobody is waiting for',
  }));

  const current = await reload(article.id);
  await q("UPDATE articles SET status = 'cancelled' WHERE id = $1", [article.id]);
  assert.equal(current.status, 'queued', 'the re-queue stands');
  assert.equal(current.stage, 'assemble', 'and the article did not advance');
  assert.equal(current.lease_requeues, 1);

  const sessions = await sessionsFor(article.id);
  const lost = sessions.at(-1)!;
  assert.equal(lost.status, 'failed');
  assert.equal(lost.error, LEASE_LOST_MESSAGE);
});

test('a stage abandoned at its budget cannot write its output afterwards', { skip }, async () => {
  const article = await claimedArticle();
  const LIVE_HALF = '## Written while the claim was live';
  // The body outlives the run waiting on it - nothing can cancel a promise -
  // so it comes back with an answer for an article that has since been timed
  // out and released. The write it makes then is the one that must not land.
  let late: Promise<void> = Promise.resolve();

  await runStage(article, async () => {
    await updateArticle(article, { draft_md: LIVE_HALF });
    late = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await assert.rejects(
        updateArticle(article, { draft_md: '## The half nobody is waiting for' }),
        /lease lost/,
        'and the stage is stopped rather than left to carry on writing',
      );
    })();
    return neverSettles();
  });

  const stopped = await reload(article.id);
  assert.equal(stopped.status, 'timed_out');
  assert.equal(stopped.draft_md, LIVE_HALF, 'what it wrote under a live claim is kept');

  await late;
  assert.equal(
    (await reload(article.id)).draft_md,
    LIVE_HALF,
    'and what it wrote after the claim was released is not',
  );
});

test('a run re-queued mid-stage cannot overwrite the re-queue when it finishes', { skip }, async () => {
  const article = await claimedArticle();

  // The stage is already running when its claim is taken away - the case the
  // 30-second heartbeat catches in production, forced here without the wait.
  await runStage(article, async () => {
    await q("UPDATE articles SET lease_expires_at = now() - interval '1 minute' WHERE id = $1", [
      article.id,
    ]);
    assert.equal(await reapExpiredLeases(), 1);
    return { next: { stage: 'image', status: 'queued' }, summary: 'late answer' };
  });

  const current = await reload(article.id);
  await q("UPDATE articles SET status = 'cancelled' WHERE id = $1", [article.id]);
  assert.equal(current.status, 'queued', 'the run that lost its claim does not resurrect itself');
  assert.equal(current.stage, 'assemble');
  assert.equal(current.claimed_by, null);
  const [session] = await sessionsFor(article.id);
  assert.equal(session.status, 'failed', 'and its session stays what the reaper wrote');
  assert.equal(session.error, LEASE_REQUEUED_MESSAGE);
});
