// Editor — revises the draft to resolve the SEO reviewer's issues (and any
// admin feedback) while preserving voice, facts, and the /go/<slug> link
// contract.
//
// The voice-scan findings are re-derived here rather than read off the review:
// the review may be a round old, and an editor working from a stale line
// number wastes the pass. The list it gets is what the scan says about the
// draft in front of it, right now.
//
// No web access here either. When the reviewer's issue is "this figure is
// unverified", the fix is to cut or hedge it — not to go and find a number
// nobody reviewed and slide it into a draft on its way out.
import { chat, UsageTracker } from '../llm/index.js';
import { authorById, defaultAuthorFor } from '../content/contract.js';
import { detectSlop, formatSlopReport } from '../content/slop.js';
import { ISSUE_PREFIX, SCAN_ISSUE_PATTERN } from './seoReviewer.js';
import {
  ANTI_SLOP_RULES,
  authorVoiceBrief,
  editorialAngleBrief,
  EDITORIAL_RULES,
  GEO_RULES,
  keywordPlanBrief,
  LINK_PLACEMENT_RULES,
  SEO_RULES,
  siteContext,
  SOURCE_DISCIPLINE,
} from './context.js';
import type { ArticleRow } from '../pipeline/types.js';

/** Most severe first - the order the prompt claims the issue list is in. */
const SEVERITY_ORDER = ['high', 'medium', 'low'];

const severityRank = (severity: string): number => {
  const at = SEVERITY_ORDER.indexOf(severity);
  return at === -1 ? SEVERITY_ORDER.length : at;
};

/**
 * How each class of reviewer issue is fixed. The classes exist because they
 * are not interchangeable: a fabricated price is cut, a missing position is
 * argued, and "adds nothing" is only fixed with evidence the top results lack
 * - never with a better sentence.
 */
const ISSUE_CLASS_GUIDE: Record<string, string> = {
  [ISSUE_PREFIX.claim]: `- "${ISSUE_PREFIX.claim}" - the dossier does not carry that specific. Cut it, or
  restate it in words the dossier does support. Never swap in another number.`,
  [ISSUE_PREFIX.delta]: `- "${ISSUE_PREFIX.delta}" - the piece says nothing the pages already ranking do
  not. Fixing it means landing a specific from the dossier that they lack: a
  failure mode with a timeframe, an owner pattern with a denominator, a price
  observation with a date, a buyer this is wrong for. Not a better sentence.`,
  [ISSUE_PREFIX.position]: `- "${ISSUE_PREFIX.position}" - the piece will not commit. Say which option
  loses and what it costs the buyer. Every pick keeps a concrete con drawn from
  the dossier; "may not suit everyone" is not a con.`,
};

/**
 * The issue list this stage actually works from, off whatever review the row
 * carries.
 *
 * The reviewer already filed the scan's hits as issues; those are dropped here
 * because the scan is re-run below and the editor should not be told the same
 * thing twice in two formats. What is left is ordered by severity - the prompt
 * promises it is, and an edit pass that runs out of attention should run out
 * of it on the low ones.
 */
export function issuesForEditor(
  review: ArticleRow['seo_review'],
): NonNullable<ArticleRow['seo_review']>['issues'] {
  return (review?.issues ?? [])
    .filter((i) => !SCAN_ISSUE_PATTERN.test(i.issue))
    .slice()
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

export async function runEditor(
  article: ArticleRow,
  model: string,
  tracker: UsageTracker,
): Promise<string> {
  const draft = article.draft_md ?? '';
  const feedback = article.feedback?.trim();
  const planBrief = keywordPlanBrief(article.keyword_plan);
  const angleBrief = editorialAngleBrief(article.editorial_angle);
  // The edit pass gets the same single voice the writer had. Without it a
  // revision rounds the byline's rhythm off and every draft converges on the
  // house voice by the second pass, which undoes the point of having bylines.
  const author =
    authorById(article.outline?.author) ?? defaultAuthorFor(article.category);

  const issues = issuesForEditor(article.seo_review);
  const slopReport = formatSlopReport(detectSlop(draft));
  const delta = article.seo_review?.competitorDelta ?? null;
  // Only explain the classes this round actually has to fix. A guide to issues
  // that are not in the list is prompt the model has to read past.
  const classGuide = Object.values(ISSUE_PREFIX)
    .filter((prefix) => issues.some((i) => i.issue.startsWith(prefix)))
    .map((prefix) => ISSUE_CLASS_GUIDE[prefix])
    .filter(Boolean);

  const result = await chat({
    model,
    system: [
      siteContext(),
      EDITORIAL_RULES,
      SOURCE_DISCIPLINE,
      ANTI_SLOP_RULES,
      LINK_PLACEMENT_RULES,
      SEO_RULES,
      GEO_RULES,
      authorVoiceBrief(author),
    ].join('\n\n'),
    temperature: 0.4,
    prompt: `Revise this draft to resolve every issue below. Keep everything that already
works — this is a surgical edit, not a rewrite. Never add facts that are not in
the research dossier: where an issue says a claim is unverified, cut it or
hedge it in plain words rather than replacing it with a figure from memory.
Keep all /go/<slug> links intact (fix them if malformed).
${feedback ? `
ADMIN FEEDBACK — highest priority, apply it even where it goes beyond the SEO
issues (but never break the editorial rules or invent facts):
${feedback}
` : ''}${angleBrief ? `\n${angleBrief}\n` : ''}${planBrief ? `\n${planBrief}\n` : ''}
Issues to resolve (from the SEO review, most severe first):
${issues
  .map((i) => `- [${i.severity}] ${i.issue}\n  Fix: ${i.fix}`)
  .join('\n') || '- (none listed - do a light quality pass only)'}

${
  classGuide.length > 0
    ? `
These issue classes are not fixed the same way as an ordinary editorial note:
${classGuide.join('\n')}
`
    : ''
}${
  delta && delta.additions.length > 0
    ? `
WHAT THIS PIECE ADDS OVER THE TOP RESULTS - keep every one of these intact, and
do not blunt them while fixing anything above:
${delta.additions.map((a) => `- ${a.claim}${a.absentFrom ? ` (absent from ${a.absentFrom})` : ''}`).join('\n')}
`
    : ''
}
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
