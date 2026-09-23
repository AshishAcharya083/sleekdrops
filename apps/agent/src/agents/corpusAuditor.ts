// Corpus auditor - the reviewer pass over one page that is already live.
//
// This is not the SEO reviewer. That stage grades a draft it has the whole
// record for: a dossier to check every specific against, a keyword plan with
// the live top-3 in it, a commissioned shape to measure the draft's fit to.
// A published page has none of that - most of the site predates the pipeline
// entirely - so a reviewer pass over the corpus has exactly what a human
// reviewer had when they called the site "automatically generated material
// lacking meaningful review or curation": the page itself.
//
// So it grades what is visible on the page, and nothing it cannot see. No
// search: fifty pages times a fact-check is an audit nobody runs twice, and
// "is this specific true" is the requalify job's question. The question here is
// narrower and answerable from the text - does this page show its evidence,
// argue anything, have a shape of its own, and give a generative engine
// something to lift?
import { chatJson, requireKeys, UsageTracker } from '../llm/index.js';
import { normaliseAuditReview, type AuditReview } from '../content/audit.js';
import type { CorpusDocument } from '../content/corpus.js';
import { ANTI_SLOP_RULES, GEO_RULES, siteContext } from './context.js';
import { formatSlopReport } from '../content/slop.js';
import type { SlopReport } from '../content/slop.js';

/** Long enough for the whole of a normal guide; a cap is still needed for the outliers. */
const MAX_BODY_CHARS = 30_000;

/**
 * Grade one published page. The deterministic scan is passed in already run,
 * so the model grades prose whose measurable faults are established facts
 * rather than re-reporting them as opinions - the same division of labour the
 * SEO reviewer uses.
 */
export async function reviewPublishedArticle(
  article: CorpusDocument,
  scan: SlopReport,
  model: string,
  tracker: UsageTracker,
): Promise<AuditReview> {
  const body = article.body.slice(0, MAX_BODY_CHARS);
  const scanReport = formatSlopReport(scan);

  const review = await chatJson<unknown>(
    {
      model,
      system: `${siteContext()}\n\n${GEO_RULES}\n\n${ANTI_SLOP_RULES}`,
      temperature: 0.2,
      maxTokens: 3000,
      prompt: `You are auditing a page that is ALREADY LIVE on this site, as a demanding
outside reviewer would read it: someone deciding whether this site publishes
work with meaningful human review and curation behind it, or automatically
generated filler. Assume it is competent and generic until it proves otherwise.

Grade only what is on the page. You have no research dossier and no web
search, so never guess whether a figure is true - grade whether the page gives
a reader any way to check it.

Title: ${article.title}
Slug: ${article.slug}
Published: ${article.publishedAt ?? 'unknown'}

${
  scanReport
    ? `A deterministic voice scan already ran over this page. Its findings are
FACTS. Do not repeat them as your own issues - grade what a scanner cannot see.

${scanReport}`
    : 'A deterministic voice scan found no banned vocabulary, phrases or structures.'
}

Page body (markdown):
${body}

Score these 0-100:
1. evidence - are the specifics checkable? A figure with a named source and a
   date is evidence; the same figure asserted is not. Does anything on this
   page come from outside a spec sheet - what owners report after months, what
   somebody measured, what a named retailer charged and when? A page whose
   every claim traces back to manufacturer copy does not score above 60.
2. position - does it argue anything, and does it pay for it? A stance names
   which option loses, who should not buy, what to skip. "Both have merits", a
   cons list of one soft caveat, or a ranking where every entry wins at
   something are all the same failure.
3. structure - does this page have a shape of its own, or the house skeleton:
   answer-first opening, an identical extractable block under every heading, a
   reflex "how we picked", a reflex FAQ, a conclusion relisting the picks? A
   reader who opened five pages of this site and saw one silhouette is the
   failure this audit exists to find. Do not score above 50 when it fits.
4. citability - what a generative engine can lift: self-contained answers,
   entities named specifically, claims paired with a named source and a year,
   an FAQ that parses, recency signals.

Return JSON:
{"dimensions": {"evidence": number, "position": number, "structure": number, "citability": number},
 "score": number (0-100, the weighted whole - do not simply average),
 "issues": [{"severity": "high"|"medium"|"low", "issue": string, "fix": string}]
   (at most 5, the ones that would decide a manual review),
 "summary": string (2-3 sentences: what this page is worth to a reader who has
            the top results one tab away)}`,
    },
    tracker,
    requireKeys<{ dimensions: unknown; score: unknown }>('dimensions', 'score'),
  );

  return normaliseAuditReview(review);
}
