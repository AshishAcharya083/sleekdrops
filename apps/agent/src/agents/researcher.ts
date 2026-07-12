// Researcher — builds an evidence dossier for an approved topic: real facts
// with source URLs, candidate products with genuine Amazon links, target
// keywords, and competitor notes. Everything downstream cites this dossier.
import { chatJson, UsageTracker } from '../llm/index.js';
import { formatSearches, tavilySearchMany } from '../tools/tavily.js';
import { slugify } from '../content/contract.js';
import { SITE_CONTEXT } from './context.js';
import type { ArticleRow, ResearchDossier, TopicRow } from '../pipeline/types.js';

export async function runResearcher(
  article: ArticleRow,
  topic: TopicRow | null,
  model: string,
  tracker: UsageTracker,
): Promise<ResearchDossier> {
  const keywords = topic?.keywords?.length ? topic.keywords.join(', ') : article.title;

  // Pass 1: let the model plan targeted searches for this specific topic.
  const plan = await chatJson<{ queries: string[] }>(
    {
      model,
      system: SITE_CONTEXT,
      temperature: 0.4,
      prompt: `Plan web research for this piece:
Title: ${article.title}
Category: ${article.category} | Post type: ${article.post_type}
Angle: ${topic?.angle ?? 'n/a'}
Target keywords: ${keywords}

Return JSON {"queries": string[]} — 5-7 focused search queries covering:
product candidates and their specs/prices, buyer pain points, expert/owner
opinions, Amazon Australia availability, and what competing articles cover.`,
    },
    tracker,
  );

  const queries = (plan.queries ?? []).slice(0, 7);
  if (queries.length === 0) queries.push(article.title);
  const searches = await tavilySearchMany(queries, 6);
  const evidence = formatSearches(searches);

  // Pass 2: synthesize the dossier strictly from the gathered evidence.
  const dossier = await chatJson<ResearchDossier>(
    {
      model,
      system: SITE_CONTEXT,
      temperature: 0.3,
      maxTokens: 8000,
      prompt: `Synthesize a research dossier for "${article.title}" (${article.post_type}, ${article.category}).

STRICT RULES:
- Use ONLY the evidence below. Never invent specs, prices, or URLs.
- amazonUrl must be a URL that literally appears in the evidence, else null.
- goSlug is the kebab-case affiliate slug for the product (e.g. "sony-wh-1000xm6").
- 3-6 products for guides/roundups; for articles include products only if relevant.

Evidence:
${evidence}

Return JSON:
{"summary": string (what the piece should say, 3-5 sentences),
 "facts": [{"fact": string, "sourceUrl": string}] (8-15 concrete facts),
 "products": [{"name": string, "brand": string, "approxPrice": string,
               "amazonUrl": string|null, "goSlug": string, "notes": string}],
 "keywords": {"primary": string, "secondary": string[]},
 "competitorNotes": string (what competing pages cover + the gap we can win),
 "faqIdeas": [{"question": string, "answerHint": string}] (3-6)}`,
    },
    tracker,
  );

  // Normalize goSlugs defensively — downstream link integrity depends on them.
  for (const product of dossier.products ?? []) {
    product.goSlug = slugify(product.goSlug || product.name);
  }
  return dossier;
}
