// Two platforms sharing one pipeline, on a real database: neither may starve
// the other of workers, scout under the other's lock, stop when the other is
// paused, or work on an event-bound preview past its window.
//
// Each test makes its own pair of platforms, copied from the SleekDrops row so
// the test does not depend on every column of the platform schema. Every
// claim here is scoped to those platforms, so rows other test files leave on
// the shared database are never taken.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { pool, q, setSetting } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { clearPlatformCache, loadPlatform } = await import('../platform/registry.js');
const { SLEEKDROPS_PLATFORM_ID } = await import('../platform/sleekdrops/index.js');
const { claimNext } = await import('./worker.js');
const { activePlatforms } = await import('./platforms.js');
const { claimNextScoutRun, enqueueScoutRun, scoutQueueStatus } = await import('./scout.js');
const { scheduleScout } = await import('./scheduler.js');
const {
  admitClaimed,
  dropStartedEvents,
  EVENT_LEAD_HOURS,
  EVENT_STARTED_ERROR,
  eventStarted,
  stageMayStart,
} = await import('./eventWindow.js');

import type { ArticleRow } from './types.js';

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

// The migration seeds the SleekDrops platform and its `au` edition, which every
// test platform below is copied from.
if (reachable) await migrate();

const platforms: string[] = [];
const HOUR = 3_600_000;

after(async () => {
  if (reachable && platforms.length > 0) {
    await q('DELETE FROM agent_sessions WHERE platform_id = ANY($1)', [platforms]);
    await q('DELETE FROM articles WHERE platform_id = ANY($1)', [platforms]);
    await q('DELETE FROM topics WHERE platform_id = ANY($1)', [platforms]);
    await q('DELETE FROM scout_runs WHERE platform_id = ANY($1)', [platforms]);
    await q('DELETE FROM settings WHERE platform_id = ANY($1)', [platforms]);
    await q('DELETE FROM editions WHERE platform_id = ANY($1)', [platforms]);
    await q('DELETE FROM platforms WHERE id = ANY($1)', [platforms]);
    clearPlatformCache();
  }
  if (reachable) await pool.end();
});

/** A platform copied from SleekDrops, with its `au` edition and any extra editions. */
async function makePlatform(extraEditions: string[] = []): Promise<string> {
  const id = `test-${randomUUID().slice(0, 8)}`;
  platforms.push(id);
  await q(
    `INSERT INTO platforms
     SELECT (jsonb_populate_record(NULL::platforms,
               to_jsonb(p) || jsonb_build_object('id', $1::text, 'name', $1::text))).*
     FROM platforms p WHERE p.id = $2`,
    [id, SLEEKDROPS_PLATFORM_ID],
  );
  for (const edition of ['au', ...extraEditions]) {
    await q(
      `INSERT INTO editions
       SELECT (jsonb_populate_record(NULL::editions,
                 to_jsonb(e) || jsonb_build_object('platform_id', $1::text, 'id', $3::text))).*
       FROM editions e WHERE e.platform_id = $2 AND e.id = 'au'`,
      [id, SLEEKDROPS_PLATFORM_ID, edition],
    );
  }
  clearPlatformCache();
  return id;
}

async function queueArticle(
  platformId: string,
  options: { waitingSince?: string; eventStartsAt?: Date | null; status?: string } = {},
): Promise<string> {
  const [row] = await q<{ id: string }>(
    `INSERT INTO articles (title, category, post_type, stage, status, platform_id, edition_id,
                           event_starts_at, updated_at)
     VALUES ('Fair claim card', 'Tech', 'guide', 'research', $1, $2, 'au', $3, $4)
     RETURNING id`,
    [
      options.status ?? 'queued',
      platformId,
      options.eventStartsAt ?? null,
      options.waitingSince ?? '2000-01-01T00:00:00Z',
    ],
  );
  return row.id;
}

async function article(id: string): Promise<ArticleRow> {
  return (await q<ArticleRow>('SELECT * FROM articles WHERE id = $1', [id]))[0];
}

/** Hand a claimed article back as a stage that finished: queued again for its next stage. */
async function finishStage(id: string): Promise<void> {
  await q(
    `UPDATE articles SET status = 'queued', stage = 'outline', claimed_by = NULL, claimed_at = NULL,
            heartbeat_at = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE id = $1`,
    [id],
  );
}

// ── Fair claims ─────────────────────────────────────────────────────────────

test('a deep backlog on one platform cannot starve the other of claims', { skip }, async () => {
  const busy = await makePlatform();
  const quiet = await makePlatform();
  // The busy platform's backlog is all older than the quiet platform's work,
  // which is exactly the case a global oldest-first claim starves.
  for (let i = 0; i < 6; i++) await queueArticle(busy, { waitingSince: `1990-01-0${i + 1}` });
  await queueArticle(quiet, { waitingSince: '2001-01-01' });
  await queueArticle(quiet, { waitingSince: '2001-01-02' });

  // One worker running one stage at a time: claim, finish, claim again.
  const order: string[] = [];
  for (let i = 0; i < 4; i++) {
    const claimed = await claimNext([busy, quiet]);
    assert.ok(claimed, `claim ${i + 1}`);
    order.push(claimed.platform_id);
    await finishStage(claimed.id);
  }
  assert.deepEqual(order, [busy, quiet, busy, quiet], 'claims alternate between the platforms');
});

test('claims held at once split the running capacity across platforms', { skip }, async () => {
  const older = await makePlatform();
  const newer = await makePlatform();
  for (let i = 0; i < 4; i++) await queueArticle(older, { waitingSince: `1980-01-0${i + 1}` });
  for (let i = 0; i < 4; i++) await queueArticle(newer, { waitingSince: `1985-01-0${i + 1}` });

  // Nothing is finished in between: the fewest-running platform goes next.
  const held: string[] = [];
  for (let i = 0; i < 4; i++) held.push((await claimNext([older, newer]))!.platform_id);
  assert.deepEqual(held, [older, newer, older, newer]);
});

test('two workers claiming at once never take the same article', { skip }, async () => {
  const platformId = await makePlatform();
  for (let i = 0; i < 3; i++) await queueArticle(platformId, { waitingSince: `1975-01-0${i + 1}` });
  const claims = await Promise.all([claimNext([platformId]), claimNext([platformId])]);
  assert.equal(new Set(claims.map((claim) => claim?.id)).size, 2);
});

test('every claimed article carries its platform and edition', { skip }, async () => {
  const platformId = await makePlatform(['global']);
  const [row] = await q<{ id: string }>(
    `INSERT INTO articles (title, category, post_type, stage, status, platform_id, edition_id, updated_at)
     VALUES ('Edition card', 'Tech', 'guide', 'research', 'queued', $1, 'global', '1970-01-01')
     RETURNING id`,
    [platformId],
  );
  const claimed = await claimNext([platformId]);
  assert.equal(claimed?.id, row.id);
  assert.equal(claimed?.platform_id, platformId);
  assert.equal(claimed?.edition_id, 'global');
});

// ── Pausing ─────────────────────────────────────────────────────────────────

test('pausing one platform stops its claims and leaves the other running', { skip }, async () => {
  const paused = await makePlatform();
  const running = await makePlatform();
  const pausedArticle = await queueArticle(paused, { waitingSince: '1970-01-01' });
  const runningArticle = await queueArticle(running, { waitingSince: '1999-01-01' });

  await setSetting(paused, 'worker_enabled', false);
  const active = (await activePlatforms()).map((platform) => platform.id);
  assert.ok(!active.includes(paused), 'the paused platform is not worked');
  assert.ok(active.includes(running), 'the other platform still is');

  const ours = active.filter((id) => id === paused || id === running);
  assert.equal((await claimNext(ours))?.id, runningArticle);
  assert.equal(await claimNext(ours), null, "the paused platform's older article stays queued");
  assert.equal((await article(pausedArticle)).status, 'queued');

  await setSetting(paused, 'worker_enabled', true);
  assert.ok((await activePlatforms()).some((platform) => platform.id === paused), 'and resumes');
});

test('a paused platform schedules nothing; the other keeps its own cadence', { skip }, async () => {
  const paused = await makePlatform();
  const live = await makePlatform(['global']);
  await setSetting(paused, 'worker_enabled', false);

  const active = await activePlatforms();
  assert.ok(!active.some((platform) => platform.id === paused));

  const queued = await scheduleScout(await loadPlatform(live));
  assert.equal(queued.length, 2, 'one topic search per edition');
  const runs = await q<{ platform_id: string; edition_id: string }>(
    'SELECT platform_id, edition_id FROM scout_runs WHERE id = ANY($1) ORDER BY edition_id',
    [queued],
  );
  assert.deepEqual(
    runs.map((run) => `${run.platform_id}/${run.edition_id}`),
    [`${live}/au`, `${live}/global`],
  );
  assert.deepEqual(await scheduleScout(await loadPlatform(live)), [], 'not again while pending');
});

// ── Per-platform scheduling ─────────────────────────────────────────────────

test("each platform's scout is due on its own settings and its own history", { skip }, async () => {
  const daily = await makePlatform();
  const off = await makePlatform();
  const hourly = await makePlatform();
  await setSetting(off, 'scout_interval_hours', 0);
  await setSetting(hourly, 'scout_interval_hours', 1);

  // A search pending on one platform does not hold the others back.
  assert.equal((await scheduleScout(await loadPlatform(daily))).length, 1);
  assert.deepEqual(await scheduleScout(await loadPlatform(off)), [], 'interval 0 turns it off');
  const [run] = await scheduleScout(await loadPlatform(hourly));
  assert.ok(run, 'due despite the other platform having a search queued');

  // Ran two hours ago: overdue on an hourly cadence, not due on a daily one.
  await q(
    `UPDATE scout_runs SET status = 'done', started_at = now() - interval '2 hours', ended_at = now()
     WHERE platform_id = ANY($1)`,
    [[daily, hourly]],
  );
  assert.deepEqual(await scheduleScout(await loadPlatform(daily)), []);
  assert.equal((await scheduleScout(await loadPlatform(hourly))).length, 1);
});

test("one platform's untriaged suggestions only hold back its own scout", { skip }, async () => {
  const full = await makePlatform();
  const other = await makePlatform();
  await setSetting(full, 'max_pending_suggestions', 2);
  for (const title of ['One', 'Two']) {
    await q(
      `INSERT INTO topics (title, norm_title, category, platform_id, edition_id)
       VALUES ($1, $2, 'Tech', $3, 'au')`,
      [title, title.toLowerCase(), full],
    );
  }
  assert.deepEqual(await scheduleScout(await loadPlatform(full)), []);
  assert.equal((await scheduleScout(await loadPlatform(other))).length, 1);
});

// ── Scout lock isolation ────────────────────────────────────────────────────

test('two platforms scout at once, and one platform never runs two', { skip }, async () => {
  const left = await makePlatform();
  const right = await makePlatform();
  for (const platformId of [left, right]) {
    await enqueueScoutRun(platformId, 'au');
    await enqueueScoutRun(platformId, 'au');
  }

  const claims = await Promise.all([
    claimNextScoutRun(left),
    claimNextScoutRun(left),
    claimNextScoutRun(right),
    claimNextScoutRun(right),
  ]);
  const won = claims.filter((claim) => claim !== null);
  assert.deepEqual(won.map((claim) => claim.platform_id).sort(), [left, right].sort());
  assert.ok(won.every((claim) => claim.edition_id === 'au'), 'a claim says which edition it scouts');

  assert.deepEqual(await scoutQueueStatus(left), { queued: 1, running: 1 });
  assert.deepEqual(await scoutQueueStatus(right), { queued: 1, running: 1 });
  assert.equal(await claimNextScoutRun(left), null, 'its first search is still live');
});

test("one platform's held scout lock does not block another platform's claim", { skip }, async () => {
  const held = await makePlatform();
  const free = await makePlatform();
  await enqueueScoutRun(held, 'au');
  const freeRun = await enqueueScoutRun(free, 'au');

  // The same key claimNextScoutRun takes, held by another session.
  const blocker = await pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('sleekdrops:topic-scout:' || $1, 0))",
      [held],
    );
    let heldClaimSettled = false;
    const heldClaim = claimNextScoutRun(held).finally(() => {
      heldClaimSettled = true;
    });

    assert.equal((await claimNextScoutRun(free))?.id, freeRun, 'claimed while the other lock is held');
    assert.equal(heldClaimSettled, false, "the held platform's claim waits on its own lock");

    await blocker.query('COMMIT');
    assert.equal((await heldClaim)?.platform_id, held);
  } finally {
    blocker.release();
  }
});

// ── Kick-off window ─────────────────────────────────────────────────────────

test('the lead window and kick-off, as pure rules', () => {
  const kickOff = new Date('2026-10-10T08:00:00Z');
  const at = (hoursBefore: number) => new Date(kickOff.getTime() - hoursBefore * HOUR);
  assert.equal(EVENT_LEAD_HOURS, 6);
  assert.equal(stageMayStart(null, at(0)), true, 'not event-bound: always');
  assert.equal(stageMayStart(kickOff.toISOString(), at(6.01)), true);
  assert.equal(stageMayStart(kickOff, at(6)), false, 'exactly six hours out is inside');
  assert.equal(stageMayStart(kickOff, at(1)), false);
  assert.equal(eventStarted(kickOff, at(0.01)), false);
  assert.equal(eventStarted(kickOff, at(0)), true);
  assert.equal(eventStarted(null, at(-100)), false);
});

test('an event-bound article is not claimed inside six hours of kick-off', { skip }, async () => {
  const platformId = await makePlatform();
  const soon = await queueArticle(platformId, {
    waitingSince: '1970-01-01',
    eventStartsAt: new Date(Date.now() + 5 * HOUR),
  });
  const later = await queueArticle(platformId, {
    waitingSince: '1971-01-01',
    eventStartsAt: new Date(Date.now() + 7 * HOUR),
  });
  const unbound = await queueArticle(platformId, { waitingSince: '1972-01-01' });

  const first = await claimNext([platformId]);
  const second = await claimNext([platformId]);
  assert.deepEqual([first?.id, second?.id], [later, unbound], 'the older, too-late one is skipped');
  assert.equal(await claimNext([platformId]), null);
  assert.equal((await article(soon)).status, 'queued', 'held, not dropped, until kick-off');
});

test('kick-off drops every unfinished event-bound article with the reason', { skip }, async () => {
  const platformId = await makePlatform();
  const past = new Date(Date.now() - HOUR);
  const queued = await queueArticle(platformId, { eventStartsAt: past });
  const waiting = await queueArticle(platformId, { eventStartsAt: past, status: 'waiting_approval' });
  const failed = await queueArticle(platformId, { eventStartsAt: past, status: 'failed' });
  const running = await queueArticle(platformId, { eventStartsAt: past, status: 'running' });
  await q(
    `UPDATE articles SET claimed_by = 'gone-worker/1', lease_expires_at = now() + interval '5 minutes'
     WHERE id = $1`,
    [running],
  );
  await q(
    `INSERT INTO agent_sessions (article_id, platform_id, agent) VALUES ($1, $2, 'researcher')`,
    [running, platformId],
  );
  const upcoming = await queueArticle(platformId, { eventStartsAt: new Date(Date.now() + HOUR) });
  const unbound = await queueArticle(platformId);
  const [published] = await q<{ id: string }>(
    `INSERT INTO articles (title, category, post_type, stage, status, platform_id, edition_id, event_starts_at)
     VALUES ('Published preview', 'Tech', 'guide', 'done', 'done', $1, 'au', $2) RETURNING id`,
    [platformId, past],
  );

  assert.ok((await dropStartedEvents()) >= 4);

  for (const id of [queued, waiting, failed, running]) {
    const row = await article(id);
    assert.equal(row.status, 'cancelled', `${id} dropped`);
    assert.equal(row.error, EVENT_STARTED_ERROR);
  }
  const lapsed = await article(running);
  assert.ok(new Date(lapsed.lease_expires_at!).getTime() <= Date.now(), 'its run loses the lease');
  const [session] = await q<{ status: string; error: string }>(
    'SELECT status, error FROM agent_sessions WHERE article_id = $1',
    [running],
  );
  assert.deepEqual(session, { status: 'failed', error: EVENT_STARTED_ERROR });

  assert.equal((await article(upcoming)).status, 'queued', 'before kick-off it is only held');
  assert.equal((await article(unbound)).status, 'queued', 'not event-bound');
  assert.equal((await article(published.id)).status, 'done', 'a finished preview is left alone');
});

test('a claimed stage is checked again on the worker clock before it runs', { skip }, async () => {
  const platformId = await makePlatform();
  const kickOff = new Date(Date.now() + 8 * HOUR);
  await queueArticle(platformId, { eventStartsAt: kickOff, waitingSince: '1970-01-01' });

  const outside = await claimNext([platformId]);
  assert.ok(outside);
  assert.equal(await admitClaimed(outside, new Date(kickOff.getTime() - 7 * HOUR)), true);

  // The worker's clock says the window has opened: the claim goes back.
  assert.equal(await admitClaimed(outside, new Date(kickOff.getTime() - 5 * HOUR)), false);
  const held = await article(outside.id);
  assert.equal(held.status, 'queued');
  assert.equal(held.claimed_by, null);

  // Past kick-off: dropped with the reason.
  const again = await claimNext([platformId]);
  assert.ok(again);
  assert.equal(await admitClaimed(again, new Date(kickOff.getTime() + 1)), false);
  const dropped = await article(again.id);
  assert.equal(dropped.status, 'cancelled');
  assert.equal(dropped.error, EVENT_STARTED_ERROR);
  assert.equal(dropped.claimed_by, null);
});
