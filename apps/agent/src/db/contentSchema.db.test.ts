// A platform's own content database as the agent leaves it: readable with
// Supabase's publishable key only for published posts, and every post filed
// under an edition - including the ones published before the column existed.
//
// Each test gets a scratch database of its own, set up by hand the way the old
// README told operators to, with Supabase's default grants to its Data API
// roles. Those roles (anon, authenticated) are cluster-wide, so they are
// created here when missing and left in place: a plain Postgres has neither.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

process.env.ADMIN_TOKEN = 'test-admin-token';

const { reachable, skip } = await import('./testDb.js');
const { pool } = await import('./pool.js');
const { seedPlatforms } = await import('../platform/profiles.js');
const { deleteInsertedArticles, insertArticle } = await import('./testFixtures.js');
const { ContentSchemaError, ensureContentSchema } = await import('./contentSchema.js');
const { endContentPools } = await import('../tools/contentStore.js');

const liveUrl = process.env.DATABASE_URL ?? '';
const PLATFORM = 'peakodds';

async function onDatabase<T extends pg.QueryResultRow>(url: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

/** Run `sql` as the Data API runs a request made with the publishable key (anon) or a signed-in user's. */
async function asDataApiRole(url: string, role: 'anon' | 'authenticated', sql: string): Promise<Array<{ slug: string }>> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`SET ROLE ${role}`);
    return (await client.query<{ slug: string }>(sql)).rows;
  } finally {
    await client.end();
  }
}

const scratchNames: string[] = [];

/** A new database holding the README's hand-made tables, granted to the Data API roles as Supabase does. */
async function handMadeContentDatabase(): Promise<string> {
  const name = `agent_content_schema_${randomUUID().replaceAll('-', '')}`;
  await onDatabase(liveUrl, `CREATE DATABASE "${name}"`);
  scratchNames.push(name);
  const url = new URL(liveUrl);
  url.pathname = `/${name}`;
  await onDatabase(
    url.href,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
     CREATE TABLE posts (
       slug TEXT PRIMARY KEY, status TEXT NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL,
       post_type TEXT NOT NULL, author TEXT NOT NULL, pub_date DATE NOT NULL,
       frontmatter_json JSONB NOT NULL, body_md TEXT NOT NULL,
       event_starts_at TIMESTAMPTZ, odds_as_at TIMESTAMPTZ,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
     );
     CREATE TABLE affiliate_links (
       slug TEXT PRIMARY KEY, default_url TEXT NOT NULL, regions_json JSONB, note TEXT, expires_at DATE,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  return url.href;
}

async function insertPost(url: string, slug: string, status: string): Promise<void> {
  await onDatabase(
    url,
    `INSERT INTO posts (slug, status, title, category, post_type, author, pub_date, frontmatter_json, body_md)
     VALUES ($1, $2, 'Swans v Lions preview', 'AFL', 'preview', 'desk', '2026-09-26', '{}', 'Body.')`,
    [slug, status],
  );
}

if (reachable) {
  await seedPlatforms();
  await onDatabase(
    liveUrl,
    `DO $$
     BEGIN
       CREATE ROLE anon NOLOGIN;
     EXCEPTION WHEN duplicate_object THEN NULL;
     END $$;
     DO $$
     BEGIN
       CREATE ROLE authenticated NOLOGIN;
     EXCEPTION WHEN duplicate_object THEN NULL;
     END $$;`,
  );
}

after(async () => {
  if (reachable) {
    await deleteInsertedArticles();
    await endContentPools();
    for (const name of scratchNames) await onDatabase(liveUrl, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  }
  await pool.end();
});

test('the publishable key reads published posts and nothing else', { skip }, async () => {
  const url = await handMadeContentDatabase();
  const published = `swans-v-lions-${randomUUID().slice(0, 8)}`;
  const draft = `${published}-draft`;
  await insertArticle({ platform_id: PLATFORM, edition_id: 'au', slug: published });
  await insertArticle({ platform_id: PLATFORM, edition_id: 'au', slug: draft });
  await insertPost(url, published, 'published');
  await insertPost(url, draft, 'draft');

  await ensureContentSchema(PLATFORM, { contentDatabaseUrl: url });

  const readable = await asDataApiRole(url, 'anon', 'SELECT slug FROM posts ORDER BY slug');
  assert.deepEqual(readable.map((row) => row.slug), [published]);
  assert.deepEqual(
    (await asDataApiRole(url, 'authenticated', 'SELECT slug FROM posts')).map((row) => row.slug),
    [published],
  );

  await assert.rejects(
    asDataApiRole(
      url,
      'anon',
      `INSERT INTO posts (slug, status, title, category, post_type, author, pub_date, edition_id, frontmatter_json, body_md)
       VALUES ('x', 'published', 'x', 'AFL', 'preview', 'x', '2026-09-26', 'au', '{}', 'x')`,
    ),
    { code: '42501' },
    'inserts are refused',
  );
  await assert.rejects(asDataApiRole(url, 'anon', "UPDATE posts SET title = 'x'"), { code: '42501' });
  await assert.rejects(asDataApiRole(url, 'anon', 'SELECT slug FROM affiliate_links'), { code: '42501' });

  // A table created later is no more readable than the pipeline's own are.
  await onDatabase(url, 'CREATE TABLE later_notes (id INT)');
  await assert.rejects(asDataApiRole(url, 'anon', 'SELECT id FROM later_notes'), { code: '42501' });
});

test("posts published before edition_id get their article's edition, and the column becomes required", { skip }, async () => {
  const url = await handMadeContentDatabase();
  const au = `swans-v-lions-${randomUUID().slice(0, 8)}`;
  const global = `arsenal-v-chelsea-${randomUUID().slice(0, 8)}`;
  await insertArticle({ platform_id: PLATFORM, edition_id: 'au', slug: au });
  await insertArticle({ platform_id: PLATFORM, edition_id: 'global', slug: global });
  await insertPost(url, au, 'published');
  await insertPost(url, global, 'published');

  await ensureContentSchema(PLATFORM, { contentDatabaseUrl: url });

  assert.deepEqual(
    await onDatabase(url, 'SELECT slug, edition_id FROM posts ORDER BY edition_id'),
    [
      { slug: au, edition_id: 'au' },
      { slug: global, edition_id: 'global' },
    ],
  );
  await assert.rejects(insertPost(url, `${au}-no-edition`, 'published'), { code: '23502' }, 'edition_id is NOT NULL');
});

test('a post no article explains fails the setup, naming it, rather than staying unfiled', { skip }, async () => {
  const url = await handMadeContentDatabase();
  const orphan = `hand-written-${randomUUID().slice(0, 8)}`;
  await insertPost(url, orphan, 'published');

  await assert.rejects(
    ensureContentSchema(PLATFORM, { contentDatabaseUrl: url }),
    (err: unknown) => err instanceof ContentSchemaError && err.message.includes(orphan),
  );
  // Nothing was guessed for it, and a later call tries again once it is fixed.
  assert.deepEqual(await onDatabase(url, 'SELECT edition_id FROM posts'), [{ edition_id: null }]);
  await onDatabase(url, "UPDATE posts SET edition_id = 'global'");
  await ensureContentSchema(PLATFORM, { contentDatabaseUrl: url });
});

test("the agent's own database is refused as a platform content database", { skip }, async () => {
  const sameDatabaseOtherSpelling = new URL(liveUrl);
  sameDatabaseOtherSpelling.searchParams.set('application_name', 'content-schema-test');
  await assert.rejects(
    ensureContentSchema(PLATFORM, { contentDatabaseUrl: sameDatabaseOtherSpelling.href }),
    /the agent's own database/,
  );
});
