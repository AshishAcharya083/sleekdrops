-- Platforms and editions: more than one brand on the same pipeline.
--
-- Every row the pipeline writes used to belong to SleekDrops implicitly, so
-- nothing could scope a topic, a prompt or a publish to anything else. A
-- platform is a brand (its text, audience, categories, formats, rules,
-- monetisation and where it publishes); an edition is one audience of it (time
-- zone, currency, locale, its own scout queries and compliance footer). Adding
-- an edition is a row, never a schema change.
--
-- The profile content itself is seeded from code (src/platform/<id>/) by
-- seedPlatforms() after migrations run. This file creates only the SleekDrops
-- and Australia rows that the existing data is backfilled to.
--
-- Deliberately no column default on any platform_id/edition_id: there is no
-- default platform, so a write that does not say which platform it is for
-- fails instead of quietly landing on SleekDrops.

CREATE TABLE IF NOT EXISTS platforms (
  id                   TEXT PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]*$'),
  name                 TEXT NOT NULL,
  brand_text           TEXT NOT NULL DEFAULT '',
  audience             TEXT NOT NULL DEFAULT '',
  categories           JSONB NOT NULL DEFAULT '[]',
  post_types           JSONB NOT NULL DEFAULT '[]',
  article_shapes       JSONB NOT NULL DEFAULT '[]',
  editorial_rules      TEXT NOT NULL DEFAULT '',
  monetisation         TEXT NOT NULL CHECK (monetisation IN ('amazon', 'none')),
  blocked_link_domains JSONB NOT NULL DEFAULT '[]',
  scout_queries        JSONB NOT NULL DEFAULT '[]',
  agent_goals          JSONB NOT NULL DEFAULT '{}',
  -- The publish target, by the NAME of the environment variable holding each
  -- value. The values - a token among them - never enter this database; the
  -- shape check is what stops a pasted secret being saved here by mistake.
  d1_database_id_env   TEXT NOT NULL CHECK (d1_database_id_env ~ '^[A-Z][A-Z0-9_]*$'),
  rebuild_hook_env     TEXT NOT NULL CHECK (rebuild_hook_env ~ '^[A-Z][A-Z0-9_]*$'),
  site_url_env         TEXT NOT NULL CHECK (site_url_env ~ '^[A-Z][A-Z0-9_]*$'),
  github_repo_env      TEXT NOT NULL CHECK (github_repo_env ~ '^[A-Z][A-Z0-9_]*$'),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS editions (
  platform_id       TEXT NOT NULL REFERENCES platforms(id),
  id                TEXT NOT NULL CHECK (id ~ '^[a-z][a-z0-9-]*$'),
  name              TEXT NOT NULL,
  time_zone         TEXT NOT NULL,
  -- NULL for an edition that quotes no currency amounts at all.
  currency          TEXT CHECK (currency ~ '^[A-Z]{3}$'),
  locale            TEXT NOT NULL,
  scout_queries     JSONB NOT NULL DEFAULT '[]',
  compliance_footer TEXT NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform_id, id)
);

-- Every edit of a platform's prompt and goal text, as the whole profile it
-- produced (platform fields plus every edition), who made it and when. Rows
-- are only ever appended; the latest one per platform is the current profile.
CREATE TABLE IF NOT EXISTS platform_profile_versions (
  id          INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform_id TEXT NOT NULL REFERENCES platforms(id),
  version     INT NOT NULL CHECK (version > 0),
  profile     JSONB NOT NULL,
  author      TEXT NOT NULL CHECK (author <> ''),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform_id, version),
  -- The target of articles' composite reference, so an article can only cite
  -- a version of its own platform's profile.
  UNIQUE (platform_id, id)
);

INSERT INTO platforms (id, name, monetisation, d1_database_id_env, rebuild_hook_env, site_url_env, github_repo_env)
VALUES ('sleekdrops', 'SleekDrops', 'amazon', 'D1_DATABASE_ID', 'GITHUB_TOKEN', 'SITE_URL', 'GITHUB_REPO')
ON CONFLICT (id) DO NOTHING;

INSERT INTO editions (platform_id, id, name, time_zone, currency, locale)
VALUES ('sleekdrops', 'au', 'Australia', 'Australia/Sydney', 'AUD', 'en-AU')
ON CONFLICT (platform_id, id) DO NOTHING;

-- ── platform_id on every row, backfilled to SleekDrops ─────────────────────
-- Added with a default so the backfill is the ALTER itself, and the default is
-- dropped straight after: it exists for this statement, not for later writes.
ALTER TABLE topics                  ADD COLUMN IF NOT EXISTS platform_id TEXT NOT NULL DEFAULT 'sleekdrops' REFERENCES platforms(id);
ALTER TABLE articles                ADD COLUMN IF NOT EXISTS platform_id TEXT NOT NULL DEFAULT 'sleekdrops' REFERENCES platforms(id);
ALTER TABLE scout_runs              ADD COLUMN IF NOT EXISTS platform_id TEXT NOT NULL DEFAULT 'sleekdrops' REFERENCES platforms(id);
ALTER TABLE agent_sessions          ADD COLUMN IF NOT EXISTS platform_id TEXT NOT NULL DEFAULT 'sleekdrops' REFERENCES platforms(id);
ALTER TABLE product_offers          ADD COLUMN IF NOT EXISTS platform_id TEXT NOT NULL DEFAULT 'sleekdrops' REFERENCES platforms(id);
ALTER TABLE product_offer_revisions ADD COLUMN IF NOT EXISTS platform_id TEXT NOT NULL DEFAULT 'sleekdrops' REFERENCES platforms(id);
ALTER TABLE channel_connections     ADD COLUMN IF NOT EXISTS platform_id TEXT NOT NULL DEFAULT 'sleekdrops' REFERENCES platforms(id);
ALTER TABLE settings                ADD COLUMN IF NOT EXISTS platform_id TEXT NOT NULL DEFAULT 'sleekdrops' REFERENCES platforms(id);

ALTER TABLE topics                  ALTER COLUMN platform_id DROP DEFAULT;
ALTER TABLE articles                ALTER COLUMN platform_id DROP DEFAULT;
ALTER TABLE scout_runs              ALTER COLUMN platform_id DROP DEFAULT;
ALTER TABLE agent_sessions          ALTER COLUMN platform_id DROP DEFAULT;
ALTER TABLE product_offers          ALTER COLUMN platform_id DROP DEFAULT;
ALTER TABLE product_offer_revisions ALTER COLUMN platform_id DROP DEFAULT;
ALTER TABLE channel_connections     ALTER COLUMN platform_id DROP DEFAULT;
ALTER TABLE settings                ALTER COLUMN platform_id DROP DEFAULT;

-- ── edition_id on topics and articles, backfilled to Australia ─────────────
ALTER TABLE topics   ADD COLUMN IF NOT EXISTS edition_id TEXT NOT NULL DEFAULT 'au';
ALTER TABLE articles ADD COLUMN IF NOT EXISTS edition_id TEXT NOT NULL DEFAULT 'au';
ALTER TABLE topics   ALTER COLUMN edition_id DROP DEFAULT;
ALTER TABLE articles ALTER COLUMN edition_id DROP DEFAULT;

-- Composite, so an edition can only be one of the row's own platform's.
ALTER TABLE topics ADD CONSTRAINT topics_edition_fkey
  FOREIGN KEY (platform_id, edition_id) REFERENCES editions(platform_id, id);
ALTER TABLE articles ADD CONSTRAINT articles_edition_fkey
  FOREIGN KEY (platform_id, edition_id) REFERENCES editions(platform_id, id);

-- ── Uniqueness is per platform now ─────────────────────────────────────────
-- Two brands can each write "Best robot vacuums 2026" under the same slug;
-- what must not happen is one brand writing it twice.
DROP INDEX IF EXISTS topics_norm_title_idx;
CREATE UNIQUE INDEX IF NOT EXISTS topics_platform_norm_title_idx ON topics (platform_id, norm_title);

DROP INDEX IF EXISTS articles_slug_idx;
CREATE UNIQUE INDEX IF NOT EXISTS articles_platform_slug_idx
  ON articles (platform_id, slug) WHERE slug IS NOT NULL;

ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_pkey;
ALTER TABLE settings ADD PRIMARY KEY (platform_id, key);

-- The lookups every platform-scoped read makes.
CREATE INDEX IF NOT EXISTS topics_platform_status_idx ON topics (platform_id, status);
CREATE INDEX IF NOT EXISTS articles_platform_stage_status_idx ON articles (platform_id, stage, status);
CREATE INDEX IF NOT EXISTS scout_runs_platform_status_idx ON scout_runs (platform_id, status);
CREATE INDEX IF NOT EXISTS agent_sessions_platform_started_idx ON agent_sessions (platform_id, started_at DESC);
CREATE INDEX IF NOT EXISTS channel_connections_platform_idx ON channel_connections (platform_id);

-- ── Event-bound pieces ─────────────────────────────────────────────────────
ALTER TABLE topics   ADD COLUMN IF NOT EXISTS event_starts_at TIMESTAMPTZ;
ALTER TABLE topics   ADD COLUMN IF NOT EXISTS odds_as_at      TIMESTAMPTZ;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS event_starts_at TIMESTAMPTZ;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS odds_as_at      TIMESTAMPTZ;

-- ── Which profile an article was commissioned under ────────────────────────
ALTER TABLE articles ADD COLUMN IF NOT EXISTS profile_version INT;
ALTER TABLE articles ADD CONSTRAINT articles_profile_version_fkey
  FOREIGN KEY (platform_id, profile_version) REFERENCES platform_profile_versions(platform_id, id);

COMMENT ON TABLE platforms IS
  'One brand the pipeline writes for: its prompt text, formats, rules, monetisation and publish target. Seeded from src/platform/<id>/; edited through platform_profile_versions.';
COMMENT ON COLUMN platforms.monetisation IS
  'amazon | none. none switches off offers and go-links for the platform entirely.';
COMMENT ON COLUMN platforms.blocked_link_domains IS
  'Domains no article of this platform may link to, matched with their subdomains.';
COMMENT ON COLUMN platforms.agent_goals IS
  'Per-agent goal text keyed by agent name. An agent with no entry keeps the goal its own prompt states.';
COMMENT ON COLUMN platforms.d1_database_id_env IS
  'Name of the environment variable holding the D1 database id this platform publishes to - never the id itself.';
COMMENT ON COLUMN platforms.rebuild_hook_env IS
  'Name of the environment variable holding the credential that fires this platform''s site rebuild - never the credential.';
COMMENT ON COLUMN platforms.site_url_env IS
  'Name of the environment variable holding the origin this platform''s site deploys to.';
COMMENT ON COLUMN platforms.github_repo_env IS
  'Name of the environment variable holding the owner/repo this platform''s rebuild is dispatched to.';
COMMENT ON TABLE editions IS
  'One audience of a platform. Adding an edition is inserting a row: time zone, currency (NULL for none), locale, its scout queries and the compliance footer code appends.';
COMMENT ON TABLE platform_profile_versions IS
  'Append-only history of a platform''s profile: every edit of its prompt or goal text, the full profile it produced, the author and when. The newest row per platform is current.';
COMMENT ON COLUMN articles.profile_version IS
  'The platform_profile_versions row current when the article was commissioned. NULL for articles that predate profile versioning.';
COMMENT ON COLUMN articles.event_starts_at IS
  'When the event an event-bound piece previews starts. NULL for a piece tied to no event.';
COMMENT ON COLUMN articles.odds_as_at IS
  'When the prices an event-bound piece quotes were observed. NULL for a piece that quotes none.';
COMMENT ON COLUMN topics.event_starts_at IS
  'When the event this topic previews starts; copied onto the article on approval. NULL for a topic tied to no event.';
COMMENT ON COLUMN topics.odds_as_at IS
  'When the prices this topic quotes were observed; copied onto the article on approval.';
