/**
 * Blog search — pure matching and ranking.
 *
 * Search runs entirely in the browser against the static index emitted by
 * src/pages/search-index.json.ts. This module holds the DOM-free core so it
 * can be unit-tested in isolation; the fetch + render wiring lives in
 * BlogSearch.astro and the header button in scripts/chrome.ts.
 */

export interface SearchDoc {
  title: string;
  dek: string;
  category: string;
  tags: string[];
  author: string;
  url: string;
}

/** Field weights: a title hit outranks a body hit for the same term. */
const FIELD_WEIGHTS = {
  title: 5,
  tags: 3,
  category: 2,
  author: 2,
  dek: 1,
} as const;

type Field = keyof typeof FIELD_WEIGHTS;

function normalize(value: string): string {
  return value.toLowerCase().trim();
}

/** Split a raw query into distinct, lowercased, non-empty terms. */
export function queryTerms(query: string): string[] {
  return [...new Set(normalize(query).split(/\s+/).filter(Boolean))];
}

function fieldText(doc: SearchDoc, field: Field): string {
  if (field === 'tags') return doc.tags.map(normalize).join(' ');
  return normalize(doc[field]);
}

/**
 * Score a document against the terms. Every term must appear in at least one
 * field (AND across terms); the score sums the weight of each field a term
 * hits. Returns 0 when any term is missing, so non-matches are filtered out.
 */
function scoreDoc(doc: SearchDoc, terms: string[]): number {
  let score = 0;
  for (const term of terms) {
    let termMatched = false;
    for (const field of Object.keys(FIELD_WEIGHTS) as Field[]) {
      if (fieldText(doc, field).includes(term)) {
        score += FIELD_WEIGHTS[field];
        termMatched = true;
      }
    }
    if (!termMatched) return 0;
  }
  return score;
}

/**
 * Rank documents for a query, best first. An empty or whitespace-only query
 * returns no results. Ties preserve input order, so an index built newest-first
 * stays newest-first within a score band.
 */
export function searchPosts(
  docs: readonly SearchDoc[],
  query: string,
): SearchDoc[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  return docs
    .map((doc) => ({ doc, score: scoreDoc(doc, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.doc);
}
