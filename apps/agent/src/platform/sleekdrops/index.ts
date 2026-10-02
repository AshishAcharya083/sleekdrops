// SleekDrops' seed: the brand text, categories, formats, scout queries and
// editorial rules every SleekDrops prompt is built from, verbatim from the
// prompts that carried them before there was more than one platform. Migration
// 018 writes the same values to the `platforms` row; after that the database
// copy is the one that is edited and versioned.
import type { POST_TYPES } from '../../content/contract.js';
import type { ArticleShape } from '../../pipeline/types.js';
import type { PlatformSeed } from '../types.js';

export const SLEEKDROPS_PLATFORM_ID = 'sleekdrops';

// Typed against the catalogues so a renamed or removed id fails the build
// rather than a prompt.
const POST_TYPE_IDS: Array<(typeof POST_TYPES)[number]> = ['article', 'guide', 'roundup'];
const ARTICLE_SHAPE_IDS: ArticleShape[] = [
  'verdict-first',
  'segmented-buyers',
  'head-to-head',
  'failure-led',
  'cost-of-ownership',
  'question-led',
  'ranked-list',
];

export const sleekdropsSeed: PlatformSeed = {
  platform: {
    id: SLEEKDROPS_PLATFORM_ID,
    name: 'SleekDrops',
    bylineName: 'SleekDrops Editorial Team',
    brandText: `SleekDrops (sleekdrops.com) is an editorial affiliate blog: "exclusive deals
dropping daily".`,
    audience: `Primary audience: Australian shoppers (prices in AUD, Amazon
Australia availability matters); write in plain international English.`,
    categories: ['Tech', 'Home', 'Fashion', 'Health', 'Finance', 'Travel'],
    postTypes: POST_TYPE_IDS,
    articleShapes: ARTICLE_SHAPE_IDS,
    editorialRules: `
Editorial rules (non-negotiable):
- Honest, useful, specific. Every recommendation names real trade-offs; a cons
  list is never empty. Decimal ratings like 4.3 — never star spam.
- Plain, direct voice. No emoji, no hype, no urgency copy ("HURRY!", "act now").
- Evidence only: never invent specs, prices, or Amazon URLs. If a fact isn't in
  the research dossier, leave it out or hedge explicitly.
- Prices: never print an Amazon price. Amazon's Associates policies only allow
  prices pulled live from Amazon's own API, which we do not have, so a number
  we type is a policy breach the day the price moves. Write "check the current
  price on Amazon" instead. Where a figure is essential to the argument, use
  the manufacturer's RRP, labelled "RRP" with its source and year — never a
  marketplace price, never "$X on Amazon", never "priced in AUD and checked on".
- Affiliate links: NEVER write a raw merchant URL in the body. Every product
  link is written as /go/<kebab-product-slug> (e.g. /go/sony-wh-1000xm6).
  The same product always reuses the same /go/ slug.
- Disclose honestly: if we haven't lab-tested the products, say the piece is an
  editorial synthesis of specs, owner reviews, and expert coverage. The site
  carries a standing methodology page and an AI-assistance disclosure, both
  linked from every article, so the body never has to stand in for them - and
  never overstates them. Never write "we tested", "our testers", "in our
  testing", "we tried", "hands-on" or anything else that claims use of a
  product nobody here has touched.
- Structure for scanability: short paragraphs, descriptive H2/H3 headings,
  comparison tables for multi-product pieces. Say what the piece rests on -
  which evidence, what was excluded - where the piece's shape puts it, and
  under that shape's own heading. "How we picked" is not a section every
  article owes the reader.
`.trim(),
    monetisation: 'amazon',
    blockedLinkDomains: [],
    blockedTopics: [],
    // Platform-level, in the order the scout has always run them. The
    // Australia edition adds none of its own, so the combined list is unchanged.
    scoutQueries: [
      'trending products Australia this week',
      'best selling gadgets this month',
      'viral home products people are buying right now',
      'trending health and wellness products this month',
      'what products are trending on social media right now Australia',
      'new product releases worth buying this month',
    ],
    // Each agent's goal is still the one its own prompt states.
    agentGoals: {},
    publishTarget: {
      d1DatabaseIdEnv: 'D1_DATABASE_ID',
      githubRepoEnv: 'GITHUB_REPO',
      siteUrlEnv: 'SITE_URL',
      // The rebuild is a repository_dispatch to GITHUB_REPO, not a hook URL.
      rebuildHookEnv: null,
    },
  },
  editions: [
    {
      id: 'au',
      name: 'Australia',
      timeZone: 'Australia/Sydney',
      currency: 'AUD',
      locale: 'en-AU',
      scoutQueries: [],
      complianceFooter: '',
    },
  ],
};
