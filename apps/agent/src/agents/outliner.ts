// Outliner — turns the research dossier and the keyword plan into an SEO
// content brief: title, dek, slug, section-by-section outline, FAQ.
//
// The keyword plan owns the strategy (which query, which format, how long,
// which gaps); this stage owns the shape of the article that executes it. When
// the plan is missing (an article queued before the keyword stage existed) it
// falls back to the dossier's own keywords.
import { chatJson, UsageTracker } from '../llm/index.js';
import { AUTHORS, slugify } from '../content/contract.js';
import { GEO_RULES, keywordPlanBrief, SEO_RULES, siteContext, SOURCE_DISCIPLINE } from './context.js';
import type { ArticleRow, ContentBrief } from '../pipeline/types.js';

export async function runOutliner(
  article: ArticleRow,
  model: string,
  tracker: UsageTracker,
): Promise<ContentBrief> {
  const plan = article.keyword_plan;
  const planBrief = keywordPlanBrief(plan);

  const brief = await chatJson<ContentBrief>(
    {
      model,
      system: `${siteContext()}\n\n${SOURCE_DISCIPLINE}\n\n${SEO_RULES}\n\n${GEO_RULES}`,
      temperature: 0.5,
      maxTokens: 8000,
      prompt: `Create the SEO content brief for this piece.

Working title: ${article.title}
Post type: ${article.post_type} | Category: ${article.category}
${planBrief ? `\n${planBrief}\n` : ''}
Research dossier:
${JSON.stringify(article.research, null, 2)}

Build the outline to execute the keyword plan:
- Every People Also Ask question becomes an H2 or an FAQ entry. None get dropped.
- Every content gap gets a section of its own — the gaps are the reason this
  piece can outrank the pages already there.
- The section that answers the primary keyword's core question comes first,
  and its "points" must include the 40-60 word extractable answer block.
- Order sections by the reader's decision path, not by what is easiest to write,
  and never by copying the shape of a competing page. The gaps are what we have
  that they don't; leading with their running order buries it.
${plan ? `- seoTitle: use one of the plan's title options, or a better one under 60 chars.
- dek: use the plan's meta description, or a better one in 140-160 chars.
- wordCountTarget: ${plan.wordCountTarget}, from the live SERP read. Do not raise it to pad.` : ''}

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
 "wordCountTarget": number (guides ≥1500, roundups ≥1200, articles ≥700),
 "sections": [{"heading": string (H2 text), "points": string[] (what it must cover,
               which products/facts from the dossier to use, and for the lead
               section the extractable answer block verbatim)}],
 "faq": [{"question": string}] (3-5 long-tail questions — prefer the plan's PAA list)}`,
    },
    tracker,
  );

  brief.slug = slugify(brief.slug || brief.seoTitle || article.title);
  if (!AUTHORS.some((a) => a.id === brief.author)) brief.author = 'mira';
  // The plan's keyword is the decision of record: the outliner may reword the
  // title, but it does not get to re-target the piece.
  if (plan?.primaryKeyword) brief.primaryKeyword = plan.primaryKeyword;
  if (plan?.wordCountTarget) brief.wordCountTarget = plan.wordCountTarget;
  // FAQ drives the FAQPage schema the site emits, which is the strongest
  // generative-engine citation signal we ship. Never let it come back empty.
  if (!Array.isArray(brief.faq) || brief.faq.length === 0) {
    brief.faq = (plan?.paaQuestions ?? [])
      .slice(0, 4)
      .map((question) => ({ question }));
  }
  return brief;
}
