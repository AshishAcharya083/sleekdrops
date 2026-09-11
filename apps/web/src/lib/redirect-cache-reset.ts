/**
 * One-time recovery for browsers already trapped in the trailing-slash redirect
 * loop.
 *
 * ./trailing-slash-mirror.mjs explains the loop and stops it being created:
 * every page now answers 200 at both /path and /path/, so no permanent redirect
 * between the two forms is ever minted again. That is enough for a visitor
 * holding one cached 308 - the form it points at now returns a page.
 *
 * It is not enough for a visitor who already hit the loop. They cached the old
 * build's "/x -> /x/" and then the new build's "/x/ -> /x", and a browser
 * holding both hops bounces between them without asking the server anything at
 * all. Nothing served from sleekdrops.com can reach those two URLs, so the only
 * way out is to make the browser drop them, and `Clear-Site-Data: "cache"` is
 * the one header that does. Verified against the Cloudflare Pages asset server:
 * a browser poisoned in both directions loads the article again immediately
 * after the fetch below, and keeps loading it, because the mirrored build gives
 * it nothing to re-cache.
 *
 * The homepage is what makes this reachable: `/` is index.html under either
 * build layout, so it never redirected and is never part of a loop. A visitor
 * who cannot open a single article can always still open the site.
 *
 * The flag is written before the request rather than after, so a browser makes
 * at most one attempt ever - a reset that fails offline is not worth a repeated
 * request on every page load, and `Clear-Site-Data: "cache"` leaves local
 * storage alone, so the flag survives the very cache clear it triggers.
 *
 * This is a migration, not a feature. Once the September 2026 URL-shape change
 * is far enough back that no cached 308 from it survives, this module, its call
 * in src/scripts/chrome.ts, the public/cache-reset.txt asset and its
 * public/_headers rule can all be deleted together.
 */

/** Remembers that this browser has had its redirect cache reset. */
export const RESET_FLAG = 'sd-redirect-cache-reset';

/**
 * The asset carrying `Clear-Site-Data: "cache"` (see public/_headers). Its body
 * is irrelevant - the header is the whole point.
 */
export const RESET_URL = '/cache-reset.txt';

/**
 * Bumped only if a later URL-shape change ever needs a second sweep; a browser
 * holding an older value resets once more.
 */
export const RESET_GENERATION = '2026-09-trailing-slash';

export interface RedirectCacheResetDeps {
  /** Local storage read, which throws in a browser with storage disabled. */
  read: (key: string) => string | null;
  write: (key: string, value: string) => void;
  /** Same-origin request for RESET_URL; only its headers matter. */
  request: (url: string) => Promise<unknown>;
}

/**
 * Clear this browser's HTTP cache once, and remember that it was done.
 *
 * @returns whether the request was made - false when this browser has already
 *   been reset, or when storage is unavailable and a one-shot cannot be tracked.
 */
export async function resetRedirectCache(deps: RedirectCacheResetDeps): Promise<boolean> {
  let done: string | null;
  try {
    done = deps.read(RESET_FLAG);
  } catch {
    // No storage means no way to tell a first visit from a hundredth, and
    // clearing the cache on every page load is worse than not clearing it.
    return false;
  }
  if (done === RESET_GENERATION) return false;

  try {
    deps.write(RESET_FLAG, RESET_GENERATION);
  } catch {
    return false;
  }

  try {
    await deps.request(RESET_URL);
  } catch {
    // Offline, blocked, or the asset is gone: the page is unaffected either way.
    return false;
  }
  return true;
}
