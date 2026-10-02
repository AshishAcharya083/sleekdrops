// The structure library's shapes, as data. Each one is an id a platform can
// select (platform.articleShapes), the one-liner the angle stage chooses it by,
// and the structure behind it. content/catalogue.ts is what makes them a
// catalogue; this file only holds them, so that catalogue and the selection
// logic in content/shapes.ts never import each other at load time.
import type { ArticleShape } from './shapes.js';

/**
 * The library: each silhouette's id, the one-line description the angle stage
 * picks it by, and the structure behind it.
 *
 * Read the seven `faq` values together rather than one at a time: three
 * require it, three leave it to the evidence, and one suppresses it. That
 * spread is deliberate. An FAQ earns its place where a piece has long-tail
 * questions its H2s do not already answer - the site builds FAQPage markup out
 * of the visible "## FAQ" section, so where it fires it still has to be real -
 * but a question-led piece whose every H2 is already a question would only
 * restate itself under a second heading.
 */
export const LIBRARY_SHAPES: readonly ArticleShape[] = [
  {
    id: 'verdict-first',
    description:
      'Open with the single pick and spend the piece defending it; every other contender is a counter-argument to answer.',
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

  {
    id: 'segmented-buyers',
    description:
      'One section per kind of buyer. The pick changes per segment and the piece says who each one is wrong for.',
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

  {
    id: 'head-to-head',
    description:
      'Two or three contenders argued against each other, axis by axis, on the things that actually decide it.',
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

  {
    id: 'failure-led',
    description:
      'Lead with what goes wrong and how long it takes to go wrong; the recommendation is whatever survives that.',
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

  {
    id: 'cost-of-ownership',
    description:
      'Lead with what the thing costs over its life - RRP, consumables, warranty, resale - and rank on that.',
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

  {
    id: 'question-led',
    description:
      'Walk the reader question chain in the order a buyer actually asks it, answering each before the next.',
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

  {
    id: 'ranked-list',
    description:
      'A ranked list with the scoring rationale stated - only when the SERP genuinely rewards a list and nothing else fits.',
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
];
