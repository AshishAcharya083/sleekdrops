// Writer — produces the full markdown draft from the brief + dossier,
// following the site's editorial voice and the /go/<slug> link contract.
import { chat, UsageTracker } from '../llm/index.js';
import { EDITORIAL_RULES, SEO_RULES, SITE_CONTEXT } from './context.js';
import type { ArticleRow } from '../pipeline/types.js';

export async function runWriter(
  article: ArticleRow,
  model: string,
  tracker: UsageTracker,
): Promise<string> {
  const brief = article.outline!;
  // Only offer slugs that can actually resolve — a /go/ link with no real
  // Amazon URL behind it would be stripped at assembly anyway.
  const products = (article.research?.products ?? []).filter((p) => p.amazonUrl);

  const result = await chat({
    model,
    system: `${SITE_CONTEXT}\n\n${EDITORIAL_RULES}\n\n${SEO_RULES}`,
    temperature: 0.7,
    prompt: `Write the complete article in Markdown. Body only — NO frontmatter,
NO title H1 (the site renders the title separately). Start with the opening paragraph.

Brief:
${JSON.stringify(brief, null, 2)}

Research dossier (your ONLY source of facts — never invent beyond it):
${JSON.stringify(article.research, null, 2)}

Product link slugs — when you link a product, use EXACTLY these (markdown links
to /go/<slug>, e.g. [Sony WH-1000XM6](/go/sony-wh-1000xm6)):
${products.map((p) => `- ${p.name}: /go/${p.goSlug}`).join('\n') || '(no products — omit product links)'}

Products NOT in that list must be mentioned WITHOUT any link (plain text only).

Requirements:
- Hit the word count target (${brief.wordCountTarget} words) with substance, not padding.
- Use GitHub-flavored markdown: ## H2 / ### H3 headings, a comparison table for
  multi-product pieces, bold sparingly.
- Include the honesty disclaimer (editorial synthesis, not lab-tested) early.
- Include a "How we picked" style section for guides/roundups.
- End with the FAQ section (### per question) and a short honest conclusion.
- Every product mention that a reader could buy links via its /go/ slug at least
  once per major section, but never spam links.

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
