// SEO Reviewer — scores the draft against the brief, the keyword plan and the
// SEO/GEO checklists, returning a structured verdict the runner routes on
// (pass → assemble, fail → edit, bounded by max_revision_rounds).
//
// Two things happen here that did not before:
//
//  1. The anti-slop scan runs FIRST, in code, and its hits are handed to the
//     model as established fact rather than left to its judgement. Asking a
//     model whether prose "sounds like AI" gets you an opinion; grepping for
//     "delve" gets you an answer. Every banned word or phrase is filed as a
//     high-severity issue, which by itself blocks the pass and forces an edit
//     round — the numeric score alone would let a single tell through.
//
//  2. The verdict is scored per dimension (search, generative-engine
//     citability, voice, E-E-A-T, link contract) instead of one number, so the
//     editor knows which axis failed.
import { chatJson, UsageTracker } from '../llm/index.js';
import { detectSlop, formatSlopReport, slopSeverity, SLOP_PASS_SCORE } from '../content/slop.js';
import {
  ANTI_SLOP_RULES,
  GEO_RULES,
  keywordPlanBrief,
  LINK_PLACEMENT_RULES,
  SEO_RULES,
  siteContext,
} from './context.js';
import type { ArticleRow, SeoReview } from '../pipeline/types.js';

/** Issues the deterministic scan contributes, capped so it can't drown the model's. */
const MAX_SLOP_ISSUES = 8;

export async function runSeoReviewer(
  article: ArticleRow,
  model: string,
  tracker: UsageTracker,
): Promise<SeoReview> {
  const draft = article.draft_md ?? '';
  const plan = article.keyword_plan;
  const planBrief = keywordPlanBrief(plan);

  // Deterministic first, so the model reviews prose we have already measured.
  const slop = detectSlop(draft);
  const slopReport = formatSlopReport(slop);

  const review = await chatJson<SeoReview>(
    {
      model,
      system: `${siteContext()}\n\n${LINK_PLACEMENT_RULES}\n\n${SEO_RULES}\n\n${GEO_RULES}\n\n${ANTI_SLOP_RULES}`,
      temperature: 0.2,
      maxTokens: 6000,
      prompt: `You are a strict SEO + editorial reviewer. Score this draft against the brief
and the keyword plan.
${planBrief ? `\n${planBrief}\n` : ''}
Brief:
${JSON.stringify(article.outline, null, 2)}

Draft (markdown body):
${draft}

${
  slopReport
    ? `An automated voice scan already ran over this draft. Its findings are
FACTS, not opinions — do not re-litigate them, and do not repeat them as your
own issues. Score the "voice" dimension against them and spend your attention
on what a scanner cannot judge: whether the piece takes positions, whether the
specifics are real, whether it reads like a person who has handled the product.

${slopReport}`
    : `An automated voice scan found no banned vocabulary, phrases or structures.
Score the "voice" dimension on what a scanner cannot judge: does the piece take
positions, vary its rhythm, and sound like a person rather than a summary?`
}

Score these dimensions 0-100 each:
1. seo — primary keyword in the first 100 words, at least one H2 and the
   conclusion. Heading hierarchy matches the search intent. Length vs the
   ${article.outline?.wordCountTarget ?? 'n/a'}-word target (substance, not padding).
   Format matches what the SERP rewards${plan ? ` (${plan.winningFormat})` : ''}.
2. geo — generative-engine citability. Does every major H2 open with a
   self-contained 40-60 word answer? Are claims paired with named sources and
   years, or left as adjectives? Are entities named specifically? Is there an
   "## FAQ" section with "### Question?" headings and 40-60 word answers (the
   site builds FAQPage schema from it — a missing or malformed FAQ is a
   high-severity issue)? Are recency signals present?
3. voice — reads as a person. Judge against the scan above plus: positions
   taken, rhythm varied, no section-summary padding.
4. eeat — methodology ("how we picked"), specific evidence, honest trade-offs,
   a non-empty cons list per pick, the editorial-synthesis disclaimer present,
   nothing invented beyond the dossier.
5. links — every product link is /go/<slug> form, no raw merchant URLs, and the
   placement rules are followed: first mention per section, a link column in
   comparison tables, per-product CTA lines, linked conclusion picks.

Return JSON:
{"dimensions": {"seo": number, "geo": number, "voice": number, "eeat": number, "links": number},
 "score": number (0-100, the weighted whole — do not simply average),
 "pass": boolean (true only if score ≥ 80 AND no high-severity issues),
 "issues": [{"severity": "high"|"medium"|"low", "issue": string, "fix": string (concrete instruction)}],
 "summary": string (2-3 sentences)}`,
    },
    tracker,
  );

  return finalizeReview(review, slop);
}

/**
 * Merge the model's verdict with the deterministic scan and clamp everything
 * into range. Exported for the tests — this is where a pass is actually
 * decided, so it must not depend on a live model.
 */
export function finalizeReview(
  review: SeoReview,
  slop: ReturnType<typeof detectSlop>,
): SeoReview {
  const clamp = (n: unknown): number => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

  const issues = Array.isArray(review?.issues) ? [...review.issues] : [];

  // The scan's findings become issues in their own right. The model was told
  // not to repeat them, and its severity judgement does not override ours:
  // a banned word is high severity whatever the prose around it reads like.
  for (const finding of slop.findings.slice(0, MAX_SLOP_ISSUES)) {
    const where = finding.lines.length > 0 ? ` (line ${finding.lines.join(', ')})` : '';
    const examples = finding.matches.length > 0 ? `: ${finding.matches.map((m) => `"${m}"`).join(', ')}` : '';
    issues.push({
      severity: slopSeverity(finding),
      issue: `Voice scan — ${finding.rule} ×${finding.count}${examples}${where}`,
      fix: finding.fix,
    });
  }

  const dimensions = {
    seo: clamp(review?.dimensions?.seo ?? review?.score),
    geo: clamp(review?.dimensions?.geo ?? review?.score),
    // The scanner is the authority on voice; the model only sees what it missed.
    voice: Math.min(clamp(review?.dimensions?.voice ?? review?.score), slop.score),
    eeat: clamp(review?.dimensions?.eeat ?? review?.score),
    links: clamp(review?.dimensions?.links ?? review?.score),
  };

  // A draft that fails the voice scan cannot out-score its way past it, so the
  // overall score is capped by the worst structural dimension.
  const modelScore = clamp(review?.score);
  const score = Math.min(modelScore, dimensions.voice, dimensions.links);

  const hasHighSeverity = issues.some((i) => i.severity === 'high');
  const pass = Boolean(review?.pass) && score >= 80 && !hasHighSeverity && slop.score >= SLOP_PASS_SCORE;

  return {
    score,
    pass,
    issues,
    dimensions,
    slop: { score: slop.score, words: slop.words, findings: slop.findings.length },
    summary: review?.summary ?? '',
  };
}
