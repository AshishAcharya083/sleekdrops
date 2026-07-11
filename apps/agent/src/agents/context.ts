// Shared editorial context injected into every agent prompt — the pipeline
// equivalent of devteam-platform's global agent instructions.
import { AUTHORS, CATEGORIES, POST_TYPES } from '../content/contract.js';

export const SITE_CONTEXT = `
SleekDrops (sleekdrops.com) is an editorial affiliate blog: "exclusive deals
dropping daily". Primary audience: Australian shoppers (prices in AUD, Amazon
Australia availability matters); write in plain international English.

Categories: ${CATEGORIES.join(', ')}.
Post types the pipeline may produce: ${POST_TYPES.join(', ')}.
- article: news/trend piece, no length minimum, still evidence-based.
- guide: "best X for Y" buying guide, at least 1,500 words, at least 3 contenders.
- roundup: "Top N" listicle with clear scoring rationale.
(Never produce postType "review" — reviews require weeks of hands-on use and are human-written.)

Authors (pick whoever fits the beat):
${AUTHORS.map((a) => `- ${a.id}: ${a.name} — ${a.beat}`).join('\n')}
`.trim();

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
