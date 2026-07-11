// SEO Reviewer — scores the draft against the brief and the SEO checklist,
// returning a structured verdict the runner uses to route (pass → assemble,
// fail → edit, bounded by max_revision_rounds).
import { chatJson, UsageTracker } from '../llm/openrouter.js';
import { SEO_RULES, SITE_CONTEXT } from './context.js';
import type { ArticleRow, SeoReview } from '../pipeline/types.js';

export async function runSeoReviewer(
  article: ArticleRow,
  model: string,
  tracker: UsageTracker,
): Promise<SeoReview> {
  const review = await chatJson<SeoReview>(
    {
      model,
      system: `${SITE_CONTEXT}\n\n${SEO_RULES}`,
      temperature: 0.2,
      maxTokens: 4000,
      prompt: `You are a strict SEO + editorial reviewer. Score this draft against the brief.

Brief:
${JSON.stringify(article.outline, null, 2)}

Draft (markdown body):
${article.draft_md}

Check specifically:
1. Primary keyword in first 100 words, at least one H2, and the conclusion.
2. Word count vs target (${article.outline?.wordCountTarget ?? 'n/a'}) — substance, not padding.
3. Heading hierarchy answers the search intent; FAQ present and long-tail.
4. Every product link uses /go/<slug> form; no raw merchant URLs anywhere.
5. Honesty: cons/trade-offs present, disclaimer present, no invented facts
   (cross-check claims against the products' notes in the brief).
6. Scanability: short paragraphs, tables where a table beats prose.
7. E-E-A-T: methodology ("how we picked"), specific evidence, honest tone.

Return JSON:
{"score": number (0-100),
 "pass": boolean (true only if score ≥ 80 AND no high-severity issues),
 "issues": [{"severity": "high"|"medium"|"low", "issue": string, "fix": string (concrete instruction)}],
 "summary": string (2-3 sentences)}`,
    },
    tracker,
  );

  review.score = Math.max(0, Math.min(100, Number(review.score) || 0));
  review.pass = Boolean(review.pass) && review.score >= 80;
  review.issues = Array.isArray(review.issues) ? review.issues : [];
  return review;
}
