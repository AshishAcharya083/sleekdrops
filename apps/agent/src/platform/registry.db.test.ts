// Migration 018 and the platform registry, against a database of this file's
// own: it is built up to 017 and filled with SleekDrops data the way a live
// deployment is, then migrated, so the backfill is tested on rows that existed
// before platforms did.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const FIRST_PLATFORM_MIGRATION = '018_platforms.sql';

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

const scratchName = `agent_platforms_${randomUUID().replaceAll('-', '')}`;
const scratchUrl = new URL(liveUrl || 'postgres://localhost/unused');
scratchUrl.pathname = `/${scratchName}`;
if (reachable) {
  await onServer(liveUrl, `CREATE DATABASE "${scratchName}"`);
  // Everything imported below connects through this.
  process.env.DATABASE_URL = scratchUrl.href;
}
process.env.ADMIN_TOKEN = 'test-admin-token';

const { getPlatformSetting, getSetting, pool, q, setPlatformSetting } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const {
  clearPlatformCache,
  getEdition,
  listPlatforms,
  loadPlatform,
  savePlatformProfile,
  UnknownEditionError,
  UnknownPlatformError,
} = await import('./registry.js');
const { SLEEKDROPS_PROFILE } = await import('./sleekdrops/index.js');
const { createApp } = await import('../api/server.js');

const AUTH = { Authorization: 'Bearer test-admin-token', 'Content-Type': 'application/json' };

/** The pre-018 rows, by table, so the backfill can be checked row for row. */
const legacy: Record<string, string[]> = {};

/** Apply every migration before 018 exactly as the runner does. */
async function migrateTo017(): Promise<void> {
  await q(
    `CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && f < FIRST_PLATFORM_MIGRATION)
    .sort();
  for (const file of files) {
    await pool.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    await q('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
  }
}

/** SleekDrops data as it looks in production today, written with pre-018 SQL. */
async function seedLegacyData(): Promise<void> {
  await q(`UPDATE settings SET value = '"auto"'::jsonb WHERE key = 'publish_mode'`);
  const [run] = await q<{ id: string }>(
    `INSERT INTO scout_runs (status, ended_at) VALUES ('done', now()) RETURNING id`,
  );
  const [topic] = await q<{ id: string }>(
    `INSERT INTO topics (scout_run_id, title, norm_title, category, post_type, status)
     VALUES ($1, 'Best robot vacuums 2026', 'best-robot-vacuums-2026', 'Home', 'guide', 'approved')
     RETURNING id`,
    [run.id],
  );
  const [article] = await q<{ id: string }>(
    `INSERT INTO articles (topic_id, title, slug, category, post_type, stage, status)
     VALUES ($1, 'Best robot vacuums 2026', 'best-robot-vacuums-2026', 'Home', 'guide', 'done', 'done')
     RETURNING id`,
    [topic.id],
  );
  const [session] = await q<{ id: string }>(
    `INSERT INTO agent_sessions (article_id, agent, status) VALUES ($1, 'writer', 'done') RETURNING id`,
    [article.id],
  );
  const [scoutSession] = await q<{ id: string }>(
    `INSERT INTO agent_sessions (scout_run_id, agent, status) VALUES ($1, 'topic_scout', 'done') RETURNING id`,
    [run.id],
  );
  const [offer] = await q<{ id: string }>(
    `INSERT INTO product_offers (article_id, go_slug, url) VALUES ($1, 'roborock-s8', 'https://amazon.com.au/dp/B0TEST')
     RETURNING id`,
    [article.id],
  );
  const [revision] = await q<{ id: string }>(
    `INSERT INTO product_offer_revisions (offer_id, article_id, go_slug, url)
     VALUES ($1, $2, 'roborock-s8', 'https://amazon.com.au/dp/B0TEST') RETURNING id`,
    [offer.id, article.id],
  );
  const [channel] = await q<{ id: string }>(
    `INSERT INTO channel_connections (provider, external_account_id, token_ref)
     VALUES ('facebook', 'page-legacy', 'FACEBOOK_PAGE_TOKEN') RETURNING id`,
  );
  Object.assign(legacy, {
    scout_runs: [run.id],
    topics: [topic.id],
    articles: [article.id],
    agent_sessions: [session.id, scoutSession.id],
    product_offers: [offer.id],
    product_offer_revisions: [revision.id],
    channel_connections: [channel.id],
  });
}

before(async () => {
  if (!reachable) return;
  await migrateTo017();
  await seedLegacyData();
  await migrate();
});

after(async () => {
  await pool.end();
  if (reachable) await onServer(liveUrl, `DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
});

/** A brand of the test's own, with two editions, saved the way an edit is. */
async function saveTestPlatform(id: string): Promise<void> {
  await savePlatformProfile(
    {
      ...SLEEKDROPS_PROFILE,
      id,
      name: `Test brand ${id}`,
      monetisation: 'none',
      blockedLinkDomains: ['bookmaker.example'],
      publishTarget: {
        d1DatabaseIdEnv: 'TEST_D1_DATABASE_ID',
        rebuildHookEnv: 'TEST_REBUILD_TOKEN',
        siteUrlEnv: 'TEST_SITE_URL',
        githubRepoEnv: 'TEST_GITHUB_REPO',
      },
      editions: [
        { ...SLEEKDROPS_PROFILE.editions[0], platformId: id },
        {
          platformId: id,
          id: 'global',
          name: 'Global',
          timeZone: 'UTC',
          currency: null,
          locale: 'en-GB',
          scoutQueries: ['global query'],
          complianceFooter: '18+ only.',
        },
      ],
    },
    'test-operator',
  );
}

/** The SQLSTATE a statement fails with, or null when it succeeds. */
async function sqlState(sql: string, params: unknown[] = []): Promise<string | null> {
  return q(sql, params)
    .then(() => null)
    .catch((err: { code?: string }) => err.code ?? 'no code');
}

test('every pre-018 row is backfilled to SleekDrops and its Australia edition', { skip }, async () => {
  for (const [table, ids] of Object.entries(legacy)) {
    const rows = await q<{ platform_id: string }>(
      `SELECT platform_id FROM ${table} WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    assert.deepEqual(
      rows.map((r) => r.platform_id),
      ids.map(() => 'sleekdrops'),
      table,
    );
  }
  for (const table of ['topics', 'articles']) {
    const [row] = await q<{ edition_id: string; event_starts_at: Date | null; odds_as_at: Date | null }>(
      `SELECT edition_id, event_starts_at, odds_as_at FROM ${table} WHERE id = $1`,
      [legacy[table][0]],
    );
    assert.deepEqual(row, { edition_id: 'au', event_starts_at: null, odds_as_at: null }, table);
  }
  const [article] = await q<{ profile_version: number | null }>(
    'SELECT profile_version FROM articles WHERE id = $1',
    [legacy.articles[0]],
  );
  assert.equal(article.profile_version, null, 'an article that predates versioning cites none');

  const settings = await q<{ platform_id: string }>('SELECT DISTINCT platform_id FROM settings');
  assert.deepEqual(settings, [{ platform_id: 'sleekdrops' }]);
  assert.equal(await getSetting('publish_mode', 'approval'), 'auto', 'a value set before 018 survives');
});

test('platform_id and edition_id are required, with no default to fall back on', { skip }, async () => {
  const columns = await q<{ table_name: string; column_name: string; is_nullable: string; column_default: string | null }>(
    `SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name IN ('platform_id', 'edition_id')
      ORDER BY table_name, column_name`,
  );
  const tagged = columns.filter((c) => !['editions', 'platform_profile_versions'].includes(c.table_name));
  assert.deepEqual(
    tagged.map((c) => `${c.table_name}.${c.column_name}`),
    [
      'agent_sessions.platform_id',
      'articles.edition_id',
      'articles.platform_id',
      'channel_connections.platform_id',
      'product_offer_revisions.platform_id',
      'product_offers.platform_id',
      'scout_runs.platform_id',
      'settings.platform_id',
      'topics.edition_id',
      'topics.platform_id',
    ],
  );
  for (const column of tagged) {
    assert.equal(column.is_nullable, 'NO', `${column.table_name}.${column.column_name}`);
    assert.equal(column.column_default, null, `${column.table_name}.${column.column_name}`);
  }

  assert.equal(
    await sqlState(`INSERT INTO articles (title, category) VALUES ('No platform', 'Tech')`),
    '23502',
    'a write that names no platform fails',
  );
  assert.equal(
    await sqlState(
      `INSERT INTO articles (platform_id, edition_id, title, category) VALUES ('nope', 'au', 'x', 'Tech')`,
    ),
    '23503',
    'an unknown platform fails',
  );
});

test('an edition can only be one of its own platform', { skip }, async () => {
  await saveTestPlatform('edition-scope');
  assert.equal(
    await sqlState(
      `INSERT INTO topics (platform_id, edition_id, title, norm_title, category)
       VALUES ('sleekdrops', 'global', 'Cross edition', 'cross-edition', 'Tech')`,
    ),
    '23503',
    "SleekDrops has no 'global' edition, even though another platform does",
  );
});

test('titles, slugs and settings are unique per platform, not globally', { skip }, async () => {
  await saveTestPlatform('uniq');
  const topic = (platform: string) =>
    sqlState(
      `INSERT INTO topics (platform_id, edition_id, title, norm_title, category)
       VALUES ($1, 'au', 'Best robot vacuums 2026', 'best-robot-vacuums-2026', 'Home')`,
      [platform],
    );
  assert.equal(await topic('uniq'), null, 'another platform may use the same title');
  assert.equal(await topic('uniq'), '23505', 'the same platform may not use it twice');

  const article = (platform: string) =>
    sqlState(
      `INSERT INTO articles (platform_id, edition_id, title, slug, category)
       VALUES ($1, 'au', 'Best robot vacuums 2026', 'best-robot-vacuums-2026', 'Home')`,
      [platform],
    );
  assert.equal(await article('uniq'), null);
  assert.equal(await article('uniq'), '23505');
  assert.equal(await article('sleekdrops'), '23505', "SleekDrops' own legacy slug still holds");

  await setPlatformSetting('uniq', 'publish_mode', 'draft');
  assert.equal(await getPlatformSetting('uniq', 'publish_mode', 'approval'), 'draft');
  assert.equal(await getSetting('publish_mode', 'approval'), 'auto', "SleekDrops' value is its own");
  await assert.rejects(getPlatformSetting('', 'publish_mode', 'approval'), /no platform id/);
});

test('the SleekDrops profile is seeded once, verbatim, and never re-seeded over an edit', { skip }, async () => {
  const platform = await loadPlatform('sleekdrops');
  const { profileVersion, ...profile } = platform;
  assert.deepEqual(profile, SLEEKDROPS_PROFILE);

  const versions = await q<{ id: number; version: number; author: string; profile: unknown }>(
    `SELECT id, version, author, profile FROM platform_profile_versions WHERE platform_id = 'sleekdrops'`,
  );
  assert.equal(versions.length, 1);
  assert.deepEqual(
    { ...versions[0], profile: undefined },
    { id: profileVersion, version: 1, author: 'seed', profile: undefined },
  );
  assert.deepEqual(versions[0].profile, SLEEKDROPS_PROFILE);

  await savePlatformProfile({ ...SLEEKDROPS_PROFILE, brandText: 'Edited brand text.' }, 'operator');
  await migrate();
  const edited = await loadPlatform('sleekdrops');
  assert.equal(edited.brandText, 'Edited brand text.', 'a re-run migrate left the edit alone');
  assert.ok(edited.profileVersion! > profileVersion!);
  const history = await q<{ version: number; author: string }>(
    `SELECT version, author FROM platform_profile_versions WHERE platform_id = 'sleekdrops' ORDER BY version`,
  );
  assert.deepEqual(history, [
    { version: 1, author: 'seed' },
    { version: 2, author: 'operator' },
  ]);
  await savePlatformProfile(SLEEKDROPS_PROFILE, 'operator');
});

test('an unknown or missing platform id throws, with no default', { skip }, async () => {
  for (const id of ['', '   ', undefined, null, 'no-such-platform']) {
    await assert.rejects(loadPlatform(id as string), UnknownPlatformError, String(id));
    await assert.rejects(getEdition(id as string, 'au'), UnknownPlatformError, String(id));
  }
  await assert.rejects(getEdition('sleekdrops', 'zz'), UnknownEditionError);
  await assert.rejects(getEdition('sleekdrops', ''), UnknownEditionError);
  assert.equal((await getEdition('sleekdrops', 'au')).timeZone, 'Australia/Sydney');
});

test('adding an edition is data only', { skip }, async () => {
  await saveTestPlatform('editions');
  // Cached with its two editions before the third exists.
  assert.deepEqual(
    (await loadPlatform('editions')).editions.map((e) => e.id),
    ['au', 'global'],
  );

  await q(
    `INSERT INTO editions (platform_id, id, name, time_zone, currency, locale, scout_queries, compliance_footer)
     VALUES ('editions', 'uk', 'United Kingdom', 'Europe/London', 'GBP', 'en-GB',
             '["premier league previews"]', 'GambleAware footer.')`,
  );

  const uk = await getEdition('editions', 'uk');
  assert.deepEqual(uk, {
    platformId: 'editions',
    id: 'uk',
    name: 'United Kingdom',
    timeZone: 'Europe/London',
    currency: 'GBP',
    locale: 'en-GB',
    scoutQueries: ['premier league previews'],
    complianceFooter: 'GambleAware footer.',
  });
  const listed = (await listPlatforms()).find((p) => p.id === 'editions');
  assert.deepEqual(listed?.editions.map((e) => e.id), ['au', 'global', 'uk']);
  assert.equal(
    await sqlState(
      `INSERT INTO articles (platform_id, edition_id, title, category) VALUES ('editions', 'uk', 'Derby preview', 'Football')`,
    ),
    null,
    'an article can be written for it straight away',
  );
});

test('a platform profile rejects what it must never hold', { skip }, async () => {
  assert.equal(
    await sqlState(`UPDATE platforms SET rebuild_hook_env = 'ghp_s3cr3tT0kenValue' WHERE id = 'sleekdrops'`),
    '23514',
    'a secret value is not an environment variable name',
  );
  assert.equal(
    await sqlState(`UPDATE platforms SET monetisation = 'bookmaker' WHERE id = 'sleekdrops'`),
    '23514',
  );
  await assert.rejects(
    savePlatformProfile(
      { ...SLEEKDROPS_PROFILE, editions: [{ ...SLEEKDROPS_PROFILE.editions[0], timeZone: 'Mars/Olympus' }] },
      'operator',
    ),
    /invalid time zone/,
  );
  await assert.rejects(savePlatformProfile(SLEEKDROPS_PROFILE, ' '), /needs an author/);
  clearPlatformCache();
  assert.equal((await loadPlatform('sleekdrops')).editions[0].timeZone, 'Australia/Sydney');
});

test('a loaded platform cannot be mutated under other callers', { skip }, async () => {
  const platform = await loadPlatform('sleekdrops');
  assert.throws(() => {
    (platform.categories as string[]).push('Gambling');
  }, TypeError);
  assert.deepEqual((await loadPlatform('sleekdrops')).categories, SLEEKDROPS_PROFILE.categories);
});

test('the admin API tags manual topics and the articles approvals create', { skip }, async () => {
  const app = createApp();
  const created = await app.fetch(
    new Request('http://localhost/api/topics/manual', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ title: `Quietest dishwashers ${randomUUID().slice(0, 8)}`, category: 'Home' }),
    }),
  );
  assert.equal(created.status, 201);
  const { topic } = (await created.json()) as { topic: { id: string; platform_id: string; edition_id: string } };
  assert.equal(topic.platform_id, 'sleekdrops');
  assert.equal(topic.edition_id, 'au');

  const event = new Date('2026-11-01T08:30:00Z');
  await q('UPDATE topics SET event_starts_at = $2, odds_as_at = $2 WHERE id = $1', [topic.id, event]);
  const approved = await app.fetch(
    new Request(`http://localhost/api/topics/${topic.id}/approve`, { method: 'POST', headers: AUTH }),
  );
  assert.equal(approved.status, 200);
  const { article } = (await approved.json()) as { article: { id: string } };

  const [row] = await q<{
    platform_id: string;
    edition_id: string;
    profile_version: number;
    event_starts_at: Date;
    odds_as_at: Date;
  }>('SELECT platform_id, edition_id, profile_version, event_starts_at, odds_as_at FROM articles WHERE id = $1', [
    article.id,
  ]);
  const current = await loadPlatform('sleekdrops');
  assert.deepEqual(row, {
    platform_id: 'sleekdrops',
    edition_id: 'au',
    profile_version: current.profileVersion,
    event_starts_at: event,
    odds_as_at: event,
  });

  const settings = await app.fetch(new Request('http://localhost/api/settings', { headers: AUTH }));
  assert.equal(settings.status, 200);
  const body = (await settings.json()) as { publish_mode: string };
  assert.equal(body.publish_mode, 'auto', "another platform's publish_mode does not leak in");
});
