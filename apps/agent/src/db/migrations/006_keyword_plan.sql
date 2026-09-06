-- Keyword strategy as its own pipeline stage.
--
-- Which query an article targets used to be a side effect of writing the
-- brief: the researcher named a "primary keyword" from whatever it happened to
-- read, and the outliner inherited it. Nobody had looked at the SERP, so the
-- piece could be built for a query owned by Amazon's own product pages, or for
-- a head term whose answer never leaves the AI Overview.
--
-- The `keyword` stage sits between research and outline and reads the live
-- SERP for several candidates before committing to one. Its output is what the
-- brief, the draft and the review are all built against, so it gets a column
-- rather than being folded into `outline`: it is an input to that stage, and
-- the admin panel needs to show the reasoning (and the rejected candidates)
-- separately from the outline the reasoning produced.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS keyword_plan JSONB;

-- Stages are now:
--   research | keyword | outline | write | seo_review | edit
--   | assemble | image | publish | done
--
-- Articles already past research keep their existing stage and simply never
-- get a plan; every prompt that reads one treats null as "fall back to the
-- dossier's keywords", so in-flight work finishes on the old path.
COMMENT ON COLUMN articles.keyword_plan IS
  'Keyword strategist output: the target query, its live SERP read, content gaps, PAA questions, entities and the snippet target. Null for articles that predate the keyword stage.';
