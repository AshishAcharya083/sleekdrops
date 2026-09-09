/**
 * The site's own name and description, in one place.
 *
 * Both were written out verbatim in index.astro and about.astro, already
 * drifting by a word, and `/llms.txt` needs the same description as the site
 * description it hands a retrieval agent. Three copies of a sentence a reviewer
 * reads as "what this site claims to be" is one too many to keep in step by
 * hand, so they all read this.
 *
 * Plain data, no imports: `scripts/generate-llms-txt.mjs` loads this module
 * directly under Node's type stripping, before anything is built.
 */

export const SITE_NAME = 'SleekDrops';

/**
 * The one-paragraph description of the site. Kept under 160 characters so
 * `buildMeta` does not have to truncate it for a meta description.
 */
export const SITE_DESCRIPTION =
  'SleekDrops publishes independent product research, side-by-side comparisons and buying guides for Australian shoppers. No paid placements, quietly opinionated.';
