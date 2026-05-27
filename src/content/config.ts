import { defineCollection, z } from 'astro:content';

/**
 * Blog collection.
 *
 * Each .md file under src/content/blog/ becomes a post. Frontmatter is
 * validated against this schema at build time — typos and missing fields
 * fail the build instead of silently shipping.
 *
 * Author and (optionally) product are referenced by id and must exist in
 * src/data/authors.ts and src/data/products.ts respectively.
 */
const blog = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    /** One-sentence subhead / dek / excerpt. */
    dek: z.string(),
    category: z.enum([
      'Tech',
      'Home',
      'Fashion',
      'Health',
      'Finance',
      'Travel',
    ]),
    /** Underlying post type drives layout choice and JSON-LD schema. */
    postType: z
      .enum(['article', 'review', 'guide', 'roundup'])
      .default('article'),
    /** Optional human label, e.g. "Buying guide", "Review", "Comparison". */
    kind: z.string().optional(),
    /** Author id — must match an entry in src/data/authors.ts. */
    author: z.string(),
    /** Optional tag list for the /tag/[tag] index pages. */
    tags: z.array(z.string()).default([]),
    pubDate: z.coerce.date(),
    /** Optional ISO update date (overrides pubDate for `dateModified`). */
    updatedDate: z.coerce.date().optional(),
    /** Reading time in minutes. */
    readTime: z.number().int().positive(),
    /** Placeholder gradient class, fill-1 … fill-8. */
    cover: z.enum([
      'fill-1',
      'fill-2',
      'fill-3',
      'fill-4',
      'fill-5',
      'fill-6',
      'fill-7',
      'fill-8',
    ]),
    /** Optional product id — required for `postType: review`. */
    product: z.string().optional(),
    /** Editor's-pick / hero slot on the homepage. */
    featured: z.boolean().default(false),
    /** Hide from listings without deleting the file. */
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog };
