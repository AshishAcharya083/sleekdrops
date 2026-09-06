// Writer — produces the full markdown draft from the brief, the keyword plan
// and the dossier, following the site's editorial voice and the /go/<slug>
// link contract.
//
// Runs on Claude Opus 5 by default. The system prompt carries the anti-slop
// ruleset because a first draft written against it needs far fewer revision
// rounds than one cleaned up afterwards — but content/slop.ts is what actually
// enforces it at review time.
import { chat, UsageTracker } from '../llm/index.js';
import {
  ANTI_SLOP_RULES,
  EDITORIAL_RULES,
  GEO_RULES,
  keywordPlanBrief,
  LINK_PLACEMENT_RULES,
  operatorBrief,
  SEO_RULES,
  siteContext,
} from './context.js';
import type { ArticleRow, TopicRow } from '../pipeline/types.js';

export async function runWriter(
  article: ArticleRow,
  topic: TopicRow | null,
  model: string,
  tracker: UsageTracker,
): Promise<string> {
  const brief = article.outline!;
  const plan = article.keyword_plan;
  const planBrief = keywordPlanBrief(plan);
  // Every dossier product is linkable: verified ASINs get a product page, the
  // rest resolve to an Amazon search for the product — so no /go/ slug can 404.
  const products = article.research?.products ?? [];
  const operator = operatorBrief(topic);

  const result = await chat({
    model,
    system: [
      siteContext(),
      EDITORIAL_RULES,
      ANTI_SLOP_RULES,
      LINK_PLACEMENT_RULES,
      SEO_RULES,
      GEO_RULES,
    ].join('\n\n'),
    temperature: 0.7,
    prompt: `Write the complete article in Markdown. Body only — NO frontmatter,
NO title H1 (the site renders the title separately). Start with the opening paragraph.
${operator ? `\n${operator}\n` : ''}${planBrief ? `\n${planBrief}\n` : ''}
Brief:
${JSON.stringify(brief, null, 2)}

Research dossier (your ONLY source of facts — never invent beyond it):
${JSON.stringify(article.research, null, 2)}

Product link slugs — when you link a product, use EXACTLY these (markdown links
to /go/<slug>, e.g. [Sony WH-1000XM6](/go/sony-wh-1000xm6)):
${products.map((p) => `- ${p.name}: /go/${p.goSlug}`).join('\n') || '(no products — omit product links)'}

Products NOT in that list must be mentioned WITHOUT any link (plain text only).

Requirements:
- Length: about ${brief.wordCountTarget} words, from the live SERP read. Hit it with
  substance. If you run out of things the dossier supports, stop short rather
  than pad — a tight 1,200 words beats a bloated 1,800.
- Open with the answer. The first 100 words must contain the primary keyword
  and tell the reader what to buy, before any context.
- Every H2 starts with a 40-60 word extractable answer to the question that
  heading implies, then expands. This is what gets cited by AI systems.
${plan?.snippetTarget?.question ? `- The snippet target is "${plan.snippetTarget.question}" as a ${plan.snippetTarget.format}. Write that block to be quoted verbatim.` : ''}
${plan?.paaQuestions?.length ? `- Answer these directly, as headings or FAQ entries: ${plan.paaQuestions.join(' / ')}` : ''}
- Attribute every spec, price and claim to its source with a year, from the
  dossier. Prices are AUD unless the source says otherwise, and say when the
  price was checked.
- GitHub-flavored markdown: ## H2 / ### H3, a comparison table for
  multi-product pieces, bold sparingly. No emoji.
- Follow the affiliate link placement rules exactly: first mention per section,
  a link column in comparison tables, a one-line CTA closing each product's
  section, and links for each pick in the conclusion.
- Include the honesty disclaimer (editorial synthesis, not lab-tested) early.
- Include a "How we picked" style section for guides/roundups.
- End with an FAQ section — "## FAQ", then one "### Question?" per entry with a
  40-60 word answer under each. The site turns this into FAQPage structured
  data, so the heading must be a real question ending in "?".
- Close with a short honest conclusion that links each named pick once.

Before you reply, reread your draft against the voice rules and fix what you
find. A draft that ships a banned word goes straight back to you.

Reply with the markdown body only.`,
  });
  tracker.add(result);

  // Strip a leading H1 or accidental fences if the model added them anyway.
  return result.text
    .replace(/^```(?:markdown|md)?\s*\n/i, '')
    .replace(/\n```\s*$/i, '')
    .replace(/^#\s+.*\n+/, '')
    .trim();
}
