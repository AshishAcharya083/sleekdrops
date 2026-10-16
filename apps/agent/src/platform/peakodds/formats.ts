// PeakOdds' own formats: the `preview` post type and the three layouts behind
// it. They are spread into the shared catalogue, and PeakOdds selects them by
// id alongside the existing shapes its explainers and guides reuse.
//
// What is missing is deliberate. Competitor previews carry a bookmaker column,
// unit stakes and a sign-up offer under every pick; those are the referral
// parts, and none of them is here. The responsible-gambling footer is not a
// section either: the assembler appends it from the edition's data, so no
// model ever writes it.
import type { PostTypeDef } from '../../content/catalogue.js';
import type { ArticleShape } from '../../content/shapes.js';

/** The picks table header, column for column. `content/compliance.ts` rejects any other. */
export const PICKS_TABLE_COLUMNS = ['Market', 'Selection', 'Indicative odds (decimal)', 'As at'] as const;

export const PEAKODDS_POST_TYPES: PostTypeDef[] = [
  {
    id: 'preview',
    description:
      'tips for an upcoming fixture, round or player/award market - a picks table with indicative decimal odds and the time each price was seen, the reasoning for each pick, and a hedged verdict. Event-bound: it expires at the start time.',
  },
];

const PICKS_TABLE_PURPOSE = `A markdown table with exactly these columns, in this order: ${PICKS_TABLE_COLUMNS.join(' | ')}.
One row per pick. "Indicative odds (decimal)" is a bare decimal price such as 1.85 - never fractional, never American, never a currency symbol.
"As at" is when that price was seen, written YYYY-MM-DD HH:MM with an explicit zone (UTC, UTC+10, AEST, AEDT).
Every price comes from an odds-comparison or news source in the dossier; a price that only a bookmaker's own page shows is left out, and so is its row.
No bookmaker column, no stake or unit column, no bookmaker named anywhere in the table.`;

const VERDICT_PURPOSE =
  'The overall lean in two or three sentences, hedged in plain words: it can be wrong, and the prices are subject to change. No certainty language, no staking advice.';

const NO_FOOTER_NOTE = `Do not write a responsible-gambling notice, a helpline or an 18+ line - the
site appends the one for this edition to every article.`;

export const PEAKODDS_SHAPES: ArticleShape[] = [
  {
    id: 'match-preview',
    description:
      'One fixture: summary bullets, a picks table of indicative decimal odds with the time each was seen, the reasoning for each pick, then a hedged verdict.',
    name: 'Match preview with tips',
    openingStyle: `Open with three to five summary bullets: the fixture, its start time with an
explicit time zone, the one fact that shapes the game, and the lean. No
scene-setting and no hype. ${NO_FOOTER_NOTE}`,
    passageBudget: { passages: 2, words: { min: 40, max: 60 } },
    faq: 'omit',
    postTypes: ['preview'],
    serpFormats: ['match preview', 'preview', 'tips', 'prediction', 'betting tips'],
    sections: [
      {
        kind: 'summary',
        label: 'The short version',
        required: true,
        slot: 'open',
        purpose: 'Three to five bullets: fixture, start time and zone, the deciding fact, the lean.',
        carriesAnswer: true,
      },
      {
        kind: 'picks-table',
        label: 'The picks',
        required: true,
        slot: 'open',
        purpose: PICKS_TABLE_PURPOSE,
        carriesAnswer: false,
      },
      {
        kind: 'context',
        label: 'Team news and form',
        required: true,
        slot: 'body',
        purpose:
          'Selections, injuries, recent form and the match-up that matters, each from a dated source in the dossier.',
        carriesAnswer: false,
      },
      {
        kind: 'pick-reasoning',
        label: 'Why <selection>',
        required: true,
        slot: 'body',
        purpose:
          'One per row of the picks table: the evidence for it, what would make it lose, and the price as at its stated time.',
        carriesAnswer: true,
        repeats: true,
      },
      {
        kind: 'verdict',
        label: 'Verdict',
        required: true,
        slot: 'close',
        purpose: VERDICT_PURPOSE,
        carriesAnswer: false,
      },
    ],
  },
  {
    id: 'round-roundup',
    description:
      'A whole round or weekend: one summary bullet per game, a single picks table across the round, short reasoning per game, then a hedged verdict on the round.',
    name: 'Round and weekend roundup',
    openingStyle: `Open with one bullet per game in start-time order, each with its start time and
an explicit time zone and the lean in a few words. ${NO_FOOTER_NOTE}`,
    passageBudget: { passages: 2, words: { min: 35, max: 55 } },
    faq: 'omit',
    postTypes: ['preview'],
    serpFormats: ['round', 'weekend', 'roundup', 'every game', 'tips for every'],
    sections: [
      {
        kind: 'summary',
        label: 'The round at a glance',
        required: true,
        slot: 'open',
        purpose: 'One bullet per game: teams, start time and zone, the lean.',
        carriesAnswer: true,
      },
      {
        kind: 'picks-table',
        label: 'The picks for the round',
        required: true,
        slot: 'open',
        purpose: `${PICKS_TABLE_PURPOSE}\nName the game in the Market cell, e.g. "Swans v Lions - Head to head".`,
        carriesAnswer: false,
      },
      {
        kind: 'game',
        label: '<home> v <away>',
        required: true,
        slot: 'body',
        purpose:
          'One per game: the deciding team news or form, and the reasoning for its pick in the table. Short - a paragraph or two.',
        carriesAnswer: true,
        repeats: true,
      },
      {
        kind: 'verdict',
        label: 'Verdict on the round',
        required: true,
        slot: 'close',
        purpose: VERDICT_PURPOSE,
        carriesAnswer: false,
      },
    ],
  },
  {
    id: 'player-markets',
    description:
      'A player or award market: summary bullets, how the market is decided, a picks table of indicative decimal odds with the time each was seen, the reasoning per pick, then a hedged verdict.',
    name: 'Player and award markets',
    openingStyle: `Open with three to five summary bullets: the market, when it is decided (with an
explicit time zone), who leads it on the evidence, and the lean. ${NO_FOOTER_NOTE}`,
    passageBudget: { passages: 3, words: { min: 40, max: 60 } },
    faq: 'optional',
    postTypes: ['preview'],
    serpFormats: ['player', 'anytime', 'goalscorer', 'try scorer', 'disposals', 'props', 'award', 'medal', 'mvp'],
    sections: [
      {
        kind: 'summary',
        label: 'The short version',
        required: true,
        slot: 'open',
        purpose: 'Three to five bullets: the market, when it is decided, the leaders, the lean.',
        carriesAnswer: true,
      },
      {
        kind: 'market',
        label: 'How the market is decided',
        required: true,
        slot: 'open',
        purpose:
          'The rules that settle it - the voting system, the stat counted, dead-heat and void rules - from the governing body or a news source.',
        carriesAnswer: true,
      },
      {
        kind: 'picks-table',
        label: 'The picks',
        required: true,
        slot: 'body',
        purpose: PICKS_TABLE_PURPOSE,
        carriesAnswer: false,
      },
      {
        kind: 'pick-reasoning',
        label: 'Why <selection>',
        required: true,
        slot: 'body',
        purpose:
          'One per row of the picks table: the numbers behind the player, their role, and what would stop it landing.',
        carriesAnswer: true,
        repeats: true,
      },
      {
        kind: 'faq',
        label: 'FAQ',
        required: false,
        slot: 'close',
        purpose:
          'Only for real long-tail questions about the market the sections above leave open. Real questions ending in "?", answered in the passage word range.',
        carriesAnswer: false,
      },
      {
        kind: 'verdict',
        label: 'Verdict',
        required: true,
        slot: 'close',
        purpose: VERDICT_PURPOSE,
        carriesAnswer: false,
      },
    ],
  },
];
