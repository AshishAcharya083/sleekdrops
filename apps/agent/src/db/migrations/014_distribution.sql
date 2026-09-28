-- Channel-agnostic distribution: a published article becomes one queued item
-- per connected social channel, and a worker hands each item to whichever
-- provider adapter owns it.
--
-- Numbered 014 rather than the 012 the card named: 012 and 013 were taken by
-- the stage-lease and retry-from-stage migrations before this one landed, and
-- the runner applies files in name order.
--
-- Three things this schema is shaped by:
--
--   * Publish is re-entrant. /api/articles/:id/republish, a retry-from-stage
--     and the editorial feedback loop all pass through the publish stage
--     again, so "post this article" cannot be a side effect that fires once
--     per pass. The unique index on (slug, channel_connection_id) is what
--     makes the second, third and tenth enqueue a no-op.
--   * A post is not sendable the moment the row is written. The site is a
--     static build: the slug 404s until the rebuild that publish dispatched
--     finishes, so an item has to be able to wait somewhere, which is what
--     scheduled_at plus the pending state are for.
--   * A second network must be one new file, not a migration. Nothing here
--     names a provider: `provider` is a string, the payload is JSONB, and the
--     credential is a reference to a secret rather than a column shape.

-- A connected account we may post as. One row per (provider, account).
--
-- No token value is ever stored here. token_ref / refresh_token_ref name a
-- secret - a Secret Manager secret, mounted as an env var on Cloud Run, or a
-- key in the `channel_credentials` settings row locally - and distribution
-- resolves the name to a value at post time so a database dump carries no
-- credential.
CREATE TABLE IF NOT EXISTS channel_connections (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider            TEXT NOT NULL,                   -- facebook | threads | bluesky | ...
  external_account_id TEXT NOT NULL,                   -- page id, DID, user id - the provider's own
  display_name        TEXT,
  token_ref           TEXT NOT NULL,
  refresh_token_ref   TEXT,
  expires_at          TIMESTAMPTZ,                     -- NULL = a token the provider never expires
  status              TEXT NOT NULL DEFAULT 'active',  -- active | disabled | needs_reauth
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_connections_account_idx
  ON channel_connections (provider, external_account_id);
CREATE INDEX IF NOT EXISTS channel_connections_active_idx
  ON channel_connections (provider) WHERE status = 'active';

COMMENT ON COLUMN channel_connections.token_ref IS
  'Name of the secret holding the access token - never the token. Resolved at post time from the channel_credentials settings row or from the environment (Secret Manager mount).';
COMMENT ON COLUMN channel_connections.expires_at IS
  'When the access token expires, as the provider reported it. Staleness is derived from this for the admin panel; the worker refuses to claim work for a connection whose token has already lapsed.';
COMMENT ON COLUMN channel_connections.status IS
  'active | disabled | needs_reauth. Only an active connection is enqueued for or claimed.';

-- One item per (published article, connected channel).
CREATE TABLE IF NOT EXISTS distribution_queue (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id            UUID REFERENCES articles(id) ON DELETE SET NULL,
  slug                  TEXT NOT NULL,
  channel_connection_id UUID NOT NULL REFERENCES channel_connections(id) ON DELETE CASCADE,
  provider              TEXT NOT NULL,
  payload               JSONB NOT NULL,                     -- RenderedPayload
  placement             TEXT NOT NULL DEFAULT 'first_comment', -- first_comment | in_body
  scheduled_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  status                TEXT NOT NULL DEFAULT 'pending',    -- pending | posting | posted | failed | held
  attempts              INT NOT NULL DEFAULT 0,
  last_error            TEXT,
  remote_post_id        TEXT,
  readiness_started_at  TIMESTAMPTZ,
  claimed_by            TEXT,
  claimed_at            TIMESTAMPTZ,
  posted_at             TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The idempotency key. Keyed on the slug rather than the article id because
-- the slug is what is live on the site and what the readiness gate fetches -
-- and because an article re-published under the same slug is the same post.
CREATE UNIQUE INDEX IF NOT EXISTS distribution_queue_slug_channel_idx
  ON distribution_queue (slug, channel_connection_id);
CREATE INDEX IF NOT EXISTS distribution_queue_due_idx
  ON distribution_queue (scheduled_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS distribution_queue_article_idx ON distribution_queue (article_id);

COMMENT ON COLUMN distribution_queue.payload IS
  'The rendered post (caption, destination URL, comment text, image and its provenance, plus the og:title/og:image the live page must serve). Rendered at enqueue time so a re-run cannot silently change what a queued item will say.';
COMMENT ON COLUMN distribution_queue.placement IS
  'first_comment | in_body - where the destination link goes. Defaulted from the distribution_link_placement setting at enqueue and overridable per row, because the body-link budget is a counted resource on some networks.';
COMMENT ON COLUMN distribution_queue.status IS
  'pending | posting | posted | failed | held. failed is terminal (retries exhausted, or the readiness gate never opened); held is for an item a provider ladder parked for an operator.';
COMMENT ON COLUMN distribution_queue.attempts IS
  'Post attempts spent. Incremented immediately before the provider call, so a worker that dies mid-post cannot spend the same attempt twice. Readiness waits never consume one.';
COMMENT ON COLUMN distribution_queue.last_error IS
  'Why the last attempt did not post - or, on a posted row, what was degraded about the one that did. Scrubbed of anything credential-shaped before it is written: this column is read in the admin panel.';
COMMENT ON COLUMN distribution_queue.readiness_started_at IS
  'When this item was first checked against the live page. The readiness window runs from here, not from created_at, so an item queued while the worker was down still gets its full wait for the rebuild.';

-- Aggregate post-level counts, per queue item, per fetch. Deliberately
-- aggregate only: no commenter identities, no comment text, no demographic
-- breakdowns, which keeps distribution outside personal-data handling.
CREATE TABLE IF NOT EXISTS distribution_metrics (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_item_id UUID NOT NULL REFERENCES distribution_queue(id) ON DELETE CASCADE,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  impressions   INT,
  clicks        INT,
  reactions     INT
);
CREATE INDEX IF NOT EXISTS distribution_metrics_item_idx
  ON distribution_metrics (queue_item_id, fetched_at DESC);

COMMENT ON TABLE distribution_metrics IS
  'Aggregate insights per posted item, joined back to the placement its row used so the placement default can be revisited on this site''s own numbers. NULL means the provider did not report that counter, which is not the same as zero.';

-- Where this article's hero image came from, as a value rather than a
-- sentence in the image stage's summary. Distribution reads it: only an image
-- we generated may be uploaded natively to a network whose terms take a
-- sublicensable licence in what is uploaded.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS hero_image_source TEXT;

COMMENT ON COLUMN articles.hero_image_source IS
  'generated | found | operator | NULL. Written at all three hero paths in the image stage. ''found'' is a third party''s photograph vetted only for watermarks and quality, so it is never uploaded natively.';

INSERT INTO settings (key, value) VALUES
  ('distribution_enabled', 'true'::jsonb),
  ('distribution_link_placement', '"first_comment"'::jsonb),
  ('channel_credentials', '{}'::jsonb)
ON CONFLICT (key) DO NOTHING;
