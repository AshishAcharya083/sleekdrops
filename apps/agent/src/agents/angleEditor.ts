// Angle editor - decides what the piece argues, before anybody writes it.
//
// The gap this fills is the one a human reviewer reads as "no meaningful
// curation". Research gathers evidence, the keyword stage picks a query, the
// outliner turns the dossier into sections and the writer fills them. At no
// point does anything decide what the article is FOR, so the output is
// complete, correct and says nothing - the same silhouette and the same
// non-position on every topic.
//
// Grounded strictly in the dossier and the keyword plan's competitor reads.
// No web access, deliberately: an angle is a judgement about evidence we
// already hold, and a stage that could search would reach for the top three
// results and come back with their take, which is the one take we cannot use.
//
// The stage is allowed to come back empty-handed. `defensible: false` records
// that the evidence supports no real position, which is a far better input to
// the writer than a manufactured contrarian claim it would then have to
// defend with invented reasons.
import { chatJson, requireKeys, UsageTracker } from '../llm/index.js';
import { AUTHORS, authorById, BYLINE_NAME, defaultAuthorFor } from '../content/contract.js';
import { keywordPlanBrief, operatorBrief, siteContext, SOURCE_DISCIPLINE } from './context.js';
import { ARTICLE_SHAPES, isArticleShape } from '../pipeline/types.js';
import type { ArticleRow, ArticleShape, EditorialAngle, TopicRow } from '../pipeline/types.js';

/**
 * The shape a post type falls back to when the model names one we do not
 * have. Deliberately not a single default: one fallback shape for everything
 * would rebuild the uniform skeleton this stage exists to break.
 */
const SHAPE_BY_POST_TYPE: Record<string, ArticleShape> = {
  guide: 'segmented-buyers',
  roundup: 'ranked-list',
  article: 'question-led',
};

export async function runAngleEditor(
  article: ArticleRow,
  topic: TopicRow | null,
  model: string,
  tracker: UsageTracker,
): Promise<EditorialAngle> {
  const plan = article.keyword_plan;
  const planBrief = keywordPlanBrief(plan);
  const brief = operatorBrief(topic);

  const angle = await chatJson<EditorialAngle>(
    {
      model,
      system: `${siteContext()}\n\n${SOURCE_DISCIPLINE}`,
      temperature: 0.6,
      maxTokens: 4000,
      prompt: `You are the commissioning editor. Before this piece is outlined, decide what it
argues. Everything downstream is held to what you write here.
${brief ? `\n${brief}\n` : ''}${planBrief ? `\n${planBrief}\n` : ''}
Working title: ${article.title}
Post type: ${article.post_type} | Category: ${article.category}

Research dossier - the ONLY evidence you may reason from:
${JSON.stringify(article.research, null, 2)}

What to decide:

THESIS. One sentence someone could disagree with. "The Ninja is the only one
of these worth buying above A$300, and the Dyson is not" is a thesis. "There
are several good options depending on your needs" is not - it is the absence
of one. The thesis must be provable from the dossier: point at the facts,
complaints, failure modes or prices that carry it.

READER. A situation, not a demographic. "Someone replacing a corded vacuum in
a two-bedroom flat with no carpet" beats "Australian shoppers aged 25-45".

CONTRARIAN OR NON-OBVIOUS TAKE. The thing the evidence supports that a reader
skimming the top three results would not come away with. Owner complaints and
failure modes are where these usually live - a product everyone recommends
that owners say dies in year two is a take. Do NOT invent one. If the dossier
does not support a position beyond what the competition already says, set
defensible=false, leave contrarianTake empty, and say in "weakness" exactly
what evidence was missing. That is a legitimate outcome and it will be
recorded on the article: a fabricated take is worse than none.

INFORMATION GAIN. What this piece says that the top three results do not, one
entry per claim. Each names the competitor URL that lacks it (use the URLs in
the keyword plan above - never invent one) and the dossier evidence that lets
us say it. If the keyword plan has no competitors, return an empty list rather
than guessing at what they cover.

SHAPE. The structural silhouette the piece takes. Pick the one that fits this
thesis; do not default to the list format because the topic is a product
roundup. Every article on this site currently opens the same way, and that
sameness is the defect this stage exists to fix.
${Object.entries(ARTICLE_SHAPES)
  .map(([id, description]) => `  - ${id}: ${description}`)
  .join('\n')}

BYLINE. The piece publishes as ${BYLINE_NAME} whatever you choose; what you
are picking is which beat's voice writes it, judged on the thesis and the
subject. The beat becomes a tag on the byline, never a byline of its own.
${AUTHORS.map((a) => `  - ${a.id}: ${a.label || 'house voice'} - ${a.beat}. Cares about: ${a.voice.cares}`).join('\n')}

Return JSON:
{"thesis": string (one sentence, arguable, provable from the dossier),
 "reader": string (a situation),
 "defensible": boolean (false when the evidence supports no real position),
 "contrarianTake": string (the non-obvious take, or "" when defensible is false),
 "weakness": string (when defensible is false, the evidence that was missing; "" otherwise),
 "informationGain": [{"claim": string, "absentFrom": string (a competitor URL from the plan), "evidence": string (what in the dossier proves it)}],
 "shape": one of ${Object.keys(ARTICLE_SHAPES).map((s) => `"${s}"`).join(' | ')},
 "shapeRationale": string (1-2 sentences: why this shape beats the others here),
 "byline": one of ${AUTHORS.map((a) => `"${a.id}"`).join(' | ')} (the beat voice),
 "bylineRationale": string (one sentence)}`,
    },
    tracker,
    // The thesis is the whole product of this stage; without it the record is
    // an empty shell that every downstream prompt would still be told to obey.
    requireKeys<EditorialAngle>('thesis', 'shape'),
  );

  return normaliseAngle(angle, {
    postType: article.post_type,
    category: article.category,
    competitorUrls: (plan?.competitors ?? []).map((c) => c.url),
  });
}

/**
 * Turn whatever the model returned into a record four downstream prompts and
 * the admin panel can rely on. Exported for the tests.
 *
 * Two rules here carry weight beyond shape-checking:
 *
 *  - A thesis-less angle is not defensible, whatever the model said about
 *    itself. A model that returns `defensible: true` with an empty thesis has
 *    told us it found nothing; recording that as a defended position would
 *    hand the writer a claim with no content behind it.
 *  - Information gain is checked against the competitor URLs the keyword
 *    stage actually read. A claim attributed to a URL nobody fetched is not
 *    information gain, it is a guess about a page we never opened.
 */
export function normaliseAngle(
  raw: unknown,
  opts: { postType: string; category: string; competitorUrls: string[] },
): EditorialAngle {
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

  const a = record(raw);
  const thesis = text(a.thesis);
  const contrarianTake = text(a.contrarianTake);
  // A take is only defensible when there is something to defend. Both the
  // model's own verdict and the presence of a thesis have to agree.
  const defensible = a.defensible !== false && thesis !== '' && contrarianTake !== '';

  const known = new Set(opts.competitorUrls);
  const informationGain = (Array.isArray(a.informationGain) ? a.informationGain : [])
    .map((entry) => {
      const g = record(entry);
      const absentFrom = text(g.absentFrom);
      return {
        claim: text(g.claim),
        // An unread URL is dropped rather than kept: the claim survives, the
        // false attribution does not.
        absentFrom: known.has(absentFrom) ? absentFrom : '',
        evidence: text(g.evidence),
      };
    })
    .filter((g) => g.claim !== '');

  const shape = text(a.shape);
  const byline = authorById(text(a.byline)) ?? defaultAuthorFor(opts.category);

  return {
    thesis,
    reader: text(a.reader),
    defensible,
    contrarianTake: defensible ? contrarianTake : '',
    weakness: defensible
      ? ''
      : text(a.weakness) ||
        (thesis === ''
          ? 'The angle stage returned no thesis, so nothing was recorded for this piece to argue.'
          : 'No take beyond what the top results already say was supported by the dossier.'),
    informationGain,
    shape: isArticleShape(shape)
      ? shape
      : Object.hasOwn(SHAPE_BY_POST_TYPE, opts.postType)
        ? SHAPE_BY_POST_TYPE[opts.postType]
        : 'question-led',
    shapeRationale: text(a.shapeRationale),
    byline: byline.id,
    bylineRationale: text(a.bylineRationale),
  };
}
