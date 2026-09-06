// Shared editorial context injected into every agent prompt — the pipeline
// equivalent of devteam-platform's global agent instructions.
import { AUTHORS, CATEGORIES, POST_TYPES } from '../content/contract.js';
import type { KeywordPlan, TopicRow } from '../pipeline/types.js';

/** Today in the audience's timezone (Australia/Sydney), e.g. "2026-07-13". */
export function todayInSydney(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

// A function, not a const: the current date must be evaluated per run, and
// every agent needs it — model training data lags reality by a year or more,
// and a wrong year in a title or watermark reads as instantly stale.
export function siteContext(): string {
  const today = todayInSydney();
  return `
SleekDrops (sleekdrops.com) is an editorial affiliate blog: "exclusive deals
dropping daily". Primary audience: Australian shoppers (prices in AUD, Amazon
Australia availability matters); write in plain international English.

GROUNDING — non-negotiable:
- Today's date is ${today}. Whenever you mention "this year", a year in a
  title, or how recent something is, derive it from THIS date — never from
  your training data, which is out of date.
- Facts come from the research dossier / live search evidence you are given,
  never from memory. If the evidence doesn't say it, you don't know it.

Categories: ${CATEGORIES.join(', ')}.
Post types the pipeline may produce: ${POST_TYPES.join(', ')}.
- article: news/trend piece, no length minimum, still evidence-based.
- guide: "best X for Y" buying guide, at least 1,500 words, at least 3 contenders.
- roundup: "Top N" listicle with clear scoring rationale.
(Never produce postType "review" — reviews require weeks of hands-on use and are human-written.)

Authors (pick whoever fits the beat):
${AUTHORS.map((a) => `- ${a.id}: ${a.name} — ${a.beat}`).join('\n')}
`.trim();
}

/**
 * The operator brief for a manually-authored topic: free-text instructions and
 * any markdown reference materials the operator attached. Rendered as a single
 * authoritative block that outranks the agent's generic guidance - a human
 * editor wrote it specifically for this piece. Empty string when the topic is
 * scouted or carries no brief, so callers can concatenate it unconditionally.
 */
export function operatorBrief(topic: TopicRow | null): string {
  if (!topic || topic.source !== 'manual') return '';
  const instructions = topic.instructions?.trim();
  const references = (topic.research_notes ?? []).filter((r) => r.content?.trim());
  if (!instructions && references.length === 0) return '';

  const parts = [
    `OPERATOR BRIEF - authoritative. A human editor wrote this specifically for
this piece. Treat it as higher priority than the generic guidance above: follow
its instructions and use its reference materials as primary source facts (same
standing as gathered evidence). Never contradict it, and never invent facts
beyond it and the research evidence.`,
  ];
  if (instructions) parts.push(`Operator instructions:\n${instructions}`);
  for (const [i, ref] of references.entries()) {
    parts.push(`--- reference ${i + 1}: ${ref.name} ---\n${ref.content.trim()}`);
  }
  return parts.join('\n\n');
}

export const EDITORIAL_RULES = `
Editorial rules (non-negotiable):
- Honest, useful, specific. Every recommendation names real trade-offs; a cons
  list is never empty. Decimal ratings like 4.3 — never star spam.
- Plain, direct voice. No emoji, no hype, no urgency copy ("HURRY!", "act now").
- Evidence only: never invent specs, prices, or Amazon URLs. If a fact isn't in
  the research dossier, leave it out or hedge explicitly.
- Affiliate links: NEVER write a raw merchant URL in the body. Every product
  link is written as /go/<kebab-product-slug> (e.g. /go/sony-wh-1000xm6).
  The same product always reuses the same /go/ slug.
- Disclose honestly: if we haven't lab-tested the products, say the piece is an
  editorial synthesis of specs, owner reviews, and expert coverage.
- Structure for scanability: short paragraphs, descriptive H2/H3 headings,
  comparison tables for multi-product pieces, a "how we picked" section.
`.trim();

export const LINK_PLACEMENT_RULES = `
Affiliate link placement (the article earns nothing without these — but never
link a product that has no /go/ slug in the provided list):
1. First mention of a product inside each major section links its /go/ slug.
2. Comparison tables get a final column ("Price" or "Where to buy") whose cells
   are links, e.g. [Check price](/go/<slug>).
3. Every recommended product's own section/subsection ends with a one-line CTA
   on its own paragraph, e.g. [See today's price on Amazon](/go/<slug>).
4. The verdict/conclusion links each named pick once more.
5. Vary anchor text naturally: the product name, "check the current price",
   "see it on Amazon" — never the bare URL, never "click here".
6. Beyond those spots, don't spam: one link per product per section is plenty.
`.trim();

export const SEO_RULES = `
SEO requirements:
- One clear primary keyword per piece, used naturally in: title (front-loaded),
  dek, first 100 words, at least one H2, and the conclusion. Around 2% body
  density, distributed — readability wins every tie.
- Secondary keywords woven in naturally. No stuffing, no synonym cycling
  (repeat the right word rather than hunting for alternatives).
- Title ≤ 60 characters, compelling and specific (year, count, or qualifier).
- Dek (meta description) 140–160 characters, includes the primary keyword.
- Descriptive H2/H3 hierarchy that answers real search intents. Turn the
  People Also Ask questions from the keyword plan into H2/H3 headings and
  answer each one directly underneath.
- Front-load value. The first screen is the highest-value real estate: define
  the buyer and answer the query there, then earn the depth.
- Match the format the SERP rewards. If the winning pages are comparison
  tables, ship a comparison table.
- Internal coherence and people-first content that satisfies E-E-A-T.
`.trim();

/**
 * Generative Engine Optimization — being cited by ChatGPT, Claude, Perplexity
 * and AI Overviews, not only ranked by Google.
 *
 * The two goals overlap more than they conflict (clarity, specificity,
 * verifiable sourcing serve both), so this block sits alongside SEO_RULES
 * rather than replacing it. Where they pull apart — Google rewards
 * comprehensive coverage, generative engines prefer short extractable text —
 * the resolution is comprehensive content with an extractable answer at the
 * top of every section.
 *
 * Method from the superseo `write-content` GEO reference, itself built on
 * Aggarwal et al., "GEO: Generative Engine Optimization" (KDD 2024).
 */
export const GEO_RULES = `
Generative-engine rules (how the piece earns a citation in ChatGPT, Claude,
Perplexity and AI Overviews — not only a Google ranking):
- ANSWER FIRST. Every major H2 opens with a self-contained 40-60 word answer to
  the question that heading implies, before any build-up. An answer buried in
  the third paragraph does not get cited. Then expand with the detail.
- CLAIM + EVIDENCE, always paired. "Battery life runs to 30 hours with ANC on
  (Sony, 2026 spec sheet)" is citable. "Battery life is excellent" is not.
  Attribute by name and year — "according to research" is worthless.
- NAME ENTITIES. Specific products, brands, chipsets, standards, prices,
  retailers. "Coolblue, Bol.com and Zalando" beats "many retailers". Generative
  engines build knowledge graphs out of named entities; unnamed ones vanish.
- QUESTION-SHAPED HEADINGS where natural, each answered immediately in an
  extractable block. Cover the who/what/when/where/why/how variants that matter.
- FAQ section with 3-5 real questions, each answered in 40-60 words. The site
  emits FAQPage schema from that section, which is the single highest-leverage
  citation signal available to us — so the FAQ is mandatory, not optional.
- RECENCY. State when a price, spec or availability claim was checked. Engines
  weight freshness heavily, and a dated claim is more citable than a vague one.
- Never invent a number, source, or date to satisfy any of the above. An
  invented specific is worse than a general sentence: it is the one failure
  mode that destroys citability permanently. If the dossier does not have it,
  write around it.
`.trim();

/**
 * Anti-slop. The deterministic scanner in content/slop.ts is what actually
 * enforces this (a model told "don't sound like AI" agrees and then does it
 * anyway); these rules exist so the first draft starts closer to clean and the
 * editor knows what "fixed" looks like.
 *
 * Rules from the `stop-slop` skill and the superseo anti-slop ruleset.
 */
export const ANTI_SLOP_RULES = `
Voice rules — the draft is scanned against these automatically and sent back
if it fails, so write to them the first time:

NEVER use these words: delve, leverage, utilize, robust, seamless(ly),
furthermore, moreover, additionally, pivotal, multifaceted, harness, embark,
showcase, streamline, paramount, culminate, spearhead, commence, endeavour,
testament, vibrant, myriad, plethora, elevate, unlock, game-changer,
cutting-edge, state-of-the-art, "landscape"/"navigate" used metaphorically,
"comprehensive" as a filler adjective.

NEVER use these phrases: "here's the thing", "here's what/why", "it's worth
noting", "in today's [anything]", "let's dive in", "deep dive", "in
conclusion", "to sum up", "plays a crucial role", "it goes without saying",
"in the realm of", "when it comes to", "at the end of the day", "at its core",
"let that sink in", "make no mistake", "this matters because", "in this
section we'll", "as we'll see".

NEVER use these structures:
- Binary contrasts: "it's not X, it's Y" / "the question isn't X, it's Y".
  State Y and move on.
- Additive hedges: "not just X but also Y". Pick the claim that matters.
- Negative listing: "It wasn't X. It wasn't Y. It was Z." Just write Z.
- Dramatic fragments for effect: "That's it. That's the trick."
- Copula avoidance: "serves as a" — write "is".
- Participial tack-ons: "..., highlighting the importance of X". Delete, or
  make it a sentence with a subject.
- Rule-of-three groupings. Use two items or four.
- False agency: "the data tells us", "the market rewards", "the decision
  emerges". Name the human: buyers, reviewers, we.

WRITE LIKE THIS INSTEAD:
- Vary sentence length hard. A five-word sentence next to a thirty-word one.
  Four consecutive sentences of similar length reads as a machine.
- Active voice with a real subject. "We picked the Ninja" not "the Ninja was
  picked".
- Take a position and own it. "The Bose is not worth $120 more" beats "both
  have merits".
- Specifics over adjectives: a price, a measurement, a model number, a date.
- Contractions are fine. Starting a sentence with "And" or "But" is fine.
- Cut hedge adverbs: really, actually, simply, genuinely, honestly, basically,
  truly, essentially, notably, arguably.
- Em-dashes: at most one or two per thousand words. Commas and full stops
  otherwise.
- Do not summarise a section at the end of it unless it ran three subsections
  or more.
`.trim();

/**
 * Render a keyword plan for a downstream prompt. The outliner, writer, editor
 * and reviewer all need it, and all need the same view of it.
 */
export function keywordPlanBrief(plan: KeywordPlan | null): string {
  if (!plan) return '';
  const bullets = (label: string, items: string[]): string =>
    items.length > 0 ? `${label}: ${items.join('; ')}` : '';
  return [
    `KEYWORD PLAN - built from a live SERP read. The piece is written to win this query.`,
    `Primary keyword: ${plan.primaryKeyword}`,
    `Why: ${plan.rationale}`,
    `Search intent: ${plan.intent} | Difficulty: ${plan.difficulty} | Zero-click risk: ${plan.zeroClickRisk}`,
    `Format the SERP rewards: ${plan.winningFormat} | Length target: ${plan.wordCountTarget} words`,
    bullets('SERP features in play', plan.serpFeatures),
    bullets('Secondary keywords', plan.secondaryKeywords),
    bullets('People Also Ask - answer these as H2/H3', plan.paaQuestions),
    bullets('Entities to name explicitly (GEO)', plan.entities),
    bullets('Gaps in the top results - this is our reason to rank', plan.contentGaps),
    plan.competitors.length > 0
      ? `Top results to beat:\n${plan.competitors
          .map((c) => `  - ${c.url} (${c.format}) - ${c.angle}. Strong at: ${c.strength}`)
          .join('\n')}`
      : '',
    plan.snippetTarget.question
      ? `Snippet/citation target - "${plan.snippetTarget.question}" as a ${plan.snippetTarget.format}. Draft answer to beat:\n  ${plan.snippetTarget.answer}`
      : '',
    plan.currentAiAnswer
      ? `What a generative engine says about this query TODAY (beat it, and be the better-sourced version):\n  ${plan.currentAiAnswer}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}
