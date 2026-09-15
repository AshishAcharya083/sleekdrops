// The published corpus - every article already on the site, as the scanner
// sees it.
//
// content/slop.ts can only judge the draft in front of it. That is how a site
// converges on one voice: each article passes its own review, and nobody ever
// compares two. This module is the other half - it hands the scanner the last
// N published bodies so the n-gram and opening-line metrics have something to
// measure against.
//
// D1 is the store. Published content already lives there (the website builds
// from the same table), which means no mirror to keep in sync and, more
// usefully, that every article published before the scanner existed - the ones
// the AdSense reviewer actually flagged - is in the corpus from day one.
//
// All the I/O lives here on purpose: detectSlop stays synchronous, pure and
// offline so it can run on every review round.
import { fetchPublishedBodies } from '../tools/d1.js';
import type { CorpusArticle } from './slop.js';

/**
 * A published article. `title` and `publishedAt` always come back from the
 * store; the scanner itself only needs `slug` and `body`.
 */
export interface CorpusDocument extends CorpusArticle {
  title: string;
  publishedAt: string | null;
}

/** Articles compared against by default. */
export const DEFAULT_CORPUS_LIMIT = 30;

/** Hard ceiling, so a bad caller cannot pull the whole site into a prompt-time scan. */
const MAX_CORPUS_LIMIT = 100;

export interface LoadCorpusOptions {
  limit?: number;
  /**
   * The article being scanned. Republishes and post-publish feedback rounds
   * re-scan a body that is already in the corpus; without this every edit of a
   * live article reads as a near-duplicate of itself.
   */
  excludeSlug?: string | null;
}

/**
 * The most recently published bodies, newest first.
 *
 * Never throws. Missing D1 credentials, a failed query or an empty site all
 * come back as `[]` with one warning, and the scan simply skips its
 * cross-corpus metrics - a review round must not fail because the corpus was
 * unreachable.
 */
export async function loadPublishedCorpus(
  options?: number | LoadCorpusOptions,
): Promise<CorpusDocument[]> {
  const { limit = DEFAULT_CORPUS_LIMIT, excludeSlug = null } =
    typeof options === 'number' ? { limit: options } : options ?? {};
  const capped = Math.max(1, Math.min(Math.floor(limit) || DEFAULT_CORPUS_LIMIT, MAX_CORPUS_LIMIT));

  try {
    const rows = await fetchPublishedBodies(capped, excludeSlug);
    return rows
      .filter((row) => typeof row.body_md === 'string' && row.body_md.trim() !== '')
      .map((row) => ({
        slug: row.slug,
        title: row.title ?? row.slug,
        body: row.body_md,
        publishedAt: row.pub_date ?? null,
      }));
  } catch (err) {
    console.warn(
      `[corpus] could not load the published corpus, scanning this draft in isolation: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
}
