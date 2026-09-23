-- How a card failed, not just that it did.
--
-- Every stage failure landed in `error` and looked the same on the board: a
-- model that returned malformed JSON twice was indistinguishable from an
-- article whose evidence genuinely was not there. The first only needed
-- another run; the second needs a person. The runner now classifies the throw
-- (pipeline/failures.ts), retries the transient ones with backoff, and records
-- both the class and how many attempts the stage took.
--
-- Additive: `error` keeps carrying the operator-facing message verbatim, and a
-- card that failed before this existed reads as a null class, which the panel
-- renders exactly as it does today.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS failure_class TEXT;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS stage_attempts INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN articles.failure_class IS
  'Why the last stage run failed: ''transient'' (parse, shape, timeout, transport, provider 429/5xx - auto-retried) or ''genuine'' (contract violation, evidence absent, validation - terminal). NULL when the stage has not failed, or failed before the taxonomy existed.';
COMMENT ON COLUMN articles.stage_attempts IS
  'Attempts the most recent stage run took, including the one that succeeded. 0 for an article no stage has run yet.';
