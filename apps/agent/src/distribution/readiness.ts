// The readiness gate: an item is handed to a provider only once the page it
// points at is actually live and serving the right card.
//
// The site is a static build. `runPublisher` writes the post to D1 and asks
// GitHub to rebuild, and until that rebuild finishes the slug 404s - so a post
// sent the instant the queue row appears sends an audience to a missing page,
// and the link preview a network caches from that first fetch is the one it
// keeps. The rebuild takes roughly 90 seconds, so the gate polls rather than
// waits once, and gives up long after the slowest plausible build instead of
// holding an item forever.
import { config } from '../config.js';
import type { RenderedPayload } from './types.js';

/**
 * How long an item may keep waiting for its page before it is given up on.
 *
 * Six times the ~90 seconds a rebuild takes, because the thing being waited
 * for is not only the build: the publisher fires a repository dispatch, and
 * that run can sit in a queue behind another one before it starts. Long enough
 * that a slow deploy still posts, short enough that a rebuild which never
 * happened is an error an operator sees today.
 */
export const READINESS_WINDOW_SECONDS = 600;

/** Gap between checks. Short enough that a fast build is not made to wait. */
export const READINESS_RETRY_SECONDS = 15;

/** One fetch of a live page. Injected so tests never reach the network. */
export type PageFetcher = (url: string) => Promise<{ status: number; body: string }>;

export type ReadinessResult = { ready: true } | { ready: false; reason: string };

/**
 * `<meta property="og:title" content="...">`, in either attribute order and
 * with either quote. Deliberately a scan rather than a parser: the only thing
 * being asked is whether the page a rebuild produced carries the two values
 * this post was rendered against, and a whole DOM to answer it is a dependency
 * the agent does not otherwise have.
 */
function metaContent(html: string, property: string): string | null {
  const escaped = property.replace(':', '\\:');
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)\\s*=\\s*["']${escaped}["'][^>]*?content\\s*=\\s*["']([^"']*)["']`,
      'i',
    ),
    new RegExp(
      `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*?(?:property|name)\\s*=\\s*["']${escaped}["']`,
      'i',
    ),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match) return decodeEntities(match[1]);
  }
  return null;
}

/** The handful of entities an escaped attribute can carry. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const normalise = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * Two image URLs that name the same file. The page absolutises whatever
 * frontmatter carried, so host and path are compared and a query string (a CDN
 * cache buster) is not.
 */
function sameImage(expected: string, actual: string): boolean {
  try {
    const want = new URL(expected, config.distribution.siteUrl);
    const got = new URL(actual, config.distribution.siteUrl);
    return want.host === got.host && want.pathname === got.pathname;
  } catch {
    return normalise(expected) === normalise(actual);
  }
}

/**
 * Whether this response is the published article we rendered a post for.
 *
 * The og:title the site renders appends the site name, so the check is
 * containment on the article's own headline rather than equality - what it is
 * actually looking for is "the rebuild has replaced whatever was at this slug
 * with this piece", and a stale build serving the previous article fails it.
 */
export function evaluateReadiness(
  response: { status: number; body: string },
  expected: RenderedPayload['expected'],
): ReadinessResult {
  if (response.status !== 200) return { ready: false, reason: `HTTP ${response.status}` };

  const ogTitle = metaContent(response.body, 'og:title');
  if (ogTitle === null) return { ready: false, reason: 'page serves no og:title yet' };
  if (!normalise(ogTitle).includes(normalise(expected.ogTitle))) {
    return { ready: false, reason: `og:title is still "${normalise(ogTitle).slice(0, 80)}"` };
  }

  if (expected.ogImage) {
    const ogImage = metaContent(response.body, 'og:image');
    if (ogImage === null) return { ready: false, reason: 'page serves no og:image yet' };
    if (!sameImage(expected.ogImage, ogImage)) {
      return { ready: false, reason: `og:image is still ${normalise(ogImage).slice(0, 120)}` };
    }
  }

  return { ready: true };
}

/** True once an item has waited out the whole rebuild window. */
export function readinessWindowExpired(
  startedAt: string | Date,
  now: Date = new Date(),
  windowSeconds = READINESS_WINDOW_SECONDS,
): boolean {
  const started = startedAt instanceof Date ? startedAt : new Date(startedAt);
  return now.getTime() - started.getTime() >= windowSeconds * 1000;
}

/** The real fetcher. A non-2xx is a result, not an exception. */
export const fetchPage: PageFetcher = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SleekDropsBot/1.0; +https://sleekdrops.com)' },
    });
    return { status: res.status, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
};

/** Fetch the article's live page and judge it. A fetch failure is not ready. */
export async function checkReadiness(
  url: string,
  expected: RenderedPayload['expected'],
  fetcher: PageFetcher = fetchPage,
): Promise<ReadinessResult> {
  try {
    return evaluateReadiness(await fetcher(url), expected);
  } catch (err) {
    return { ready: false, reason: `page fetch failed: ${err instanceof Error ? err.message : err}` };
  }
}
