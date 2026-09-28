-- Post insights backfill: the scheduled read-back that turns a posted item
-- into numbers, so the first_comment default can be revisited on this site's
-- own evidence instead of on industry reporting with no published multiplier.
--
-- 014 already declared distribution_metrics and its privacy boundary (three
-- aggregate counters per item, nothing about who saw or clicked). What is
-- missing is the clock that fills it, and the one conclusion a reading can
-- reach by itself:
--
--   * insights_next_at is the polling clock, and insights_done is the end of
--     it. The cadence widens - an hour, six, a day, three, a week - because a
--     post's counters move fastest in the hours after it lands and barely at
--     all after the first week. A clock of NULL is "not scheduled yet", which
--     is due from posted_at: that is what lets every item posted before this
--     migration be picked up with no backfill UPDATE, and it is why the end of
--     the schedule needs a flag of its own rather than a NULL that would read
--     as "start again".
--   * insights_flag is the silent failure. A meaningful share of first-comment
--     links render as unclickable plain text, and from the API side that is
--     invisible: the comment posts successfully and returns an id. The only
--     symptom is impressions accumulating against near-zero clicks, which is
--     what this column records when a reading shows it.
--
-- Nothing here widens what is stored about an audience.
ALTER TABLE distribution_queue ADD COLUMN IF NOT EXISTS insights_next_at TIMESTAMPTZ;
ALTER TABLE distribution_queue ADD COLUMN IF NOT EXISTS insights_done BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE distribution_queue ADD COLUMN IF NOT EXISTS insights_flag TEXT;

CREATE INDEX IF NOT EXISTS distribution_queue_insights_idx
  ON distribution_queue (posted_at) WHERE status = 'posted' AND NOT insights_done;

COMMENT ON COLUMN distribution_queue.insights_next_at IS
  'When the next aggregate insights reading is due, on a cadence that widens with the age of the post. NULL is "not scheduled yet", which means the first reading is due from posted_at.';
COMMENT ON COLUMN distribution_queue.insights_done IS
  'The collection schedule for this post is spent - the last checkpoint has been read, or the window closed with the network still refusing. Nothing polls it again.';
COMMENT ON COLUMN distribution_queue.insights_flag IS
  'What this post''s counters concluded, or NULL for nothing to report. Recomputed from every counter the network has reported (they are lifetime totals) rather than latched, so a first-comment link that starts earning clicks clears its own flag - and a reading that reported nothing leaves the flag as it stands, because NULL is not zero.';
