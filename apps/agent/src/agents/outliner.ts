// Outliner — turns the research dossier into an SEO content brief: title,
// dek, slug, keyword plan, section-by-section outline, FAQ.
import { chatJson, UsageTracker } from '../llm/openrouter.js';
import { AUTHORS, slugify } from '../content/contract.js';
import { SEO_RULES, SITE_CONTEXT } from './context.js';
import type { ArticleRow, ContentBrief } from '../pipeline/types.js';

export async function runOutliner(
  article: ArticleRow,
  model: string,
  tracker: UsageTracker,
): Promise<ContentBrief> {
  const brief = await chatJson<ContentBrief>(
    {
      model,
      system: `${SITE_CONTEXT}\n\n${SEO_RULES}`,
      temperature: 0.5,
      maxTokens: 6000,
      prompt: `Create the SEO content brief for this piece.

Working title: ${article.title}
Post type: ${article.post_type} | Category: ${article.category}
Research dossier:
${JSON.stringify(article.research, null, 2)}

Return JSON:
{"seoTitle": string (≤60 chars, front-loaded primary keyword, include the year when natural),
 "dek": string (140-160 chars, includes primary keyword, sells the click honestly),
 "slug": string (kebab-case, short, keyword-bearing),
 "author": string (one of: ${AUTHORS.map((a) => a.id).join(', ')} — match the beat),
 "kind": string (human badge label, e.g. "Buying guide", "Comparison", "Trend watch"),
 "searchIntent": string,
 "primaryKeyword": string,
 "secondaryKeywords": string[],
 "tags": string[] (4-7 lowercase tags),
 "wordCountTarget": number (guides ≥1800, roundups ≥1400, articles ≥900),
 "sections": [{"heading": string (H2 text), "points": string[] (what it must cover,
               which products/facts from the dossier to use)}],
 "faq": [{"question": string}] (3-5 long-tail questions from the dossier's faqIdeas)}`,
    },
    tracker,
  );

  brief.slug = slugify(brief.slug || brief.seoTitle || article.title);
  if (!AUTHORS.some((a) => a.id === brief.author)) brief.author = 'mira';
  return brief;
}
