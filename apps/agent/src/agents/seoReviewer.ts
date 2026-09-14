// SEO Reviewer - grades the draft the way a demanding editor would, against
// the pages it has to beat and the evidence it was written from, rather than
// against the checklist the writer was handed.
//
// The old reviewer scored the draft against the same rules writer.ts was
// given, so a piece that followed the template perfectly scored well by
// construction. It rewarded exactly the sameness a human reviewer calls
// "automatically generated material lacking meaningful review or curation".
// Three things replace that:
//
//  1. A competitor-delta pass. The keyword stage already captured the top
//     results; this pass asks what a reader gets here that they would not get
//     there. A piece that adds nothing fails, whatever its prose is like.
//
//  2. A claim audit. Every specific in the draft - number, price, spec, date,
//     attributed statement - is checked against the dossier, with no web
//     access, because the dossier is the fact boundary. An unsupported
//     specific is a high-severity issue, not a style note.
//
//  3. A position check. A draft that takes no stance, hedges its cons or
//     recommends everything equally fails. "Both have merits" is the failure
//     mode this whole pipeline exists to prevent.
//
// The deterministic anti-slop scan still runs FIRST, in code, and its hits are
// handed to the model as established fact rather than left to its judgement.
// Asking a model whether prose "sounds like AI" gets you an opinion; grepping
// for "delve" gets you an answer.
import { chatJson, requireKeys, UsageTracker } from '../llm/index.js';
import { detectSlop, formatSlopReport, slopSeverity, SLOP_PASS_SCORE } from '../content/slop.js';
import { structureBrief } from '../content/shapes.js';
import {
  ANTI_SLOP_RULES,
  editorialAngleBrief,
  GEO_RULES,
  keywordPlanBrief,
  LINK_PLACEMENT_RULES,
  SEO_RULES,
  siteContext,
  SOURCE_DISCIPLINE,
  VERIFICATION_RULES,
} from './context.js';
import type { ArticleRow, KeywordPlan, SeoReview } from '../pipeline/types.js';

/** Issues the deterministic scan contributes, capped so it can't drown the model's. */
const MAX_SLOP_ISSUES = 12;

/** Unsupported specifics filed individually before the rest are rolled up. */
const MAX_CLAIM_ISSUES = 12;

/** The captured top results a draft is graded against. */
const TOP_COMPETITORS = 3;

/** The composite a draft has to clear. Unchanged - the gate moved, not the bar. */
const PASS_SCORE = 80;

/**
 * Where the position dimension lands once the position check has failed. Well
 * below the pass bar, so the panel reads the same way the gate does.
 */
const POSITION_FAILED_CAP = 40;

/**
 * Below this a draft is short enough that "no checkable specific" says nothing.
 * Above it, a piece with no number, price, spec or date in it is the generic
 * failure itself, and no amount of prose review will find it.
 */
const MIN_WORDS_FOR_SPECIFICS = 400;

/**
 * Issue prefixes. Every issue this stage files carries one, because the editor
 * treats the four classes differently: a fabricated price is cut, a missing
 * position is argued, a scan hit is rewritten at its source.
 */
export const ISSUE_PREFIX = {
  scan: 'Voice scan - ',
  claim: 'Unsupported specific - ',
  delta: 'Competitor delta - ',
  position: 'Position - ',
} as const;

/**
 * Matches both the current prefix and the em-dashed one reviews written before
 * this stage was rebuilt carry, so a stale review does not hand the editor the
 * same scan finding twice in two formats.
 */
export const SCAN_ISSUE_PATTERN = /^Voice scan\s*[-—]/;

/** What this piece gives a reader that the captured top results do not. */
export interface CompetitorDelta {
  /** The top-result URLs the draft was actually graded against. */
  comparedWith: string[];
  additions: Array<{ claim: string; absentFrom: string; evidence: string }>;
  /** Substantive ground the draft only restates from them. */
  duplicated: string[];
  verdict: 'adds-substantially' | 'adds-marginally' | 'adds-nothing';
  notes: string;
}

/** Every specific in the draft, checked against the dossier and nothing else. */
export interface ClaimAudit {
  claims: Array<{
    claim: string;
    kind: 'number' | 'price' | 'spec' | 'date' | 'attribution';
    supported: boolean;
    /** The dossier entry that carries it, or what is missing. */
    support: string;
  }>;
  notes: string;
}

/** Whether the piece argues anything, and whether its cons are real. */
export interface PositionCheck {
  takesStance: boolean;
  /** The stance in one sentence, as the draft actually states it. */
  stance: string;
  recommendsEverythingEqually: boolean;
  picks: Array<{ pick: string; cons: string[]; hedged: boolean }>;
  notes: string;
}

/** The three graded passes finalizeReview folds in. Any of them may be absent. */
export interface ReviewAudits {
  competitors?: CompetitorDelta | null;
  claims?: ClaimAudit | null;
  position?: PositionCheck | null;
}

const CLAIM_KINDS = new Set(['number', 'price', 'spec', 'date', 'attribution']);
const DELTA_VERDICTS = new Set(['adds-substantially', 'adds-marginally', 'adds-nothing']);

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The captured top results, in plan order. */
function topCompetitors(plan: KeywordPlan | null): KeywordPlan['competitors'] {
  return list(plan?.competitors)
    .filter((c): c is KeywordPlan['competitors'][number] => Boolean(c) && text((c as { url?: unknown }).url) !== '')
    .slice(0, TOP_COMPETITORS);
}

export function normaliseDelta(raw: unknown, comparedWith: string[]): CompetitorDelta {
  const reply = (raw ?? {}) as Record<string, unknown>;
  const additions = list(reply.additions)
    .map((a) => {
      const entry = (a ?? {}) as Record<string, unknown>;
      return {
        claim: text(entry.claim),
        absentFrom: text(entry.absentFrom),
        evidence: text(entry.evidence),
      };
    })
    // A claim we cannot state is not an addition, whatever the model called it.
    .filter((a) => a.claim !== '');
  const verdictRaw = text(reply.verdict);
  return {
    comparedWith,
    additions,
    duplicated: list(reply.duplicated).map(text).filter(Boolean),
    // The additions are the evidence for the verdict, so a generous word with
    // nothing behind it does not survive: an empty list is "adds nothing",
    // whatever the model called it.
    verdict:
      additions.length === 0
        ? 'adds-nothing'
        : DELTA_VERDICTS.has(verdictRaw)
          ? (verdictRaw as CompetitorDelta['verdict'])
          : 'adds-marginally',
    notes: text(reply.notes),
  };
}

export function normaliseClaimAudit(raw: unknown): ClaimAudit {
  const reply = (raw ?? {}) as Record<string, unknown>;
  return {
    claims: list(reply.claims)
      .map((c) => {
        const entry = (c ?? {}) as Record<string, unknown>;
        const kind = text(entry.kind);
        return {
          claim: text(entry.claim),
          kind: (CLAIM_KINDS.has(kind) ? kind : 'number') as ClaimAudit['claims'][number]['kind'],
          // Anything but an explicit true is unsupported: a missing verdict is
          // the model declining to vouch for the figure, not clearing it.
          supported: entry.supported === true,
          support: text(entry.support),
        };
      })
      .filter((c) => c.claim !== ''),
    notes: text(reply.notes),
  };
}

export function normalisePosition(raw: unknown): PositionCheck {
  const reply = (raw ?? {}) as Record<string, unknown>;
  return {
    takesStance: reply.takesStance === true,
    stance: text(reply.stance),
    recommendsEverythingEqually: reply.recommendsEverythingEqually === true,
    picks: list(reply.picks)
      .map((p) => {
        const entry = (p ?? {}) as Record<string, unknown>;
        return {
          pick: text(entry.pick),
          cons: list(entry.cons).map(text).filter(Boolean),
          hedged: entry.hedged === true,
        };
      })
      .filter((p) => p.pick !== ''),
    notes: text(reply.notes),
  };
}

/** The captured top-3 as the delta pass sees them. */
function competitorBrief(competitors: KeywordPlan['competitors']): string {
  return competitors
    .map(
      (c, i) =>
        `${i + 1}. ${c.url}\n   Format: ${c.format || 'unknown'}\n   Angle: ${c.angle || 'unknown'}\n   Strong at: ${c.strength || 'unknown'}`,
    )
    .join('\n');
}

/**
 * Compare the draft against the top results the keyword stage captured. This
 * is the pass the old reviewer had no equivalent of: it grades information
 * gain against real pages instead of grading conformity against our own rules.
 *
 * Returns null when the plan captured no competitors - a draft cannot be
 * failed for adding nothing to pages nobody recorded.
 */
export async function auditCompetitorDelta(
  article: ArticleRow,
  model: string,
  tracker: UsageTracker,
): Promise<CompetitorDelta | null> {
  const competitors = topCompetitors(article.keyword_plan);
  if (competitors.length === 0) return null;

  const plan = article.keyword_plan;
  const gaps = (plan?.contentGaps ?? []).filter(Boolean);
  const reply = await chatJson<Record<string, unknown>>(
    {
      model,
      system: `${siteContext()}\n\n${SOURCE_DISCIPLINE}`,
      temperature: 0.2,
      maxTokens: 4000,
      search: true,
      prompt: `Grade one thing, hard: what a reader gets from this draft that they would not
get from the pages already ranking for "${plan?.primaryKeyword ?? article.title}".

The top ${competitors.length} results, as captured when the keyword plan was built:
${competitorBrief(competitors)}
${gaps.length > 0 ? `\nGaps the keyword stage recorded in those results: ${gaps.join('; ')}\n` : ''}
Open each URL with read_page where you can and work from what the page actually
says. Where a page will not open, grade against the capture above and say so in
the notes.

An addition counts only when all three hold:
- it is a specific - a number, a failure mode, a price history, an exclusion, a
  measured result, an owner pattern - and not a framing or a better sentence;
- a named competitor above does not carry it;
- something in this draft backs it (a figure, a named source, an attribution).

Restating what the top results already say, in our own words, is not an
addition. Covering more products is not an addition unless the extra coverage
carries specifics they do not. A cleaner structure is not an addition.

Draft (markdown body):
${article.draft_md ?? ''}

Return JSON:
{"additions": [{"claim": string, "absentFrom": string (the competitor URL that lacks it), "evidence": string (what in the draft backs it)}],
 "duplicated": [string] (the substantive ground this draft only restates from them),
 "verdict": "adds-substantially" | "adds-marginally" | "adds-nothing",
 "notes": string (2-3 sentences: what a reader gains here, and what they do not)}

"adds-nothing" is the right verdict for a competent piece that covers the same
ground competently, and it is the verdict most drafts earn. Do not soften it.`,
    },
    tracker,
    requireKeys('additions', 'verdict'),
  );

  return normaliseDelta(
    reply,
    competitors.map((c) => c.url),
  );
}

/**
 * Check every specific in the draft against the dossier. No web access on this
 * pass on purpose: the question is not whether a figure is true somewhere, it
 * is whether this piece was entitled to state it. A number the pipeline never
 * gathered is a number nobody reviewed.
 */
export async function auditClaims(
  article: ArticleRow,
  model: string,
  tracker: UsageTracker,
): Promise<ClaimAudit> {
  const reply = await chatJson<Record<string, unknown>>(
    {
      model,
      system: `${siteContext()}\n\n${SOURCE_DISCIPLINE}`,
      temperature: 0,
      maxTokens: 8000,
      prompt: `Audit every specific in this draft against the research dossier. The dossier
is the fact boundary: a specific it does not carry is unsupported, even when
you believe it and even when it is true. You have no web access on this pass
and you must not fill a gap from memory.

A specific is any of:
- a number or measurement ("5.7 litres", "30 hours", "62 dB")
- a price or a price movement ("A$229", "down from $299")
- a spec, model number or standard ("Bluetooth 5.4", "LDAC", "IP67")
- a date, year or recency claim ("the 2026 model", "released in March")
- an attributed statement ("Choice found...", "owners report...", "Sony says...")

For each one, find the dossier entry that carries it: a fact, a tested claim,
an owner complaint, a failure mode, a price observation, a product record.
Loose matching counts - the dossier says "about 30 hours", the draft says "30
hours". A rounded or restated figure is supported. A figure nobody wrote down
is not, and neither is a statement attributed to a source the dossier does not
name, however plausible that source is.

Audit each distinct specific once. Skip generic prose, opinions and comparisons
that carry no specific.

Research dossier:
${JSON.stringify(article.research, null, 2)}

Draft (markdown body):
${article.draft_md ?? ''}

Return JSON:
{"claims": [{"claim": string (the specific, quoted as the draft states it),
             "kind": "number"|"price"|"spec"|"date"|"attribution",
             "supported": boolean,
             "support": string (the dossier entry that carries it, or what is missing)}],
 "notes": string (1-2 sentences on what the draft is standing on)}`,
    },
    tracker,
    requireKeys('claims'),
  );

  return normaliseClaimAudit(reply);
}

/** The audits as facts for the scoring prompt - it grades against them, not over them. */
function auditBrief(audits: ReviewAudits): string {
  const parts: string[] = [];
  const delta = audits.competitors;
  if (delta) {
    parts.push(
      `COMPETITOR DELTA (already graded against ${delta.comparedWith.join(', ')}) - verdict: ${delta.verdict}.
${
  delta.additions.length > 0
    ? `What this draft adds:\n${delta.additions
        .map((a) => `  - ${a.claim}${a.absentFrom ? ` (absent from ${a.absentFrom})` : ''}`)
        .join('\n')}`
    : 'It adds nothing the top results do not already carry.'
}${delta.duplicated.length > 0 ? `\nGround it only restates: ${delta.duplicated.join('; ')}` : ''}${delta.notes ? `\n${delta.notes}` : ''}`,
    );
  }
  const audit = audits.claims;
  if (audit) {
    const unsupported = audit.claims.filter((c) => !c.supported);
    parts.push(
      `CLAIM AUDIT - ${audit.claims.length} specific(s) checked against the dossier, ${unsupported.length} unsupported.${
        unsupported.length > 0
          ? `\nUnsupported:\n${unsupported.map((c) => `  - [${c.kind}] ${c.claim}${c.support ? ` (${c.support})` : ''}`).join('\n')}`
          : ''
      }${audit.notes ? `\n${audit.notes}` : ''}`,
    );
  }
  return parts.length > 0
    ? `These passes already ran over the draft. Their findings are FACTS - do not
re-litigate them and do not repeat them as your own issues. Score against them.

${parts.join('\n\n')}`
    : '';
}

export async function runSeoReviewer(
  article: ArticleRow,
  model: string,
  tracker: UsageTracker,
): Promise<SeoReview> {
  const draft = article.draft_md ?? '';
  const plan = article.keyword_plan;
  const planBrief = keywordPlanBrief(plan);
  const angle = article.editorial_angle;
  const angleBrief = editorialAngleBrief(angle);
  const shape = article.structure_shape ?? article.outline?.structureShape ?? null;
  const shapeBrief = structureBrief(shape);

  // Deterministic first, so the model reviews prose we have already measured.
  const slop = detectSlop(draft);
  const slopReport = formatSlopReport(slop);

  // The two graded passes are independent of each other and of the rubric, so
  // they run together and land in the scoring prompt as established facts.
  const [competitors, claims] = await Promise.all([
    auditCompetitorDelta(article, model, tracker),
    auditClaims(article, model, tracker),
  ]);

  const review = await chatJson<SeoReview & { position?: unknown }>(
    {
      model,
      system: `${siteContext()}\n\n${SOURCE_DISCIPLINE}\n\n${LINK_PLACEMENT_RULES}\n\n${SEO_RULES}\n\n${GEO_RULES}\n\n${ANTI_SLOP_RULES}\n\n${VERIFICATION_RULES}`,
      temperature: 0.2,
      maxTokens: 6000,
      search: true,
      prompt: `You are a demanding editor, not a checklist. Assume this draft is competent and
generic until it proves otherwise, and grade what it is worth to a reader who
has the top results one tab away.
${angleBrief ? `\n${angleBrief}\n` : ''}${planBrief ? `\n${planBrief}\n` : ''}${shapeBrief ? `\n${shapeBrief}\n` : ''}
Brief:
${JSON.stringify(article.outline, null, 2)}

Draft (markdown body):
${draft}

${
  slopReport
    ? `An automated voice scan already ran over this draft. Its findings are FACTS,
not opinions - do not re-litigate them, and do not repeat them as your own
issues. Spend your attention on what a scanner cannot judge.

${slopReport}`
    : 'An automated voice scan found no banned vocabulary, phrases or structures.'
}
${auditBrief({ competitors, claims })}

Score these dimensions 0-100 each:
1. evidence - is every specific traceable to the dossier, sourced by name and
   dated where recency matters, and drawn from more than a spec sheet? The
   claim audit above already graded support: score what it means. A piece
   leaning entirely on manufacturer copy, with no owner evidence, no failure
   data and no measured result, does not score above 60 however clean it reads.
   Then FACT-CHECK the three or four claims that would do the most damage if
   wrong - the headline prices, the flagship spec, "the latest model", a
   release year, an Australian availability claim - against a primary source
   with web_search / read_page. A claim the search contradicts is a
   high-severity issue with the correct figure in the fix. Say in the summary
   what you checked and what came back, and deduct nothing for claims you did
   not have the budget to check.${
     article.revision_round > 0
       ? `\n   This is revision round ${article.revision_round}: the facts were already
   checked on an earlier pass and the editor may not add new ones. Re-check only
   figures that have changed since.`
       : ''
   }
2. position - does the piece argue something, and does it pay for it? A stance
   costs the writer a reader: it says which option loses, who should not buy,
   what to skip. "Both have merits", a cons list of one soft caveat, or a
   ranking where every entry wins at something are all the same failure.${
     angle
       ? angle.defensible
         ? `\n   The angle commissioned this thesis: "${angle.thesis}". Does the draft argue
   it, or cover the topic and retreat to "it depends"?`
         : `\n   This piece was recorded as having NO defensible contrarian take, so it must
   not have invented one. It still has to be decisive about what the evidence
   does say - "no contrarian take" is not licence to recommend everything.`
       : ''
   }
3. structure - does it hold the shape it was commissioned in${shape ? ` ("${shape.name}", ${shape.id})` : ''},
   with that shape's own running order, opening and section naming? Or has it
   collapsed back into the house skeleton: answer-first opening, an identical
   extractable block under every heading, a reflex "how we picked", a reflex
   FAQ, a conclusion that relists the picks? A piece that reads like every
   other piece on this site is the failure this review exists to catch, and
   this dimension does not score above 50 when it does.
4. citability - what a generative engine can lift. Are the extractable answers
   where the shape spends them, self-contained, and inside its word range? Are
   claims paired with a named source and a year rather than an adjective? Are
   entities named specifically? Where the shape requires an FAQ, is there an
   "## FAQ" section with "### Question?" headings (the site builds FAQPage
   schema by parsing it, so a missing or malformed one is a high-severity
   issue)? Are recency signals present? Does it beat the snippet target above?
5. links - every product link is /go/<slug> form, no raw merchant URLs, and the
   placement rules are followed: first mention per section, a link column in
   comparison tables, per-product CTA lines, linked conclusion picks.

Also report the position check, read off the draft rather than inferred:
- takesStance: does the piece say which option loses, and why?
- stance: that stance in one sentence, in the draft's own words.
- recommendsEverythingEqually: true when every pick is praised and none is
  argued against - a roundup where each entry "excels" at something.
- picks: one entry per recommended product, with the cons the draft actually
  states for it. hedged is true when those cons are non-committal - "may not
  suit everyone", "slightly pricier", "could be better" - rather than a
  concrete cost to the buyer.

Return JSON:
{"dimensions": {"evidence": number, "position": number, "structure": number, "citability": number, "links": number},
 "score": number (0-100, the weighted whole - do not simply average),
 "pass": boolean (true only if score >= ${PASS_SCORE} AND no high-severity issues),
 "issues": [{"severity": "high"|"medium"|"low", "issue": string, "fix": string (concrete instruction)}],
 "position": {"takesStance": boolean, "stance": string, "recommendsEverythingEqually": boolean,
              "picks": [{"pick": string, "cons": [string], "hedged": boolean}], "notes": string},
 "summary": string (2-3 sentences)}`,
    },
    tracker,
    requireKeys<SeoReview & { position?: unknown }>('dimensions', 'score', 'issues', 'position'),
  );

  return finalizeReview(review, slop, {
    competitors,
    claims,
    position: normalisePosition(review?.position),
  });
}

/**
 * Merge the model's verdict with the deterministic scan and the graded passes,
 * and clamp everything into range. Exported for the tests - this is where a
 * pass is actually decided, so it must not depend on a live model.
 */
export function finalizeReview(
  review: SeoReview,
  slop: ReturnType<typeof detectSlop>,
  audits: ReviewAudits = {},
): SeoReview {
  const clamp = (n: unknown): number => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

  const issues = Array.isArray(review?.issues) ? [...review.issues] : [];

  // --- Claim audit. An unsupported specific is a hard fail, not a style note:
  // a fabricated price is the one defect a reader can catch us on.
  const audit = audits.claims ?? null;
  const checked = audit?.claims ?? [];
  const unsupported = checked.filter((c) => !c.supported);
  for (const claim of unsupported.slice(0, MAX_CLAIM_ISSUES)) {
    issues.push({
      severity: 'high',
      issue: `${ISSUE_PREFIX.claim}[${claim.kind}] "${claim.claim}"${claim.support ? ` - ${claim.support}` : ''}`,
      fix: 'Nothing in the dossier supports this. Cut it, or restate it in plain words the dossier does carry. Never substitute a figure from memory.',
    });
  }
  if (unsupported.length > MAX_CLAIM_ISSUES) {
    issues.push({
      severity: 'high',
      issue: `${ISSUE_PREFIX.claim}${unsupported.length - MAX_CLAIM_ISSUES} further specific(s) the dossier does not carry.`,
      fix: 'Work through the draft and cut or hedge every figure, spec, date and attribution the dossier does not carry.',
    });
  }
  if (audit && checked.length === 0 && slop.words >= MIN_WORDS_FOR_SPECIFICS) {
    issues.push({
      severity: 'high',
      issue: `${ISSUE_PREFIX.claim}the draft carries no checkable specific at all - no price, measurement, spec, date or attribution.`,
      fix: 'Replace the adjectives with what the dossier actually knows: a price, a measured result, a failure timeframe, an owner pattern, with the source named.',
    });
  }

  // --- Competitor delta. A piece that adds nothing to the top results has no
  // reason to exist, however well it is written.
  const delta = audits.competitors ?? null;
  const addsNothing = delta !== null && (delta.verdict === 'adds-nothing' || delta.additions.length === 0);
  if (addsNothing) {
    issues.push({
      severity: 'high',
      issue: `${ISSUE_PREFIX.delta}this draft adds nothing the top ${delta.comparedWith.length} result(s) do not already carry (${delta.comparedWith.join(', ')}).${delta.notes ? ` ${delta.notes}` : ''}`,
      fix: 'Land at least one specific those pages do not have - a failure mode with a timeframe, an owner pattern with a denominator, a price history, a buyer this is wrong for - from the dossier, and say who it is for.',
    });
  }

  // --- Position. No stance, or a cons list nobody could disagree with, is the
  // "automatically generated material lacking curation" failure exactly.
  const position = audits.position ?? null;
  const positionProblems: string[] = [];
  if (position) {
    if (!position.takesStance) {
      positionProblems.push('the draft takes no stance - it never says which option loses, or who should skip this category');
    }
    if (position.recommendsEverythingEqually) {
      positionProblems.push('every pick is recommended and none is argued against, so the ranking decides nothing for the reader');
    }
    for (const pick of position.picks) {
      if (pick.cons.length === 0) {
        positionProblems.push(`"${pick.pick}" is recommended with no cons at all`);
      } else if (pick.hedged) {
        positionProblems.push(`"${pick.pick}" has only hedged cons (${pick.cons.join('; ')})`);
      }
    }
  }
  for (const problem of positionProblems) {
    issues.push({
      severity: 'high',
      issue: `${ISSUE_PREFIX.position}${problem}.`,
      fix: 'Say which option loses and what it costs the buyer, in a sentence someone could disagree with. Every pick carries a concrete cost - a real fault, a real exclusion - drawn from the dossier.',
    });
  }

  // --- The scan's findings become issues in their own right. The model was
  // told not to repeat them, and its severity judgement does not override
  // ours: a banned word is high severity whatever the prose around it reads
  // like. Severity is routed through slopSeverity so new scanner metrics need
  // no change here.
  for (const finding of slop.findings.slice(0, MAX_SLOP_ISSUES)) {
    const where = finding.lines.length > 0 ? ` (line ${finding.lines.join(', ')})` : '';
    const examples = finding.matches.length > 0 ? `: ${finding.matches.map((m) => `"${m}"`).join(', ')}` : '';
    issues.push({
      severity: slopSeverity(finding),
      issue: `${ISSUE_PREFIX.scan}${finding.rule} x${finding.count}${examples}${where}`,
      fix: finding.fix,
    });
  }

  const fallback = clamp(review?.score);
  const scored = (review?.dimensions ?? {}) as Partial<Record<string, unknown>>;
  const dimension = (key: string): number => clamp(scored[key] ?? review?.score);

  // The audit is the authority on evidence: a draft cannot score higher on it
  // than the share of its own specifics the dossier actually carries.
  const supportRatio =
    checked.length > 0 ? Math.round(((checked.length - unsupported.length) / checked.length) * 100) : 100;

  const dimensions = {
    evidence: Math.min(dimension('evidence'), supportRatio),
    position:
      positionProblems.length > 0 || addsNothing
        ? Math.min(dimension('position'), POSITION_FAILED_CAP)
        : dimension('position'),
    structure: dimension('structure'),
    citability: dimension('citability'),
    links: dimension('links'),
  };

  // A draft that fails the scan cannot out-score its way past it, and neither
  // can one that lost its shape or broke the affiliate contract: the composite
  // is capped by the worst structural dimension and by the scanner.
  const score = Math.min(fallback, dimensions.structure, dimensions.links, slop.score);

  const hasHighSeverity = issues.some((i) => i.severity === 'high');
  const pass =
    Boolean(review?.pass) && score >= PASS_SCORE && !hasHighSeverity && slop.score >= SLOP_PASS_SCORE;

  return {
    score,
    pass,
    issues,
    dimensions,
    slop: { score: slop.score, words: slop.words, findings: slop.findings.length },
    ...(delta ? { competitorDelta: delta } : {}),
    ...(audit ? { claimAudit: { checked: checked.length, unsupported: unsupported.length } } : {}),
    ...(position ? { positionCheck: position } : {}),
    summary: review?.summary ?? '',
  };
}
