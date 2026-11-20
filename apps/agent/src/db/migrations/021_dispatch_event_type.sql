-- Each platform's rebuild is now a repository dispatch with an event type of
-- its own. publish_target gains dispatchEventType - the event_type value
-- itself, not a variable name - so the workflow that deploys one brand's site
-- never runs for another brand's publish.
--
-- SleekDrops keeps content-updated, the event its deploy workflow already
-- listens for. Any other platform gets <id>-content-updated. PeakOdds also
-- stops naming PEAKODDS_REBUILD_HOOK_URL: a Cloudflare deploy hook only
-- rebuilds a project Cloudflare builds from git, and this repository uploads
-- its builds from GitHub Actions, so PeakOdds rebuilds by dispatch too.
--
-- Idempotent, like 020.

-- The shape check rejects any value that is not a variable name, which the
-- event type is not, so it goes first. Found by what it checks, as in 020.
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
   SET publish_target = publish_target || jsonb_build_object(
         'dispatchEventType',
         CASE WHEN id = 'sleekdrops' THEN 'content-updated' ELSE id || '-content-updated' END)
 WHERE NOT publish_target ? 'dispatchEventType';

UPDATE platforms
   SET publish_target = jsonb_set(publish_target, '{rebuildHookEnv}', 'null'::jsonb)
 WHERE id = 'peakodds'
   AND publish_target ->> 'rebuildHookEnv' = 'PEAKODDS_REBUILD_HOOK_URL';

ALTER TABLE platforms ADD CONSTRAINT platforms_publish_target_check CHECK (
  jsonb_typeof(publish_target) = 'object'
  AND publish_target ?& ARRAY['contentDatabaseUrlEnv', 'githubRepoEnv', 'siteUrlEnv', 'rebuildHookEnv', 'dispatchEventType']
  AND NOT jsonb_path_exists(
    publish_target - 'dispatchEventType',
    '$.* ? (@.type() != "null" && (@.type() != "string" || !(@ like_regex "^[A-Z][A-Z0-9_]*$")))'
  )
  AND jsonb_typeof(publish_target -> 'contentDatabaseUrlEnv') = 'string'
  AND jsonb_typeof(publish_target -> 'githubRepoEnv') = 'string'
  AND jsonb_typeof(publish_target -> 'siteUrlEnv') = 'string'
  AND jsonb_typeof(publish_target -> 'dispatchEventType') = 'string'
  AND (publish_target ->> 'dispatchEventType') ~ '^[a-z][a-z0-9-]{0,99}$'
);

COMMENT ON COLUMN platforms.publish_target IS
  'Names of the environment variables holding the content database URL (its posts and affiliate_links tables), GitHub repo, site URL and rebuild hook (null = repository_dispatch), plus dispatchEventType: the event_type value of that repository dispatch - never the values of the variables.';
