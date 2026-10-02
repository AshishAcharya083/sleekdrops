// Contract tests for the platform-scoped admin API against a real Postgres:
// the panel's switcher sends X-Platform on every call, and what one platform
// reads, writes and versions must never reach another. Point DATABASE_URL at a
// throwaway server to run these.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ADMIN_TOKEN = 'test-admin-token';
// D1 is answered by a stub below, never the network.
process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
process.env.D1_DATABASE_ID = 'test-d1';
process.env.CLOUDFLARE_D1_TOKEN = 'test-d1-token';

const { pool, q } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { clearPlatformCache, loadPlatform } = await import('../platform/registry.js');
const { removeCredential, resolveCredential, storeCredential } = await import(
  '../distribution/channels.js'
);
const { registerProvider, unregisterProvider } = await import('../distribution/providers.js');
const { createApp } = await import('./server.js');

import type { SocialProvider } from '../distribution/types.js';

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

const app = createApp();
/** A platform of this file's own, so nothing here touches another test's rows. */
const OTHER = `odds-${randomUUID().slice(0, 8)}`;
const SLEEKDROPS = 'sleekdrops';
const TAG = `platform-test-${randomUUID()}`;

const OTHER_PROFILE = {
  brand_text: 'Independent tips, no bookmaker referrals.',
  audience: 'Punters',
  editorial_rules: 'Never promise a result.',
  agent_goals: { write: 'Explain the reasoning behind every pick.' },
  scout_queries: ['AFL round preview'],
  editions: [
    { id: 'au', scout_queries: ['AFL'], compliance_footer: 'Gamble responsibly. 18+' },
    { id: 'global', scout_queries: [], compliance_footer: '18+ (21+ where local law requires)' },
  ],
};

interface Call {
  status: number;
  body: any;
}

async function call(platform: string | null, path: string, init: RequestInit = {}): Promise<Call> {
  const headers: Record<string, string> = {
    Authorization: 'Bearer test-admin-token',
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...(platform ? { 'X-Platform': platform } : {}),
  };
  const res = await app.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
  return { status: res.status, body: await res.json() };
}

const post = (platform: string, path: string, body: unknown) =>
  call(platform, path, { method: 'POST', body: JSON.stringify(body) });
const put = (platform: string, path: string, body: unknown) =>
  call(platform, path, { method: 'PUT', body: JSON.stringify(body) });

/** A network that signs each pasted token in as the account of the same name. */
const NETWORK = `stub-platform-${randomUUID().slice(0, 8)}`;
const network: SocialProvider = {
  name: NETWORK,
  defaultTokenRef: `${NETWORK}-page-token`,
  authenticate: async ({ token }) => ({
    externalAccountId: token ?? '',
    displayName: `Page ${token}`,
    accessToken: `exchanged-${token}`,
    expiresIn: null,
  }),
  refreshToken: async () => {
    throw new Error('not used here');
  },
  post: async () => {
    throw new Error('not used here');
  },
  fetchInsights: async () => ({
    impressions: null,
    clicks: null,
    reactions: null,
    fetchedAt: new Date().toISOString(),
  }),
  postUrl: (remotePostId) => `https://social.example/${remotePostId}`,
};
const OTHER_PAGE_REF = `${NETWORK}-other-page`;

let otherTopicId = '';
let otherArticleId = '';
let otherChannelId = '';

before(async () => {
  if (!reachable) return;
  await migrate();
  await q(
    `INSERT INTO platforms
       (id, name, byline_name, brand_text, audience, categories, post_types, article_shapes,
        editorial_rules, monetisation, blocked_link_domains, blocked_topics, scout_queries,
        agent_goals, publish_target)
     VALUES ($1, 'PeakOdds Test', 'PeakOdds Tipping Team', $2, $3, '["AFL","NRL"]',
             '["preview","guide"]', '[]', $4, 'none', '["sportsbet.com.au"]', '["racing"]',
             $5::jsonb, $6::jsonb, $7::jsonb)`,
    [
      OTHER,
      OTHER_PROFILE.brand_text,
      OTHER_PROFILE.audience,
      OTHER_PROFILE.editorial_rules,
      JSON.stringify(OTHER_PROFILE.scout_queries),
      JSON.stringify(OTHER_PROFILE.agent_goals),
      JSON.stringify({
        d1DatabaseIdEnv: 'PEAKODDS_D1_DATABASE_ID',
        githubRepoEnv: 'PEAKODDS_GITHUB_REPO',
        siteUrlEnv: 'PEAKODDS_SITE_URL',
        rebuildHookEnv: 'PEAKODDS_REBUILD_HOOK_URL',
      }),
    ],
  );
  await q(
    `INSERT INTO editions (platform_id, id, name, time_zone, currency, locale, scout_queries, compliance_footer)
     VALUES ($1, 'au', 'Australia', 'Australia/Sydney', 'AUD', 'en-AU', '["AFL"]', $2),
            ($1, 'global', 'Global', 'UTC', NULL, 'en-GB', '[]', $3)`,
    [OTHER, OTHER_PROFILE.editions[0].compliance_footer, OTHER_PROFILE.editions[1].compliance_footer],
  );
  const [version] = await q<{ id: number }>(
    `INSERT INTO platform_profile_versions (platform_id, version, profile, author)
     VALUES ($1, 1, $2::jsonb, 'seed') RETURNING id`,
    [OTHER, JSON.stringify(OTHER_PROFILE)],
  );
  await q('UPDATE platforms SET profile_version = $2 WHERE id = $1', [OTHER, version.id]);

  const [channel] = await q<{ id: string }>(
    `INSERT INTO channel_connections (platform_id, provider, external_account_id, token_ref)
     VALUES ($1, 'facebook', $2, 'facebook-test-token') RETURNING id`,
    [OTHER, TAG],
  );
  otherChannelId = channel.id;
  registerProvider(network);
  await q(
    `INSERT INTO channel_connections (platform_id, provider, external_account_id, display_name, token_ref)
     VALUES ($1, $2, 'other-page', 'PeakOdds Page', $3)`,
    [OTHER, NETWORK, OTHER_PAGE_REF],
  );
  await storeCredential(OTHER_PAGE_REF, 'other-page-credential');
  await q(
    `INSERT INTO agent_sessions (platform_id, agent, status, cost_usd) VALUES ($1, $2, 'done', '1.5')`,
    [OTHER, TAG],
  );
  clearPlatformCache();
});

after(async () => {
  if (reachable) {
    await q('DELETE FROM agent_sessions WHERE platform_id = $1', [OTHER]);
    await q('DELETE FROM scout_runs WHERE platform_id = $1', [OTHER]);
    await q('DELETE FROM articles WHERE platform_id = $1', [OTHER]);
    await q('DELETE FROM topics WHERE platform_id = $1 OR title LIKE $2', [OTHER, `${TAG}%`]);
    await q('DELETE FROM channel_connections WHERE platform_id = $1 OR provider = $2', [
      OTHER,
      NETWORK,
    ]);
    for (const ref of [OTHER_PAGE_REF, `${NETWORK}-page-token`]) await removeCredential(ref);
    await q('DELETE FROM settings WHERE platform_id = $1', [OTHER]);
    await q('DELETE FROM editions WHERE platform_id = $1', [OTHER]);
    await q('UPDATE platforms SET profile_version = NULL WHERE id = $1', [OTHER]);
    await q('DELETE FROM platform_profile_versions WHERE platform_id = $1', [OTHER]);
    await q('DELETE FROM platforms WHERE id = $1', [OTHER]);
    clearPlatformCache();
  }
  unregisterProvider(NETWORK);
  await pool.end();
});

test('GET /api/platforms lists every platform and its editions without X-Platform', { skip }, async () => {
  const { status, body } = await call(null, '/api/platforms');

  assert.equal(status, 200);
  const other = body.platforms.find((p: { id: string }) => p.id === OTHER);
  assert.deepEqual(other, {
    id: OTHER,
    name: 'PeakOdds Test',
    monetisation: 'none',
    // No distribution_enabled row: off.
    distribution_enabled: false,
    categories: ['AFL', 'NRL'],
    post_types: ['preview', 'guide'],
    editions: [
      { id: 'au', name: 'Australia', time_zone: 'Australia/Sydney', locale: 'en-AU', currency: 'AUD' },
      { id: 'global', name: 'Global', time_zone: 'UTC', locale: 'en-GB', currency: null },
    ],
  });
  const sleekdrops = body.platforms.find((p: { id: string }) => p.id === SLEEKDROPS);
  assert.equal(sleekdrops.monetisation, 'amazon');
  assert.equal(sleekdrops.distribution_enabled, true);
});

test('a manual topic is written to its platform and edition, with its event time', { skip }, async () => {
  const created = await post(OTHER, '/api/topics/manual', {
    title: `${TAG} Grand final preview`,
    category: 'AFL',
    post_type: 'preview',
    edition_id: 'global',
    event_starts_at: '2026-10-03T14:30:00+10:00',
  });

  assert.equal(created.status, 201);
  otherTopicId = created.body.topic.id;
  assert.equal(created.body.topic.platform_id, OTHER);
  assert.equal(created.body.topic.edition_id, 'global');
  assert.equal(new Date(created.body.topic.event_starts_at).toISOString(), '2026-10-03T04:30:00.000Z');
});

test('the same title is a separate topic on another platform', { skip }, async () => {
  const created = await post(SLEEKDROPS, '/api/topics/manual', {
    title: `${TAG} Grand final preview`,
    edition_id: 'au',
  });

  assert.equal(created.status, 201);
  assert.equal(created.body.topic.platform_id, SLEEKDROPS);
  assert.equal(created.body.topic.category, 'Tech', "the platform's first category is the default");
  assert.equal(created.body.topic.event_starts_at, null);
});

test('a racing topic is refused on the platform that blocks racing only', { skip }, async () => {
  const title = `${TAG} Melbourne Cup tips`;
  const refused = await post(OTHER, '/api/topics/manual', { title, category: 'AFL', edition_id: 'au' });
  assert.equal(refused.status, 400);
  assert.deepEqual(refused.body, { error: 'racing topics are not covered on PeakOdds Test' });
  assert.equal((await q('SELECT 1 FROM topics WHERE title = $1', [title])).length, 0);

  const allowed = await post(SLEEKDROPS, '/api/topics/manual', { title, edition_id: 'au' });
  assert.equal(allowed.status, 201);
});

test('approval copies the edition, event time and current profile version onto the article', { skip }, async () => {
  const approved = await post(OTHER, `/api/topics/${otherTopicId}/approve`, {});
  assert.equal(approved.status, 200);
  otherArticleId = approved.body.article.id;

  const [article] = await q<{
    platform_id: string;
    edition_id: string;
    event_starts_at: Date;
    profile_version: number;
  }>('SELECT platform_id, edition_id, event_starts_at, profile_version FROM articles WHERE id = $1', [
    otherArticleId,
  ]);
  const [platform] = await q<{ profile_version: number }>(
    'SELECT profile_version FROM platforms WHERE id = $1',
    [OTHER],
  );
  assert.equal(article.platform_id, OTHER);
  assert.equal(article.edition_id, 'global');
  assert.equal(article.event_starts_at.toISOString(), '2026-10-03T04:30:00.000Z');
  assert.equal(article.profile_version, platform.profile_version);

  const detail = await call(OTHER, `/api/articles/${otherArticleId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.article.edition_id, 'global');
  assert.equal(detail.body.article.odds_as_at, null);
  const list = await call(OTHER, '/api/articles');
  const row = list.body.articles.find((a: { id: string }) => a.id === otherArticleId);
  assert.equal(row.edition_id, 'global');
  assert.equal(new Date(row.event_starts_at).toISOString(), '2026-10-03T04:30:00.000Z');
  assert.equal(row.odds_as_at, null);
});

test("another platform's rows are absent from lists and 404 by id", { skip }, async () => {
  const topics = await call(SLEEKDROPS, '/api/topics');
  assert.equal(topics.body.topics.some((t: { id: string }) => t.id === otherTopicId), false);
  const articles = await call(SLEEKDROPS, '/api/articles');
  assert.equal(articles.body.articles.some((a: { id: string }) => a.id === otherArticleId), false);
  const sessions = await call(SLEEKDROPS, '/api/sessions');
  assert.equal(sessions.body.sessions.some((s: { agent: string }) => s.agent === TAG), false);
  const usage = await call(SLEEKDROPS, '/api/usage');
  assert.equal(usage.body.byAgent.some((u: { agent: string }) => u.agent === TAG), false);
  const distribution = await call(SLEEKDROPS, '/api/distribution');
  assert.equal(distribution.body.channels.some((ch: { id: string }) => ch.id === otherChannelId), false);

  for (const [method, path, body] of [
    ['GET', `/api/articles/${otherArticleId}`],
    ['GET', `/api/articles/${otherArticleId}/offers`],
    ['POST', `/api/articles/${otherArticleId}/retry`],
    ['POST', `/api/articles/${otherArticleId}/retry-stage`, { stage: 'write' }],
    ['POST', `/api/articles/${otherArticleId}/rerun-all`],
    ['POST', `/api/articles/${otherArticleId}/cancel`],
    ['POST', `/api/articles/${otherArticleId}/approve-publish`],
    ['POST', `/api/articles/${otherArticleId}/feedback`, { feedback: 'tighter' }],
    ['POST', `/api/articles/${otherArticleId}/republish`],
    ['POST', `/api/articles/${otherArticleId}/reassemble`],
    ['DELETE', `/api/articles/${otherArticleId}/hero-image`],
    ['POST', `/api/topics/${otherTopicId}/approve`],
    ['GET', `/api/distribution/channels/${otherChannelId}/queue`],
    ['DELETE', `/api/distribution/channels/${otherChannelId}`],
  ] as Array<[string, string, unknown?]>) {
    const res = await call(SLEEKDROPS, path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(res.status, 404, `${method} ${path}`);
  }
  // The article is untouched by every one of those calls.
  const [article] = await q<{ status: string; stage: string }>(
    'SELECT status, stage FROM articles WHERE id = $1',
    [otherArticleId],
  );
  assert.deepEqual(article, { status: 'queued', stage: 'research' });
});

test("connecting an account another platform already has is refused and leaves its channel alone", { skip }, async () => {
  const taken = await post(SLEEKDROPS, '/api/distribution/channels', {
    provider: NETWORK,
    token: 'other-page',
  });
  assert.equal(taken.status, 409);
  assert.deepEqual(taken.body, {
    error: `that ${NETWORK} account is already connected to another platform`,
  });

  const [row] = await q(
    `SELECT platform_id, display_name, token_ref, status FROM channel_connections
      WHERE provider = $1 AND external_account_id = 'other-page'`,
    [NETWORK],
  );
  assert.deepEqual(row, {
    platform_id: OTHER,
    display_name: 'PeakOdds Page',
    token_ref: OTHER_PAGE_REF,
    status: 'active',
  });
  assert.equal(await resolveCredential(OTHER_PAGE_REF, NETWORK), 'other-page-credential');
  const theirs = await call(OTHER, '/api/distribution');
  assert.ok(theirs.body.channels.some((ch: { externalAccountId: string }) => ch.externalAccountId === 'other-page'));
});

test('a platform connects a new account as its own, and reconnects it', { skip }, async () => {
  for (const attempt of ['connect', 'reconnect']) {
    const res = await post(OTHER, '/api/distribution/channels', { provider: NETWORK, token: 'new-page' });
    assert.equal(res.status, 201, attempt);
    const [row] = await q<{ platform_id: string }>(
      'SELECT platform_id FROM channel_connections WHERE id = $1',
      [res.body.channel.id],
    );
    assert.equal(row.platform_id, OTHER, attempt);
  }
  const mine = await call(SLEEKDROPS, '/api/distribution');
  assert.equal(
    mine.body.channels.some((ch: { externalAccountId: string }) => ch.externalAccountId === 'new-page'),
    false,
  );
});

test("a live post carries the edition and event time of its own platform's article", { skip }, async () => {
  const slug = `${TAG}-grand-final-preview`;
  await q('UPDATE articles SET slug = $2 WHERE id = $1', [otherArticleId, slug]);
  const posts = [slug, `${TAG}-older-post`].map((postSlug) => ({
    slug: postSlug,
    status: 'published',
    title: postSlug,
    category: 'AFL',
    post_type: 'preview',
    author: 'PeakOdds Tipping Team',
    pub_date: '2026-10-01',
    updated_at: '2026-10-01',
    hero_image: null,
    hero_alt: null,
  }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ success: true, result: [{ results: posts }] }), { status: 200 });
  try {
    const other = await call(OTHER, '/api/published');
    assert.equal(other.status, 200);
    assert.deepEqual(
      other.body.posts.map((p: { slug: string; edition_id: string | null; event_starts_at: string | null }) => [
        p.slug,
        p.edition_id,
        p.event_starts_at && new Date(p.event_starts_at).toISOString(),
      ]),
      [
        [slug, 'global', '2026-10-03T04:30:00.000Z'],
        [`${TAG}-older-post`, null, null],
      ],
    );
    assert.equal(other.body.posts[0].title, slug, 'the D1 fields are unchanged');

    const sleekdrops = await call(SLEEKDROPS, '/api/published');
    assert.equal(sleekdrops.body.posts[0].edition_id, null, "another platform's article is not joined");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the overview counts only its own platform', { skip }, async () => {
  const other = await call(OTHER, '/api/overview');
  assert.equal(other.status, 200);
  assert.deepEqual(other.body.failedSections, []);
  assert.deepEqual(other.body.topics, [{ status: 'approved', n: '1' }]);
  assert.deepEqual(other.body.articles, [{ stage: 'research', status: 'queued', n: '1' }]);
  assert.equal(other.body.usage30d.runs, 1);
  assert.deepEqual(
    other.body.recentSessions.map((s: { agent: string }) => s.agent),
    [TAG],
  );
});

test('settings are read and written per platform', { skip }, async () => {
  const saved = await put(OTHER, '/api/settings', { publish_mode: 'draft' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.publish_mode, 'draft');
  assert.equal(saved.body.distribution_enabled, undefined, 'no other platform row leaks in');

  const sleekdrops = await call(SLEEKDROPS, '/api/settings');
  assert.notEqual(sleekdrops.body.publish_mode, 'draft');
  const [row] = await q<{ value: string }>(
    "SELECT value FROM settings WHERE platform_id = $1 AND key = 'publish_mode'",
    [OTHER],
  );
  assert.equal(row.value, 'draft');
});

test('a manual scout queues one search per edition of its own platform', { skip }, async () => {
  const { status, body } = await call(OTHER, '/api/scout', { method: 'POST' });

  assert.equal(status, 202);
  assert.deepEqual(
    body.runs.map((run: { edition_id: string }) => run.edition_id),
    ['au', 'global'],
  );
  assert.equal(body.queued, body.runs[0].id);
  const rows = await q<{ id: string; platform_id: string; edition_id: string; status: string }>(
    'SELECT id, platform_id, edition_id, status FROM scout_runs WHERE id = ANY($1) ORDER BY edition_id',
    [body.runs.map((run: { id: string }) => run.id)],
  );
  assert.deepEqual(
    rows.map(({ platform_id, edition_id, status }) => ({ platform_id, edition_id, status })),
    [
      { platform_id: OTHER, edition_id: 'au', status: 'queued' },
      { platform_id: OTHER, edition_id: 'global', status: 'queued' },
    ],
  );

  const runs = await call(OTHER, '/api/scout-runs');
  assert.equal(runs.body.runs.length, 2);
  const sleekdrops = await call(SLEEKDROPS, '/api/scout-runs');
  assert.ok(
    sleekdrops.body.runs.every((run: { platform_id: string }) => run.platform_id === SLEEKDROPS),
  );
});

test('GET /api/platform/profile is the version in force', { skip }, async () => {
  const { status, body } = await call(OTHER, '/api/platform/profile');

  assert.equal(status, 200);
  assert.equal(body.platform_id, OTHER);
  assert.equal(body.version, 1);
  assert.equal(body.author, 'seed');
  assert.equal(typeof body.created_at, 'string');
  assert.deepEqual(body.profile, OTHER_PROFILE);
});

test('a profile save writes the next version with its author and time, and applies it', { skip }, async () => {
  const before = Date.now();
  const edited = {
    ...OTHER_PROFILE,
    brand_text: 'Independent tips. No referrals, ever.',
    agent_goals: { write: 'Explain every pick.', research: 'Cite a price source.', edit: '  ' },
    // Only the Global edition is sent; Australia keeps its text.
    editions: [{ id: 'global', scout_queries: ['EPL preview'], compliance_footer: 'Play safe.' }],
  };
  const saved = await put(OTHER, '/api/platform/profile', {
    base_version: 1,
    author: '  Ana Editor  ',
    profile: edited,
  });

  assert.equal(saved.status, 200);
  assert.equal(saved.body.platform_id, OTHER);
  assert.equal(saved.body.version, 2);
  assert.equal(saved.body.author, 'Ana Editor');
  assert.ok(Date.parse(saved.body.created_at) >= before - 1_000);
  const expected = {
    ...edited,
    agent_goals: { write: 'Explain every pick.', research: 'Cite a price source.' },
    editions: [
      OTHER_PROFILE.editions[0],
      { id: 'global', scout_queries: ['EPL preview'], compliance_footer: 'Play safe.' },
    ],
  };
  assert.deepEqual(saved.body.profile, expected);
  assert.deepEqual((await call(OTHER, '/api/platform/profile')).body, saved.body);

  // Applied to the rows the pipeline reads, and the registry sees it at once.
  const platform = await loadPlatform(OTHER);
  assert.equal(platform.brandText, 'Independent tips. No referrals, ever.');
  assert.deepEqual(platform.agentGoals, expected.agent_goals);
  assert.equal(platform.editions.find((e) => e.id === 'global')?.complianceFooter, 'Play safe.');
  assert.equal(platform.editions.find((e) => e.id === 'au')?.complianceFooter, 'Gamble responsibly. 18+');
  const [version] = await q<{ id: number }>(
    'SELECT id FROM platform_profile_versions WHERE platform_id = $1 AND version = 2',
    [OTHER],
  );
  assert.equal(platform.profileVersion, version.id);
  // Fields outside the editable profile are as they were.
  assert.deepEqual(platform.categories, ['AFL', 'NRL']);
  assert.equal(platform.monetisation, 'none');
});

test('versions are listed newest first, each with its author and profile', { skip }, async () => {
  const { status, body } = await call(OTHER, '/api/platform/profile/versions');

  assert.equal(status, 200);
  assert.deepEqual(
    body.versions.map((v: { version: number; author: string }) => [v.version, v.author]),
    [
      [2, 'Ana Editor'],
      [1, 'seed'],
    ],
  );
  assert.deepEqual(body.versions[1].profile, OTHER_PROFILE);
  for (const version of body.versions) assert.equal(typeof version.created_at, 'string');
});

test('a save against a version that is no longer current is a 409 that writes nothing', { skip }, async () => {
  const stale = await put(OTHER, '/api/platform/profile', {
    base_version: 1,
    author: 'Ben',
    profile: OTHER_PROFILE,
  });

  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body, { error: 'profile changed since you loaded it', current_version: 2 });
  const versions = await q('SELECT 1 FROM platform_profile_versions WHERE platform_id = $1', [OTHER]);
  assert.equal(versions.length, 2);
  assert.equal((await loadPlatform(OTHER)).brandText, 'Independent tips. No referrals, ever.');
});

test("one platform's profile history is not another's", { skip }, async () => {
  const sleekdrops = await call(SLEEKDROPS, '/api/platform/profile/versions');
  assert.equal(sleekdrops.status, 200);
  assert.equal(
    sleekdrops.body.versions.some((v: { author: string }) => v.author === 'Ana Editor'),
    false,
  );
  const refused = await put(OTHER, '/api/platform/profile', {
    base_version: 2,
    author: 'Ana',
    profile: { ...OTHER_PROFILE, editions: [{ id: 'nz', scout_queries: [], compliance_footer: '' }] },
  });
  assert.equal(refused.status, 400);
  assert.deepEqual(refused.body, { error: `edition nz does not belong to ${OTHER}` });
});
