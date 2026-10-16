-- The website's content, in Postgres: the posts it builds from and the
-- affiliate links its /go/<slug> redirects resolve.
--
-- These two tables used to live in Cloudflare D1 (SQLite) and the publisher
-- reached them over Cloudflare's REST API. They now live in Supabase, in the
-- same database as the pipeline, so a publish is an ordinary write through the
-- agent's own pool and the site's build reads them through Supabase's Data
-- API. The columns are D1's, one for one, so the publisher's statements and
-- the build's guardrails keep their meaning; the JSON held as text in D1 is
-- JSONB here, and the dates are dates.
--
-- Idempotent on purpose: the same file is applied to a database restored from
-- a dump that never recorded it, and to one that already has the tables.

CREATE TABLE IF NOT EXISTS posts (
  slug             TEXT PRIMARY KEY,
  status           TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'review', 'published', 'archived')),
  title            TEXT NOT NULL,
  category         TEXT NOT NULL
                   CHECK (category IN ('Tech', 'Home', 'Fashion', 'Health', 'Finance', 'Travel')),
  post_type        TEXT NOT NULL DEFAULT 'article'
                   CHECK (post_type IN ('article', 'review', 'guide', 'roundup')),
  author           TEXT NOT NULL,
  pub_date         DATE NOT NULL,
  updated_date     DATE,
  -- The full frontmatter the site renders from; the columns above are copies
  -- of a few of its keys, kept for listing and filtering.
  frontmatter_json JSONB NOT NULL CHECK (jsonb_typeof(frontmatter_json) = 'object'),
  body_md          TEXT NOT NULL,
  assignee         TEXT NOT NULL DEFAULT 'agent',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_posts_status ON posts (status);

CREATE TABLE IF NOT EXISTS affiliate_links (
  slug         TEXT PRIMARY KEY,
  default_url  TEXT NOT NULL,
  -- {network, search, asins} for an Amazon row; see content/contract.ts.
  regions_json JSONB,
  note         TEXT,
  expires_at   DATE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The publisher stamps updated_at itself; this keeps it honest for an edit
-- made anywhere else, such as the Supabase table editor.
CREATE OR REPLACE FUNCTION content_touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS posts_touch_updated_at ON posts;
CREATE TRIGGER posts_touch_updated_at
  BEFORE UPDATE ON posts
  FOR EACH ROW EXECUTE FUNCTION content_touch_updated_at();

DROP TRIGGER IF EXISTS affiliate_links_touch_updated_at ON affiliate_links;
CREATE TRIGGER affiliate_links_touch_updated_at
  BEFORE UPDATE ON affiliate_links
  FOR EACH ROW EXECUTE FUNCTION content_touch_updated_at();

-- Supabase serves every table in `public` through its Data API to two roles,
-- `anon` and `authenticated`, and by default grants them everything. Here that
-- would publish the pipeline's settings (a pasted Claude token among them),
-- its drafts and its channel credentials to anyone holding the site's public
-- key. So on a database that has those roles, they may read published posts
-- and the affiliate links - what the site's build fetches, and what the live
-- site shows anyway - and nothing else, now or later. The agent itself
-- connects as the tables' owner, which row-level security does not restrict.
--
-- A plain Postgres (local docker-compose, CI) has neither role, and this
-- block does nothing there.
DO $$
DECLARE
  t record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    RETURN;
  END IF;

  REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
  -- Tables a later migration creates get no grant either.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;

  GRANT SELECT ON posts, affiliate_links TO anon, authenticated;

  DROP POLICY IF EXISTS posts_read_published ON posts;
  CREATE POLICY posts_read_published ON posts
    FOR SELECT TO anon, authenticated
    USING (status = 'published');

  DROP POLICY IF EXISTS affiliate_links_read ON affiliate_links;
  CREATE POLICY affiliate_links_read ON affiliate_links
    FOR SELECT TO anon, authenticated
    USING (true);
END;
$$;
