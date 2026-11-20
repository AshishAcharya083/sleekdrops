// Migration 021 against a database of this file's own: it is built up to 020
// and given a PeakOdds row as the seed before 021 wrote it, then migrated.
// seedPlatforms never rewrites a row that exists, so on a deployed database
// this upgrade is the only thing that moves PeakOdds off its deploy hook.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const DISPATCH_EVENT_MIGRATION = '021_dispatch_event_type.sql';

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

const scratchName = `agent_dispatch_event_${randomUUID().replaceAll('-', '')}`;
const scratchUrl = new URL(liveUrl || 'postgres://localhost/unused');
scratchUrl.pathname = `/${scratchName}`;
if (reachable) {
  await onServer(liveUrl, `CREATE DATABASE "${scratchName}"`);
  // Everything imported below connects through this.
  process.env.DATABASE_URL = scratchUrl.href;
}

const { pool, q } = await import('./pool.js');
const { migrate } = await import('./migrate.js');
const { loadPlatform } = await import('../platform/registry.js');

/** Apply every migration before 021 exactly as the runner does. */
async function migrateTo020(): Promise<void> {
  await q(
    `CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && f < DISPATCH_EVENT_MIGRATION)
    .sort();
  for (const file of files) {
    await pool.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    await q('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
  }
}

/** PeakOdds' row as the seed wrote it while it still rebuilt by deploy hook. */
async function seedHookedPeakOdds(): Promise<void> {
  await q(
    `INSERT INTO platforms
       (id, name, byline_name, brand_text, audience, categories, post_types, article_shapes,
        editorial_rules, monetisation, blocked_link_domains, blocked_topics, scout_queries,
        agent_goals, publish_target)
     SELECT 'peakodds', 'PeakOdds', byline_name, brand_text, audience, categories, post_types,
            article_shapes, editorial_rules, 'none', blocked_link_domains, blocked_topics,
            scout_queries, agent_goals, $1::jsonb
       FROM platforms WHERE id = 'sleekdrops'`,
    [
      JSON.stringify({
        contentDatabaseUrlEnv: 'PEAKODDS_CONTENT_DATABASE_URL',
        githubRepoEnv: 'PEAKODDS_GITHUB_REPO',
        siteUrlEnv: 'PEAKODDS_SITE_URL',
        rebuildHookEnv: 'PEAKODDS_REBUILD_HOOK_URL',
      }),
    ],
  );
  await q(
    `INSERT INTO editions (platform_id, id, name, time_zone, currency, locale)
     VALUES ('peakodds', 'au', 'Australia', 'Australia/Sydney', 'AUD', 'en-AU')`,
  );
  await q(
    `WITH version AS (
       INSERT INTO platform_profile_versions (platform_id, version, profile, author)
       SELECT 'peakodds', 1, profile, 'seed' FROM platform_profile_versions WHERE platform_id = 'sleekdrops'
       RETURNING id
     )
     UPDATE platforms SET profile_version = (SELECT id FROM version) WHERE id = 'peakodds'`,
  );
}

before(async () => {
  if (!reachable) return;
  await migrateTo020();
  await seedHookedPeakOdds();
  await migrate();
});

after(async () => {
  await pool.end();
  if (reachable) await onServer(liveUrl, `DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
});

test('an existing PeakOdds row rebuilds by its own dispatch event instead of the deploy hook', { skip }, async () => {
  const peakodds = await loadPlatform('peakodds');

  assert.equal(peakodds.publishTarget.rebuildHookEnv, null);
  assert.equal(peakodds.publishTarget.dispatchEventType, 'peakodds-content-updated');
});

test('the existing SleekDrops row keeps the content-updated event its deploy workflow listens for', { skip }, async () => {
  const sleekdrops = await loadPlatform('sleekdrops');

  assert.equal(sleekdrops.publishTarget.rebuildHookEnv, null);
  assert.equal(sleekdrops.publishTarget.dispatchEventType, 'content-updated');
});
