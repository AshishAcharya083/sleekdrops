// The content schema of a platform that publishes to a database of its own
// (PeakOdds): the posts and affiliate_links tables its site builds from, set
// up by the agent rather than pasted in by hand, and locked down the way
// migration 019 locks down SleekDrops'. SleekDrops' content lives in the
// pipeline's own database, where migration 019 owns these tables and their
// SleekDrops-only category and post_type checks; nothing here touches it.
//
// Applied at boot and again before a publish, once per process and content
// database. Every statement is idempotent, so a database set up by hand from
// an older README, or by another instance, is brought forward rather than
// rejected.
import { createLogger } from '../lib/log.js';
import { PublishTargetError, resolveContentTarget } from '../platform/publishTarget.js';
import { listPlatforms } from '../platform/registry.js';
import type { Platform } from '../platform/types.js';
import { contentQuery, isPipelineDatabase, type ContentTarget } from '../tools/contentStore.js';
import { q } from './pool.js';

const log = createLogger('content-schema');

// One simple-protocol query string, which Postgres runs as a single
// transaction: instances booting together queue on the advisory lock instead
// of racing each other's CREATE TABLE, and a failure leaves nothing half-done.
//
// edition_id is created NOT NULL on a new table. A table that predates it gets
// it nullable here, and backfillEditions below fills it from the pipeline's
// articles before tightening it - that data lives in another database, so it
// cannot happen inside this statement.
const CONTENT_SCHEMA_SQL = `
SELECT pg_advisory_xact_lock(hashtext('content_schema'));

-- The lockdown below would take the site's read of affiliate_links away from
-- SleekDrops, so a URL that reaches the agent's own database by another
-- spelling is refused rather than set up.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    RAISE EXCEPTION 'this is the agent''s own database, not a platform content database';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS posts (
  slug             TEXT PRIMARY KEY,
  status           TEXT NOT NULL,
  title            TEXT NOT NULL,
  category         TEXT NOT NULL,
  post_type        TEXT NOT NULL,
  author           TEXT NOT NULL,
  pub_date         DATE NOT NULL,
  updated_date     DATE,
  edition_id       TEXT NOT NULL,
  frontmatter_json JSONB NOT NULL,
  body_md          TEXT NOT NULL,
  event_starts_at  TIMESTAMPTZ,
  odds_as_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE posts ADD COLUMN IF NOT EXISTS updated_date DATE;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS edition_id TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS event_starts_at TIMESTAMPTZ;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS odds_as_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts (status);

COMMENT ON TABLE posts IS
  'One row per piece the agent published or parked; the site builds from the published ones.';
COMMENT ON COLUMN posts.edition_id IS
  'The edition (editions.id in the agent''s database, e.g. au or global) the piece was written for.';
COMMENT ON COLUMN posts.event_starts_at IS
  'When the event a preview is about starts, UTC; NULL for a piece tied to no event.';
COMMENT ON COLUMN posts.odds_as_at IS
  'When the stalest price the piece quotes was seen, UTC; NULL when it quotes none.';

CREATE TABLE IF NOT EXISTS affiliate_links (
  slug         TEXT PRIMARY KEY,
  default_url  TEXT NOT NULL,
  regions_json JSONB,
  note         TEXT,
  expires_at   DATE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE affiliate_links IS
  'The /go/<slug> destinations a post links to; empty for a platform that earns nothing from links.';

-- Supabase's Data API roles get everything in public by default. They may
-- read published posts and nothing else, now or later; the agent connects as
-- the tables' owner, which row-level security does not restrict. A plain
-- Postgres has neither role, and this block does nothing there.
DO $$
DECLARE
  t record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    RETURN;
  END IF;

  REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;

  GRANT SELECT ON posts TO anon, authenticated;

  DROP POLICY IF EXISTS posts_read_published ON posts;
  CREATE POLICY posts_read_published ON posts
    FOR SELECT TO anon, authenticated
    USING (status = 'published');
END;
$$;
`;

/** Posts no pipeline article gives an edition to, so edition_id cannot be made NOT NULL. */
export class ContentSchemaError extends Error {
  constructor(slugs: readonly string[]) {
    super(
      `${slugs.length} post(s) in the content database have no edition_id and no article to take one from ` +
        `(${slugs.slice(0, 5).join(', ')}${slugs.length > 5 ? ', ...' : ''}): set their edition_id or delete them`,
    );
    this.name = 'ContentSchemaError';
  }
}

/** Fill edition_id on posts that predate it from the article each was published from, then require it. */
async function backfillEditions(platformId: string, target: ContentTarget): Promise<void> {
  const missing = await contentQuery<{ slug: string }>(target, 'SELECT slug FROM posts WHERE edition_id IS NULL');
  if (missing.length > 0) {
    const editions = await q<{ slug: string; edition_id: string }>(
      'SELECT slug, edition_id FROM articles WHERE platform_id = $1 AND slug = ANY($2::text[])',
      [platformId, missing.map((row) => row.slug)],
    );
    const filled = await contentQuery<{ slug: string }>(
      target,
      `UPDATE posts SET edition_id = known.edition_id
         FROM unnest($1::text[], $2::text[]) AS known (slug, edition_id)
        WHERE posts.slug = known.slug AND posts.edition_id IS NULL
        RETURNING posts.slug`,
      [editions.map((row) => row.slug), editions.map((row) => row.edition_id)],
    );
    const filledSlugs = new Set(filled.map((row) => row.slug));
    const orphans = missing.map((row) => row.slug).filter((slug) => !filledSlugs.has(slug));
    if (orphans.length > 0) throw new ContentSchemaError(orphans);
    log.info('backfilled post editions', { platform_id: platformId, posts: filled.length });
  }
  await contentQuery(target, 'ALTER TABLE posts ALTER COLUMN edition_id SET NOT NULL');
}

async function applyContentSchema(platformId: string, target: ContentTarget): Promise<void> {
  await contentQuery(target, CONTENT_SCHEMA_SQL);
  await backfillEditions(platformId, target);
}

/** Per content database: the run in flight or done, dropped again when it fails so the next call retries. */
const applied = new Map<string, Promise<void>>();

/**
 * Set up `platformId`'s content database, once per process. A no-op for the
 * pipeline's own database, whose content tables migration 019 owns.
 */
export async function ensureContentSchema(platformId: string, target: ContentTarget): Promise<void> {
  if (isPipelineDatabase(target)) return;
  let run = applied.get(target.contentDatabaseUrl);
  if (!run) {
    run = applyContentSchema(platformId, target);
    applied.set(target.contentDatabaseUrl, run);
    run.catch(() => applied.delete(target.contentDatabaseUrl));
  }
  await run;
}

/**
 * Whether a publish to this target writes the post's edition_id: every
 * content database this module sets up has the column; SleekDrops' does not.
 */
export function hasEditionColumn(target: ContentTarget): boolean {
  return !isPipelineDatabase(target);
}

/**
 * The boot step: set up every platform's own content database that is
 * configured. Never rejects - a platform's database being down must not stop
 * the agent serving the others, and its next publish applies the schema again
 * and fails there, naming the problem on the article.
 */
export async function ensureContentSchemas(): Promise<void> {
  try {
    for (const platform of await listPlatforms()) await ensurePlatformContentSchema(platform);
  } catch (err) {
    log.warn('could not list platforms to set up their content databases', { error: err });
  }
}

async function ensurePlatformContentSchema(platform: Platform): Promise<void> {
  try {
    await ensureContentSchema(platform.id, resolveContentTarget(platform));
  } catch (err) {
    // An unset or malformed variable is configuration the platform's publish
    // reports by name; only a database that is set and still fails is a fault.
    const fields = { platform_id: platform.id, error: err };
    if (err instanceof PublishTargetError) log.info('content database not configured', fields);
    else log.warn('content database could not be set up', fields);
  }
}
