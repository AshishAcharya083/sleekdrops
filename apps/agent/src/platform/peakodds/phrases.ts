// The words a PeakOdds article may not print, as code rather than advice to a
// model. The editorial rules tell every agent the same thing; this is what
// fails the assembly when a draft does it anyway.

export interface PhraseRule {
  /** Reader-facing name of the problem, quoted in the assembly error. */
  label: string;
  pattern: RegExp;
  /**
   * True when a negation that governs the match makes it responsible copy
   * rather than a breach: "no result is guaranteed" is exactly what the rules
   * ask for, "guaranteed winner" is exactly what they forbid. The negation
   * must sit directly before the phrase ("not a sure thing", "no bet is
   * risk-free"); "No doubt about it: a sure thing" is not negated.
   */
  negatable?: boolean;
}

export interface PhraseRules {
  certainty: readonly PhraseRule[];
  inducement: readonly PhraseRule[];
  income: readonly PhraseRule[];
  staking: readonly PhraseRule[];
  bookmaker: readonly PhraseRule[];
}

const APOSTROPHE = "['’]";

/**
 * Bookmaker brands as a reader sees them, for copy that names one without a
 * link. The hostnames are blocked separately (`blockedLinkDomains` in
 * index.ts); a brand that is also an everyday word ("Stake", "Coral",
 * "Pinnacle", "Dabble", "Matchbook", "Fanatics") is caught by its domain only.
 */
const BOOKMAKER_NAMES = [
  'Sportsbet',
  'Ladbrokes',
  'Neds',
  'PointsBet',
  'bet365',
  'Unibet',
  'Betfair',
  'Palmerbet',
  'BlueBet',
  'Betr',
  'PlayUp',
  'TopSport',
  'BetDeluxe',
  'BoomBet',
  'Picklebet',
  'BetRight',
  'Colossalbet',
  'Elitebet',
  'Realbookie',
  'GetSetBet',
  'Southern Cross Bet',
  'William Hill',
  'Paddy Power',
  'Sky Bet',
  'Betfred',
  'Betway',
  '888sport',
  'BoyleSports',
  'BetVictor',
  'Sportingbet',
  'bwin',
  'Betsson',
  'Betano',
  'LiveScore Bet',
  'Smarkets',
  'DraftKings',
  'FanDuel',
  'BetMGM',
  'Caesars Sportsbook',
  'BetRivers',
  'ESPN Bet',
  'Fanatics Sportsbook',
  'Hard Rock Bet',
  'Bet99',
  '1xBet',
  'BetOnline',
  'Bovada',
  'MyBookie',
  'Cloudbet',
  '22Bet',
  'Mostbet',
  'Melbet',
  'Parimatch',
  'Roobet',
] as const;

function namePattern(name: string): string {
  return name.replace(/ /g, '[ -]?');
}

/**
 * A sponsor's name inside a fixed proper noun - "the bet365 Stadium", "the Sky
 * Bet Championship" - names the venue or competition, not a place to bet.
 * A brand inside a hostname ("sportsbet.com.au") is the domain check's to report.
 */
const SPONSORED_NOUN = '(?:Stadium|Arena|Park|Oval|Centre|Ground|Championship|League|Premiership|Cup|Trophy|Series)';

export const PEAKODDS_BOOKMAKER_RULES: readonly PhraseRule[] = [
  {
    label: 'bookmaker',
    pattern: new RegExp(
      `(?<![\\w.])(?:${BOOKMAKER_NAMES.map(namePattern).join('|')})(?![\\w]|\\.\\w|\\s+${SPONSORED_NOUN}\\b)`,
      'gi',
    ),
  },
  // "TAB" in capitals is the Australian and New Zealand totalisator; "tab" is a browser's.
  { label: 'bookmaker', pattern: new RegExp(`(?<![\\w.])TAB(?![\\w]|\\.\\w|\\s+${SPONSORED_NOUN}\\b)`, 'g') },
];

export const PEAKODDS_PHRASE_RULES: PhraseRules = {
  certainty: [
    // Not every "guarantee": "a win guarantees them a home final" is a ladder fact, not a tip.
    {
      label: 'guaranteed',
      pattern:
        /\bguaranteed?\s+(?:to\s+|an?\s+|the\s+)?(?:win|winners?|results?|profits?|returns?|money|success|cash|payouts?|tips?|picks?|bets?|collect)\b/gi,
      negatable: true,
    },
    // "Guaranteed.", "Absolutely guaranteed!", "it's guaranteed", "we guarantee ...".
    {
      label: 'guaranteed',
      pattern: new RegExp(
        `\\bguaranteed(?=\\s*(?:[.!?,;:)]|\\s[-–—]|$))|\\b(?:it|this|that)(?:${APOSTROPHE}s|\\s+is|\\s+was)\\s+guaranteed\\b|\\b(?:we|i)(?:${APOSTROPHE}ll|\\s+can|\\s+will)?\\s+guarantee\\b`,
        'gim',
      ),
      negatable: true,
    },
    { label: 'sure thing / safe bet', pattern: /\b(?:sure|safe)[ -](?:thing|bet|win)s?\b/gi, negatable: true },
    { label: 'dead cert', pattern: /\bdead[ -]?certs?\b/gi },
    // The everyday Australian tip: "the Swans are a certainty", "a cert". "Not a certainty"
    // is the hedge; "the certainty of a home final" is the ladder.
    { label: 'certainty', pattern: /(?<!\bdead[ -])\b(?:certainty|certainties|certs?)\b(?!\s+of\s+(?:an?|making|finishing|reaching|playing|qualifying)\b)/gi, negatable: true },
    { label: 'nailed on', pattern: /\bnailed[ -]on\b/gi, negatable: true },
    { label: 'sure-fire', pattern: /\bsure[ -]?fire\b/gi, negatable: true },
    {
      label: 'bet the house',
      pattern:
        /\bbet(?:ting)? the (?:house|farm|ranch|mortgage|lot)\b|\b(?:put|stake|bet) (?:the|your) (?:house|mortgage) on\b/gi,
      negatable: true,
    },
    { label: 'lock', pattern: /\block(?:s)? of the (?:day|week|round|weekend|season|year)\b/gi },
    { label: 'lock', pattern: /\b(?:an?|absolute|total|mortal|stone-cold) lock\b/gi, negatable: true },
    { label: 'risk-free', pattern: /\brisk[ -]free\b/gi, negatable: true },
    // Advice to the reader, or a claim about this game: "they can't lose tonight",
    // "Swans cannot lose this". Not "Sydney can't lose another game", which is about the ladder.
    {
      label: "can't lose",
      pattern: new RegExp(
        `\\bcan${APOSTROPHE}t-(?:lose|miss)\\b|\\byou can(?:not|${APOSTROPHE}t) (?:lose|miss|go wrong)\\b|` +
          `\\bcan(?:not|${APOSTROPHE}t)\\s+(?:possibly\\s+)?(?:lose|be\\s+beaten)` +
          '(?=\\s*(?:[.!?,;:)]|\\s[-–—]|$)|\\s+(?:this|that|it|tonight|today|tomorrow|here|now|from\\s+here|on|at|against|versus|vs|v)\\b|\\s+the\\s+(?:game|match|clash|final|derby|tie|contest|fixture|decider)\\b)',
        'gim',
      ),
    },
    { label: 'certain to win', pattern: /\b(?:certain|bound|set) to win\b/gi, negatable: true },
    { label: 'will definitely win', pattern: /\bwill (?:definitely|certainly|surely) win\b/gi, negatable: true },
    { label: '100% certain', pattern: /\b100 ?(?:%|per ?cent) (?:certain|sure|safe|guaranteed|winner|win)\b/gi },
    { label: 'no-brainer', pattern: /\bno[ -]brainer\b/gi },
    // A tipster's banker, not "Commonwealth Bank bankers say".
    {
      label: 'banker',
      pattern: new RegExp(
        `\\bbankers?\\s+(?:bets?|picks?|tips?|selections?|legs?|plays?)\\b|\\bbankers? (?:of|for) the (?:day|week|round|weekend|season|year)\\b|\\b(?:my|our|your|today${APOSTROPHE}s|weekend${APOSTROPHE}s|round${APOSTROPHE}s|week${APOSTROPHE}s) bankers?\\b`,
        'gi',
      ),
    },
  ],
  inducement: [
    { label: 'bonus or free bets', pattern: /\b(?:bonus|free)[ -]bets?\b/gi },
    // Any other bonus is a bookmaker's - "claim your bonus", "a 200% bonus" - except a
    // competition's bonus point or round and a player's contract bonus.
    {
      label: 'bonus',
      pattern:
        /(?<!\b(?:signing|performance|appearance|retention|contract|salary|added)[ -])\bbonus(?:es)?\b(?![ -](?:points?|round|ball|bets?|codes?|payments?|clauses?|structures?|scheme)\b)/gi,
    },
    {
      label: 'refund special',
      pattern:
        /\b(?:bet|stake)[ -]refunds?\b|\brefund(?:s|ed)?\b(?=[^.\n]{0,40}\b(?:if|when|should)\b[^.\n]{0,40}\b(?:loses?|lost|losing|runs? second|draws?|miss(?:es)?)\b)/gi,
    },
    {
      label: 'sign-up call to action',
      pattern: new RegExp(
        `\\b(?:sign[ -]?up|join|register)\\s+(?:now|today|here|in minutes|and (?:get|claim|grab|receive))\\b(?!${APOSTROPHE})|` +
          '\\b(?:open|create)\\s+an?\\s+(?:new\\s+)?(?:betting\\s+)?account\\b|' +
          '\\b(?:get|claim|grab|receive|collect)\\s+(?:up\\s+to\\s+)?(?:an?\\s+)?(?:extra\\s+)?(?:(?:A|AU|US|NZ)\\$|[$£€])\\s?\\d+(?:[,.]\\d+)*',
        'gi',
      ),
    },
    {
      label: 'sign-up offer',
      pattern:
        /\b(?:deposit|sign[ -]?up|welcome|joining|new[ -]customer|reload)[ -](?:bonus(?:es)?|offers?|deals?|promos?|specials?)\b/gi,
    },
    {
      label: 'promo code',
      pattern: /\b(?:promo(?:tion(?:al)?)?|bonus|referral|voucher|coupon)[ -]codes?\b/gi,
    },
    { label: 'odds boost', pattern: /\b(?:odds|price|super|profit)[ -]boosts?\b|\bboosted (?:odds|prices?)\b/gi },
    { label: 'money-back special', pattern: /\bmoney[ -]back\b|\bcash[ -]?back\b/gi },
    { label: 'bet credits', pattern: /\bbet(?:ting)?[ -]?credits?\b/gi },
    { label: 'deposit match', pattern: /\bdeposit[ -]match(?:es|ed)?\b|\bmatched[ -]betting\b/gi },
    { label: 'refer-a-friend', pattern: /\brefer[ -]a[ -]friend\b/gi },
  ],
  income: [
    { label: 'betting as income', pattern: /\b(?:passive|second|extra|side|regular|steady|reliable) income\b/gi },
    { label: 'side hustle', pattern: /\bside[ -]hustles?\b/gi },
    { label: 'make a living', pattern: /\bmak(?:e|ing) (?:a|your) living\b/gi },
    { label: 'quit your job', pattern: /\bquit (?:your|the) (?:day )?job\b/gi },
    { label: 'get rich', pattern: /\bget(?:ting)? rich\b/gi },
    { label: 'easy money', pattern: /\b(?:free|easy|quick) money\b/gi },
    { label: 'beat the bookies', pattern: /\bbeat(?:ing)? the (?:bookies|bookmakers)\b/gi },
    {
      label: 'betting framed as earning',
      pattern:
        /\b(?:make|making|earn|earning)\b[^.\n]{0,30}\b(?:money|profits?|income)\b[^.\n]{0,20}\b(?:betting|punting|gambling|wagering|tips)\b/gi,
      negatable: true,
    },
    { label: 'betting as an investment', pattern: /\binvest(?:ment|ing)? (?:in|on) (?:bets?|betting|punting)\b/gi },
  ],
  staking: [
    // Units only as a stake ("stake 2 units", "1.5u on the Swans", "(2u)"), not
    // "won 2 U.S. Opens" or "3 units left in the squad".
    {
      label: 'unit stakes',
      pattern:
        /\b(?:stak(?:e|es|ing)|bet|wager|risk|put|play|back(?:ing)?|lay)\s+\d+(?:\.\d+)?\s?(?:units?\b|u\b(?!\.))|\b\d+(?:\.\d+)?\s?(?:units?|u)\s+(?:on|at|each[ -]way|e\/w|to win)\b|\(\s*\d+(?:\.\d+)?\s?(?:units?|u)\s*\)/gi,
    },
    { label: 'staking plan', pattern: /\b(?:unit|staking) (?:stakes?|plans?|sizes?)\b|\bstake \d/gi },
  ],
  bookmaker: PEAKODDS_BOOKMAKER_RULES,
};
