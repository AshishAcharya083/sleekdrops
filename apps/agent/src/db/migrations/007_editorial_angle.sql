-- The editorial angle as its own pipeline stage.
--
-- Nothing between the keyword plan and the outline decided what an article
-- argued. The outliner turned a dossier into sections and the writer filled
-- them, so every piece had coverage and no position - which is what a manual
-- reviewer reads as "automatically generated material lacking meaningful
-- review or curation". The `angle` stage sits between `keyword` and `outline`
-- and records the thesis, the reader served, the non-obvious take, what the
-- piece says that the top-3 results do not, and the structural shape.
--
-- It gets a column rather than being folded into `outline` for the same reason
-- `keyword_plan` did: it is an input to that stage, not a product of it, and
-- the admin panel has to show what a piece was commissioned to argue
-- separately from the outline that executes it.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS editorial_angle JSONB;

-- Stages are now:
--   research | keyword | angle | outline | write | seo_review | edit
--   | assemble | image | publish | done
--
-- `stage` is TEXT with no constraint, so in-flight articles keep whatever
-- stage they hold and simply never get an angle. Every prompt that reads one
-- treats null as "no angle was recorded", so work queued before this migration
-- finishes on the old path instead of stalling.
COMMENT ON COLUMN articles.stage IS
  'research | keyword | angle | outline | write | seo_review | edit | assemble | image | publish | done';

COMMENT ON COLUMN articles.editorial_angle IS
  'Angle editor output: the thesis, the reader served, the contrarian take (or an explicit record that the evidence supports none), the information gain over the top-3 results, the structural shape and the beat voice it is written in. Null for articles that predate the angle stage.';
