// A PeakOdds article can never reach SleekDrops: not its D1 database, not its
// rebuild, not its site, not its Facebook Page. Run against a database of this
// file's own, so the PeakOdds fixture platform and the gate rows it flips
// cannot be seen by - or see - any other suite's.
//
// Every outside call is answered by a stub that records where it was sent;
// the assertions are about those destinations.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const liveUrl = process.env.DATABASE_URL ?? '';

async function onServer(url: string, sql: string): Promise<void> {
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
}

const reachable = liveUrl
  ? await onServer(liveUrl, 'SELECT 1')
      .then(() => true)
      .catch(() => false)
  : false;
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

const scratchName = `agent_publish_target_${randomUUID().replaceAll('-', '')}`;
const scratchUrl = new URL(liveUrl || 'postgres://localhost/unused');
scratchUrl.pathname = `/${scratchName}`;
if (reachable) {
  await onServer(liveUrl, `CREATE DATABASE "${scratchName}"`);
  process.env.DATABASE_URL = scratchUrl.href;
}

const SLEEKDROPS_ENV = {
  D1_DATABASE_ID: 'sleekdrops-d1',
  GITHUB_REPO: 'example/sleekdrops',
  SITE_URL: 'https://sleekdrops.example',
  GITHUB_TOKEN: 'test-github-token',
};
const PEAKODDS_ENV = {
  PEAKODDS_D1_DATABASE_ID: 'peakodds-d1',
  PEAKODDS_GITHUB_REPO: 'example/peakodds',
  PEAKODDS_SITE_URL: 'https://peakodds.example',
  PEAKODDS_REBUILD_HOOK_URL: 'https://hooks.example/peakodds-deploy-secret',
};
process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
process.env.CLOUDFLARE_D1_TOKEN = 'test-d1-token';
Object.assign(process.env, SLEEKDROPS_ENV, PEAKODDS_ENV);

const { pool, q, setSetting } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { PLATFORM_SEEDS, seedPlatforms } = await import('./profiles.js');
const { sleekdropsSeed } = await import('./sleekdrops/index.js');
const { runPublisher } = await import('../agents/publisher.js');
const { claimNextItem, enqueuePublishedArticle } = await import('../distribution/queue.js');
const { processItem } = await import('../distribution/worker.js');
const { connectChannel, ChannelAdminError } = await import('../distribution/admin.js');
const { registerProvider, unregisterProvider } = await import('../distribution/providers.js');
const { ChannelOwnedElsewhereError, upsertConnection } = await import('../distribution/channels.js');
const { toDistributionItem } = await import('../distribution/types.js');

import type { ArticleRow } from '../pipeline/types.js';
import type { PlatformSeed } from './types.js';
import type { DistributionQueueRow, SocialProvider } from '../distribution/types.js';

const PEAKODDS = 'peakodds';
const SLEEKDROPS = 'sleekdrops';

if (reachable) {
  await migrate();
  // The PeakOdds profile ships with its own card; what matters here is only
  // its publish target, which is the contracted one. Seeded the way a new
  // platform in PLATFORM_SEEDS is.
  const peakoddsSeed: PlatformSeed = {
    platform: {
      ...sleekdropsSeed.platform,
      id: PEAKODDS,
      name: 'PeakOdds',
      monetisation: 'none',
      publishTarget: {
        d1DatabaseIdEnv: 'PEAKODDS_D1_DATABASE_ID',
        githubRepoEnv: 'PEAKODDS_GITHUB_REPO',
        siteUrlEnv: 'PEAKODDS_SITE_URL',
        rebuildHookEnv: 'PEAKODDS_REBUILD_HOOK_URL',
      },
    },
    editions: [
      { ...sleekdropsSeed.editions[0], scoutQueries: [], complianceFooter: '' },
      {
        id: 'global',
        name: 'Global',
        timeZone: 'UTC',
        currency: null,
        locale: 'en-GB',
        scoutQueries: [],
        complianceFooter: '',
      },
    ],
  };
  const seeds = PLATFORM_SEEDS as PlatformSeed[];
  seeds.push(peakoddsSeed);
  try {
    await seedPlatforms();
  } finally {
    seeds.splice(seeds.indexOf(peakoddsSeed), 1);
  }
}

after(async () => {
  globalThis.fetch = realFetch;
  await pool.end();
  if (reachable) await onServer(liveUrl, `DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
});

// ── Outside calls, recorded ────────────────────────────────────────────────

interface Sent {
  url: string;
  method: string;
  body: string;
}

const realFetch = globalThis.fetch;

/** Answer every outside call as a success, and keep where each one went. */
function recordCalls(): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, method: init?.method ?? 'GET', body: String(init?.body ?? '') });
    if (url.includes('api.cloudflare.com')) {
      return Response.json({ success: true, result: [{ results: [] }] });
    }
    if (url.includes('api.github.com')) return new Response(null, { status: 204 });
    return Response.json({});
  }) as typeof fetch;
  return sent;
}

const d1Calls = (sent: Sent[]) => sent.filter((call) => call.url.includes('api.cloudflare.com'));

// ── Fixtures ───────────────────────────────────────────────────────────────

const BODY = 'The Swans are the pick at the line.';

async function article(
  platformId: string,
  fields: { eventStartsAt?: Date | null; oddsAsAt?: Date | null; editionId?: string } = {},
): Promise<ArticleRow> {
  const slug = `grand-final-${randomUUID().slice(0, 8)}`;
  const [row] = await q<ArticleRow>(
    `INSERT INTO articles (platform_id, edition_id, title, slug, category, post_type, stage, status,
                           draft_md, frontmatter, event_starts_at, odds_as_at)
     VALUES ($1, $2, 'Grand final preview', $3, 'Tech', 'guide', 'publish', 'queued', $4,
             $5::jsonb, $6, $7)
     RETURNING *`,
    [
      platformId,
      fields.editionId ?? 'au',
      slug,
      BODY,
      JSON.stringify({ title: 'Grand final preview', author: 'desk', pubDate: '2026-09-26' }),
      fields.eventStartsAt ?? null,
      fields.oddsAsAt ?? null,
    ],
  );
  return row;
}

async function channel(platformId: string, provider: string): Promise<{ id: string; pageId: string }> {
  const pageId = `page-${randomUUID().slice(0, 8)}`;
  const [row] = await q<{ id: string }>(
    `INSERT INTO channel_connections (platform_id, provider, external_account_id, token_ref)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [platformId, provider, pageId, `channel-${pageId}`],
  );
  return { id: row.id, pageId };
}

async function queuedFor(articleId: string): Promise<Array<{ channel_connection_id: string }>> {
  return q('SELECT channel_connection_id FROM distribution_queue WHERE article_id = $1', [articleId]);
}

const uniqueProvider = () => `stub-isolation-${randomUUID().slice(0, 8)}`;

async function withEnv<T>(overrides: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ── Publishing ─────────────────────────────────────────────────────────────

test("a PeakOdds article is written to PeakOdds' D1 and rebuilds PeakOdds' site only", { skip }, async () => {
  const sent = recordCalls();
  const result = await runPublisher(await article(PEAKODDS));

  assert.equal(result.dispatched, true);
  const d1 = d1Calls(sent);
  assert.ok(d1.length > 0);
  for (const call of d1) {
    assert.match(call.url, /\/d1\/database\/peakodds-d1\/query$/);
    assert.ok(!call.url.includes(SLEEKDROPS_ENV.D1_DATABASE_ID), 'never the SleekDrops database');
  }
  const rebuilds = sent.filter((call) => !call.url.includes('api.cloudflare.com'));
  assert.deepEqual(
    rebuilds.map((call) => [call.method, call.url]),
    [['POST', PEAKODDS_ENV.PEAKODDS_REBUILD_HOOK_URL]],
    "PeakOdds' own deploy hook, and no dispatch to the SleekDrops repo",
  );
});

test("a SleekDrops article still goes to SleekDrops' D1 and repository dispatch", { skip }, async () => {
  const sent = recordCalls();
  await runPublisher(await article(SLEEKDROPS));

  for (const call of d1Calls(sent)) assert.match(call.url, /\/d1\/database\/sleekdrops-d1\/query$/);
  const rebuilds = sent.filter((call) => !call.url.includes('api.cloudflare.com'));
  assert.deepEqual(
    rebuilds.map((call) => call.url),
    ['https://api.github.com/repos/example/sleekdrops/dispatches'],
  );
  const post = d1Calls(sent).find((call) => call.body.includes('INSERT INTO posts'))!;
  assert.doesNotMatch(post.body, /event_starts_at|odds_as_at/, "SleekDrops' posts table has no event columns");
});

test('a missing PeakOdds variable fails the publish, naming it, with nothing sent anywhere', { skip }, async () => {
  for (const name of Object.keys(PEAKODDS_ENV)) {
    const sent = recordCalls();
    const piece = await article(PEAKODDS);
    await withEnv({ [name]: undefined }, async () => {
      await assert.rejects(runPublisher(piece), {
        name: 'PublishTargetError',
        message: `publish target for peakodds: ${name} is not set`,
      });
    });
    assert.deepEqual(sent, [], `${name} missing: SleekDrops' values are never used instead`);
  }
});

test("a PeakOdds target pointing at SleekDrops' database or site is refused", { skip }, async () => {
  for (const [name, value] of [
    ['PEAKODDS_D1_DATABASE_ID', SLEEKDROPS_ENV.D1_DATABASE_ID],
    ['PEAKODDS_SITE_URL', `${SLEEKDROPS_ENV.SITE_URL}/`],
  ]) {
    const sent = recordCalls();
    const piece = await article(PEAKODDS);
    await withEnv({ [name]: value }, async () => {
      await assert.rejects(runPublisher(piece), new RegExp(`${name} names the same .* as sleekdrops`));
    });
    assert.deepEqual(sent, [], 'nothing was written while the targets collide');
  }
});

test('an event-bound preview is refused after kick-off, naming the event time', { skip }, async () => {
  const kickOff = new Date('2026-09-26T04:30:00.000Z');
  const sent = recordCalls();
  const piece = await article(PEAKODDS, { eventStartsAt: kickOff, oddsAsAt: new Date('2026-09-25T22:00:00Z') });

  for (const now of [kickOff, new Date(kickOff.getTime() + 60_000)]) {
    await assert.rejects(
      runPublisher(piece, { now: () => now }),
      /refusing to publish: the event this piece previews started at 2026-09-26T04:30:00\.000Z/,
    );
  }
  assert.deepEqual(sent, [], 'not a single D1 write after kick-off');
});

test('an event-bound preview before kick-off carries its event fields to D1', { skip }, async () => {
  const kickOff = new Date('2026-09-26T04:30:00.000Z');
  const oddsAsAt = new Date('2026-09-25T22:00:00.000Z');
  const sent = recordCalls();
  const piece = await article(PEAKODDS, { eventStartsAt: kickOff, oddsAsAt, editionId: 'global' });

  await runPublisher(piece, { now: () => new Date(kickOff.getTime() - 3_600_000) });

  const post = JSON.parse(d1Calls(sent).find((call) => call.body.includes('INSERT INTO posts'))!.body) as {
    sql: string;
    params: unknown[];
  };
  assert.match(post.sql, /event_starts_at = excluded\.event_starts_at/);
  assert.match(post.sql, /odds_as_at = excluded\.odds_as_at/);
  assert.ok(post.params.includes('2026-09-26T04:30:00.000Z'));
  assert.ok(post.params.includes('2026-09-25T22:00:00.000Z'));
});

test('a corrected kick-off time rebuilds the site even when the text did not change', { skip }, async () => {
  const piece = await article(PEAKODDS, { eventStartsAt: new Date('2026-12-01T09:00:00Z') });
  const now = () => new Date('2026-11-01T00:00:00Z');
  recordCalls();
  assert.equal((await runPublisher(piece, { now })).dispatched, true);
  assert.equal((await runPublisher(piece, { now })).dispatched, false, 'unchanged: no second rebuild');

  await q("UPDATE articles SET event_starts_at = '2026-12-02T09:00:00Z' WHERE id = $1", [piece.id]);
  assert.equal((await runPublisher(piece, { now })).dispatched, true);
});

// ── Distribution ───────────────────────────────────────────────────────────

test('PeakOdds distribution is off until its gate row says otherwise', { skip }, async () => {
  const provider = uniqueProvider();
  await channel(PEAKODDS, provider);
  await q("DELETE FROM settings WHERE platform_id = $1 AND key = 'distribution_enabled'", [PEAKODDS]);
  const piece = await article(PEAKODDS);

  const outcome = await enqueuePublishedArticle(piece, { d1Status: 'published' });
  assert.equal(outcome.skipped, 'disabled', 'no gate row means off');
  assert.deepEqual(await queuedFor(piece.id), []);

  await setSetting(PEAKODDS, 'distribution_enabled', false);
  assert.equal((await enqueuePublishedArticle(piece, { d1Status: 'published' })).skipped, 'disabled');
});

test("a platform's article is only ever queued for that platform's channels", { skip }, async () => {
  const provider = uniqueProvider();
  const sleekdropsPage = await channel(SLEEKDROPS, provider);
  const peakoddsPage = await channel(PEAKODDS, provider);
  await setSetting(PEAKODDS, 'distribution_enabled', true);
  try {
    const peakoddsPiece = await article(PEAKODDS);
    await enqueuePublishedArticle(peakoddsPiece, { d1Status: 'published' });
    const peakoddsQueue = (await queuedFor(peakoddsPiece.id)).map((row) => row.channel_connection_id);
    assert.ok(peakoddsQueue.includes(peakoddsPage.id));
    assert.ok(!peakoddsQueue.includes(sleekdropsPage.id), "never SleekDrops' Page");

    const sleekdropsPiece = await article(SLEEKDROPS);
    await enqueuePublishedArticle(sleekdropsPiece, { d1Status: 'published' });
    const sleekdropsQueue = (await queuedFor(sleekdropsPiece.id)).map((row) => row.channel_connection_id);
    assert.ok(sleekdropsQueue.includes(sleekdropsPage.id));
    assert.ok(!sleekdropsQueue.includes(peakoddsPage.id));

    // The queued link points at PeakOdds' own site.
    const [row] = await q<{ payload: { url: string } }>(
      'SELECT payload FROM distribution_queue WHERE article_id = $1',
      [peakoddsPiece.id],
    );
    assert.equal(new URL(row.payload.url).origin, PEAKODDS_ENV.PEAKODDS_SITE_URL);
  } finally {
    await setSetting(PEAKODDS, 'distribution_enabled', false);
  }
});

test('enqueue reads the platform off the article row, not off what it was handed', { skip }, async () => {
  const provider = uniqueProvider();
  const sleekdropsPage = await channel(SLEEKDROPS, provider);
  const piece = await article(PEAKODDS);
  await assert.rejects(
    enqueuePublishedArticle({ ...piece, platform_id: SLEEKDROPS }, { d1Status: 'published' }),
    /belongs to peakodds, not sleekdrops/,
  );
  assert.ok(!(await queuedFor(piece.id)).some((row) => row.channel_connection_id === sleekdropsPage.id));
});

test("an item pairing a PeakOdds article with SleekDrops' Page is never claimed", { skip }, async () => {
  const provider = uniqueProvider();
  const sleekdropsPage = await channel(SLEEKDROPS, provider);
  const piece = await article(PEAKODDS);
  // Nothing in the code writes this row; the claim must hold even if it existed.
  await q(
    `INSERT INTO distribution_queue (article_id, slug, channel_connection_id, provider, payload, placement)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, 'first_comment')`,
    [piece.id, piece.slug, sleekdropsPage.id, provider],
  );
  assert.equal(await claimNextItem([provider]), null);
});

test("a PeakOdds item waits while PeakOdds' gate is off, whatever SleekDrops' says", { skip }, async () => {
  const provider = uniqueProvider();
  const peakoddsPage = await channel(PEAKODDS, provider);
  const piece = await article(PEAKODDS);
  await q(
    `INSERT INTO distribution_queue (article_id, slug, channel_connection_id, provider, payload, placement)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, 'first_comment')`,
    [piece.id, piece.slug, peakoddsPage.id, provider],
  );
  await setSetting(SLEEKDROPS, 'distribution_enabled', true);
  await setSetting(PEAKODDS, 'distribution_enabled', false);
  assert.equal(await claimNextItem([provider]), null);

  await setSetting(PEAKODDS, 'distribution_enabled', true);
  try {
    const claimed = await claimNextItem([provider]);
    assert.equal(claimed?.channelConnectionId, peakoddsPage.id);
  } finally {
    await setSetting(PEAKODDS, 'distribution_enabled', false);
  }
});

test("the worker posts a PeakOdds item as PeakOdds' Page, checked against PeakOdds' site", { skip }, async () => {
  const provider = uniqueProvider();
  const peakoddsPage = await channel(PEAKODDS, provider);
  const piece = await article(PEAKODDS);
  await setSetting(PEAKODDS, 'channel_credentials', { [`channel-${peakoddsPage.pageId}`]: 'peakodds-page-token' });
  const [row] = await q<DistributionQueueRow>(
    `INSERT INTO distribution_queue (article_id, slug, channel_connection_id, provider, payload, placement)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'in_body') RETURNING *`,
    [
      piece.id,
      piece.slug,
      peakoddsPage.id,
      provider,
      JSON.stringify({ caption: 'x', url: 'x', placement: 'in_body', expected: { ogTitle: 'Grand final preview', ogImage: null } }),
    ],
  );

  const fetched: string[] = [];
  const posted: Array<{ accessToken: string; externalAccountId: string }> = [];
  const stub: SocialProvider = {
    name: provider,
    defaultTokenRef: `${provider}-token`,
    authenticate: async () => ({ externalAccountId: 'x', displayName: null, accessToken: 'x', expiresIn: null }),
    refreshToken: async () => ({ externalAccountId: 'x', displayName: null, accessToken: 'x', expiresIn: null }),
    post: async (ctx) => {
      posted.push({ accessToken: ctx.accessToken, externalAccountId: ctx.externalAccountId });
      return { remotePostId: 'remote-1' };
    },
    fetchInsights: async () => ({ impressions: null, clicks: null, reactions: null }),
  };

  const outcome = await processItem(toDistributionItem(row), {
    resolveProvider: () => stub,
    fetchPage: async (url) => {
      fetched.push(url);
      return { status: 200, body: '<meta property="og:title" content="Grand final preview | PeakOdds">' };
    },
  });

  assert.equal(outcome, 'posted');
  assert.deepEqual(fetched, [`${PEAKODDS_ENV.PEAKODDS_SITE_URL}/blog/${piece.slug}`]);
  assert.deepEqual(posted, [{ accessToken: 'peakodds-page-token', externalAccountId: peakoddsPage.pageId }]);
});

test("PeakOdds cannot connect SleekDrops' Page, nor take its connection over", { skip }, async () => {
  const provider = uniqueProvider();
  const sleekdropsPage = await channel(SLEEKDROPS, provider);

  await assert.rejects(
    upsertConnection({
      platformId: PEAKODDS,
      provider,
      externalAccountId: sleekdropsPage.pageId,
      displayName: 'Hijack',
      tokenRef: `${provider}-hijack`,
      expiresInSeconds: null,
    }),
    ChannelOwnedElsewhereError,
  );

  registerProvider({
    name: provider,
    defaultTokenRef: `${provider}-token`,
    authenticate: async () => ({
      externalAccountId: sleekdropsPage.pageId,
      displayName: 'SleekDrops',
      accessToken: 'pasted-token',
      expiresIn: null,
    }),
    refreshToken: async () => {
      throw new Error('unused');
    },
    post: async () => {
      throw new Error('unused');
    },
    fetchInsights: async () => ({ impressions: null, clicks: null, reactions: null }),
  });
  try {
    await assert.rejects(
      connectChannel(PEAKODDS, { provider, token: 'pasted-token' }),
      (err: unknown) => err instanceof ChannelAdminError && err.status === 409,
    );
  } finally {
    unregisterProvider(provider);
  }

  const [row] = await q<{ platform_id: string; token_ref: string; display_name: string | null }>(
    'SELECT platform_id, token_ref, display_name FROM channel_connections WHERE id = $1',
    [sleekdropsPage.id],
  );
  assert.deepEqual(row, { platform_id: SLEEKDROPS, token_ref: `channel-${sleekdropsPage.pageId}`, display_name: null });
  const [stored] = await q<{ value: Record<string, string> }>(
    "SELECT value FROM settings WHERE platform_id = $1 AND key = 'channel_credentials'",
    [PEAKODDS],
  );
  assert.ok(!Object.values(stored?.value ?? {}).includes('pasted-token'), 'the refused token was not kept');
});
