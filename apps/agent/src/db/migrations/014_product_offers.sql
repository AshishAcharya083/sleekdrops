-- Per-offer link and price records for launch-window and pre-order products.
--
-- A brand-new SKU cannot be polled: affiliate feeds only carry what the
-- merchant has already published, and Amazon's Product Advertising API is
-- gated behind 3 qualifying sales in 180 days. The link is not the problem —
-- a deep link works off any live advertiser URL on announcement day — the
-- DATA is. So an editor can attach the destination and the price by hand, and
-- the record says where each figure came from and when it was seen.
--
-- One current record per (article, /go/ slug). Feed or API data overwrites the
-- editor's record in place once the SKU appears; every version ever saved is
-- kept in product_offer_revisions, so the manual entry survives the overwrite
-- as history rather than being replaced by it.
CREATE TABLE IF NOT EXISTS product_offers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id        UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  -- The product's /go/ slug: what the body links, and the key the site-wide
  -- affiliate_links map is keyed on.
  go_slug           TEXT NOT NULL,
  product_name      TEXT NOT NULL DEFAULT '',
  -- The commissionable destination, as a human pasted it.
  url               TEXT NOT NULL,
  -- Null until somebody has a figure: a link with no price is still a link,
  -- and inventing a price to fill the column is the failure this table exists
  -- to prevent.
  price             NUMERIC(12, 2),
  currency          TEXT NOT NULL DEFAULT 'AUD',
  -- The day the price was seen. This is what the reader's "as at" stamp shows;
  -- without it a price is presented as live, which it is not.
  price_observed_on DATE,
  preorder          BOOLEAN NOT NULL DEFAULT false,
  release_date      DATE,
  -- Where the link points, in a reader's words ("Amazon AU", "JB Hi-Fi").
  merchant          TEXT,
  source            TEXT NOT NULL DEFAULT 'editor', -- editor | feed | api
  -- The panel has one shared token and no accounts, so this is a role rather
  -- than a person: 'operator' for a hand-entered record, the sync that wrote
  -- it otherwise.
  entered_by        TEXT,
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS product_offers_article_slug_idx
  ON product_offers (article_id, go_slug);
CREATE INDEX IF NOT EXISTS product_offers_slug_idx ON product_offers (go_slug);

-- Every version of every offer, newest last. Written on each save, including
-- the one where a feed takes a manual record over, which is the whole point:
-- the editor's entry and the date it was observed stay readable after the
-- feed's figure has replaced it on the page.
CREATE TABLE IF NOT EXISTS product_offer_revisions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Cleared rather than cascaded when the current record is detached: the
  -- history of what a reader was shown outlives the record itself.
  offer_id          UUID REFERENCES product_offers(id) ON DELETE SET NULL,
  article_id        UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  go_slug           TEXT NOT NULL,
  url               TEXT NOT NULL,
  price             NUMERIC(12, 2),
  currency          TEXT NOT NULL DEFAULT 'AUD',
  price_observed_on DATE,
  preorder          BOOLEAN NOT NULL DEFAULT false,
  release_date      DATE,
  merchant          TEXT,
  source            TEXT NOT NULL DEFAULT 'editor',
  entered_by        TEXT,
  saved_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_offer_revisions_offer_idx
  ON product_offer_revisions (article_id, go_slug, saved_at DESC);

COMMENT ON TABLE product_offers IS
  'Editor-attached (later feed/API-overwritten) offer per product per article, keyed to its /go/ slug.';
COMMENT ON TABLE product_offer_revisions IS
  'Every version ever saved of an offer, so a feed overwrite never loses the manual entry.';
