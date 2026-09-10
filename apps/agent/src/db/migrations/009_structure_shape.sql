-- The structure library: which silhouette a piece was built to.
--
-- One skeleton used to be hardcoded into the writer prompt - answer-first
-- opening, a 40-60 word extractable block under every H2, "How we picked", an
-- FAQ, a conclusion linking each pick - so every article on the site shared a
-- silhouette. That sameness is what a manual reviewer reads as "automatically
-- generated material lacking meaningful review or curation".
--
-- The skeleton is now a library of shapes (src/content/shapes.ts), one of
-- which is chosen per piece from the editorial angle and the keyword plan's
-- winning format. It gets a column for the same reason keyword_plan and
-- editorial_angle did: it is a decision about the piece, and an operator has
-- to be able to see which shape an article was commissioned in, separately
-- from the outline that executes it. The same record is also embedded in
-- `outline` (ContentBrief.structureShape), which is what carries it into the
-- writer and reviewer prompts.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS structure_shape JSONB;

COMMENT ON COLUMN articles.structure_shape IS
  'The structure library shape the piece was outlined to: section kinds and their order, opening style, per-article extractable-passage budget and FAQ rule. Null for articles outlined before the library existed - every consumer treats null as the old universal skeleton.';
