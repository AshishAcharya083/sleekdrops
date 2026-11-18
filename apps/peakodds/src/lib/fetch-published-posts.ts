// Reads PeakOdds' published posts from its Supabase project through the Data
// API, a page at a time. scripts/fetch-content.mjs runs it before every build.
//
// The publishable key is public by design: row-level security lets it read
// published posts and nothing else, so the build needs no secret.
import { POST_ROW_COLUMNS } from './posts.ts';

/** How long one page request may take before the build gives up on Supabase. */
export const FETCH_TIMEOUT_MS = 30_000;

/** Rows per request. Supabase caps a Data API response at 1,000 rows by default. */
export const PAGE_SIZE = 1000;

export interface ContentSource {
  readonly supabaseUrl: string;
  readonly publishableKey: string;
}

export interface FetchPublishedPostsDeps {
  readonly fetch?: typeof fetch;
  readonly pageSize?: number;
}

/**
 * The Supabase project to read, from PEAKODDS_SUPABASE_URL and
 * PEAKODDS_SUPABASE_PUBLISHABLE_KEY. An empty value counts as missing: CI
 * passes an unset repository variable as ''.
 */
export function contentSourceFromEnv(env: Readonly<Record<string, string | undefined>>): ContentSource {
  const supabaseUrl = (env.PEAKODDS_SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
  const publishableKey = (env.PEAKODDS_SUPABASE_PUBLISHABLE_KEY ?? '').trim();
  const missing = [
    ...(supabaseUrl ? [] : ['PEAKODDS_SUPABASE_URL']),
    ...(publishableKey ? [] : ['PEAKODDS_SUPABASE_PUBLISHABLE_KEY']),
  ];
  if (missing.length > 0) {
    throw new Error(
      `Missing ${missing.join(' and ')}. The PeakOdds build reads its posts from Supabase: ` +
        'locally, copy apps/peakodds/.env.example to apps/peakodds/.env and fill them in; ' +
        'in CI, set them as repository variables.',
    );
  }
  return { supabaseUrl, publishableKey };
}

/** Every published `posts` row the publishable key can read, ordered by slug. */
export async function fetchPublishedPosts(
  source: ContentSource,
  deps: FetchPublishedPostsDeps = {},
): Promise<unknown[]> {
  const fetchPage = deps.fetch ?? fetch;
  const pageSize = deps.pageSize ?? PAGE_SIZE;
  const rows: unknown[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await readPage(source, fetchPage, pageSize, offset);
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

async function readPage(
  source: ContentSource,
  fetchPage: typeof fetch,
  pageSize: number,
  offset: number,
): Promise<unknown[]> {
  const query = new URLSearchParams({
    select: POST_ROW_COLUMNS,
    status: 'eq.published',
    order: 'slug.asc',
    limit: String(pageSize),
    offset: String(offset),
  });
  let response: Response;
  let body: string;
  try {
    response = await fetchPage(`${source.supabaseUrl}/rest/v1/posts?${query}`, {
      headers: { apikey: source.publishableKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    body = await response.text();
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(`Supabase did not answer the posts query within ${FETCH_TIMEOUT_MS} ms`, { cause: error });
    }
    throw new Error(`Supabase is unreachable reading posts: ${String(error)}`, { cause: error });
  }
  if (!response.ok) throw new Error(`Supabase posts query failed (HTTP ${response.status}): ${body}`);
  const page: unknown = JSON.parse(body);
  if (!Array.isArray(page)) throw new Error('Supabase posts query did not return a JSON array');
  return page;
}
