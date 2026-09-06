// Researcher — builds an evidence dossier for an approved topic: real facts
// with source URLs, candidate products with genuine Amazon links, target
// keywords, and competitor notes. Everything downstream cites this dossier,
// which is why this is the stage that gets live search: a wrong price here is
// a wrong price in the published piece, repeated by four agents on the way.
//
// The Tavily sweep still runs first and unconditionally. It is the evidence
// floor — breadth the model does not have to think to ask for — and the search
// tool is what the model uses on top of it to check the specifics that matter.
import { chatJson, UsageTracker } from '../llm/index.js';
import { formatSearches, tavilySearchMany } from '../tools/tavily.js';
import { parseAmazonUrl, slugify } from '../content/contract.js';
import { operatorBrief, siteContext, SOURCE_DISCIPLINE, VERIFICATION_RULES } from './context.js';
import type { ArticleRow, ResearchDossier, TopicRow } from '../pipeline/types.js';

export async function runResearcher(
  article: ArticleRow,
  topic: TopicRow | null,
  model: string,
  tracker: UsageTracker,
): Promise<ResearchDossier> {
  const keywords = topic?.keywords?.length ? topic.keywords.join(', ') : article.title;
  const brief = operatorBrief(topic);

  // Pass 1: let the model plan targeted searches for this specific topic.
  const plan = await chatJson<{ queries: string[] }>(
    {
      model,
      system: `${siteContext()}\n\n${SOURCE_DISCIPLINE}`,
      temperature: 0.4,
      prompt: `Plan web research for this piece:
Title: ${article.title}
Category: ${article.category} | Post type: ${article.post_type}
Angle: ${topic?.angle ?? 'n/a'}
Target keywords: ${keywords}
${brief ? `\n${brief}\n\nLet the operator brief steer these queries: search to verify and expand on it, not to second-guess it.\n` : ''}
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
      system: `${siteContext()}\n\n${SOURCE_DISCIPLINE}\n\n${VERIFICATION_RULES}`,
      temperature: 0.3,
      maxTokens: 8000,
      search: true,
      prompt: `Synthesize a research dossier for "${article.title}" (${article.post_type}, ${article.category}).
${brief ? `\n${brief}\n\nFold the operator's reference materials into the dossier as facts (with their source where given), and let the operator instructions shape the summary and angle. They are authoritative source material, on par with the search evidence below.\n` : ''}
STRICT RULES:
- Your facts come from three places and nowhere else: the evidence below${brief ? ', the operator brief above' : ''},
  and what you confirm yourself with web_search / read_page. Never invent a
  spec, a price or a URL, and never carry one over from memory.
- VERIFY BEFORE YOU FILE. Every price, model number, headline spec and
  availability claim gets checked against a primary source — the maker's page
  or the retailer's listing — before it enters the dossier. Prices are AUD and
  move weekly; an unchecked one is the single most likely thing to be wrong.
  Anything that survives the check is a fact; anything that doesn't is dropped,
  not hedged into the dossier for a later stage to trip over.
- amazonUrl: an Amazon PRODUCT page URL (amazon.com.au or amazon.com, containing
  /dp/ or /gp/product/) that you have actually seen in the evidence or in a
  search result — else null. A retailer or news site URL is NEVER an amazonUrl,
  and neither is a URL you assembled from an ASIN you remember. Products without
  one are still fine: the pipeline links them via an Amazon search fallback.
- goSlug is the kebab-case affiliate slug for the product (e.g. "sony-wh-1000xm6").
- 3-6 products for guides/roundups; for articles include products only if relevant.
- competitorNotes describes what the top pages cover and where they are thin.
  It is the one field allowed to discuss them, and even there: no facts lifted,
  no URLs that will end up in the body.

Evidence (the floor, not the ceiling — check what matters before you file it):
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
  // And never trust the model's idea of "an Amazon URL": anything that doesn't
  // parse as a real Amazon product page (marketplace host + /dp/ ASIN) is
  // dropped here, deterministically. This is the gate that keeps news-site and
  // retailer URLs out of the affiliate table.
  for (const product of dossier.products ?? []) {
    product.goSlug = slugify(product.goSlug || product.name);
    if (product.amazonUrl && !parseAmazonUrl(product.amazonUrl)) {
      product.notes = `${product.notes ?? ''} [non-Amazon URL dropped: ${product.amazonUrl}]`.trim();
      product.amazonUrl = null;
    }
  }
  return dossier;
}
