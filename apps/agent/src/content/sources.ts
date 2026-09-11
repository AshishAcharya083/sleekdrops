// The sources a published article shows, derived from the research dossier.
//
// This is the deterministic half of the trust surface: what the reader sees
// under "Sources" is exactly what the researcher gathered, in the order it
// gathered it, with nothing added by a model. The writer is handed the same
// numbered list it produces here, so a citation marker in the body and an
// entry in the visible list always mean the same source.
//
// The fact shape is declared structurally rather than imported from
// pipeline/types.ts so this file type-checks against any dossier that carries
// `fact` and `sourceUrl` - including the rows already in Postgres, written
// before the researcher was tiered.

/**
 * Where a claim came from, and therefore what it is worth. Mirrors
 * `SourceTier` in pipeline/types.ts. 'unknown' is a visible state: a source we
 * could not place says so rather than being quietly promoted.
 */
export const SOURCE_TIERS = ['primary', 'expert', 'owner', 'aggregator', 'unknown'] as const;

export type SourceTier = (typeof SOURCE_TIERS)[number];

/** The parts of a dossier fact this module reads. Nothing else is its business. */
export interface DossierFact {
  fact: string;
  sourceUrl: string;
  tier?: SourceTier;
  date?: string | null;
  publisher?: string | null;
}

/** One entry of the article's `sources` frontmatter, and of the visible list. */
export interface ArticleSource {
  url: string;
  publisher: string;
  /** 'YYYY', 'YYYY-MM' or 'YYYY-MM-DD', as the source itself gives it. */
  date?: string;
  tier?: SourceTier;
}

/** The three date shapes a source may carry; anything else is not a date. */
const SOURCE_DATE = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/;

function statedDate(date: string | null | undefined): string | undefined {
  const stated = date?.trim();
  return stated && SOURCE_DATE.test(stated) ? stated : undefined;
}

function statedTier(tier: string | null | undefined): SourceTier | undefined {
  return SOURCE_TIERS.find((known) => known === tier);
}

/**
 * The dossier's sources, deduplicated by URL and limited to web pages.
 *
 * What is stored is the parser's normalised serialisation, never the raw
 * string: a source URL is attacker-influenceable (the researcher collects them
 * from search results), and `new URL()` percent-encodes the characters that
 * would otherwise let one break out of the `<script type="application/ld+json">`
 * block it is rendered into. Normalising also makes the dedupe set compare
 * canonical forms rather than incidental spelling.
 *
 * The publisher falls back to the hostname so the list never shows a reader a
 * blank attribution; the date and tier are omitted rather than guessed.
 */
export function articleSources(facts: readonly DossierFact[]): ArticleSource[] {
  const seen = new Set<string>();
  const sources: ArticleSource[] = [];
  for (const fact of facts) {
    const stated = fact.sourceUrl?.trim();
    if (!stated) continue;
    let parsed: URL;
    try {
      parsed = new URL(stated);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
    const url = parsed.toString();
    if (seen.has(url)) continue;
    seen.add(url);
    const publisher = fact.publisher?.trim() || parsed.hostname.replace(/^www\./, '');
    // A URL with no hostname to fall back on (http:///path) would leave the
    // reader an unattributed row, which is worse than one fewer source.
    if (!publisher) continue;
    const date = statedDate(fact.date);
    const tier = statedTier(fact.tier);
    sources.push({ url, publisher, ...(date ? { date } : {}), ...(tier ? { tier } : {}) });
  }
  return sources;
}

/**
 * The numbered source list the writer cites against, one line per source. The
 * indices are the ones the published article shows, because both come from
 * `articleSources` over the same dossier.
 */
export function numberedSourceList(sources: readonly ArticleSource[]): string {
  return sources
    .map(
      (source, index) =>
        `[${index + 1}] ${source.publisher}${source.date ? ` (${source.date})` : ''}${
          source.tier ? ` - ${source.tier} source` : ''
        } - ${source.url}`,
    )
    .join('\n');
}

/**
 * A bracketed citation marker: `[3]`, but never a markdown link (`[text](url)`)
 * or link reference (`[text][3]`, `[3]: url`). Any space in front of it is part
 * of the match so removing a broken marker does not leave one behind.
 */
const CITATION_MARKER = /[ \t]?(?<!\])\[(\d{1,3})\](?![(:])/g;

/**
 * Drop the citation markers that point at a source the article does not carry.
 *
 * A marker is only worth showing if the reader can follow it, and the writer
 * numbering one past the end of the list is exactly the kind of drift that
 * turns a trust surface into a liability. Unresolvable markers are removed the
 * same way an unresolvable /go/ link is - the sentence survives, the broken
 * reference does not.
 */
export function stripUnresolvedCitations(body: string, sourceCount: number): string {
  return body.replace(CITATION_MARKER, (marker, index: string) => {
    const position = Number(index);
    return position >= 1 && position <= sourceCount ? marker : '';
  });
}

/** Every source index the body actually cites, in ascending order. */
export function citedSourceIndexes(body: string): number[] {
  const cited = new Set<number>();
  for (const [, index] of body.matchAll(CITATION_MARKER)) cited.add(Number(index));
  return [...cited].sort((a, b) => a - b);
}
