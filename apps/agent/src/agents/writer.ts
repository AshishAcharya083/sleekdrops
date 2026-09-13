// Writer — produces the full markdown draft from the brief, the keyword plan
// and the dossier, following the site's editorial voice and the /go/<slug>
// link contract.
//
// Runs on Claude Opus 5 by default. The system prompt carries the anti-slop
// ruleset because a first draft written against it needs far fewer revision
// rounds than one cleaned up afterwards — but content/slop.ts is what actually
// enforces it at review time.
//
// The structure of the piece is not in this prompt. It arrives on the brief as
// a structure-library shape picked at outline time — the running order, the
// opening style, the passage budget and whether this piece carries an FAQ at
// all. A fixed checklist here (open with the answer, 40-60 words under every
// H2, "How we picked", FAQ, conclusion) is what gave every article on the site
// the same silhouette, so it is gone; a brief with no shape (queued before the
// library existed) still gets it, as the fallback.
//
// This is the one stage with no web access, deliberately. Research and review
// verify; the writer writes what they verified. A writer that could search
// would pull in sources nobody checked and reach for the competing articles
// sitting at the top of every result page — which is exactly the material this
// piece has to beat, not echo.
import { chat, UsageTracker } from '../llm/index.js';
import { authorById, defaultAuthorFor } from '../content/contract.js';
import { structureBrief } from '../content/shapes.js';
import {
  ANTI_SLOP_RULES,
  authorVoiceBrief,
  editorialAngleBrief,
  EDITORIAL_RULES,
  GEO_RULES,
  keywordPlanBrief,
  LINK_PLACEMENT_RULES,
  operatorBrief,
  SEO_RULES,
  siteContext,
  SOURCE_DISCIPLINE,
} from './context.js';
import type { ArticleRow, TopicRow } from '../pipeline/types.js';

/**
 * What the writer is told about structure when the brief carries no shape.
 * This is the skeleton every article used to be written to, kept for in-flight
 * work only: an article outlined before the structure library existed has a
 * brief built to it, and handing that brief a different contract would produce
 * a draft that matches neither.
 */
const LEGACY_STRUCTURE = `- Open with the answer. The first 100 words must contain the primary keyword
  and tell the reader what to buy, before any context.
- Every H2 starts with a 40-60 word extractable answer to the question that
  heading implies, then expands.
- Include a "How we picked" style section for guides/roundups.
- End with an FAQ section — "## FAQ", then one "### Question?" per entry with a
  40-60 word answer under each. Answer engines quote these pairs directly, so
  the heading must be a real question ending in "?".
- Close with a short honest conclusion that links each named pick once.`;

export async function runWriter(
  article: ArticleRow,
  topic: TopicRow | null,
  model: string,
  tracker: UsageTracker,
): Promise<string> {
  const brief = article.outline!;
  const plan = article.keyword_plan;
  const planBrief = keywordPlanBrief(plan);
  const angle = article.editorial_angle;
  const angleBrief = editorialAngleBrief(angle);
  // The shape the outliner recorded on the brief. Absent only for articles
  // outlined before the structure library existed.
  const shape = brief.structureShape ?? null;
  const extractable = (brief.sections ?? []).filter((section) => section.extractable);
  // Only the byline that is actually publishing this piece. Handing the writer
  // the whole roster produces the average of four voices, which is the one
  // house voice every article on the site already has.
  const author = authorById(brief.author) ?? defaultAuthorFor(article.category);
  // Every dossier product is linkable: verified ASINs get a product page, the
  // rest resolve to an Amazon search for the product — so no /go/ slug can 404.
  const products = article.research?.products ?? [];
  const operator = operatorBrief(topic);

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
    temperature: 0.7,
    prompt: `Write the complete article in Markdown. Body only — NO frontmatter,
NO title H1 (the site renders the title separately). Start with the opening paragraph.
${operator ? `\n${operator}\n` : ''}${angleBrief ? `\n${angleBrief}\n` : ''}${planBrief ? `\n${planBrief}\n` : ''}
${shape ? `${structureBrief(shape)}\n` : ''}
Brief:
${JSON.stringify(brief, null, 2)}

Research dossier (your ONLY source of facts — every one of these has been
checked against a primary source already, so use it and never reach past it):
${JSON.stringify(article.research, null, 2)}

The dossier's competitorNotes tell you what the pages you are outranking cover.
They are there so you can be better, not so you can borrow: no competing
article gets named, quoted, linked or paraphrased in the body, and none of them
decides your section order.

Product link slugs — when you link a product, use EXACTLY these (markdown links
to /go/<slug>, e.g. [Sony WH-1000XM6](/go/sony-wh-1000xm6)):
${products.map((p) => `- ${p.name}: /go/${p.goSlug}`).join('\n') || '(no products — omit product links)'}

Products NOT in that list must be mentioned WITHOUT any link (plain text only).

Requirements:
- Length: about ${brief.wordCountTarget} words, from the live SERP read. Hit it with
  substance. If you run out of things the dossier supports, stop short rather
  than pad — a tight 1,200 words beats a bloated 1,800.
${angle ? `- The piece argues the thesis above.
${angle.defensible ? `- The take is a position, so hold it. Say which product loses and why, in the
  reader's own terms, and never retreat to "it depends on your needs".` : `- No defensible contrarian take was found for this piece. Do NOT invent one.
  Compete on evidence: the failure modes, the owner complaints with their
  denominators, the buyers this is wrong for, and what the dossier cannot say.`}` : ''}
${
  shape
    ? `- Write the piece in the "${shape.name}" shape above: that running order, that
  opening, nothing bolted on. Sections the shape does not carry do not appear —
  no "How we picked" block unless the shape asks for one, and no FAQ where it
  says omit.
- The opening follows the shape's opening style, and it names the primary
  keyword inside the first 100 words. There is no house opening formula to
  fall back on.
- Extractable answers: ${shape.passageBudget.passages} in the whole piece, ${shape.passageBudget.words.min}-${shape.passageBudget.words.max} words each, and only
  under ${extractable.length > 0 ? `these headings: ${extractable.map((s) => `"${s.heading}"`).join(', ')}` : 'the sections the shape marks "extractable answer"'}.
  Each one is a self-contained answer to a question a reader typed — quotable
  with nothing around it, sources and years inside the block. Every other
  section opens however that section needs to open, in prose.`
    : LEGACY_STRUCTURE
}
${plan?.snippetTarget?.question ? `- The snippet target is "${plan.snippetTarget.question}" as a ${plan.snippetTarget.format}. Write that block to be quoted verbatim.` : ''}
${plan?.paaQuestions?.length ? `- Answer these directly, as headings or FAQ entries: ${plan.paaQuestions.join(' / ')}` : ''}
- Attribute every spec and claim to its source with a year, from the dossier.
  Never print a marketplace price (see the editorial rules): if a figure is
  essential, it is the manufacturer's RRP in AUD, labelled "RRP" with the year.
  Point readers to the /go/ link for what it costs today.
- GitHub-flavored markdown: ## H2 / ### H3, a comparison table for
  multi-product pieces, bold sparingly. No emoji.
- Follow the affiliate link placement rules exactly: first mention per section,
  a link column in comparison tables, a one-line CTA closing each product's
  section, and links for each pick in the conclusion.
- Include the honesty disclaimer (editorial synthesis, not lab-tested) early.
${shape && brief.faq?.length ? `- The FAQ is "## FAQ", then one "### Question?" per brief entry with a
  ${shape?.passageBudget.words.min}-${shape?.passageBudget.words.max} word answer under each. Answer engines quote these pairs directly,
  so every heading is a real question ending in "?".` : ''}

Before you reply, reread your draft against the voice rules and the byline
voice, and fix what you find. A draft that ships a banned word goes straight
back to you, and one that reads like the generic house voice rather than the
${author.label || 'house'} beat has not done the job either.

Reply with the markdown body only.`,
  });
  tracker.add(result);

  // Strip a leading H1 or accidental fences if the model added them anyway.
  return result.text
    .replace(/^```(?:markdown|md)?\s*\n/i, '')
    .replace(/\n```\s*$/i, '')
    .replace(/^#\s+.*\n+/, '')
    .trim();
}
