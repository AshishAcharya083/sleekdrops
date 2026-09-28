-- How many times the pipeline has put this article back in the queue on its
-- own because the worker holding it stopped mid-stage.
--
-- A claim whose lease lapsed means the process holding it is gone - a Cloud
-- Run instance recycled, killed for memory or scaled in - not that the stage
-- ran out of time: a stage that is merely slow keeps renewing and is stopped by
-- its own budget. So a lapsed claim is re-queued rather than timed out. The
-- count is what keeps that from becoming a loop when the stage itself is what
-- keeps killing the instance: past the cap the card fails and waits for a
-- person. It counts per attempt, so an operator retry starts it again at 0.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS lease_requeues INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN articles.lease_requeues IS
  'Automatic re-queues this attempt took because the worker holding the claim stopped and its lease lapsed. Capped (pipeline/worker.ts MAX_LEASE_REQUEUES); reset by an operator retry.';

COMMENT ON COLUMN articles.lease_expires_at IS
  'When this claim stops being valid unless the worker renews it. A ''running'' article past this is re-queued (or failed once lease_requeues reaches its cap); NULL when the article is not claimed.';
