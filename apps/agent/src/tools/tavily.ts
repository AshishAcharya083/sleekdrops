// Tavily web search — live evidence for the topic scout + researcher agents.
import { config } from '../config.js';

export interface SearchHit {
  title: string;
  url: string;
  content: string;
}

export async function tavilySearch(query: string, maxResults = 6): Promise<SearchHit[]> {
  return (await tavilySerp(query, maxResults)).results;
}

export interface SerpRead {
  query: string;
  /** Ranked organic results — the closest thing to reading the SERP. */
  results: SearchHit[];
  /**
   * Tavily's own generated answer for the query. Not an organic result: it is
   * a live sample of what a generative engine currently says about this
   * query, which is exactly what a GEO play has to earn a citation inside.
   * Empty unless `withAnswer` was asked for.
   */
  answer: string;
}

/**
 * One search, with the ranked results and (optionally) the generated answer.
 * `tavilySearch` is the thin wrapper the researcher and scout still use.
 */
export async function tavilySerp(
  query: string,
  maxResults = 6,
  withAnswer = false,
): Promise<SerpRead> {
  if (!config.tavilyApiKey) {
    throw new Error('TAVILY_API_KEY is not set — add it to apps/agent/.env');
  }
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: config.tavilyApiKey,
      query,
      max_results: maxResults,
      search_depth: 'advanced',
      ...(withAnswer ? { include_answer: true } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`Tavily HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    results?: Array<Record<string, string>>;
    answer?: string;
  };
  return {
    query,
    results: (json.results ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      content: r.content ?? '',
    })),
    answer: typeof json.answer === 'string' ? json.answer : '',
  };
}

/** Several SERP reads at once, tolerating individual failures. */
export async function tavilySerpMany(
  queries: string[],
  maxResults = 6,
  withAnswer = false,
): Promise<SerpRead[]> {
  const settled = await Promise.allSettled(
    queries.map((query) => tavilySerp(query, maxResults, withAnswer)),
  );
  return settled.map((outcome, i) =>
    outcome.status === 'fulfilled' ? outcome.value : { query: queries[i], results: [], answer: '' },
  );
}

/**
 * Render SERP reads for a keyword-analysis prompt: ranked position, domain and
 * the snippet, so the model can judge who holds the page and in what format.
 */
export function formatSerps(serps: SerpRead[]): string {
  return serps
    .map((serp) => {
      const ranked =
        serp.results.length === 0
          ? '(no results)'
          : serp.results
              .map((r, i) => {
                let domain = r.url;
                try {
                  domain = new URL(r.url).hostname.replace(/^www\./, '');
                } catch {
                  /* keep the raw string */
                }
                return `${i + 1}. ${r.title}\n   ${domain} — ${r.url}\n   ${r.content.slice(0, 400)}`;
              })
              .join('\n');
      const answer = serp.answer ? `\nGenerated answer currently shown for this query:\n${serp.answer}\n` : '';
      return `### SERP: "${serp.query}"\n${ranked}${answer}`;
    })
    .join('\n\n');
}

export interface ImageHit {
  url: string;
  description: string;
}

/** Image results for a query — candidate hero images for the image agent. */
export async function tavilyImageSearch(query: string, maxResults = 8): Promise<ImageHit[]> {
  if (!config.tavilyApiKey) {
    throw new Error('TAVILY_API_KEY is not set — add it to apps/agent/.env');
  }
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: config.tavilyApiKey,
      query,
      max_results: maxResults,
      include_images: true,
      include_image_descriptions: true,
    }),
  });
  if (!res.ok) {
    throw new Error(`Tavily HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as { images?: Array<string | { url: string; description?: string }> };
  return (json.images ?? []).map((img) =>
    typeof img === 'string' ? { url: img, description: '' } : { url: img.url, description: img.description ?? '' },
  );
}

/** Run several searches, tolerating individual failures. */
export async function tavilySearchMany(
  queries: string[],
  maxResults = 6,
): Promise<Array<{ query: string; results: SearchHit[] }>> {
  const settled = await Promise.allSettled(queries.map((query) => tavilySearch(query, maxResults)));
  return settled.map((outcome, i) => ({
    query: queries[i],
    results: outcome.status === 'fulfilled' ? outcome.value : [],
  }));
}

export function formatSearches(
  searches: Array<{ query: string; results: SearchHit[] }>,
): string {
  return searches
    .map(
      (s) =>
        `### Search: "${s.query}"\n` +
        (s.results.length === 0
          ? '(no results)'
          : s.results
              .map((r) => `- ${r.title}\n  URL: ${r.url}\n  ${r.content.slice(0, 400)}`)
              .join('\n')),
    )
    .join('\n\n');
}
