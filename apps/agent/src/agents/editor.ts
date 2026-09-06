// Editor — revises the draft to resolve the SEO reviewer's issues (and any
// admin feedback) while preserving voice, facts, and the /go/<slug> link
// contract.
//
// The voice-scan findings are re-derived here rather than read off the review:
// the review may be a round old, and an editor working from a stale line
// number wastes the pass. The list it gets is what the scan says about the
// draft in front of it, right now.
import { chat, UsageTracker } from '../llm/index.js';
import { detectSlop, formatSlopReport } from '../content/slop.js';
import {
  ANTI_SLOP_RULES,
  EDITORIAL_RULES,
  GEO_RULES,
  keywordPlanBrief,
  LINK_PLACEMENT_RULES,
  SEO_RULES,
  siteContext,
} from './context.js';
import type { ArticleRow } from '../pipeline/types.js';

export async function runEditor(
  article: ArticleRow,
  model: string,
  tracker: UsageTracker,
): Promise<string> {
  const draft = article.draft_md ?? '';
  const feedback = article.feedback?.trim();
  const planBrief = keywordPlanBrief(article.keyword_plan);

  // The reviewer already filed the scan's hits as issues; drop those from the
  // list so the editor is not told the same thing twice in two formats.
  const issues = (article.seo_review?.issues ?? []).filter(
    (i) => !i.issue.startsWith('Voice scan —'),
  );
  const slopReport = formatSlopReport(detectSlop(draft));

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
    temperature: 0.4,
    prompt: `Revise this draft to resolve every issue below. Keep everything that already
works — this is a surgical edit, not a rewrite. Never add facts that are not in
the research dossier. Keep all /go/<slug> links intact (fix them if malformed).
${feedback ? `
ADMIN FEEDBACK — highest priority, apply it even where it goes beyond the SEO
issues (but never break the editorial rules or invent facts):
${feedback}
` : ''}${planBrief ? `\n${planBrief}\n` : ''}
Issues to resolve (from the SEO review, most severe first):
${issues
  .map((i) => `- [${i.severity}] ${i.issue}\n  Fix: ${i.fix}`)
  .join('\n') || '- (none listed — do a light quality pass only)'}

${
  slopReport
    ? `VOICE SCAN on the draft below. Every one of these is a mechanical find with
a line number — fix each one at its source. Rewriting the sentence is fine;
swapping in a synonym for a banned word is not, because the sentence around it
is usually the real problem. This scan runs again after your edit, so anything
you leave comes straight back.

${slopReport}`
    : 'Voice scan: clean. Do not introduce banned vocabulary, phrases or structures while editing.'
}

Research dossier (fact boundary):
${JSON.stringify(article.research, null, 2)}

Current draft:
${draft}

Reply with the complete revised markdown body only — no frontmatter, no H1, no commentary.`,
  });
  tracker.add(result);

  return result.text
    .replace(/^```(?:markdown|md)?\s*\n/i, '')
    .replace(/\n```\s*$/i, '')
    .replace(/^#\s+.*\n+/, '')
    .trim();
}
