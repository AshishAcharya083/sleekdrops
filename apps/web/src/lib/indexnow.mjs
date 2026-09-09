/**
 * IndexNow - telling Bing (and Yandex, Naver, Seznam, Yep, Amazon) which URLs
 * changed, the moment a deploy finishes, instead of waiting to be crawled.
 *
 * Why it is worth a script: Bing's index is what Copilot, DuckDuckGo and, by
 * OpenAI's own account, ChatGPT search draw on, and Bing says sitemap freshness
 * "directly influence[s] how quickly updates are reflected in search results and
 * AI generated answers". Google does not participate; Search Console covers it.
 *
 * The protocol: a key file at a public URL proves we own the host, then one POST
 * with up to 10,000 URLs fans out to every participating engine. IndexNow only
 * wants URLs that changed, so the caller picks them from the sitemap's own
 * `lastmod` (see ./sitemap-policy.mjs) rather than resubmitting the whole site.
 *
 * Pure functions here; the network and the filesystem are in
 * scripts/indexnow-submit.mjs.
 */

export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';

/** The key file `public/` ships at the site root; its contents are the key. */
export const KEY_FILE = 'indexnow-key.txt';

/** IndexNow's own constraint on a key: 8-128 of [A-Za-z0-9-]. */
export function isValidKey(key) {
  return typeof key === 'string' && /^[A-Za-z0-9-]{8,128}$/.test(key);
}

/** Every `<url>` in a sitemap, with its lastmod when it has one. */
export function parseSitemapUrls(xml) {
  const entries = [];
  for (const block of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = /<loc>\s*([^<\s]+)\s*<\/loc>/.exec(block[1])?.[1];
    if (!loc) continue;
    const lastmod = /<lastmod>\s*([^<\s]+)\s*<\/lastmod>/.exec(block[1])?.[1] ?? null;
    entries.push({ loc, lastmod });
  }
  return entries;
}

/** The sitemap files a sitemap index points at. */
export function parseSitemapIndex(xml) {
  return [...xml.matchAll(/<sitemap>[\s\S]*?<loc>\s*([^<\s]+)\s*<\/loc>[\s\S]*?<\/sitemap>/g)].map((m) => m[1]);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The URLs whose lastmod falls inside the window. An entry without a lastmod is
 * never "changed" - we cannot vouch for it, so we do not claim it.
 *
 * Every lastmod is read at day precision. The dates come from post frontmatter
 * that carries a day and no time (`pubDate: "2026-09-05"`), and @astrojs/sitemap
 * writes them back out as midnight UTC - so a post published on the 5th reads as
 * the very start of the 5th, and a window measured from the 6th would miss it.
 * "Changed on that day" is what the date means, so an entry counts until the end
 * of the day it names. Claiming a day too many is harmless to IndexNow; missing
 * yesterday's post is the failure this guards against.
 */
export function selectChangedUrls(entries, { now, sinceHours }) {
  const floor = now.getTime() - sinceHours * 60 * 60 * 1000;
  return entries
    .filter((entry) => {
      if (!entry.lastmod) return false;
      const changed = new Date(entry.lastmod);
      if (Number.isNaN(changed.getTime())) return false;
      const endOfDay =
        Date.UTC(changed.getUTCFullYear(), changed.getUTCMonth(), changed.getUTCDate()) + DAY_MS - 1;
      // A lastmod in the future is a mistake, not a change; do not claim it.
      return endOfDay >= floor && changed.getTime() <= now.getTime() + DAY_MS;
    })
    .map((entry) => entry.loc);
}

/** The JSON body IndexNow expects. */
export function buildSubmission({ siteUrl, key, urls }) {
  const host = new URL(siteUrl).host;
  return {
    host,
    key,
    keyLocation: `${siteUrl.replace(/\/+$/, '')}/${KEY_FILE}`,
    urlList: [...new Set(urls)].slice(0, 10_000),
  };
}
