-- Operator-supplied hero images: an admin drops an image file in the panel and
-- that file becomes the article's hero, outranking whatever the image agent
-- would have found or generated.
--
-- The URL gets its own column instead of living only in `frontmatter` because
-- the operator can attach the image at any point — while briefing a manual
-- topic, or long before the assembler has built a frontmatter object to patch.
-- The assembler stamps the column into frontmatter on every pass, so an image
-- dropped at brief time survives re-assembly and the admin-feedback loop.
--
-- On topics the columns are the brief-time slot: approving the topic copies
-- both onto the article it creates.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS hero_image_url TEXT;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS hero_alt       TEXT;
ALTER TABLE topics   ADD COLUMN IF NOT EXISTS hero_image_url TEXT;
ALTER TABLE topics   ADD COLUMN IF NOT EXISTS hero_alt       TEXT;
