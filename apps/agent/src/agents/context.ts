// Shared editorial context injected into every agent prompt — the pipeline
// equivalent of devteam-platform's global agent instructions.
import { AUTHORS, CATEGORIES, POST_TYPES } from '../content/contract.js';

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
  dek, first 100 words, at least one H2, and the conclusion.
- Secondary keywords woven in naturally — no stuffing; readability wins ties.
- Title ≤ 60 characters, compelling and specific (year, count, or qualifier).
- Dek (meta description) 140–160 characters, includes the primary keyword.
- Descriptive H2/H3 hierarchy that answers real search intents; include an FAQ
  section targeting long-tail question queries when it genuinely helps.
- Internal coherence: define the buyer, answer the query in the first screen,
  then earn depth. People-first content that satisfies E-E-A-T signals.
`.trim();
