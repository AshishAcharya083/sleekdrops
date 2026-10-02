-- Platforms and editions: more than one brand on the same pipeline.
--
-- Every row the pipeline writes used to belong to SleekDrops implicitly, so
-- nothing could scope a topic, a prompt or a publish to anything else. A
-- platform is a brand (its text, audience, categories, formats, rules,
-- monetisation and where it publishes); an edition is one audience of it (time
-- zone, currency, locale, its own scout queries and compliance footer). Adding
-- an edition is a row, never a schema change.
--
-- SleekDrops, its Australia edition and version 1 of its profile are written
-- here, verbatim from src/platform/sleekdrops/, so the backfill below has rows
-- to reference. Any other platform is seeded from code by seedPlatforms() at
-- boot.
--
-- Deliberately no column default on any platform_id/edition_id: there is no
-- default platform, so a write that does not say which platform it is for
-- fails instead of quietly landing on SleekDrops.

CREATE TABLE IF NOT EXISTS platforms (
  id                   TEXT PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]*$'),
  name                 TEXT NOT NULL,
  byline_name          TEXT NOT NULL,
  brand_text           TEXT NOT NULL,
  audience             TEXT NOT NULL,
  categories           JSONB NOT NULL,
  post_types           JSONB NOT NULL,
  article_shapes       JSONB NOT NULL,
  editorial_rules      TEXT NOT NULL,
  monetisation         TEXT NOT NULL CHECK (monetisation IN ('amazon', 'none')),
  blocked_link_domains JSONB NOT NULL,
  blocked_topics       JSONB NOT NULL,
  scout_queries        JSONB NOT NULL,
  agent_goals          JSONB NOT NULL,
  -- The publish target, by the NAME of the environment variable holding each
  -- value (PublishTargetRef). The values - a token among them - never enter
  -- this database; the shape check is what stops a pasted secret being saved
  -- here by mistake. rebuildHookEnv is null for a repository_dispatch rebuild.
  publish_target       JSONB NOT NULL CHECK (
    jsonb_typeof(publish_target) = 'object'
    AND publish_target ?& ARRAY['d1DatabaseIdEnv', 'githubRepoEnv', 'siteUrlEnv', 'rebuildHookEnv']
    AND NOT jsonb_path_exists(
      publish_target,
      '$.* ? (@.type() != "null" && (@.type() != "string" || !(@ like_regex "^[A-Z][A-Z0-9_]*$")))'
    )
    AND jsonb_typeof(publish_target -> 'd1DatabaseIdEnv') = 'string'
    AND jsonb_typeof(publish_target -> 'githubRepoEnv') = 'string'
    AND jsonb_typeof(publish_target -> 'siteUrlEnv') = 'string'
  ),
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

-- Every edit of a platform's prompt and goal text, as the editable profile it
-- produced, who made it and when. Rows are only ever appended.
CREATE TABLE IF NOT EXISTS platform_profile_versions (
  id          SERIAL PRIMARY KEY,
  platform_id TEXT NOT NULL REFERENCES platforms(id),
  version     INT NOT NULL CHECK (version > 0),
  profile     JSONB NOT NULL,
  author      TEXT NOT NULL CHECK (author <> ''),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform_id, version)
);

-- The version in force. Nullable only so a platform row can exist for the
-- moment before its first version is written in the same transaction.
ALTER TABLE platforms ADD COLUMN IF NOT EXISTS profile_version INT REFERENCES platform_profile_versions(id);

INSERT INTO platforms
  (id, name, byline_name, brand_text, audience, categories, post_types, article_shapes,
   editorial_rules, monetisation, blocked_link_domains, blocked_topics, scout_queries,
   agent_goals, publish_target)
VALUES (
  'sleekdrops',
  'SleekDrops',
  'SleekDrops Editorial Team',
  $seed$SleekDrops (sleekdrops.com) is an editorial affiliate blog: "exclusive deals
dropping daily".$seed$,
  $seed$Primary audience: Australian shoppers (prices in AUD, Amazon
Australia availability matters); write in plain international English.$seed$,
  '["Tech","Home","Fashion","Health","Finance","Travel"]',
  '["article","guide","roundup"]',
  '["verdict-first", "segmented-buyers", "head-to-head", "failure-led",
    "cost-of-ownership", "question-led", "ranked-list"]',
  $seed$Editorial rules (non-negotiable):
- Honest, useful, specific. Every recommendation names real trade-offs; a cons
  list is never empty. Decimal ratings like 4.3 — never star spam.
- Plain, direct voice. No emoji, no hype, no urgency copy ("HURRY!", "act now").
- Evidence only: never invent specs, prices, or Amazon URLs. If a fact isn't in
  the research dossier, leave it out or hedge explicitly.
- Prices: never print an Amazon price. Amazon's Associates policies only allow
  prices pulled live from Amazon's own API, which we do not have, so a number
  we type is a policy breach the day the price moves. Write "check the current
  price on Amazon" instead. Where a figure is essential to the argument, use
  the manufacturer's RRP, labelled "RRP" with its source and year — never a
  marketplace price, never "$X on Amazon", never "priced in AUD and checked on".
- Affiliate links: NEVER write a raw merchant URL in the body. Every product
  link is written as /go/<kebab-product-slug> (e.g. /go/sony-wh-1000xm6).
  The same product always reuses the same /go/ slug.
- Disclose honestly: if we haven't lab-tested the products, say the piece is an
  editorial synthesis of specs, owner reviews, and expert coverage. The site
  carries a standing methodology page and an AI-assistance disclosure, both
  linked from every article, so the body never has to stand in for them - and
  never overstates them. Never write "we tested", "our testers", "in our
  testing", "we tried", "hands-on" or anything else that claims use of a
  product nobody here has touched.
- Structure for scanability: short paragraphs, descriptive H2/H3 headings,
  comparison tables for multi-product pieces. Say what the piece rests on -
  which evidence, what was excluded - where the piece's shape puts it, and
  under that shape's own heading. "How we picked" is not a section every
  article owes the reader.$seed$,
  'amazon',
  '[]',
  '[]',
  '[
    "trending products Australia this week",
    "best selling gadgets this month",
    "viral home products people are buying right now",
    "trending health and wellness products this month",
    "what products are trending on social media right now Australia",
    "new product releases worth buying this month"
  ]',
  '{}',
  '{"d1DatabaseIdEnv":"D1_DATABASE_ID","githubRepoEnv":"GITHUB_REPO","siteUrlEnv":"SITE_URL","rebuildHookEnv":null}'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO editions (platform_id, id, name, time_zone, currency, locale, scout_queries, compliance_footer)
VALUES ('sleekdrops', 'au', 'Australia', 'Australia/Sydney', 'AUD', 'en-AU', '[]', '')
ON CONFLICT (platform_id, id) DO NOTHING;

INSERT INTO platform_profile_versions (platform_id, version, profile, author)
SELECT p.id, 1,
       jsonb_build_object(
         'brand_text', p.brand_text,
         'audience', p.audience,
         'editorial_rules', p.editorial_rules,
         'agent_goals', p.agent_goals,
         'scout_queries', p.scout_queries,
         'editions', (SELECT jsonb_agg(jsonb_build_object(
                                'id', e.id,
                                'scout_queries', e.scout_queries,
                                'compliance_footer', e.compliance_footer) ORDER BY e.id)
                        FROM editions e WHERE e.platform_id = p.id)),
       'seed'
  FROM platforms p
 WHERE p.id = 'sleekdrops'
ON CONFLICT (platform_id, version) DO NOTHING;

UPDATE platforms
   SET profile_version = (SELECT id FROM platform_profile_versions WHERE platform_id = 'sleekdrops' AND version = 1)
 WHERE id = 'sleekdrops' AND profile_version IS NULL;

-- ── platform_id on every row, backfilled to SleekDrops ─────────────────────
-- Added with a default so the backfill is the ALTER itself, and the default is
-- dropped straight after: it exists for this statement, not for later writes.
ALTER TABLE topics              ADD COLUMN IF NOT EXISTS platform_id TEXT NOT NULL DEFAULT 'sleekdrops' REFERENCES platforms(id);
ALTER TABLE articles            ADD COLUMN IF NOT EXISTS platform_id TEXT NOT NULL DEFAULT 'sleekdrops' REFERENCES platforms(id);
ALTER TABLE scout_runs          ADD COLUMN IF NOT EXISTS platform_id TEXT NOT NULL DEFAULT 'sleekdrops' REFERENCES platforms(id);
ALTER TABLE agent_sessions      ADD COLUMN IF NOT EXISTS platform_id TEXT NOT NULL DEFAULT 'sleekdrops' REFERENCES platforms(id);
ALTER TABLE product_offers      ADD COLUMN IF NOT EXISTS platform_id TEXT NOT NULL DEFAULT 'sleekdrops' REFERENCES platforms(id);
ALTER TABLE channel_connections ADD COLUMN IF NOT EXISTS platform_id TEXT NOT NULL DEFAULT 'sleekdrops' REFERENCES platforms(id);
ALTER TABLE settings            ADD COLUMN IF NOT EXISTS platform_id TEXT NOT NULL DEFAULT 'sleekdrops' REFERENCES platforms(id);

ALTER TABLE topics              ALTER COLUMN platform_id DROP DEFAULT;
ALTER TABLE articles            ALTER COLUMN platform_id DROP DEFAULT;
ALTER TABLE scout_runs          ALTER COLUMN platform_id DROP DEFAULT;
ALTER TABLE agent_sessions      ALTER COLUMN platform_id DROP DEFAULT;
ALTER TABLE product_offers      ALTER COLUMN platform_id DROP DEFAULT;
ALTER TABLE channel_connections ALTER COLUMN platform_id DROP DEFAULT;
ALTER TABLE settings            ALTER COLUMN platform_id DROP DEFAULT;

-- ── edition_id on topics, articles and scout runs, backfilled to Australia ─
ALTER TABLE topics     ADD COLUMN IF NOT EXISTS edition_id TEXT NOT NULL DEFAULT 'au';
ALTER TABLE articles   ADD COLUMN IF NOT EXISTS edition_id TEXT NOT NULL DEFAULT 'au';
ALTER TABLE scout_runs ADD COLUMN IF NOT EXISTS edition_id TEXT NOT NULL DEFAULT 'au';
ALTER TABLE topics     ALTER COLUMN edition_id DROP DEFAULT;
ALTER TABLE articles   ALTER COLUMN edition_id DROP DEFAULT;
ALTER TABLE scout_runs ALTER COLUMN edition_id DROP DEFAULT;

-- Composite, so an edition can only be one of the row's own platform's.
ALTER TABLE topics ADD CONSTRAINT topics_edition_fkey
  FOREIGN KEY (platform_id, edition_id) REFERENCES editions(platform_id, id);
ALTER TABLE articles ADD CONSTRAINT articles_edition_fkey
  FOREIGN KEY (platform_id, edition_id) REFERENCES editions(platform_id, id);
ALTER TABLE scout_runs ADD CONSTRAINT scout_runs_edition_fkey
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
-- "Event-bound" means event_starts_at IS NOT NULL, everywhere.
ALTER TABLE topics   ADD COLUMN IF NOT EXISTS event_starts_at TIMESTAMPTZ;
ALTER TABLE topics   ADD COLUMN IF NOT EXISTS odds_as_at      TIMESTAMPTZ;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS event_starts_at TIMESTAMPTZ;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS odds_as_at      TIMESTAMPTZ;

-- ── Which profile an article was commissioned under ────────────────────────
ALTER TABLE articles ADD COLUMN IF NOT EXISTS profile_version INT REFERENCES platform_profile_versions(id);

COMMENT ON TABLE platforms IS
  'One brand the pipeline writes for: its prompt text, formats, rules, monetisation and publish target. Seeded from src/platform/<id>/; edited through platform_profile_versions.';
COMMENT ON COLUMN platforms.monetisation IS
  'amazon | none. none switches off offers and go-links for the platform entirely.';
COMMENT ON COLUMN platforms.blocked_link_domains IS
  'Bare hostnames no article of this platform may link to; a subdomain of one is blocked too.';
COMMENT ON COLUMN platforms.blocked_topics IS
  'Topic classes (see src/platform/topicRules.ts) this platform never covers.';
COMMENT ON COLUMN platforms.agent_goals IS
  'Per-agent goal text keyed by agent id. An agent with no entry keeps the goal its own prompt states.';
COMMENT ON COLUMN platforms.publish_target IS
  'Names of the environment variables holding the D1 database id, GitHub repo, site URL and rebuild hook (null = repository_dispatch) - never the values.';
COMMENT ON COLUMN platforms.profile_version IS
  'The platform_profile_versions row currently in force.';
COMMENT ON TABLE editions IS
  'One audience of a platform. Adding an edition is inserting a row: time zone, currency (NULL for none), locale, its scout queries and the compliance footer code appends.';
COMMENT ON TABLE platform_profile_versions IS
  'Append-only history of a platform''s editable profile: every edit of its prompt or goal text, the author and when.';
COMMENT ON COLUMN articles.profile_version IS
  'The platform_profile_versions row current when the article was commissioned. NULL for articles that predate profile versioning.';
COMMENT ON COLUMN articles.event_starts_at IS
  'When the event an event-bound piece previews starts. NULL for a piece tied to no event.';
COMMENT ON COLUMN articles.odds_as_at IS
  'When the prices an event-bound piece quotes were observed. NULL for a piece that quotes none.';
COMMENT ON COLUMN topics.event_starts_at IS
  'When the event this topic previews starts. NULL for a topic tied to no event.';
COMMENT ON COLUMN topics.odds_as_at IS
  'When the prices this topic quotes were observed.';
