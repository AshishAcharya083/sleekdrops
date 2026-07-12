// Editor — revises the draft to resolve the SEO reviewer's issues while
// preserving voice, facts, and the /go/<slug> link contract.
import { chat, UsageTracker } from '../llm/index.js';
import { EDITORIAL_RULES, SEO_RULES, SITE_CONTEXT } from './context.js';
import type { ArticleRow } from '../pipeline/types.js';

export async function runEditor(
  article: ArticleRow,
  model: string,
  tracker: UsageTracker,
): Promise<string> {
  const issues = article.seo_review?.issues ?? [];
  const result = await chat({
    model,
    system: `${SITE_CONTEXT}\n\n${EDITORIAL_RULES}\n\n${SEO_RULES}`,
    temperature: 0.4,
    prompt: `Revise this draft to resolve every issue below. Keep everything that already
works — this is a surgical edit, not a rewrite. Never add facts that are not in
the research dossier. Keep all /go/<slug> links intact (fix them if malformed).

Issues to resolve (from the SEO review, most severe first):
${issues
  .map((i) => `- [${i.severity}] ${i.issue}\n  Fix: ${i.fix}`)
  .join('\n') || '- (none listed — do a light quality pass only)'}

Research dossier (fact boundary):
${JSON.stringify(article.research, null, 2)}

Current draft:
${article.draft_md}

Reply with the complete revised markdown body only — no frontmatter, no H1, no commentary.`,
  });
  tracker.add(result);

  return result.text
    .replace(/^```(?:markdown|md)?\s*\n/i, '')
    .replace(/\n```\s*$/i, '')
    .replace(/^#\s+.*\n+/, '')
    .trim();
}
