-- Topic discovery requests are durable queued jobs. The API only enqueues;
-- the scout worker claims the oldest request when no other live run exists.
ALTER TABLE scout_runs ALTER COLUMN status SET DEFAULT 'queued';
ALTER TABLE scout_runs ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS scout_runs_queue_idx
  ON scout_runs (started_at, id) WHERE status = 'queued';

COMMENT ON COLUMN scout_runs.status IS
  'Topic-search job state: queued | running | done | failed.';
COMMENT ON COLUMN scout_runs.claimed_at IS
  'When a queue worker claimed this topic-search request.';
