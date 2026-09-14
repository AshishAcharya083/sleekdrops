-- A lease on the scout lock.
--
-- A sweep is a detached background task, and isScoutRunning() was a bare
-- `SELECT 1 FROM scout_runs WHERE status = 'running'`. When the Cloud Run
-- instance holding a sweep was recycled mid-run the row never left 'running',
-- so every later sweep - manual or scheduled - refused to start with a 409
-- forever, with zero agents actually running and nothing to clear it.
--
-- Articles already solve this: a claim carries `claimed_at` and
-- recoverStranded() re-queues anything still 'running' 30 minutes later. This
-- is the same treatment for scout_runs - a live run renews `heartbeat_at`
-- while it works, and a run whose heartbeat has gone quiet past that threshold
-- no longer holds the lock and gets swept to a terminal state.
ALTER TABLE scout_runs ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Existing rows are backfilled from the run's own clock rather than from the
-- migration's: a run stranded before this column existed has to read as stale
-- immediately, not get a fresh 30-minute lease the moment we deploy.
UPDATE scout_runs SET heartbeat_at = COALESCE(ended_at, started_at);

COMMENT ON COLUMN scout_runs.heartbeat_at IS
  'Lease renewal: last time the process running this sweep reported it was alive. A run with status = ''running'' holds the scout lock only while this is fresher than the stale threshold (30 minutes, matching recoverStranded()).';
