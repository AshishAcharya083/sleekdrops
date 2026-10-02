// PeakOdds: independent editorial sports-betting content for an Australian and
// a neutral Global audience. Static editorial only - match previews, round
// roundups, player and award markets, explainers and guides. Nothing here
// depends on a live odds feed, and nothing earns from a bookmaker.
//
// Out of scope, and why, so the next edit does not quietly add one back:
// bookmaker reviews, "best betting site" lists and promo-code pages are paid
// for by referrals and promote inducements; calculators are interactive tools
// for the site, not articles; futures and market-mover pieces go stale the
// moment the price moves; racing needs form data and late scratchings change
// the field; Same Game Multi builders push a high-risk bookmaker product.
import { AU_FOOTER, GLOBAL_FOOTER } from './footers.js';
import { PEAKODDS_SHAPES } from './formats.js';
import type { PlatformSeed } from './contractTypes.js';

export const PEAKODDS_PLATFORM_ID = 'peakodds';

/**
 * Bare hostnames; a subdomain of one is blocked too. Licensed Australian
 * wagering operators, the major UK, US and NZ books, exchanges, and the
 * offshore operators most often linked to Australians. `complianceProblems`
 * (content/compliance.ts) rejects any article that links or names one of them.
 */
const BOOKMAKER_DOMAINS = [
  // Australia
  'sportsbet.com.au',
  'tab.com.au',
  'ladbrokes.com.au',
  'neds.com.au',
  'pointsbet.com.au',
  'bet365.com.au',
  'unibet.com.au',
  'betfair.com.au',
  'palmerbet.com',
  'bluebet.com.au',
  'betr.com.au',
  'playup.com.au',
  'topsport.com.au',
  'betdeluxe.com.au',
  'boombet.com.au',
  'dabble.com.au',
  'picklebet.com',
  'betright.com.au',
  'colossalbet.com.au',
  'elitebet.com.au',
  'realbookie.com.au',
  'getsetbet.com.au',
  'southerncrossbet.com.au',
  // New Zealand
  'tab.co.nz',
  // UK and Europe
  'bet365.com',
  'betfair.com',
  'williamhill.com',
  'paddypower.com',
  'skybet.com',
  'ladbrokes.com',
  'coral.co.uk',
  'betfred.com',
  'betway.com',
  'unibet.com',
  'unibet.co.uk',
  '888sport.com',
  'boylesports.com',
  'betvictor.com',
  'sportingbet.com',
  'bwin.com',
  'betsson.com',
  'betano.com',
  'livescorebet.com',
  'smarkets.com',
  'matchbook.com',
  // US
  'draftkings.com',
  'fanduel.com',
  'betmgm.com',
  'sportsbook.caesars.com',
  'betrivers.com',
  'espnbet.com',
  'sportsbook.fanatics.com',
  'hardrock.bet',
  'bet99.com',
  // Offshore and crypto operators
  'pinnacle.com',
  'stake.com',
  'sportsbet.io',
  '1xbet.com',
  'betonline.ag',
  'bovada.lv',
  'mybookie.ag',
  'cloudbet.com',
  '22bet.com',
  'mostbet.com',
  'melbet.com',
  'parimatch.com',
  'roobet.com',
  'bc.game',
] as const;

const EDITORIAL_RULES = `
Editorial rules (non-negotiable, every edition):
- 18+ only. Write for adults who already bet. Nothing aimed at, styled for or
  likely to appeal to anyone under 18: no school, youth or cartoon framing, no
  child or teenage athletes as the hook.
- No bookmaker is ever recommended, ranked, named as a place to bet or linked.
  Where a source is a bookmaker's own page, it is not a source: a price that
  only a bookmaker's page shows is left out, along with the pick it priced.
- Prices are cited only from odds-comparison or news sources, as indicative
  decimal odds (e.g. 1.85) with the time they were seen and an explicit time
  zone, and are always described as subject to change. Never fractional or
  American odds, never a dollar sign in front of a price.
- No inducements, ever: no bonus bets, free bets, deposit or sign-up offers,
  promo codes, odds boosts, cash-back, money-back or refund specials,
  refer-a-friend offers, "sign up" or "join now" calls - not as a
  recommendation, not as a passing mention. Do not use the word "bonus" at all,
  except for a competition's bonus point.
- No offshore or unlicensed operator is ever mentioned as somewhere to bet.
- Betting is never framed as income, an investment, a side hustle or a way to
  make money, and never as a way to recover losses.
- No certainty language: nothing is a "lock", a "sure thing", a "certainty" or
  "cert", "nailed on", "sure-fire", "guaranteed", "risk-free", a "banker" or
  "can't lose", and nobody should "bet the house". Every pick is a judgement
  that can be wrong, and the copy says so in plain words.
- No unit stakes, staking plans or bet sizes. No Same Game Multi builders, no
  multi or parlay suggestions.
- Every time is written with an explicit time zone. Every start time and every
  price carries the source it came from.
- Do not write a responsible-gambling notice, helpline or 18+ line: the site
  appends the one for this edition to every article.
- Plain, direct voice. No hype, no urgency ("get on now", "before it's gone"),
  no emoji.
`.trim();

export const peakoddsSeed: PlatformSeed = {
  platform: {
    id: PEAKODDS_PLATFORM_ID,
    name: 'PeakOdds',
    bylineName: 'PeakOdds Editorial Team',
    brandText: `PeakOdds is an independent editorial sports-betting site: match previews, round
roundups, player and award markets, and plain-English explainers, built on the
reasoning rather than the hype. It takes no bookmaker money - no affiliate
links, no sign-up offers, no promotions of any kind - so no pick is there
because someone paid for it.`,
    audience:
      'Adults 18+ who follow team and individual sports and already bet, in Australia and worldwide. Never aimed at anyone under 18.',
    categories: [
      'AFL',
      'NRL',
      'Cricket',
      'Football',
      'Rugby Union',
      'Basketball',
      'Tennis',
      'Golf',
      'NFL',
      'Combat Sports',
    ],
    postTypes: ['article', 'guide', 'preview'],
    articleShapes: [...PEAKODDS_SHAPES.map((shape) => shape.id), 'question-led'],
    editorialRules: EDITORIAL_RULES,
    monetisation: 'none',
    blockedLinkDomains: BOOKMAKER_DOMAINS,
    blockedTopics: ['racing'],
    scoutQueries: [
      'major sporting fixtures this weekend team news and injuries',
      'player award markets favourites this season',
      'sports betting explainer questions punters ask',
    ],
    agentGoals: {
      scout:
        'Find upcoming team and individual sport fixtures, rounds and player or award markets worth a preview, each with a confirmed start time from a dated source. Never racing, never futures or market movers, never bookmaker reviews, promotions or calculators.',
      research:
        'Cite a source for the start time and for every price, with the time the price was seen. Take prices only from odds-comparison or news sources; drop any price a bookmaker page alone shows.',
      keyword:
        'Target the queries a punter types before a game ("<team> v <team> tips", "<round> preview"), never bookmaker, bonus or promo-code queries.',
      angle:
        'Find the one fact the market may be underrating, and say plainly how it could be wrong.',
      outline:
        'Follow the shape exactly; for a preview the picks table has only Market, Selection, Indicative odds (decimal) and As at.',
      write:
        'Explain the reasoning behind each pick in plain words, hedge every call, and never use certainty or staking language.',
      seo_review:
        'Check the start time, every price and its As at time against the dossier, and that no bookmaker is named or linked.',
      edit:
        'Strip any certainty, inducement, staking or income language and any bookmaker mention; keep every price decimal with its time and zone.',
      assemble:
        'Reject the article on any bookmaker link, certainty phrase or inducement term, then append the edition footer.',
      image:
        'Use a neutral sports image with no bookmaker branding, odds boards or anyone who could be under 18.',
    },
    publishTarget: {
      d1DatabaseIdEnv: 'PEAKODDS_D1_DATABASE_ID',
      githubRepoEnv: 'PEAKODDS_GITHUB_REPO',
      siteUrlEnv: 'PEAKODDS_SITE_URL',
      rebuildHookEnv: 'PEAKODDS_REBUILD_HOOK_URL',
    },
  },
  editions: [
    {
      id: 'au',
      name: 'Australia',
      timeZone: 'Australia/Sydney',
      currency: 'AUD',
      locale: 'en-AU',
      scoutQueries: [
        'AFL news and fixtures this week',
        'NRL news and fixtures this week',
        'A-League Men fixtures this weekend team news',
        'Australian cricket fixtures this week squads',
        'Super Rugby Pacific and Wallabies fixtures this week',
        'NBL fixtures this week',
        'Brownlow Medal and Dally M award markets',
      ],
      complianceFooter: AU_FOOTER,
    },
    {
      id: 'global',
      name: 'Global',
      timeZone: 'UTC',
      currency: null,
      locale: 'en-GB',
      scoutQueries: [
        'Premier League fixtures this weekend team news',
        'UEFA Champions League matchday preview injuries',
        'NFL week preview injury report',
        'NBA games this week injury report',
        'ATP and WTA tournament this week draw',
        'golf tournament this week field and form',
        'international cricket series this week squads',
        'rugby union test fixtures this month',
      ],
      complianceFooter: GLOBAL_FOOTER,
    },
  ],
};
