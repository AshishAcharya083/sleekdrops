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
// The vocabulary of shape ids is the one the angle stage already picks from
// (ARTICLE_SHAPES in pipeline/types.ts). That stage decides the silhouette
// against the thesis; this file is the body behind each of those ids.
import { ARTICLE_SHAPES, isArticleShape } from '../pipeline/types.js';
import type { ArticleShape as ShapeId, EditorialAngle } from '../pipeline/types.js';

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
  /** kebab-case id, shared with ARTICLE_SHAPES so the angle stage can name one. */
  id: ShapeId;
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
 * The library. Ids and their one-line silhouettes come from ARTICLE_SHAPES;
 * everything here is the structure behind them.
 *
 * Read the seven `faq` values together rather than one at a time: three
 * require it, three leave it to the evidence, and one suppresses it. That
 * spread is deliberate. An FAQ earns its place where a piece has long-tail
 * questions its H2s do not already answer - the site builds FAQPage markup out
 * of the visible "## FAQ" section, so where it fires it still has to be real -
 * but a question-led piece whose every H2 is already a question would only
 * restate itself under a second heading.
 */
const LIBRARY: Record<ShapeId, Omit<ArticleShape, 'id'>> = {
  'verdict-first': {
    name: 'Single-winner verdict',
    openingStyle: `Name the winner in the first sentence and its price band in the second.
No scene-setting, no category explainer, no "we looked at 14 models". The whole
piece is the defence of that call, so the call goes first and the defence
follows it.`,
    passageBudget: { passages: 3, words: { min: 40, max: 60 } },
    faq: 'optional',
    postTypes: ['guide', 'roundup', 'article'],
    serpFormats: ['single', 'verdict', 'best overall', 'review'],
    sections: [
      {
        kind: 'verdict',
        label: 'The pick',
        required: true,
        slot: 'open',
        purpose: 'The winner, the price band, and the one reason it wins. Nothing else.',
        carriesAnswer: true,
      },
      {
        kind: 'defence',
        label: 'Why it wins',
        required: true,
        slot: 'body',
        purpose:
          'The evidence behind the call - tested claims, specs with their source and year, owner data.',
        carriesAnswer: true,
      },
      {
        kind: 'limits',
        label: 'Where it falls short',
        required: true,
        slot: 'body',
        purpose:
          'The failure modes and complaints against the winner, with their denominators. Never an empty cons list.',
        carriesAnswer: false,
      },
      {
        kind: 'contender',
        label: 'What almost beat it',
        required: true,
        slot: 'body',
        purpose:
          'One per serious rival, each written as an argument against the pick and then answered. Not a mini-review.',
        carriesAnswer: false,
        repeats: true,
      },
      {
        kind: 'method-note',
        label: 'How this call was made',
        required: false,
        slot: 'body',
        purpose:
          'One short paragraph on the evidence this rests on. A paragraph, not a bulleted methodology block.',
        carriesAnswer: false,
      },
      {
        kind: 'faq',
        label: 'FAQ',
        required: false,
        slot: 'close',
        purpose:
          'Only where the piece has real long-tail questions the sections above do not answer. Real questions ending in "?", answered in the passage word range - and left out entirely when there are none.',
        carriesAnswer: false,
      },
      {
        kind: 'exclusions',
        label: 'Who should skip it',
        required: true,
        slot: 'close',
        purpose:
          'The buyers this is wrong for and what they should look at instead, with each pick it names linked once. This closes the piece - the verdict was the opening, so it is not restated here.',
        carriesAnswer: true,
      },
    ],
  },

  'segmented-buyers': {
    name: 'Decision tree by use case',
    openingStyle: `Open with the branch, not the winner. Two or three sentences that let a
reader place themselves in one of the segments below, and an explicit statement
that the pick changes per segment. Do not crown an overall winner in the
opening - this shape argues that there isn't one.`,
    passageBudget: { passages: 4, words: { min: 40, max: 60 } },
    faq: 'required',
    postTypes: ['guide', 'roundup'],
    serpFormats: ['buying guide', 'buyer', 'use case', 'best for'],
    sections: [
      {
        kind: 'branches',
        label: 'Which of these you are',
        required: true,
        slot: 'open',
        purpose:
          'The segments, named as situations a reader recognises, and the pick each one lands on.',
        carriesAnswer: true,
      },
      {
        kind: 'segment',
        label: 'The pick for <segment>',
        required: true,
        slot: 'body',
        purpose:
          'One per segment: the pick, the evidence for it in that use case, and who inside this segment it is still wrong for.',
        carriesAnswer: true,
        repeats: true,
      },
      {
        kind: 'table',
        label: 'The picks side by side',
        required: false,
        slot: 'body',
        purpose: 'A comparison table keyed by segment, with a "Where to buy" column.',
        carriesAnswer: false,
      },
      {
        kind: 'method',
        label: 'How we matched picks to buyers',
        required: true,
        slot: 'close',
        purpose:
          'The criteria that separated the segments and the evidence each pick rests on. It sits near the end because the reader wants their answer first.',
        carriesAnswer: false,
      },
      {
        kind: 'faq',
        label: 'FAQ',
        required: true,
        slot: 'close',
        purpose:
          'The long-tail questions the segments do not answer. Real questions ending in "?", each answered in the passage word range.',
        carriesAnswer: false,
      },
    ],
  },

  'head-to-head': {
    name: 'Head-to-head',
    openingStyle: `Open on the single axis that actually decides between them and say which
side of it each contender lands on, naming both in the first two sentences.
No "both are great options" throat-clearing - if the axis does not separate
them, it is the wrong axis.`,
    passageBudget: { passages: 4, words: { min: 35, max: 55 } },
    faq: 'optional',
    postTypes: ['guide', 'article'],
    serpFormats: ['vs', 'versus', 'comparison', 'head-to-head', 'compare'],
    sections: [
      {
        kind: 'split',
        label: 'What actually separates them',
        required: true,
        slot: 'open',
        purpose: 'The deciding axis, and where each contender sits on it.',
        carriesAnswer: true,
      },
      {
        kind: 'axis',
        label: '<axis>: <winner> takes it',
        required: true,
        slot: 'body',
        purpose:
          'One per deciding axis, argued to a result. Every axis heading names its winner - an axis that ends "it depends" is padding.',
        carriesAnswer: true,
        repeats: true,
      },
      {
        kind: 'table',
        label: 'Specs against each other',
        required: true,
        slot: 'body',
        purpose:
          'A comparison table of the contenders on the axes above, with a "Where to buy" column.',
        carriesAnswer: false,
      },
      {
        kind: 'method',
        label: 'How we compared them',
        required: false,
        slot: 'body',
        purpose:
          'Two or three sentences on where the axes came from. Only if the axes are not self-evident.',
        carriesAnswer: false,
      },
      {
        kind: 'faq',
        label: 'FAQ',
        required: false,
        slot: 'close',
        purpose:
          'Only where the piece has real long-tail questions the sections above do not answer. Real questions ending in "?", answered in the passage word range - and left out entirely when there are none.',
        carriesAnswer: false,
      },
      {
        kind: 'call',
        label: 'Which one to buy',
        required: true,
        slot: 'close',
        purpose:
          'The call, stated outright, with both contenders linked once, plus the one buyer profile that should take the loser instead.',
        carriesAnswer: true,
      },
    ],
  },

  'failure-led': {
    name: 'Problem-first diagnostic',
    openingStyle: `Open on the failure: what goes wrong, how long it takes to go wrong, and
how many owners it happened to, with the denominator. The reader already has
the problem - do not explain the category to them, and do not open with a
product name.`,
    passageBudget: { passages: 3, words: { min: 45, max: 70 } },
    faq: 'optional',
    postTypes: ['article', 'guide'],
    serpFormats: ['problem', 'troubleshoot', 'fix', 'complaint', 'reliability'],
    sections: [
      {
        kind: 'fault',
        label: 'What goes wrong',
        required: true,
        slot: 'open',
        purpose:
          'The failure mode, its timeframe and its volume, from the owner evidence. Named products, named sources, dates.',
        carriesAnswer: true,
      },
      {
        kind: 'cause',
        label: 'Why it happens',
        required: true,
        slot: 'body',
        purpose: 'The mechanism, from primary sources. Hedge explicitly where the evidence stops.',
        carriesAnswer: true,
      },
      {
        kind: 'survivors',
        label: 'What survives it',
        required: true,
        slot: 'body',
        purpose:
          'The products the failure evidence does not implicate, and what they do differently. This is the recommendation, and it is earned rather than announced.',
        carriesAnswer: true,
        repeats: true,
      },
      {
        kind: 'evidence-trail',
        label: 'Where these numbers come from',
        required: true,
        slot: 'body',
        purpose:
          'The sources behind the fault data, with their denominators and dates. This shape earns its authority from the evidence, so the trail is explicit rather than a methodology boilerplate.',
        carriesAnswer: false,
      },
      {
        kind: 'faq',
        label: 'FAQ',
        required: false,
        slot: 'close',
        purpose:
          'Only where the piece has real long-tail questions the sections above do not answer. Real questions ending in "?", answered in the passage word range - and left out entirely when there are none.',
        carriesAnswer: false,
      },
      {
        kind: 'if-you-own-one',
        label: 'If you already own one',
        required: true,
        slot: 'close',
        purpose:
          'What to do now - warranty position, what to watch for, when replacing is the cheaper call, with each pick it names linked once. No restated verdict.',
        carriesAnswer: false,
      },
    ],
  },

  'cost-of-ownership': {
    name: 'Total cost of ownership',
    openingStyle: `Open with the number the reader has not budgeted for: what the thing costs
over its life against what it costs on the shelf, both labelled RRP with their
year. The gap between those two numbers is the piece.`,
    passageBudget: { passages: 3, words: { min: 40, max: 60 } },
    faq: 'required',
    postTypes: ['guide', 'roundup'],
    serpFormats: ['cost', 'running costs', 'value', 'cheapest', 'price'],
    sections: [
      {
        kind: 'real-number',
        label: 'What it actually costs to own',
        required: true,
        slot: 'open',
        purpose:
          'Shelf price against lifetime cost, sourced and dated. Never a marketplace price.',
        carriesAnswer: true,
      },
      {
        kind: 'cost-line',
        label: '<cost line>',
        required: true,
        slot: 'body',
        purpose:
          'One per cost line the reader will actually pay - consumables, warranty, repairs, resale - each with its evidence.',
        carriesAnswer: false,
        repeats: true,
      },
      {
        kind: 'ranked-by-cost',
        label: 'Ranked by what they cost to keep',
        required: true,
        slot: 'body',
        purpose:
          'The contenders ordered on lifetime cost, in a table with a "Where to buy" column. The order will not match the shelf-price order; say so.',
        carriesAnswer: true,
      },
      {
        kind: 'costing-method',
        label: 'How we costed this',
        required: true,
        slot: 'body',
        purpose:
          'The ownership window, what is counted, and what could not be priced. A costing the reader cannot check is worthless.',
        carriesAnswer: false,
      },
      {
        kind: 'faq',
        label: 'FAQ',
        required: true,
        slot: 'close',
        purpose:
          'The cost questions the sections do not answer. Real questions ending in "?", answered in the passage word range.',
        carriesAnswer: false,
      },
      {
        kind: 'bottom-line',
        label: 'The cheapest one to live with',
        required: true,
        slot: 'close',
        purpose: 'The call on lifetime cost, with each named pick linked once.',
        carriesAnswer: true,
      },
    ],
  },

  'question-led': {
    name: 'Question chain',
    openingStyle: `Answer the exact question in the headline outright, in under fifty words,
then say which questions the rest of the chain works through. No definition of
the category, no history of it.`,
    passageBudget: { passages: 3, words: { min: 30, max: 50 } },
    // Omitted deliberately: every H2 here is already a question with its answer
    // under it, so a trailing FAQ would restate the article beneath a second
    // set of headings. The citable question/answer pairs are the body itself.
    faq: 'omit',
    postTypes: ['article', 'guide'],
    serpFormats: ['q&a', 'how-to', 'explainer', 'faq', 'informational'],
    sections: [
      {
        kind: 'lead-answer',
        label: '<the headline question>',
        required: true,
        slot: 'open',
        purpose: 'The headline question answered outright, before anything else.',
        carriesAnswer: true,
      },
      {
        kind: 'question',
        label: '<question>?',
        required: true,
        slot: 'body',
        purpose:
          'One per question, in the order a buyer actually asks them, each answered immediately underneath. Every People Also Ask question the plan carries belongs in this chain.',
        carriesAnswer: true,
        repeats: true,
      },
      {
        kind: 'picks',
        label: 'Where the products land',
        required: true,
        slot: 'body',
        purpose:
          'The named products, filed under the question each one answers best. Not a ranked list.',
        carriesAnswer: false,
      },
      {
        kind: 'final-question',
        label: 'So which one should you buy?',
        required: true,
        slot: 'close',
        purpose:
          'The last question in the chain is the buying one, and it is answered outright with each pick linked once.',
        carriesAnswer: true,
      },
    ],
  },

  'ranked-list': {
    name: 'Ranked roundup',
    openingStyle: `Open with the top and the bottom of the ranking in one breath - what won,
what was cut, and the single criterion the order was built on. The criterion is
the argument; a ranking without one is a list.`,
    passageBudget: { passages: 3, words: { min: 40, max: 60 } },
    faq: 'required',
    postTypes: ['roundup', 'guide'],
    serpFormats: ['listicle', 'ranked', 'top 10', 'best of', 'list', 'roundup'],
    sections: [
      {
        kind: 'ranking',
        label: 'The ranking at a glance',
        required: true,
        slot: 'open',
        purpose:
          'The order, the criterion behind it, and a table with a "Where to buy" column.',
        carriesAnswer: true,
      },
      {
        kind: 'criteria',
        label: 'How we ranked these',
        required: true,
        slot: 'open',
        purpose:
          'The scoring rationale, up front because the ranking is meaningless without it, and what would move an entry up or down.',
        carriesAnswer: false,
      },
      {
        kind: 'entry',
        label: '<n>. <product> - <what it is best at>',
        required: true,
        slot: 'body',
        purpose:
          'One per ranked product: why it sits where it sits, what it beats, what beats it, and who it is wrong for.',
        carriesAnswer: false,
        repeats: true,
      },
      {
        kind: 'cut',
        label: 'What missed the cut',
        required: true,
        slot: 'body',
        purpose:
          'The products considered and rejected, with the reason. A ranking with no exclusions was not a ranking.',
        carriesAnswer: true,
      },
      {
        kind: 'faq',
        label: 'FAQ',
        required: true,
        slot: 'close',
        purpose:
          'The long-tail questions the entries do not answer. Real questions ending in "?", answered in the passage word range.',
        carriesAnswer: false,
      },
      {
        kind: 'top-line',
        label: 'The one to buy',
        required: true,
        slot: 'close',
        purpose: 'Two or three sentences on the number one, with each named pick linked once.',
        carriesAnswer: true,
      },
    ],
  },
};

/** Every shape in the library, in a stable order. */
export const SHAPES: ArticleShape[] = (Object.keys(LIBRARY) as ShapeId[]).map((id) => ({
  id,
  ...LIBRARY[id],
}));

/** The library entry for an id, or null when the id is not one we publish. */
export function shapeById(id: unknown): ArticleShape | null {
  return isArticleShape(id) ? { id, ...LIBRARY[id] } : null;
}

/** The shapes offered for a post type, in library order. */
export function shapesForPostType(postType: string): ArticleShape[] {
  const offered = SHAPES.filter((shape) => shape.postTypes.includes(postType));
  // An unrecognised post type still gets a library rather than the old
  // skeleton: the whole point is that no piece falls back to one silhouette.
  return offered.length > 0 ? offered : SHAPES;
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
const SHAPE_BY_INTENT: Record<string, ShapeId> = {
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
  const offered = shapesForPostType(input.postType);
  const offers = (id: ShapeId | null | undefined): ArticleShape | null =>
    id ? offered.find((shape) => shape.id === id) ?? null : null;

  const angleShape = input.angle?.shape;
  const fromAngle = offers(isArticleShape(angleShape) ? angleShape : null);
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
export function passageBudgetRule(shape: ArticleShape): string {
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
export function structureBrief(shape: ArticleShape | null | undefined): string {
  if (!shape) return '';
  const order = (['open', 'body', 'close'] as SectionSlot[]).flatMap((slot) =>
    shape.sections.filter((section) => section.slot === slot),
  );
  return [
    `STRUCTURE - this piece takes the "${shape.name}" shape (${shape.id}). It is a
decision recorded on the article, not a default, and it is what stops two
SleekDrops articles sharing a silhouette. Where the editorial angle above names
a shape, this block is that decision resolved into a structure: follow this
one.`,
    ARTICLE_SHAPES[shape.id],
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
export function describeShapeSelection(shape: ArticleShape): string {
  return `${shape.name} (${shape.id})${shape.selectedBy ? ` from the ${shape.selectedBy}` : ''}`;
}
