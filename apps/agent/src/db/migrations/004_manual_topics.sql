-- Manual operator topics: an admin hand-writes a topic with instructions and
-- optional Markdown reference materials that the article agents treat as
-- authoritative context.
--
-- Staged-review guard (the editorial-CMS convention): a manual topic lands as
-- status='draft' with NO article row, so jotting a topic costs nothing. An
-- article is created only on an explicit, separate approval - a typo, a
-- double-click, or a reconsidered idea can't burn a generation run.
--
-- 'source'         - 'scout' (Topic Scout) | 'manual' (operator-authored).
-- 'instructions'   - free-text operator brief: what to write, angle, must-haves.
-- 'research_notes' - JSON array of reference materials [{name, content}] merged
--                    from uploaded .md files and pasted-inline markdown blocks.
ALTER TABLE topics ADD COLUMN IF NOT EXISTS source         TEXT  NOT NULL DEFAULT 'scout';
ALTER TABLE topics ADD COLUMN IF NOT EXISTS instructions   TEXT;
ALTER TABLE topics ADD COLUMN IF NOT EXISTS research_notes JSONB NOT NULL DEFAULT '[]';
