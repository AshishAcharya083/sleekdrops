// The insights job as a database contract: which posted items a poll picks
// up and when, what a reading writes, and the join that makes two placements
// comparable.
//
// No network is involved: the provider is a stub registered under a name
// unique to this file, so a poll here can never claim a concurrent suite's
// posts. The pure schedule and flag rules are insights.test.ts.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ADMIN_TOKEN = 'test-admin-token';

const { pool, q } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { registerProvider, unregisterProvider } = await import('./providers.js');
const {
  INSIGHT_CHECKPOINT_SECONDS,
  INSIGHT_RETRY_SECONDS,
  INSIGHT_WINDOW_SECONDS,
  UNCLICKABLE_COMMENT_LINK,
  claimDueInsights,
  collectItemInsights,
  insightsTick,
  placementPerformance,
} = await import('./insights.js');
const { createApp } = await import('../api/server.js');

import type { InsightSnapshot, LinkPlacement, SocialProvider } from './types.js';

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

if (reachable) await migrate();

const TOKEN = 'stub-insights-token-4b21e7';
const TOKEN_REF = 'stub-insights-token';
process.env.STUB_INSIGHTS_TOKEN = TOKEN;

const PROVIDER = `stub-insights-${randomUUID().slice(0, 8)}`;
const articles: string[] = [];
const connections: string[] = [];
const registered: string[] = [];

after(async () => {
  for (const name of registered) unregisterProvider(name);
  if (reachable) {
    // The queue rows, and the metrics keyed to them, cascade with the channel.
    await q('DELETE FROM channel_connections WHERE id = ANY($1)', [connections]);
    await q('DELETE FROM articles WHERE id = ANY($1)', [articles]);
  }
  await pool.end();
});

/** A provider that answers `fetchInsights` however the test needs it to. */
function stub(fetchInsights: () => Promise<InsightSnapshot>): string {
  const name = `${PROVIDER}-${randomUUID().slice(0, 8)}`;
  const provider: SocialProvider = {
    name,
    authenticate: async () => {
      throw new Error('not used here');
    },
    refreshToken: async () => {
      throw new Error('not used here');
    },
    post: async () => {
      throw new Error('not used here');
    },
    fetchInsights,
  };
  registerProvider(provider);
  registered.push(name);
  return name;
}

function reading(
  impressions: number | null,
  clicks: number | null,
  reactions: number | null = 0,
): InsightSnapshot {
  return { impressions, clicks, reactions, fetchedAt: new Date().toISOString() };
}

/** A posted queue item on its own channel, `postedSecondsAgo` in the past. */
async function posted(fields: {
  provider: string;
  placement?: LinkPlacement;
  postedSecondsAgo: number;
  insightsNextAt?: string | null;
  tokenRef?: string;
}): Promise<string> {
  const [connection] = await q<{ id: string }>(
    `INSERT INTO channel_connections (provider, external_account_id, token_ref)
     VALUES ($1, $2, $3) RETURNING id`,
    [fields.provider, `page-${randomUUID().slice(0, 8)}`, fields.tokenRef ?? TOKEN_REF],
  );
  connections.push(connection.id);

  const slug = `insights-${randomUUID().slice(0, 8)}`;
  const [article] = await q<{ id: string }>(
    `INSERT INTO articles (title, slug, category, post_type, stage, status)
     VALUES ('The headphones for a quiet commute', $1, 'Tech', 'guide', 'publish', 'done')
     RETURNING id`,
    [slug],
  );
  articles.push(article.id);

  const [item] = await q<{ id: string }>(
    `INSERT INTO distribution_queue
       (article_id, slug, channel_connection_id, provider, payload, placement,
        status, remote_post_id, posted_at, insights_next_at)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, 'posted', $6,
             now() - make_interval(secs => $7), $8)
     RETURNING id`,
    [
      article.id,
      slug,
      connection.id,
      fields.provider,
      fields.placement ?? 'first_comment',
      `${randomUUID().slice(0, 8)}_900`,
      fields.postedSecondsAgo,
      fields.insightsNextAt ?? null,
    ],
  );
  return item.id;
}

interface QueueState {
  status: string;
  last_error: string | null;
  insights_flag: string | null;
  insights_next_at: Date | null;
  insights_done: boolean;
  updated_at: Date;
}

async function state(id: string): Promise<QueueState> {
  const [row] = await q<QueueState>(
    `SELECT status, last_error, insights_flag, insights_next_at, insights_done, updated_at
     FROM distribution_queue WHERE id = $1`,
    [id],
  );
  return row;
}

async function metrics(
  id: string,
): Promise<Array<{ impressions: number | null; clicks: number | null; reactions: number | null }>> {
  return q('SELECT impressions, clicks, reactions FROM distribution_metrics WHERE queue_item_id = $1 ORDER BY fetched_at', [id]);
}

/** Seconds from now until `at`, which is how every schedule assertion reads. */
function secondsAway(at: Date | null): number {
  assert.ok(at, 'expected the item to still be scheduled for a reading');
  return (new Date(at).getTime() - Date.now()) / 1_000;
}

// ── The polling schedule ───────────────────────────────────────────────────

test('a post is not read back before its first checkpoint', { skip }, async () => {
  const provider = stub(async () => reading(10, 1));
  await posted({ provider, postedSecondsAgo: 60 });

  assert.deepEqual(await claimDueInsights([provider]), []);
});

test('a post past its first checkpoint is claimed and read back', { skip }, async () => {
  const provider = stub(async () => reading(412, 19, 9));
  const id = await posted({ provider, postedSecondsAgo: INSIGHT_CHECKPOINT_SECONDS[0] + 60 });

  const outcomes = await insightsTick({ availableProviders: () => [provider] });

  assert.deepEqual(outcomes, ['recorded']);
  assert.deepEqual(await metrics(id), [{ impressions: 412, clicks: 19, reactions: 9 }]);
});

test('the next reading is scheduled at the next widening checkpoint', { skip }, async () => {
  const provider = stub(async () => reading(412, 19));
  const id = await posted({ provider, postedSecondsAgo: INSIGHT_CHECKPOINT_SECONDS[0] + 60 });

  await insightsTick({ availableProviders: () => [provider] });

  // Posted an hour and a minute ago, so the six-hour checkpoint is what is
  // left of it - just under five hours away.
  const expected = INSIGHT_CHECKPOINT_SECONDS[1] - INSIGHT_CHECKPOINT_SECONDS[0] - 60;
  const away = secondsAway((await state(id)).insights_next_at);
  assert.ok(Math.abs(away - expected) < 60, `expected ~${expected}s away, got ${away}s`);
});

test('polling stops once the last checkpoint is behind the post', { skip }, async () => {
  const provider = stub(async () => reading(900, 40));
  const id = await posted({
    provider,
    postedSecondsAgo: INSIGHT_CHECKPOINT_SECONDS.at(-1)! + 3_600,
  });

  assert.deepEqual(await insightsTick({ availableProviders: () => [provider] }), ['recorded']);

  const now = await state(id);
  assert.equal(now.insights_next_at, null);
  assert.equal(now.insights_done, true, 'the schedule is spent');
  assert.deepEqual(await claimDueInsights([provider]), []);
});

test('a post past the collection window is never claimed again', { skip }, async () => {
  const provider = stub(async () => reading(900, 40));
  await posted({
    provider,
    postedSecondsAgo: INSIGHT_WINDOW_SECONDS + 3_600,
    // Even with a clock that says it is due: the window is the outer bound.
    insightsNextAt: new Date(Date.now() - 60_000).toISOString(),
  });

  assert.deepEqual(await insightsTick({ availableProviders: () => [provider] }), []);
});

test('claiming leases the item, so two polls cannot read the same post', { skip }, async () => {
  const provider = stub(async () => reading(412, 19));
  await posted({ provider, postedSecondsAgo: INSIGHT_CHECKPOINT_SECONDS[0] + 60 });

  const [first, second] = await Promise.all([
    claimDueInsights([provider]),
    claimDueInsights([provider]),
  ]);

  assert.equal(first.length + second.length, 1);
});

// ── Failures ───────────────────────────────────────────────────────────────

test('a failed reading is retried and leaves the post itself untouched', { skip }, async () => {
  const provider = stub(async () => {
    throw new Error(`the Page rejected the call with ${TOKEN}`);
  });
  const id = await posted({ provider, postedSecondsAgo: INSIGHT_CHECKPOINT_SECONDS[0] + 60 });
  const before = await state(id);

  assert.deepEqual(await insightsTick({ availableProviders: () => [provider] }), ['failed']);

  const now = await state(id);
  assert.deepEqual(await metrics(id), [], 'a failed reading records nothing');
  assert.equal(now.status, 'posted', 'the post is unaffected by a failed reading');
  assert.equal(now.last_error, before.last_error, 'the account of the post itself is not rewritten');
  assert.deepEqual(
    now.updated_at,
    before.updated_at,
    'a background reading is not activity on the post',
  );

  const away = secondsAway(now.insights_next_at);
  assert.ok(
    Math.abs(away - INSIGHT_RETRY_SECONDS) < 60,
    `expected a retry ~${INSIGHT_RETRY_SECONDS}s away, got ${away}s`,
  );

  // The thrown message carried the credential, the way a real Graph error can.
  const [row] = await q<{ dump: string }>(
    'SELECT distribution_queue::text AS dump FROM distribution_queue WHERE id = $1',
    [id],
  );
  assert.equal(row.dump.includes(TOKEN), false, 'a failed reading writes no token anywhere');
});

test('an unregistered adapter leaves the reading for later rather than failing', { skip }, async () => {
  const provider = stub(async () => reading(412, 19));
  const id = await posted({ provider, postedSecondsAgo: INSIGHT_CHECKPOINT_SECONDS[0] + 60 });
  const [item] = await claimDueInsights([provider]);

  const outcome = await collectItemInsights(item, { resolveProvider: () => null });

  assert.equal(outcome, 'unavailable');
  assert.deepEqual(await metrics(id), []);
  assert.ok(secondsAway((await state(id)).insights_next_at) > 0);
});

test('a channel whose secret is configured nowhere waits too', { skip }, async () => {
  const provider = stub(async () => reading(412, 19));
  const id = await posted({
    provider,
    postedSecondsAgo: INSIGHT_CHECKPOINT_SECONDS[0] + 60,
    tokenRef: `missing-secret-${randomUUID().slice(0, 8)}`,
  });

  assert.deepEqual(await insightsTick({ availableProviders: () => [provider] }), ['unavailable']);
  assert.deepEqual(await metrics(id), []);
  assert.equal((await state(id)).insights_done, false, 'the operator can still fix this');
});

// ── The flag ───────────────────────────────────────────────────────────────

test('a first-comment post with impressions and no clicks is flagged', { skip }, async () => {
  const provider = stub(async () => reading(4_000, 0, 31));
  const id = await posted({
    provider,
    placement: 'first_comment',
    postedSecondsAgo: INSIGHT_CHECKPOINT_SECONDS[0] + 60,
  });

  assert.deepEqual(await insightsTick({ availableProviders: () => [provider] }), ['flagged']);
  assert.equal((await state(id)).insights_flag, UNCLICKABLE_COMMENT_LINK);
});

test('the same numbers on an in_body post are not a flag', { skip }, async () => {
  const provider = stub(async () => reading(4_000, 0, 31));
  const id = await posted({
    provider,
    placement: 'in_body',
    postedSecondsAgo: INSIGHT_CHECKPOINT_SECONDS[0] + 60,
  });

  assert.deepEqual(await insightsTick({ availableProviders: () => [provider] }), ['recorded']);
  assert.equal((await state(id)).insights_flag, null);
});

test('a later reading that shows clicks clears the flag', { skip }, async () => {
  let clicks = 0;
  const provider = stub(async () => reading(4_000, clicks));
  const id = await posted({
    provider,
    placement: 'first_comment',
    postedSecondsAgo: INSIGHT_CHECKPOINT_SECONDS[0] + 60,
  });

  await insightsTick({ availableProviders: () => [provider] });
  assert.equal((await state(id)).insights_flag, UNCLICKABLE_COMMENT_LINK);

  clicks = 140;
  await q('UPDATE distribution_queue SET insights_next_at = now() WHERE id = $1', [id]);
  await insightsTick({ availableProviders: () => [provider] });

  assert.equal((await state(id)).insights_flag, null, 'the flag is a reading, not a verdict');
});

// ── The join ───────────────────────────────────────────────────────────────

test('placement is joined from the queue row, on the latest reading only', { skip }, async () => {
  const provider = stub(async () => reading(1_000, 50, 10));
  const comment = await posted({
    provider,
    placement: 'first_comment',
    postedSecondsAgo: INSIGHT_CHECKPOINT_SECONDS[0] + 60,
  });
  const body = await posted({
    provider,
    placement: 'in_body',
    postedSecondsAgo: INSIGHT_CHECKPOINT_SECONDS[0] + 60,
  });

  const before = new Map((await placementPerformance()).map((row) => [row.placement, row]));
  await insightsTick({ availableProviders: () => [provider] });
  // A second reading of the same two posts: lifetime counters, so the totals
  // must not double.
  await q('UPDATE distribution_queue SET insights_next_at = now() WHERE id = ANY($1)', [
    [comment, body],
  ]);
  await insightsTick({ availableProviders: () => [provider] });
  const now = new Map((await placementPerformance()).map((row) => [row.placement, row]));

  assert.equal((await metrics(comment)).length, 2, 'both readings are kept');
  for (const placement of ['first_comment', 'in_body']) {
    const delta = {
      posts: (now.get(placement)?.posts ?? 0) - (before.get(placement)?.posts ?? 0),
      impressions:
        (now.get(placement)?.impressions ?? 0) - (before.get(placement)?.impressions ?? 0),
      clicks: (now.get(placement)?.clicks ?? 0) - (before.get(placement)?.clicks ?? 0),
      reactions: (now.get(placement)?.reactions ?? 0) - (before.get(placement)?.reactions ?? 0),
    };
    assert.deepEqual(
      delta,
      { posts: 1, impressions: 1_000, clicks: 50, reactions: 10 },
      `${placement} counts its one post once`,
    );
  }
});

// ── What the admin panel actually reads ────────────────────────────────────

test('GET /api/distribution reports the placement split and the flag', { skip }, async () => {
  const provider = stub(async () => reading(4_000, 0, 31));
  const id = await posted({
    provider,
    placement: 'first_comment',
    postedSecondsAgo: INSIGHT_CHECKPOINT_SECONDS[0] + 60,
  });
  await insightsTick({ availableProviders: () => [provider] });

  const res = await createApp().fetch(
    new Request('http://localhost/api/distribution?limit=200', {
      headers: { Authorization: 'Bearer test-admin-token' },
    }),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    items: Array<{ id: string; placement: string; insightsFlag: string | null }>;
    placements: Array<{ placement: string; posts: number; clicks: number; flagged: number }>;
  };

  const item = body.items.find((row) => row.id === id);
  assert.equal(item?.insightsFlag, UNCLICKABLE_COMMENT_LINK);

  const firstComment = body.placements.find((row) => row.placement === 'first_comment');
  assert.ok(firstComment, 'the panel can compare placements');
  assert.ok(firstComment.posts >= 1);
  assert.ok(firstComment.flagged >= 1);
});
