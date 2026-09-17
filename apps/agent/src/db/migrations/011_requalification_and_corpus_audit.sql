-- Requalification, and the audit that says which page needs it next.
--
-- Rebuilding the pipeline does nothing for the pages already on the site. The
-- three articles an AdSense reviewer flagged were written under the old
-- prompts and are still live, and asking for a second review while they are up
-- invites the same rejection. Requalification is the way back: a published
-- page re-enters the pipeline at research, carrying its own slug, its angle
-- and its published body as input, and comes out the other end republished at
-- the same address with updatedDate stamped.
--
-- The column holds that input because the run needs it at three separate
-- points, hours apart: the researcher reads the old body, the outliner is
-- refused permission to move the slug, and the assembler keeps the original
-- pubDate and protects the /go/ rows the live page already had. A run flag
-- alone could not carry any of that.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS requalification JSONB;

COMMENT ON COLUMN articles.requalification IS
  'Set while a published page is being rebuilt: the live slug, angle, body, publication date and /go/ slugs captured when the operator asked for it. Null on a normal article. The slug in here is locked for the whole run - a requalification republishes the page it came from, never a new one.';

-- One row per corpus audit sweep: scanner v2 plus a reviewer pass over every
-- published article, ranked worst first. Same shape as scout_runs, including
-- the lease - an audit is a detached background task and would otherwise hold
-- its lock forever when the instance running it is recycled.
CREATE TABLE IF NOT EXISTS corpus_audits (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status           TEXT NOT NULL DEFAULT 'running', -- running | done | failed
  articles_scanned INT  NOT NULL DEFAULT 0,
  report           JSONB,
  error            TEXT,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS corpus_audits_started_idx ON corpus_audits (started_at DESC);

COMMENT ON COLUMN corpus_audits.report IS
  'The ranked report the admin panel renders: one entry per published article with its scanner score, its reviewer dimensions and the composite that ranks it, worst first.';

-- An audit run is neither an article nor a scout sweep, so its spend had
-- nowhere to hang. Sessions are how this platform accounts for tokens, and an
-- audit that grades fifty pages is the most expensive non-article job it runs.
ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS corpus_audit_id UUID REFERENCES corpus_audits(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS agent_sessions_corpus_audit_idx ON agent_sessions (corpus_audit_id);
