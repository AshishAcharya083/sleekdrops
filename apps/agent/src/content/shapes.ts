// The structure library - the silhouettes an article is allowed to take, as
// data.
//
// Every piece on this site used to come out of one skeleton hardcoded into the
// writer prompt: answer-first opening, a 40-60 word extractable block under
// every H2, "How we picked", an FAQ of 3-5 entries, a conclusion linking each
// pick. Read one article and you have read the shape of all of them, which is
// exactly what a manual reviewer calls "automatically generated material". The
// citability principle behind that skeleton is sound - generative engines
// retrieve passages, not pages - but realising it identically in every section
// of every piece is the tell.
//
// So the skeleton becomes a library. Each shape owns its own section kinds and
// running order, its own opening style, its own naming for the methodology and
// closing sections, and a per-article passage budget: how many extractable
// answers this piece carries in total, spent on the sections that genuinely
// answer a query rather than sprayed under every heading.
//
// The shapes themselves are a code-level catalogue (content/catalogue.ts) and
// each platform selects the ones it publishes. The angle stage picks one of
// the platform's shapes against the thesis; this file is how a piece's shape
// is chosen and how it reads as an instruction.
import { getArticleShapes, shapeById } from './catalogue.js';
import type { EditorialAngle } from '../pipeline/types.js';
import type { Platform } from '../platform/types.js';

/** Where a section sits in the running order. Order within a slot is array order. */
export type SectionSlot = 'open' | 'body' | 'close';

export interface ShapeSection {
  /** Stable id for the job this section does. Not printed to the reader. */
  kind: string;
  /**
   * What this shape calls it. The naming is part of the variety: a methodology
   * section is "How we ranked these" in one shape and "Where these numbers
   * come from" in another, because a reader who meets "How we picked" on every
   * page has met one template.
   */
  label: string;
  required: boolean;
  slot: SectionSlot;
  /** What the section has to do. Handed to the outliner as an instruction. */
  purpose: string;
  /**
   * True when this section answers a question a reader actually typed, and so
   * may spend one of the article's extractable passages. False sections get
   * ordinary prose - which is the point of the budget.
   */
  carriesAnswer: boolean;
  /** Written once per contender / segment / question rather than once per article. */
  repeats?: boolean;
}

/**
 * One article silhouette. The field names through `sections` are fixed by the
 * cross-card contract; `postTypes`, `serpFormats` and `selectedBy` are this
 * card's own.
 */
export interface ArticleShape {
  /** kebab-case id, unique across the catalogue, so the angle stage can name one. */
  id: string;
  /**
   * The silhouette in one line. It is how the angle stage chooses between
   * shapes, and it is rendered straight into prompts - a shape has to arrive
   * as an instruction, not as an id.
   */
  description: string;
  /** Human label for the admin panel and the session summary. */
  name: string;
  /** The opening instruction handed to the writer instead of one global formula. */
  openingStyle: string;
  /** Per-article extractable-answer budget: how many passages, and their word range. */
  passageBudget: { passages: number; words: { min: number; max: number } };
  /** Whether this shape emits the FAQ that backs FAQPage schema. */
  faq: 'required' | 'optional' | 'omit';
  /** Section kinds and their running order. */
  sections: ShapeSection[];
  /** Post types this shape is offered for. */
  postTypes: string[];
  /** Lowercase fragments of a SERP winning format this shape answers. */
  serpFormats: string[];
  /** How this shape came to be picked. Stamped at selection, not in the library. */
  selectedBy?: 'angle' | 'format' | 'intent' | 'rotation';
}

/**
 * A shape as recorded on an article - its structure_shape, and the brief that
 * carries it into the writer and reviewer prompts. The description stays in
 * the catalogue and is looked up by id: every record written before shapes
 * carried one has none, and leaving it out of new records keeps the brief a
 * writer reads the same whichever kind it holds.
 */
export type ShapeRecord = Omit<ArticleShape, 'description'>;

export function shapeRecord(shape: ShapeRecord & { description?: string }): ShapeRecord {
  const { description: _description, ...record } = shape;
  return record;
}


/**
 * The shapes this platform offers for a post type, in platform order. An
 * unrecognised post type still gets the platform's whole library rather than
 * the old skeleton: the whole point is that no piece falls back to one
 * silhouette.
 */
export function shapesForPostType(platform: Platform, postType: string): ArticleShape[] {
  const shapes = getArticleShapes(platform);
  const offered = shapes.filter((shape) => shape.postTypes.includes(postType));
  return offered.length > 0 ? offered : shapes;
}

/** FNV-1a. A stable spread over the shape list from an article's own id. */
function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** The intent the SERP read named, nudged toward a silhouette. */
const SHAPE_BY_INTENT: Record<string, string> = {
  Informational: 'question-led',
  'Commercial Investigation': 'segmented-buyers',
  Transactional: 'verdict-first',
};

/**
 * Does this winning format name this shape? A fragment has to land on a whole
 * word: substring matching read "Ranked listicle of the best TVs" as a
 * head-to-head, because "vs" sits inside "TVs" - and "fix" inside "fixture",
 * "value" inside "valuable". A hyphen counts as part of a word here, so
 * "single" does not fire on "single-serve" while the hyphenated fragments
 * ("head-to-head", "how-to") still match themselves. A trailing plural counts:
 * the SERP says "reviews" and "running costs".
 */
function formatNames(format: string, shape: ArticleShape): boolean {
  return shape.serpFormats.some((fragment) => fragmentPattern(fragment).test(format));
}

const WORD_CHAR = '[a-z0-9-]';
const FRAGMENT_PATTERNS = new Map<string, RegExp>();

function fragmentPattern(fragment: string): RegExp {
  const cached = FRAGMENT_PATTERNS.get(fragment);
  if (cached) return cached;
  const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<!${WORD_CHAR})${escaped}(?:e?s)?(?!${WORD_CHAR})`);
  FRAGMENT_PATTERNS.set(fragment, pattern);
  return pattern;
}

export interface ShapeSelectionInput {
  /** The platform whose shapes are on offer. */
  platform: Platform;
  postType: string;
  /** The angle record. Its `shape` is the decision of record when it fits. */
  angle: EditorialAngle | null;
  /** keyword_plan.winningFormat - the content type the live SERP rewards. */
  winningFormat?: string | null;
  /** keyword_plan.intent. */
  intent?: string | null;
  /**
   * Stable per-article string (the article id) used only to spread the
   * no-signal fallback across the library. Selection stays pure: the same
   * seed always yields the same shape.
   */
  seed?: string | null;
}

/**
 * Pick the silhouette for one piece. Pure and deterministic, so it is testable
 * without a model.
 *
 * The order of precedence is the order in which the decisions were actually
 * made. The angle stage chose a shape against the thesis, so it wins whenever
 * the library offers that shape for this post type. Failing that the live SERP
 * read decides: the format the winning pages take, then the intent behind the
 * query. Only when none of those said anything - an article queued before
 * either stage existed - does the fallback run, and even then it spreads
 * across the post type's shapes rather than collapsing on one default, because
 * one default is the thing this library exists to remove.
 */
export function selectShape(input: ShapeSelectionInput): ArticleShape {
  const offered = shapesForPostType(input.platform, input.postType);
  const offers = (id: unknown): ArticleShape | null =>
    typeof id === 'string' ? offered.find((shape) => shape.id === id) ?? null : null;

  const fromAngle = offers(input.angle?.shape);
  if (fromAngle) return { ...fromAngle, selectedBy: 'angle' };

  const format = (input.winningFormat ?? '').toLowerCase();
  if (format) {
    const fromFormat = offered.find((shape) => formatNames(format, shape));
    if (fromFormat) return { ...fromFormat, selectedBy: 'format' };
  }

  const fromIntent = offers(SHAPE_BY_INTENT[(input.intent ?? '').trim()]);
  if (fromIntent) return { ...fromIntent, selectedBy: 'intent' };

  const seed = input.seed?.trim() || input.postType;
  return { ...offered[hash(seed) % offered.length], selectedBy: 'rotation' };
}

/** How the passage budget reads as an instruction. Used by both prompts. */
export function passageBudgetRule(shape: ShapeRecord): string {
  const { passages, words } = shape.passageBudget;
  return `This piece carries ${passages} extractable answer${passages === 1 ? '' : 's'} in total,
of ${words.min}-${words.max} words each - a self-contained answer to a question a reader
typed, quotable with nothing around it. Spend them on the sections marked
"extractable answer" in the running order, and nowhere else. Every other section is written as
ordinary prose. A ${words.min}-${words.max} word block under every heading is a template, and it
reads like one.`;
}

const FAQ_RULE: Record<ArticleShape['faq'], string> = {
  required: `FAQ: required. An "## FAQ" section with one "### Question?" per entry, each
answered in the passage word range. The site builds FAQPage markup out of it.`,
  optional: `FAQ: only if the brief carries FAQ entries. This shape does not owe the reader
one - include it when there are real long-tail questions the sections above do
not already answer, and leave it out otherwise. If it is included it is an
"## FAQ" section with "### Question?" headings, because the site's FAQPage
markup is built by parsing exactly that.`,
  omit: `FAQ: omitted for this shape. Do not add an "## FAQ" section - the questions are
the body of the piece, and repeating them underneath would say everything twice.`,
};

/**
 * The shape as an instruction block for a prompt. The outliner builds sections
 * from it and the writer writes to it, so both read the same record - a shape
 * described two slightly different ways is a shape neither stage follows.
 */
export function structureBrief(shape: ShapeRecord | null | undefined, platform: Platform): string {
  if (!shape) return '';
  const order = (['open', 'body', 'close'] as SectionSlot[]).flatMap((slot) =>
    shape.sections.filter((section) => section.slot === slot),
  );
  return [
    `STRUCTURE - this piece takes the "${shape.name}" shape (${shape.id}). It is a
decision recorded on the article, not a default, and it is what stops two
${platform.name} articles sharing a silhouette. Where the editorial angle above names
a shape, this block is that decision resolved into a structure: follow this
one.`,
    shapeById(shape.id)?.description ?? '',
    `OPENING - do not use any other opening formula:\n${shape.openingStyle}`,
    `RUNNING ORDER - the sections, in this order. "repeats" means one section per
contender / segment / question, not one section. Headings are written for this
piece in this shape's naming, not copied from the labels below:`,
    ...order.map((section) => {
      const flags = [
        section.required ? 'required' : 'optional',
        section.repeats ? 'repeats' : '',
        section.carriesAnswer ? 'extractable answer' : '',
      ].filter(Boolean);
      return `  - [${section.slot}] ${section.label} (${flags.join(', ')})\n      ${section.purpose}`;
    }),
    passageBudgetRule(shape),
    FAQ_RULE[shape.faq],
  ].join('\n\n');
}

/** One line for a stage summary or the admin panel. */
export function describeShapeSelection(shape: ShapeRecord): string {
  return `${shape.name} (${shape.id})${shape.selectedBy ? ` from the ${shape.selectedBy}` : ''}`;
}
