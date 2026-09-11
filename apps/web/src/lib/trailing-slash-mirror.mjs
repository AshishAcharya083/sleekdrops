/**
 * Which pages need a second copy at their trailing-slash URL, so that neither
 * form of a URL ever redirects to the other.
 *
 * The bug this fixes, reported from the live site in September 2026: opening an
 * article showed Chrome's "This page isn't working - sleekdrops.com redirected
 * you too many times. Try deleting your cookies. ERR_TOO_MANY_REDIRECTS", on
 * some pages, some of the time, on both develop and production.
 *
 * It is a redirect the *browser* is holding, not one the server sends:
 *
 *  1. Until `build.format: 'file'` landed, Astro wrote blog/<slug>/index.html,
 *     so Cloudflare Pages served the trailing-slash form and answered the
 *     slash-less one - the form the canonical tag names - with a 308.
 *  2. Pages sends that 308 with no Cache-Control, and a permanent redirect
 *     with no freshness information is heuristically cacheable: Chrome keeps it
 *     more or less indefinitely.
 *  3. `build.format: 'file'` reversed the direction. The server now 308s
 *     /blog/<slug>/ to /blog/<slug>.
 *
 * A browser that read an article before the switch therefore has "/blog/x ->
 * /blog/x/" pinned in its redirect cache, and the two take turns forever:
 * cache sends it to the slash form, server sends it back, until Chrome gives
 * up. Only the pages that visitor happened to open before the switch are
 * affected, which is why it looks intermittent, and a reload clears it only
 * because a reload revalidates rather than replaying the cached hop.
 *
 * There is no way to evict an entry from someone else's redirect cache, so the
 * loop can only be broken from the other end: the trailing-slash URL has to
 * answer 200 instead of redirecting. Emitting the directory form alongside the
 * file form does exactly that, and makes the pair immune to this class of
 * defect for good - with both files present Pages serves each form from its own
 * file and neither one redirects, so no permanent redirect is ever minted, and
 * a future change of URL shape cannot strand anyone again.
 *
 * The duplicate is not a duplicate to a crawler: both copies carry the same
 * `rel="canonical"` naming the slash-less URL, and the sitemap lists only that
 * one. Nothing about which URL is canonical changes here - the slash-less form
 * is still what is served, linked and submitted.
 *
 * Plain ESM, like ./sitemap-policy.mjs, because scripts/mirror-trailing-slash.mjs
 * runs it over `dist` after the build with no bundler in the way. The decision
 * lives here rather than in the script so it can be unit-tested.
 */

/** Pages resolves a request that misses to the nearest 404.html, never /404/. */
const NOT_FOUND = '404.html';

/** A directory URL is already served by its own index.html. */
const DIRECTORY_INDEX = 'index.html';

/**
 * Plan the copies for one build.
 *
 * @param {string[]} htmlPaths Every .html file in the build, as dist-relative
 *   POSIX paths (`about.html`, `blog/xiaomi-17-ultra.html`).
 * @returns {{ source: string, mirror: string }[]} Copies to make, in input
 *   order. A page whose directory form the build already wrote is left alone.
 */
export function planTrailingSlashMirrors(htmlPaths) {
  const existing = new Set(htmlPaths);

  return htmlPaths.flatMap((source) => {
    if (!source.endsWith('.html')) return [];

    const name = source.slice(source.lastIndexOf('/') + 1);
    // index.html *is* the trailing-slash form, and 404.html is Pages' handler
    // for a miss rather than a page anyone holds a cached redirect to.
    if (name === DIRECTORY_INDEX || name === NOT_FOUND) return [];

    const mirror = `${source.slice(0, -'.html'.length)}/${DIRECTORY_INDEX}`;
    return existing.has(mirror) ? [] : [{ source, mirror }];
  });
}
