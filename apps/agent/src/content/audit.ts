// Corpus audit scoring - turning one published page's measurements into a
// place in a ranked list.
//
// The pipeline already knows how to judge a draft it is holding. What it could
// not do is answer the operator's actual question after an AdSense rejection:
// of everything already on the site, which pages are the worst, and in what
// order do I fix them? Three articles were named by a reviewer; the rest of
// the corpus was written under the same prompts and nobody has read it since.
//
// So each page gets two numbers - the deterministic scanner's, and a reviewer
// pass's - and this module is the arithmetic that folds them into one rank and
// says, in a sentence, why a page sits where it sits. Kept pure and offline so
// the ranking is testable without a model and cannot drift between runs.
import { SLOP_PASS_SCORE, slopSeverity, type SlopFinding, type SlopReport } from './slop.js';

/**
 * What to do about a page.
 *
 * 'requalify' is a recommendation, never an action: the audit ranks, the
 * operator decides, and the requalify job is what actually rewrites anything.
 */
export type AuditBand = 'requalify' | 'review' | 'ok';

/** Below this a page is recommended for a rebuild. */
const REQUALIFY_BELOW = 55;

/** Below this it is worth a human read, above it the page is holding up. */
const REVIEW_BELOW = 75;

/**
 * How much of the composite the scanner carries. The reviewer weighs more
 * because the failure being hunted - "reads templated and generic" - is a
 * judgement about what the page is worth to a reader, and the scanner measures
 * the symptoms of that rather than the thing itself.
 */
const SCAN_WEIGHT = 0.4;

/** Scan findings named in the report per page. */
const RULES_SHOWN = 5;

/** Issues from the reviewer pass kept per page. */
const ISSUES_KEPT = 5;

/** The axes a published page can be graded on without a dossier behind it. */
export interface AuditDimensions {
  /** Specifics that are actually checkable: figures, named sources, dates. */
  evidence: number;
  /** Does the page argue anything and pay for it. */
  position: number;
  /** Does it have a shape of its own, or the house skeleton. */
  structure: number;
  /** What a generative engine can lift out of it. */
  citability: number;
}

export interface AuditIssue {
  severity: 'high' | 'medium' | 'low';
  issue: string;
  fix: string;
}

/** The reviewer pass's verdict on one published page. */
export interface AuditReview {
  dimensions: AuditDimensions;
  score: number;
  summary: string;
  issues: AuditIssue[];
}

/** A scan rule that cost this page, as the report names it. */
export interface AuditRule {
  category: string;
  rule: string;
  count: number;
  severity: 'high' | 'medium' | 'low';
}

/** One published page's place in the ranking. */
export interface AuditedArticle {
  slug: string;
  title: string;
  publishedAt: string | null;
  words: number;
  scanScore: number;
  scanFindings: number;
  /** The rules costing this page the most, worst first. */
  worstRules: AuditRule[];
  /** Null when the reviewer pass could not grade the page. */
  review: AuditReview | null;
  /** Why the reviewer pass is missing, when it is. */
  reviewError: string | null;
  /** 0-100 composite. Lower is worse, and the list is sorted on it. */
  score: number;
  band: AuditBand;
  /** Why the page ranks here, in one line an operator can act on. */
  verdict: string;
}

export interface CorpusAuditReport {
  generatedAt: string;
  scanned: number;
  /** Worst first - the whole point of the report. */
  articles: AuditedArticle[];
  bands: Record<AuditBand, number>;
  /** Slugs the audit recommends requalifying, worst first. */
  requalify: string[];
  /** The one line the panel shows above the table. */
  summary: string;
}

const clamp = (n: unknown): number => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

const SEVERITY_RANK: Record<'high' | 'medium' | 'low', number> = { high: 0, medium: 1, low: 2 };

/** The rules that cost this page the most: worst severity first, then volume. */
function worstRules(findings: SlopFinding[]): AuditRule[] {
  return findings
    .map((finding) => ({
      category: finding.category,
      rule: finding.rule,
      count: finding.count,
      severity: slopSeverity(finding),
    }))
    .sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.count - a.count,
    )
    .slice(0, RULES_SHOWN);
}

/** The reviewer's reply, clamped into range and trimmed to what the report shows. */
export function normaliseAuditReview(raw: unknown): AuditReview {
  const reply = (raw ?? {}) as Record<string, unknown>;
  const dims = (reply.dimensions ?? {}) as Record<string, unknown>;
  const dimensions: AuditDimensions = {
    evidence: clamp(dims.evidence),
    position: clamp(dims.position),
    structure: clamp(dims.structure),
    citability: clamp(dims.citability),
  };
  const values = Object.values(dimensions);
  return {
    dimensions,
    // A missing or nonsense overall falls back to the axes it was supposed to
    // weigh, rather than ranking the page at zero for the model's sloppiness.
    score:
      reply.score === undefined || reply.score === null
        ? Math.round(values.reduce((sum, v) => sum + v, 0) / values.length)
        : clamp(reply.score),
    summary: typeof reply.summary === 'string' ? reply.summary.trim() : '',
    issues: (Array.isArray(reply.issues) ? reply.issues : [])
      .map((entry) => {
        const issue = (entry ?? {}) as Record<string, unknown>;
        const severity = String(issue.severity ?? '').toLowerCase();
        return {
          severity: (severity === 'high' || severity === 'medium' ? severity : 'low') as AuditIssue['severity'],
          issue: typeof issue.issue === 'string' ? issue.issue.trim() : '',
          fix: typeof issue.fix === 'string' ? issue.fix.trim() : '',
        };
      })
      .filter((issue) => issue.issue !== '')
      .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
      .slice(0, ISSUES_KEPT),
  };
}

/** The weakest axes, named, so the verdict says what to fix and not just how bad. */
function weakestAxes(dimensions: AuditDimensions): string {
  return Object.entries(dimensions)
    .sort(([, a], [, b]) => a - b)
    .slice(0, 2)
    .map(([name, value]) => `${name} ${value}`)
    .join(', ');
}

export interface AuditInput {
  slug: string;
  title: string;
  publishedAt: string | null;
  scan: SlopReport;
  review: AuditReview | null;
  /** Set when the reviewer pass failed for this page; the scan still counts. */
  reviewError?: string | null;
}

/**
 * Fold one page's measurements into a rank and a verdict.
 *
 * A page whose reviewer pass failed is still ranked, on its scan alone. The
 * alternative - dropping it - would quietly hide exactly the pages that time
 * out, and the scanner's verdict on its own is already evidence.
 */
export function scoreAudited(input: AuditInput): AuditedArticle {
  const { scan, review } = input;
  const scanScore = clamp(scan.score);
  const score = review
    ? Math.round(scanScore * SCAN_WEIGHT + clamp(review.score) * (1 - SCAN_WEIGHT))
    : scanScore;

  // A published page below the scanner's own pass mark is below the bar the
  // pipeline applies to a draft it would refuse to ship, whatever a reviewer
  // thought of it. That is a rebuild by definition.
  const band: AuditBand =
    score < REQUALIFY_BELOW || scanScore < SLOP_PASS_SCORE
      ? 'requalify'
      : score < REVIEW_BELOW
        ? 'review'
        : 'ok';

  const rules = worstRules(scan.findings);
  const verdictParts = [`scan ${scanScore}/100 (${scan.findings.length} finding(s))`];
  if (review) {
    verdictParts.push(`review ${clamp(review.score)}/100`);
    verdictParts.push(`weakest on ${weakestAxes(review.dimensions)}`);
  } else {
    verdictParts.push(`no reviewer pass (${input.reviewError || 'not graded'})`);
  }
  if (rules.length > 0) verdictParts.push(`top flag: ${rules[0].rule} ×${rules[0].count}`);

  return {
    slug: input.slug,
    title: input.title,
    publishedAt: input.publishedAt,
    words: scan.words,
    scanScore,
    scanFindings: scan.findings.length,
    worstRules: rules,
    review,
    reviewError: input.reviewError ?? null,
    score,
    band,
    verdict: verdictParts.join('; '),
  };
}

/**
 * The ranked report. Sorted worst first, because the only reason to run this
 * is to find out what to fix next - ties break on the deterministic score and
 * then the slug, so two runs over an unchanged corpus produce the same order.
 */
export function rankAudit(articles: AuditedArticle[], generatedAt = new Date().toISOString()): CorpusAuditReport {
  const ranked = [...articles].sort(
    (a, b) => a.score - b.score || a.scanScore - b.scanScore || a.slug.localeCompare(b.slug),
  );
  const bands: Record<AuditBand, number> = { requalify: 0, review: 0, ok: 0 };
  for (const article of ranked) bands[article.band] += 1;
  const requalify = ranked.filter((a) => a.band === 'requalify').map((a) => a.slug);

  return {
    generatedAt,
    scanned: ranked.length,
    articles: ranked,
    bands,
    requalify,
    summary:
      ranked.length === 0
        ? 'No published articles to audit.'
        : `${ranked.length} published article(s) scored: ${bands.requalify} to requalify, ` +
          `${bands.review} worth a read, ${bands.ok} holding up. Weakest: ${ranked
            .slice(0, 3)
            .map((a) => `${a.slug} (${a.score})`)
            .join(', ')}.`,
  };
}
