-- A lease on an article claim, and the terminal state a stage that runs out of
-- wall-clock time lands in.
--
-- `claimed_at` alone cannot tell "claimed 40 minutes ago" from "wedged 40
-- minutes ago": it is stamped once and never touched again, so a stage that
-- stopped making progress looks exactly like a slow one until a container
-- restart happens to notice it. scout_runs already got this treatment in
-- 010_scout_lease.sql - a live run renews `heartbeat_at` while it works, and a
-- run whose heartbeat has gone quiet no longer holds its claim. This is the
-- same shape for articles, plus the lease's own expiry so the reaper does not
-- have to recompute a staleness window it could get wrong.
--
-- `attempt` counts passes over the same article: retry-forward re-runs a stage
-- against stored upstream output, so the attempts of one stage are rows of the
-- same article rather than a duplicated card, and the session that ran under
-- each one records which attempt it was. The first pipeline pass is attempt 1
-- and a retry makes it 2, which is why the default is 1 and not 0 - only a
-- retry increments it, never the claim.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;
ALTER TABLE articles       ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE articles       ADD COLUMN IF NOT EXISTS attempt INT NOT NULL DEFAULT 1;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS attempt INT NOT NULL DEFAULT 1;

-- Anything already claimed when this ships gets a lease read off the claim's
-- own clock rather than the migration's, so it is already expired: a row
-- stranded before the lease existed has to be reapable immediately, not handed
-- a fresh window by the deploy that introduced the column.
UPDATE articles
SET heartbeat_at = claimed_at, lease_expires_at = claimed_at
WHERE status = 'running' AND claimed_at IS NOT NULL;

-- The reaper's query, run on the worker tick: live claims whose lease has run
-- out. Partial, because every other article in the table is irrelevant to it.
CREATE INDEX IF NOT EXISTS articles_lease_idx
  ON articles (lease_expires_at)
  WHERE status = 'running';

COMMENT ON COLUMN articles.heartbeat_at IS
  'Last time the worker running this article''s stage reported it was alive. NULL when the article is not claimed.';
COMMENT ON COLUMN articles.lease_expires_at IS
  'When this claim stops being valid unless the worker renews it. A ''running'' article past this is reaped to ''timed_out''; NULL when the article is not claimed.';
COMMENT ON COLUMN articles.attempt IS
  'Which pass over this article is current. The first pipeline pass is 1; a retry increments it, a claim does not.';
COMMENT ON COLUMN agent_sessions.attempt IS
  'The article attempt this session ran under, so repeated runs of one stage stay distinguishable.';

-- 001_init.sql documents the status vocabulary in a column comment; 'timed_out'
-- is a distinct terminal state from 'failed' (the stage ran out of its budget
-- or stopped reporting - it did not report an error) and belongs in it.
COMMENT ON COLUMN articles.status IS
  'queued | running | failed | timed_out | waiting_approval | cancelled | done';
COMMENT ON COLUMN agent_sessions.status IS
  'running | done | failed | timed_out';
