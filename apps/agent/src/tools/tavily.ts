// Tavily web search — live evidence for the topic scout + researcher agents.
import { config } from '../config.js';

export interface SearchHit {
  title: string;
  url: string;
  content: string;
}

export async function tavilySearch(query: string, maxResults = 6): Promise<SearchHit[]> {
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
    }),
  });
  if (!res.ok) {
    throw new Error(`Tavily HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as { results?: Array<Record<string, string>> };
  return (json.results ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    content: r.content ?? '',
  }));
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
