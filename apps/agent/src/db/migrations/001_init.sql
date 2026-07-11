-- SleekDrops agent platform — pipeline state.
-- Published content lives in Cloudflare D1; this database is operational
-- state only (a light version of the devteam-platform card/session model).

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per topic-scout sweep (triggered from the admin panel).
CREATE TABLE IF NOT EXISTS scout_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status       TEXT NOT NULL DEFAULT 'running', -- running | done | failed
  topics_found INT  NOT NULL DEFAULT 0,
  error        TEXT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at     TIMESTAMPTZ
);

-- Trending topic suggestions. Admin approves the ones worth writing;
-- approval creates an article and the pipeline takes over.
CREATE TABLE IF NOT EXISTS topics (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scout_run_id UUID REFERENCES scout_runs(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  norm_title   TEXT NOT NULL,                    -- normalized for dedupe
  category     TEXT NOT NULL,                    -- Tech|Home|Fashion|Health|Finance|Travel
  post_type    TEXT NOT NULL DEFAULT 'article',  -- article|guide|roundup
  angle        TEXT,
  keywords     JSONB NOT NULL DEFAULT '[]',
  why_trending TEXT,
  sources      JSONB NOT NULL DEFAULT '[]',
  status       TEXT NOT NULL DEFAULT 'suggested', -- suggested|approved|rejected
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS topics_norm_title_idx ON topics (norm_title);
CREATE INDEX IF NOT EXISTS topics_status_idx ON topics (status);

-- One row per article moving through the pipeline (the "card").
CREATE TABLE IF NOT EXISTS articles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id        UUID REFERENCES topics(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  slug            TEXT,
  category        TEXT NOT NULL,
  post_type       TEXT NOT NULL DEFAULT 'article',
  stage           TEXT NOT NULL DEFAULT 'research',
    -- research | outline | write | seo_review | edit | assemble | publish | done
  status          TEXT NOT NULL DEFAULT 'queued',
    -- queued | running | failed | waiting_approval | cancelled | done
  revision_round  INT NOT NULL DEFAULT 0,
  research        JSONB,
  outline         JSONB,
  draft_md        TEXT,
  seo_review      JSONB,
  frontmatter     JSONB,
  affiliate_links JSONB,
  error           TEXT,
  claimed_by      TEXT,
  claimed_at      TIMESTAMPTZ,
  published_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS articles_stage_status_idx ON articles (stage, status);
CREATE UNIQUE INDEX IF NOT EXISTS articles_slug_idx ON articles (slug) WHERE slug IS NOT NULL;

-- One row per agent run (one stage execution / one scout sweep).
CREATE TABLE IF NOT EXISTS agent_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id    UUID REFERENCES articles(id) ON DELETE CASCADE,
  scout_run_id  UUID REFERENCES scout_runs(id) ON DELETE CASCADE,
  agent         TEXT NOT NULL,
    -- topic_scout | researcher | outliner | writer | seo_reviewer | editor | assembler | publisher
  model         TEXT,
  status        TEXT NOT NULL DEFAULT 'running', -- running | done | failed
  summary       TEXT,
  error         TEXT,
  tokens_input  BIGINT NOT NULL DEFAULT 0,
  tokens_output BIGINT NOT NULL DEFAULT 0,
  cost_usd      NUMERIC(12, 6) NOT NULL DEFAULT 0,
  llm_calls     INT NOT NULL DEFAULT 0,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS agent_sessions_article_idx ON agent_sessions (article_id);
CREATE INDEX IF NOT EXISTS agent_sessions_started_idx ON agent_sessions (started_at DESC);

-- Defaults (admin panel edits these via /api/settings).
INSERT INTO settings (key, value) VALUES
  ('models', '{}'::jsonb),                 -- per-agent model overrides, e.g. {"writer": "anthropic/claude-sonnet-4.5"}
  ('publish_mode', '"approval"'::jsonb),   -- "approval" (human gate) | "auto" | "draft" (write D1 draft, no dispatch)
  ('max_revision_rounds', '2'::jsonb),
  ('worker_enabled', 'true'::jsonb)
ON CONFLICT (key) DO NOTHING;
