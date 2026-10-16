-- The public bucket for article hero images, as applied to the SleekDrops
-- project (ofcujovpxfoxvpfkszmf). Public means anyone may GET an object by its
-- URL - what the website's <img> tags do; listing, uploading and deleting
-- still need the service role, which only the agent holds. The size cap is
-- the admin panel's own hero-image limit (tools/heroImages.ts).
--
-- Everything else in the database - the content tables, the pipeline's tables
-- and what the Data API may read - is the agent's migrations'
-- (apps/agent/src/db/migrations, 019 for the content store and its policies).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'images',
  'images',
  true,
  10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;
