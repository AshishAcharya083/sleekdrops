import { defineCollection } from 'astro:content';

import { blogFrontmatterSchema } from './frontmatter';

/**
 * Blog collection.
 *
 * The actual `.md` files are NOT committed to this repo. They live in D1
 * (`posts.frontmatter_json`) and are fetched into src/content/blog/ at build
 * time by scripts/fetch-content.mjs (see package.json -> scripts.dev/prebuild).
 *
 * The frontmatter contract itself is in ./frontmatter.ts, where it is unit
 * tested against the exact JSON the agent's assembler writes.
 */
const blog = defineCollection({
  type: 'content',
  schema: blogFrontmatterSchema,
});

export const collections = { blog };

// Re-exported so components keep importing their frontmatter types from the
// collection they belong to.
export { pickSchema, productSchema, sourceSchema, sourceTiers } from './frontmatter';
export type { BlogFrontmatter, PickData, ProductData, SourceData, SourceTier } from './frontmatter';
