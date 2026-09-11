// Outliner — turns the research dossier and the keyword plan into an SEO
// content brief: title, dek, slug, section-by-section outline, FAQ.
//
// The keyword plan owns the strategy (which query, which format, how long,
// which gaps); the angle owns what the piece argues; the structure library
// owns the silhouette it takes. This stage executes all three. When the plan
// is missing (an article queued before the keyword stage existed) it falls
// back to the dossier's own keywords.
//
// The shape is picked here rather than by the model, and it is picked from
// records that already exist: the angle stage's chosen silhouette, then the
// live SERP read. Selection is deterministic code (content/shapes.ts), so the
// running order of an article is a decision on the row, reproducible and
// visible in the admin panel, instead of whatever the outliner improvised.
import { chatJson, requireKeys, UsageTracker } from '../llm/index.js';
import { authorById, defaultAuthorFor, slugify } from '../content/contract.js';
import { selectShape, structureBrief } from '../content/shapes.js';
import type { ArticleShape } from '../content/shapes.js';
import {
  editorialAngleBrief,
  GEO_RULES,
  keywordPlanBrief,
  SEO_RULES,
  siteContext,
  SOURCE_DISCIPLINE,
} from './context.js';
import type { ArticleRow, ContentBrief, KeywordPlan } from '../pipeline/types.js';

export async function runOutliner(
  article: ArticleRow,
  model: string,
  tracker: UsageTracker,
): Promise<ContentBrief> {
  const plan = article.keyword_plan;
  const planBrief = keywordPlanBrief(plan);
  const angle = article.editorial_angle;
  const angleBrief = editorialAngleBrief(angle);
  const shape = selectShape({
    postType: article.post_type,
    angle,
    winningFormat: plan?.winningFormat,
    intent: plan?.intent,
    seed: article.id,
  });
  const budget = shape.passageBudget;

  const brief = await chatJson<ContentBrief>(
    {
      model,
      system: `${siteContext()}\n\n${SOURCE_DISCIPLINE}\n\n${SEO_RULES}\n\n${GEO_RULES}`,
      temperature: 0.5,
      maxTokens: 8000,
      prompt: `Create the SEO content brief for this piece.

Working title: ${article.title}
Post type: ${article.post_type} | Category: ${article.category}
${angleBrief ? `\n${angleBrief}\n` : ''}${planBrief ? `\n${planBrief}\n` : ''}
${structureBrief(shape)}

Research dossier:
${JSON.stringify(article.research, null, 2)}

Build the outline to execute the shape, the angle and the keyword plan:
- The sections ARE the shape's running order above. Every required section kind
  gets at least one heading; a section marked "repeats" gets one heading per
  contender, segment, cost line or question the dossier supports.
- Write the headings for this piece. The shape's labels say what a section is
  for, not what to call it — a heading copied from the label is a template.
${angle ? `- The sections must argue the thesis. Every claim under "what this piece says
  that the top results do not" gets a section or a named sub-point. That list
  is the reason this piece exists.` : ''}
- Every People Also Ask question is answered — inside the section that owns it,
  or as an FAQ entry where the shape carries an FAQ. None get dropped.
- Every content gap is covered — inside the section that owns it, or as an
  extra section placed within the shape's running order rather than appended to
  it. The gaps are the reason this piece can outrank the pages already there.
  Give an extra section an empty "kind".
- Exactly ${budget.passages} section${budget.passages === 1 ? '' : 's'} carry an extractable answer (${budget.words.min}-${budget.words.max} words), and they are
  the ones the shape marks "extractable answer". Set "extractable": true on
  those and false on every other section, and put the answer block verbatim in
  the extractable sections' points.
- Order sections by the shape, then by the reader's decision path — never by
  copying the running order of a competing page.
${plan ? `- seoTitle: use one of the plan's title options, or a better one under 60 chars.
- dek: use the plan's meta description, or a better one in 140-160 chars.
- wordCountTarget: ${plan.wordCountTarget}, from the live SERP read. Do not raise it to pad.` : ''}

Return JSON:
{"seoTitle": string (≤60 chars, front-loaded primary keyword, include the year when natural),
 "dek": string (140-160 chars, includes primary keyword, sells the click honestly),
 "slug": string (kebab-case, short, keyword-bearing),
 "kind": string (human badge label, e.g. "Buying guide", "Comparison", "Trend watch"),
 "searchIntent": string,
 "primaryKeyword": string,
 "secondaryKeywords": string[],
 "tags": string[] (4-7 lowercase tags),
 "wordCountTarget": number (guides ≥1500, roundups ≥1200, articles ≥700),
 "sections": [{"heading": string (H2 text, written for this piece),
               "kind": string (the shape's section kind this heading executes),
               "extractable": boolean (true for exactly ${budget.passages} of the sections),
               "points": string[] (what it must cover, which products/facts from the
               dossier to use, and for an extractable section the answer block verbatim)}],
 "faq": ${faqInstruction(shape, plan)}}`,
    },
    tracker,
    // The slug and title are written straight onto the article row; a brief
    // missing either leaves an untitled, unroutable piece in the pipeline.
    requireKeys<ContentBrief>('seoTitle', 'slug', 'sections'),
  );

  return finaliseBrief(brief, { article, plan, shape });
}

/** What to ask the model for under "faq", given the shape's rule. */
function faqInstruction(shape: ArticleShape, plan: KeywordPlan | null): string {
  if (shape.faq === 'omit') {
    return '[] (this shape carries no FAQ — the questions are the body of the piece)';
  }
  const source = plan?.paaQuestions?.length ? ' — prefer the plan\'s PAA list' : '';
  return shape.faq === 'required'
    ? `[{"question": string}] (3-5 long-tail questions${source})`
    : `[{"question": string}] (only the long-tail questions no section above answers${source}; [] when there are none)`;
}

/**
 * The deterministic half of the brief: everything the pipeline decides rather
 * than the model. Exported for the tests, because this is the part of the
 * structure contract that can be proved without a model call.
 *
 * The FAQ rule is the one to read twice. It used to be "never let the FAQ come
 * back empty", which is right when every article ends in an FAQ and wrong the
 * moment shapes differ: a shape that suppresses the FAQ would still get a
 * populated `faq[]`, the writer would emit the section, and the uniformity
 * would come back through the side door.
 */
export function finaliseBrief(
  brief: ContentBrief,
  opts: { article: ArticleRow; plan: KeywordPlan | null; shape: ArticleShape },
): ContentBrief {
  const { article, plan, shape } = opts;

  brief.slug = slugify(brief.slug || brief.seoTitle || article.title);
  // The byline belongs to the angle stage, which picked it against the thesis
  // and the beat; the outliner is not asked for one. An article that predates
  // the angle stage falls back to the beat that owns its category.
  brief.author = (authorById(article.editorial_angle?.byline) ?? defaultAuthorFor(article.category))
    .id;
  // The plan's keyword is the decision of record: the outliner may reword the
  // title, but it does not get to re-target the piece.
  if (plan?.primaryKeyword) brief.primaryKeyword = plan.primaryKeyword;
  if (plan?.wordCountTarget) brief.wordCountTarget = plan.wordCountTarget;

  brief.sections = enforcePassageBudget(brief.sections, shape);
  brief.faq = enforceFaqRule(brief.faq, shape, plan);
  // The record of decision travels with the brief: the writer and the SEO
  // reviewer both serialise the whole brief into their prompt, so this is what
  // carries the shape downstream without either of them loading anything.
  brief.structureShape = shape;
  return brief;
}

/**
 * The passage budget as a hard cap. A model asked for three extractable
 * answers will sometimes return eight, and eight is the uniform per-H2 block
 * this library replaced. The kinds the shape marks are preferred; ties break
 * on the running order, so the article's lead answer is never the one dropped.
 */
function enforcePassageBudget(
  sections: ContentBrief['sections'],
  shape: ArticleShape,
): ContentBrief['sections'] {
  const list = (Array.isArray(sections) ? sections : []).filter((s) => s?.heading?.trim());
  const answerKinds = new Set(
    shape.sections.filter((s) => s.carriesAnswer).map((s) => s.kind),
  );
  const ranked = list
    .map((section, index) => ({ section, index }))
    .filter(({ section }) => section.extractable !== false)
    .sort((a, b) => {
      const kindA = answerKinds.has(a.section.kind ?? '') ? 0 : 1;
      const kindB = answerKinds.has(b.section.kind ?? '') ? 0 : 1;
      return kindA - kindB || a.index - b.index;
    });
  const spend = new Set(
    ranked.slice(0, shape.passageBudget.passages).map(({ index }) => index),
  );
  return list.map((section, index) => ({ ...section, extractable: spend.has(index) }));
}

/**
 * The FAQ, by the shape's rule rather than by reflex.
 *
 * - required: never empty — the site parses the visible "## FAQ" into FAQPage
 *   markup, so a shape that promises one has to deliver questions.
 * - optional: whatever the model judged this piece needed, left alone.
 * - omit: dropped, so nothing downstream sees entries to write a section from.
 */
function enforceFaqRule(
  faq: ContentBrief['faq'],
  shape: ArticleShape,
  plan: KeywordPlan | null,
): ContentBrief['faq'] {
  if (shape.faq === 'omit') return [];
  const entries = (Array.isArray(faq) ? faq : []).filter((entry) => entry?.question?.trim());
  if (shape.faq === 'optional' || entries.length > 0) return entries;
  return (plan?.paaQuestions ?? []).slice(0, 4).map((question) => ({ question }));
}
