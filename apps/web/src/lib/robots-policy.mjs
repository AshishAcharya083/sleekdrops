/**
 * The crawl policy this site publishes, and the parse a crawler performs on it.
 *
 * Until now robots.txt carried a single `User-agent: *` group, which happens to
 * let every AI crawler in without ever saying so. That is a policy by accident:
 * nothing in the file states whether GPTBot, ClaudeBot or Google-Extended may
 * read the articles, so anyone auditing the site - or any operator honouring a
 * per-agent opt-out - has to infer it. The groups below say it outright.
 *
 * The rule for every named agent is the same as the wildcard: the editorial
 * pages are open, `/api/` and `/go/` are not. `/go/<slug>` is the affiliate
 * redirect hop - there is no content behind it, only a 302 to a merchant with
 * our tag on it - so it is worth nothing to a retrieval agent and worth a
 * crawl-budget hole and a pile of untagged referrals to us. Under RFC 9309 a
 * crawler obeys the MOST SPECIFIC group that names it and ignores the wildcard
 * entirely, so a named group has to repeat the whole policy; leaving the
 * disallows out of it would have *opened* /go/ to exactly the agents this
 * change was meant to be explicit with. `matchRules`/`isAllowed` below perform
 * that resolution, so the contract can be asserted over the emitted file rather
 * than over the arrays it was built from (see robots-policy.test.ts).
 *
 * Plain ESM because `scripts/generate-robots.mjs` imports it as bare node
 * before the build, the same constraint `sitemap-policy.mjs` has with
 * `astro.config.mjs`.
 */

/** Paths no deployment wants crawled: the redirect hop and any API surface. */
export const DISALLOWED_PATHS = ['/api/', '/go/'];

/**
 * The AI crawlers and answer engines named explicitly, grouped by operator so
 * the file reads as a policy rather than a token dump.
 *
 * Search crawlers proper (Googlebot, Bingbot, Applebot) are deliberately absent
 * - they are covered by the wildcard, and naming them here would only create a
 * second place to keep the same rules. `Google-Extended` and
 * `Applebot-Extended` are not crawlers at all but the opt-in/out tokens Google
 * and Apple read for Gemini and Apple Intelligence; listing them with `Allow: /`
 * is how this site says yes to being used in an AI answer.
 */
export const AI_AGENT_GROUPS = [
  { operator: 'OpenAI', tokens: ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User'] },
  { operator: 'Anthropic', tokens: ['ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'anthropic-ai'] },
  { operator: 'Google (Gemini grounding and training)', tokens: ['Google-Extended'] },
  { operator: 'Apple Intelligence', tokens: ['Applebot-Extended'] },
  { operator: 'Perplexity', tokens: ['PerplexityBot', 'Perplexity-User'] },
  { operator: 'Meta AI', tokens: ['Meta-ExternalAgent', 'Meta-ExternalFetcher'] },
  { operator: 'Common Crawl (the corpus most models train on)', tokens: ['CCBot'] },
  { operator: 'Amazon', tokens: ['Amazonbot'] },
  { operator: 'ByteDance', tokens: ['Bytespider'] },
  { operator: 'DuckDuckGo', tokens: ['DuckAssistBot'] },
  { operator: 'Mistral', tokens: ['MistralAI-User'] },
  { operator: 'Cohere', tokens: ['cohere-ai', 'cohere-training-data-crawler'] },
  { operator: 'You.com', tokens: ['YouBot'] },
];

/** Every explicitly named agent token, in the order the file lists them. */
export const AI_AGENT_TOKENS = AI_AGENT_GROUPS.flatMap((group) => group.tokens);

/** The rules every group carries: the content is open, the two paths are not. */
function policyLines() {
  return ['Allow: /', ...DISALLOWED_PATHS.map((path) => `Disallow: ${path}`)];
}

/**
 * The robots.txt this build publishes.
 *
 * @param {object} input
 * @param {'production'|'preview'} input.deployment which deployment this is
 * @param {string} input.siteUrl canonical site URL, no trailing slash
 * @param {boolean} [input.hasContentMap] whether this build wrote /llms.txt
 * @param {string} [input.marker] leading comment identifying the generator
 */
export function buildRobotsTxt({ deployment, siteUrl, hasContentMap = false, marker }) {
  const isProduction = deployment === 'production';
  const site = siteUrl.replace(/\/+$/, '');

  const header = isProduction
    ? []
    : [
        '# PREVIEW DEPLOYMENT - not the live site.',
        '#',
        '# Every page here also carries <meta name="robots" content="noindex, nofollow">,',
        '# and that is what keeps this build out of the index. Crawling is deliberately',
        '# not blocked: a page a crawler cannot fetch is a page whose noindex it cannot',
        '# see, which would preserve anything already indexed instead of removing it.',
        '#',
      ];

  // Both pointers name an absolute URL, so both are held to the same rule as the
  // sitemap line: only a production build serves the host SITE_URL names.
  const contentMap =
    isProduction && hasContentMap
      ? [
          '# Curated map of what this site knows, for retrieval agents:',
          `#   ${site}/llms.txt       - the strongest articles, one line each`,
          `#   ${site}/llms-full.txt  - the same articles with fuller summaries`,
          '#',
        ]
      : [];

  const aiPolicy = [
    '',
    '# AI crawlers and answer engines, named explicitly rather than left to the',
    '# wildcard above. Same policy: the articles are open, /api/ and /go/ are not.',
    '# /go/<slug> is an affiliate redirect - a 302 to a merchant, no content of its',
    '# own - so there is nothing there to read and nothing we want read.',
    '#',
    '# One group: a crawler obeys the most specific group that names it and ignores',
    '# the wildcard, so these rules are the whole policy for every agent listed.',
    ...AI_AGENT_GROUPS.flatMap((group) => [
      `# ${group.operator}`,
      ...group.tokens.map((token) => `User-agent: ${token}`),
    ]),
    ...policyLines(),
  ];

  const sitemap = isProduction ? ['', `Sitemap: ${site}/sitemap-index.xml`] : [];

  return [
    ...(marker ? [marker] : []),
    `# Source: PUBLIC_SITE_ENV=${isProduction ? 'production' : 'preview'} for this build.`,
    '# Do NOT edit by hand - your changes will be overwritten on the next build.',
    '#',
    ...header,
    ...contentMap,
    '# Everything not named below reads this group, unchanged from what it has',
    '# always said: the site is open, the API surface and the affiliate hop are not.',
    'User-agent: *',
    ...policyLines(),
    ...aiPolicy,
    ...sitemap,
    '',
  ].join('\n');
}

/**
 * The groups in a robots.txt, in file order. Comments and blank lines are
 * dropped; consecutive `User-agent` lines with no rule between them are one
 * group, which is what makes the block above a single policy.
 */
function parseGroups(robotsTxt) {
  const groups = [];
  let current = null;
  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const field = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!field) continue;
    const name = field[1].toLowerCase();
    const value = field[2].trim();
    if (name === 'user-agent') {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (name === 'allow' || name === 'disallow') {
      current?.rules.push({ allow: name === 'allow', path: value });
    }
  }
  return groups;
}

/**
 * The rules a crawler calling itself `userAgent` would follow: its own group if
 * the file names it, otherwise the wildcard, otherwise nothing at all. Token
 * comparison is case-insensitive, per RFC 9309.
 */
export function matchRules(robotsTxt, userAgent) {
  const token = userAgent.toLowerCase();
  const groups = parseGroups(robotsTxt);
  const named = groups.filter((group) => group.agents.includes(token));
  const source = named.length > 0 ? named : groups.filter((group) => group.agents.includes('*'));
  return {
    token: named.length > 0 ? token : source.length > 0 ? '*' : null,
    rules: source.flatMap((group) => group.rules),
  };
}

/**
 * Whether `path` is crawlable by `userAgent` under this robots.txt. Longest
 * matching rule wins and a tie goes to `Allow`, per RFC 9309; matching is plain
 * prefix matching, which is all this file ever emits.
 */
export function isAllowed(robotsTxt, userAgent, path) {
  let winner = null;
  for (const rule of matchRules(robotsTxt, userAgent).rules) {
    if (rule.path === '' || !path.startsWith(rule.path)) continue;
    if (!winner || rule.path.length > winner.path.length || (rule.path.length === winner.path.length && rule.allow)) {
      winner = rule;
    }
  }
  return winner ? winner.allow : true;
}
