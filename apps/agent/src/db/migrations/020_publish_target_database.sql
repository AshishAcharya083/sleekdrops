-- Where a platform publishes is now a Postgres database rather than a
-- Cloudflare D1 one. publish_target names the environment variable holding
-- the connection string of the database with that platform's posts and
-- affiliate_links tables (contentDatabaseUrlEnv), in place of the one that
-- held a D1 database id (d1DatabaseIdEnv).
--
-- SleekDrops' content moved into the pipeline's own database (019), so its
-- variable is DATABASE_URL itself. Any other platform gets
-- <ID>_CONTENT_DATABASE_URL, the name its code seed carries, and publishes
-- nowhere until that variable holds a database with those two tables - the
-- same "fail, never fall back" a platform with no D1 database id had.
--
-- Idempotent, like 019.

-- The shape check names the old key, so it goes first. Found by what it
-- checks rather than by name: a database restored from a dump keeps whatever
-- name its constraint had.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'platforms'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%publish_target%'
  LOOP
    EXECUTE format('ALTER TABLE platforms DROP CONSTRAINT %I', c.conname);
  END LOOP;
END;
$$;

UPDATE platforms
   SET publish_target = (publish_target - 'd1DatabaseIdEnv')
         || jsonb_build_object(
              'contentDatabaseUrlEnv',
              CASE WHEN id = 'sleekdrops' THEN 'DATABASE_URL'
                   ELSE upper(replace(id, '-', '_')) || '_CONTENT_DATABASE_URL'
              END)
 WHERE publish_target ? 'd1DatabaseIdEnv';

ALTER TABLE platforms ADD CONSTRAINT platforms_publish_target_check CHECK (
  jsonb_typeof(publish_target) = 'object'
  AND publish_target ?& ARRAY['contentDatabaseUrlEnv', 'githubRepoEnv', 'siteUrlEnv', 'rebuildHookEnv']
  AND NOT jsonb_path_exists(
    publish_target,
    '$.* ? (@.type() != "null" && (@.type() != "string" || !(@ like_regex "^[A-Z][A-Z0-9_]*$")))'
  )
  AND jsonb_typeof(publish_target -> 'contentDatabaseUrlEnv') = 'string'
  AND jsonb_typeof(publish_target -> 'githubRepoEnv') = 'string'
  AND jsonb_typeof(publish_target -> 'siteUrlEnv') = 'string'
);

COMMENT ON COLUMN platforms.publish_target IS
  'Names of the environment variables holding the content database URL (its posts and affiliate_links tables), GitHub repo, site URL and rebuild hook (null = repository_dispatch) - never the values.';
