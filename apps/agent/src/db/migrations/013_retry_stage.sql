-- Retry-from-stage bookkeeping.
--
-- An operator can re-run one stage of a run against the output the stage
-- before it already stored, then let the run continue forward. That needs
-- three things the pipeline never recorded: how many times this article has
-- been run (so one article carries its own history instead of spawning a
-- duplicate row), which stages downstream of the retried one are now derived
-- from superseded input, and enough of a publish receipt that re-entering the
-- publish stage cannot re-stamp a publication date or fire a second site
-- rebuild for content that has not changed.

-- ── Borrowed from 012_stage_lease.sql (SLE-103's file, not this one's) ──────
-- Repeated here character for character so this migration is runnable on a
-- database where 012 has not been applied yet. ADD COLUMN IF NOT EXISTS makes
-- each statement a no-op the moment 012 lands, in either order.
ALTER TABLE articles       ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE articles       ADD COLUMN IF NOT EXISTS attempt INT NOT NULL DEFAULT 1;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS attempt INT NOT NULL DEFAULT 1;

-- ── This migration's own columns ───────────────────────────────────────────
ALTER TABLE articles       ADD COLUMN IF NOT EXISTS stale_from_stage TEXT;
ALTER TABLE articles       ADD COLUMN IF NOT EXISTS pub_date DATE;
ALTER TABLE articles       ADD COLUMN IF NOT EXISTS published_digest TEXT;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'pipeline';

COMMENT ON COLUMN articles.stale_from_stage IS
  'The stage a retry restarted from. Every stage after it, up to the one the run has reached again, produced its output from input that has since been superseded; the run regenerates them as it moves forward. Written only by the retry endpoints, never cleared - "out of date" is derived from this plus the current stage, so it resolves itself.';
COMMENT ON COLUMN articles.pub_date IS
  'The publication date stamped on the first successful publish and reused verbatim on every later pass. Publish is re-entered by a retry, and a live post must not silently change the date it says it was published.';
COMMENT ON COLUMN articles.published_digest IS
  'sha256 of the slug, frontmatter and body last pushed live. dispatchContentUpdated() fires only when a publish pass computes a different digest, so re-entering publish with unchanged content does not rebuild the site again.';
COMMENT ON COLUMN agent_sessions.kind IS
  'pipeline | test. A ''test'' session is an isolated single-stage run from POST /api/articles/:id/test-stage: it wrote nothing to the article, so its spend counts in /api/usage but it is excluded from anything describing pipeline progress.';
