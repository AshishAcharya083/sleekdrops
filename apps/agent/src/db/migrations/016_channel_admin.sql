-- The admin Channels surface: why a held item is held, as a value, and the
-- link placement as a per-network setting.
--
--   * hold_reason is the plain-language reason the panel leads a held row
--     with. last_error already carries the provider's own sentence, but a
--     sentence is not something a panel can group, filter or word
--     consistently, and "held" alone does not tell an operator whether the
--     fix is a hero image or next month. NULL on a held row written before
--     this column existed, which the panel shows as held with the error text.
--     "Site not yet serving the article" is deliberately not a value here: that
--     item is pending at the readiness gate and retries by itself, which the
--     row already says (status = 'pending' with readiness_started_at set).
--   * <provider>_link_placement is the per-network default placement, read
--     at enqueue before the network-agnostic distribution_link_placement.
--     facebook_link_placement is seeded from whatever the global default is
--     today, so nothing a deployment already chose changes under it.
ALTER TABLE distribution_queue ADD COLUMN IF NOT EXISTS hold_reason TEXT;

COMMENT ON COLUMN distribution_queue.hold_reason IS
  'no_safe_image | link_budget_exhausted | NULL. Why a held item is held, as the panel words it; last_error keeps the provider''s own detail. Cleared when an operator releases the item.';

INSERT INTO settings (key, value)
SELECT 'facebook_link_placement', value FROM settings WHERE key = 'distribution_link_placement'
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value) VALUES ('facebook_link_placement', '"first_comment"'::jsonb)
ON CONFLICT (key) DO NOTHING;
