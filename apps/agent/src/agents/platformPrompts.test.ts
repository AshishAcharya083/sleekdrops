// What a platform other than SleekDrops gets told. The SleekDrops prompts are
// pinned byte for byte in prompts.snapshot.test.ts; this file pins the other
// half of the change - that every brand-specific line follows the platform and
// edition a piece is written for, and that a platform's goal for a stage
// reaches that stage.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.TAVILY_API_KEY;
delete process.env.CLOUDFLARE_ACCOUNT_ID;
delete process.env.CLOUDFLARE_D1_TOKEN;
delete process.env.D1_DATABASE_ID;
process.env.GCS_IMAGES_BUCKET = 'platform-prompts-bucket';

const { UsageTracker } = await import('../llm/index.js');
const { withModelStub } = await import('../llm/modelStub.js');
const context = await import('./context.js');
const { scoutQueries, scoutRequest } = await import('./topicScout.js');
const researcher = await import('./researcher.js');
const { runKeywordStrategist } = await import('./keywordStrategist.js');
const { runAngleEditor } = await import('./angleEditor.js');
const { runOutliner } = await import('./outliner.js');
const { runWriter } = await import('./writer.js');
const { runSeoReviewer } = await import('./seoReviewer.js');
const { runEditor } = await import('./editor.js');
const { runImageAgent } = await import('./imageAgent.js');
const { runAssembler } = await import('./assembler.js');
const { selectShape, shapeRecord, structureBrief } = await import('../content/shapes.js');

import type { StubbedCall } from '../llm/modelStub.js';
import type { AgentId, PlatformSeed } from '../platform/types.js';
import type {
  ArticleRow,
  ContentBrief,
  EditorialAngle,
  KeywordPlan,
  ResearchDossier,
} from '../pipeline/types.js';

const { promptContextFromSeed, siteContext, withAgentGoal } = context;

const AGENTS: AgentId[] = [
  'scout',
  'research',
  'keyword',
  'angle',
  'outline',
  'write',
  'seo_review',
  'edit',
  'image',
];

const seed: PlatformSeed = {
  platform: {
    id: 'testbrand',
    name: 'Testbrand',
    bylineName: 'Testbrand Desk',
    brandText: 'Testbrand (testbrand.example) previews football for a worldwide audience.',
    audience: 'football fans',
    categories: ['AFL', 'NRL'],
    postTypes: ['guide', 'article'],
    articleShapes: ['question-led', 'head-to-head', 'ranked-list'],
    editorialRules: 'Testbrand rules: no promises about any result.',
    monetisation: 'none',
    blockedLinkDomains: [],
    blockedTopics: [],
    scoutQueries: ['platform query'],
    agentGoals: Object.fromEntries(AGENTS.map((agent) => [agent, `Goal for the ${agent} stage.`])),
    publishTarget: {
      d1DatabaseIdEnv: 'TESTBRAND_D1',
      githubRepoEnv: 'TESTBRAND_REPO',
      siteUrlEnv: 'TESTBRAND_URL',
      rebuildHookEnv: null,
    },
  },
  editions: [
    {
      id: 'global',
      name: 'Global',
      timeZone: 'UTC',
      currency: null,
      locale: 'en-GB',
      scoutQueries: ['edition query'],
      complianceFooter: '',
    },
  ],
};
const ctx = promptContextFromSeed(seed, 'global');

/** 06:00 in Sydney on the 13th, 20:00 UTC on the 12th: the edition decides the day. */
const NOW = new Date('2026-07-12T20:00:00.000Z');
const EVENT = '2026-07-18T09:35:00.000Z';

const dossier: ResearchDossier = {
  summary: 'Carlton host Collingwood with both sides in form.',
  facts: [
    {
      fact: 'Carlton have won four in a row.',
      sourceUrl: 'https://www.afl.com.au/news/1',
      tier: 'primary',
      date: '2026-07-10',
      publisher: 'AFL',
    },
  ],
  products: [],
  failureModes: [],
  whoShouldNotBuy: [],
  ownerComplaints: [],
  priceObservations: [],
  testedClaims: [],
  keywords: { primary: 'carlton vs collingwood tips', secondary: [] },
  competitorNotes: '',
  faqIdeas: [],
};

const plan = {
  primaryKeyword: 'carlton vs collingwood tips',
  rationale: 'Thin results.',
  intent: 'Informational',
  difficulty: 'Moderate',
  zeroClickRisk: 'Low',
  serpFeatures: [],
  winningFormat: 'Question-led explainer',
  wordCountTarget: 900,
  secondaryKeywords: [],
  paaQuestions: [],
  entities: [],
  competitors: [],
  contentGaps: [],
  snippetTarget: { question: '', format: 'paragraph', answer: '' },
  currentAiAnswer: '',
  titleOptions: [],
  metaDescription: '',
  rejected: [],
} as KeywordPlan;

const angle = {
  thesis: 'Carlton cover the line.',
  reader: 'A fan picking a line bet.',
  contrarianTake: 'The favourite is overrated.',
  defensible: true,
  weakness: '',
  informationGain: [],
  shape: 'question-led',
  shapeRationale: 'Fans ask questions.',
  byline: 'desk',
  bylineRationale: 'House voice.',
} as EditorialAngle;

const shape = shapeRecord(selectShape({ platform: ctx.platform, postType: 'article', angle }));

const brief = {
  seoTitle: 'Carlton vs Collingwood tips',
  dek: 'Who covers the line.',
  slug: 'carlton-vs-collingwood-tips',
  author: 'desk',
  kind: 'Match preview',
  searchIntent: 'Informational',
  primaryKeyword: 'carlton vs collingwood tips',
  secondaryKeywords: [],
  tags: ['afl'],
  wordCountTarget: 900,
  sections: [{ heading: 'Who wins?', kind: 'question', points: ['form'] }],
  faq: [],
  structureShape: shape,
} as ContentBrief;

const article = (overrides: Partial<ArticleRow> = {}): ArticleRow =>
  ({
    id: '22222222-3333-4444-5555-666666666666',
    platform_id: 'testbrand',
    edition_id: 'global',
    event_starts_at: null,
    topic_id: null,
    title: 'Carlton vs Collingwood tips',
    slug: 'carlton-vs-collingwood-tips',
    category: 'AFL',
    post_type: 'article',
    research: dossier,
    keyword_plan: plan,
    editorial_angle: angle,
    structure_shape: shape,
    outline: brief,
    draft_md: '## Who wins?\n\nCarlton have won four in a row.[1]',
    seo_review: null,
    frontmatter: null,
    affiliate_links: null,
    hero_image_url: null,
    hero_alt: null,
    feedback: null,
    revision_round: 0,
    ...overrides,
  }) as ArticleRow;

const replies: Array<[RegExp, string]> = [
  [/^Plan web research/, '{"primary": ["carlton team news"]}'],
  [/^Synthesize a research dossier/, JSON.stringify(dossier)],
  [/^Propose the search queries/, '{"candidates": ["carlton vs collingwood tips"]}'],
  [/You are a senior SEO strategist/, JSON.stringify(plan)],
  [/You are the commissioning editor/, JSON.stringify(angle)],
  [/Create the SEO content brief/, JSON.stringify(brief)],
  [/^Audit every specific/, '{"claims": [], "notes": ""}'],
  [
    /Return JSON:\n\{"dimensions"/,
    JSON.stringify({
      dimensions: { evidence: 90, position: 90, structure: 90, citability: 90, links: 90 },
      score: 90,
      pass: true,
      issues: [],
      position: { takesStance: true, stance: 'Carlton.', recommendsEverythingEqually: false, picks: [] },
      summary: 'Fine.',
    }),
  ],
];

/** Every call one agent run makes, with the clock at NOW. */
async function callsOf(
  run: () => Promise<unknown>,
  reply: (call: StubbedCall) => string = (call) =>
    replies.find(([pattern]) => pattern.test(call.prompt))?.[1] ?? '{}',
): Promise<StubbedCall[]> {
  const calls: StubbedCall[] = [];
  mock.timers.enable({ apis: ['Date'], now: NOW });
  try {
    await withModelStub(async (call) => {
      calls.push(call);
      if (call.kind === 'image') throw new Error('no image from a stub');
      return reply(call);
    }, run);
  } catch {
    // Whatever the agent made of the stub's replies, the calls are the subject.
  } finally {
    mock.timers.reset();
  }
  assert.ok(calls.length > 0, 'the agent made no model call');
  return calls;
}

/** Text only an Australian edition, or SleekDrops itself, may carry. */
const AUSTRALIAN = /SleekDrops|\bAUD\b|Sydney|Australia|\bAU\b|A\$/;

const tracker = () => new UsageTracker();
const goal = (agent: AgentId) => `Goal for the ${agent} stage.`;

test('siteContext is built from the platform and the edition', () => {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  try {
    const text = siteContext(ctx);
    assert.ok(text.startsWith('Testbrand (testbrand.example) previews football'));
    assert.match(text, /Today's date is 2026-07-12\./, 'the UTC edition is still on the 12th');
    assert.match(text, /Categories: AFL, NRL\./);
    assert.match(text, /Post types the pipeline may produce: guide, article\.\n- guide: .*\n- article: /);
    assert.doesNotMatch(text, /roundup/);
    assert.match(text, /one accountable entity, Testbrand Desk,/);
    assert.doesNotMatch(text, AUSTRALIAN);
  } finally {
    mock.timers.reset();
  }
});

test('a platform goal is appended to a stage, and only to that stage', () => {
  const system = withAgentGoal(ctx, 'write', 'SYSTEM');
  assert.match(system, /^SYSTEM\n\nTESTBRAND GOAL FOR THIS STAGE/);
  assert.ok(system.endsWith(goal('write')));
  const noGoals = { ...ctx, platform: { ...ctx.platform, agentGoals: {} } };
  assert.equal(withAgentGoal(noGoals, 'write', 'SYSTEM'), 'SYSTEM');
});

test('the scout searches the platform queries, then the edition queries', () => {
  assert.deepEqual(scoutQueries(ctx), ['platform query', 'edition query']);
  const request = scoutRequest(ctx, [], '');
  assert.match(request.prompt ?? '', /content topics for Testbrand that are trending/);
  assert.match(request.prompt ?? '', /postType must be one of: guide, article\. category one of: AFL, NRL\./);
  assert.ok(request.system?.endsWith(goal('scout')));
  assert.doesNotMatch(`${request.system}\n${request.prompt}`, AUSTRALIAN);
  assert.match(request.prompt ?? '', /confirm they are current, still available, and not a rerun/);
});

test('every stage tells the model about this platform, with its goal', async () => {
  const runs: Array<[AgentId, () => Promise<unknown>]> = [
    ['research', () => researcher.runResearcher(ctx, article({ research: null }), null, 'm', tracker())],
    ['keyword', () => runKeywordStrategist(ctx, article(), null, 'm', tracker())],
    ['angle', () => runAngleEditor(ctx, article(), null, 'm', tracker())],
    ['outline', () => runOutliner(ctx, article(), 'm', tracker())],
    ['write', () => runWriter(ctx, article(), null, 'm', tracker())],
    ['seo_review', () => runSeoReviewer(ctx, article(), 'm', tracker())],
    ['edit', () => runEditor(ctx, article(), 'm', tracker())],
  ];
  for (const [agent, run] of runs) {
    for (const call of await callsOf(run)) {
      assert.match(call.system ?? '', /^Testbrand \(testbrand\.example\)/, `${agent} system text`);
      assert.ok(call.system?.endsWith(goal(agent)), `${agent} carries its goal`);
      assert.doesNotMatch(`${call.system}\n${call.prompt}`, AUSTRALIAN, agent);
    }
  }
});

test('the hero image prompt carries the image goal', async () => {
  const [call] = await callsOf(() => runImageAgent(ctx, article(), 'm'));
  assert.equal(call.kind, 'image');
  assert.ok(call.prompt.endsWith(goal('image')));
});

test('the angle stage and the outline choose only among the platform shapes', async () => {
  const [call] = await callsOf(() => runAngleEditor(ctx, article(), null, 'm', tracker()));
  assert.match(call.prompt, /"shape": one of "question-led" \| "head-to-head" \| "ranked-list",/);
  assert.doesNotMatch(call.prompt, /verdict-first/);
  assert.match(call.prompt, /The piece publishes as Testbrand Desk whatever you choose/);
  for (const seedId of ['a', 'b', 'c', 'd', 'e']) {
    const picked = selectShape({ platform: ctx.platform, postType: 'newsletter', angle: null, seed: seedId });
    assert.ok(ctx.platform.articleShapes.includes(picked.id), picked.id);
  }
  assert.match(structureBrief(shape, ctx.platform), /stops two\nTestbrand articles sharing a silhouette/);
});

test('an edition with no currency is never asked for one', async () => {
  const research = await callsOf(() =>
    researcher.runResearcher(ctx, article({ research: null }), null, 'm', tracker()),
  );
  const synthesis = research.find((call) => /^Synthesize/.test(call.prompt));
  assert.ok(synthesis);
  assert.match(synthesis.prompt, /before it enters the dossier\. Prices\n  move weekly;/);
  assert.match(synthesis.prompt, /"currency": string \(ISO\),/);

  const [discovery] = await callsOf(() =>
    researcher.runProductDiscovery(ctx, article(), null, 'tips', 'm', tracker()),
  );
  assert.match(discovery.prompt, /- approxPrice is always "": this edition quotes no currency amounts\./);
  assert.doesNotMatch(`${discovery.system}\n${discovery.prompt}`, AUSTRALIAN);
  assert.match(discovery.prompt, /### Search: "best tips"\n/);

  const [writer] = await callsOf(() => runWriter(ctx, article(), null, 'm', tracker()));
  assert.match(writer.prompt, /it is the manufacturer's RRP, labelled "RRP" with the year\./);
});

test('a currency edition writes its own money in the examples', async () => {
  const gbp = { ...ctx, edition: { ...ctx.edition, currency: 'GBP' } };
  const [discovery] = await callsOf(() =>
    researcher.runProductDiscovery(gbp, article(), null, 'tips', 'm', tracker()),
  );
  assert.match(discovery.prompt, /approxPrice is GBP and approximate \("about £2,899"\)/);
});

test('a country edition is told about its own country, not Australia', async () => {
  const uk = {
    ...ctx,
    edition: { ...ctx.edition, id: 'uk', name: 'United Kingdom', currency: 'GBP', locale: 'en-GB' },
  };
  const [keyword] = await callsOf(() => runKeywordStrategist(uk, article(), null, 'm', tracker()));
  assert.match(keyword.prompt, /- British buyers are the audience; include a UK-qualified variant if it is natural\./);
  const [angleCall] = await callsOf(() => runAngleEditor(uk, article(), null, 'm', tracker()));
  assert.match(angleCall.prompt, /worth buying above £300,/);
  assert.match(angleCall.prompt, /"British shoppers aged 25-45"/);
  assert.match(scoutRequest(uk, [], '').prompt ?? '', /actually on sale in the United Kingdom,/);
  for (const call of [keyword, angleCall]) {
    assert.doesNotMatch(`${call.system}\n${call.prompt}`, AUSTRALIAN);
  }
});

test('assembly stamps the edition day, its currency and the platform lists', async () => {
  const assembled = await runAssembler(ctx, article({ draft_md: 'Carlton have won four in a row.' }));
  assert.equal(assembled.frontmatter.pubDate, new Date().toISOString().slice(0, 10));
  assert.equal(Object.hasOwn(assembled.frontmatter, 'currency'), false, 'no currency edition');
  assert.equal(assembled.frontmatter.category, 'AFL');
  await assert.rejects(
    runAssembler(ctx, article({ category: 'Tech' })),
    /frontmatter\.category: "Tech" is not a Testbrand category \(AFL, NRL\)/,
  );
});

// ------------------------------------------------------------ event-bound

const citedDossier = {
  ...dossier,
  priceObservations: [
    {
      product: 'Carlton -6.5',
      value: 1.91,
      currency: 'unknown',
      retailer: 'Oddschecker',
      dateChecked: '2026-07-12',
      sourceUrl: 'https://www.oddschecker.com/afl/carlton-v-collingwood',
      observedAt: '2026-07-12T19:40:00Z',
    },
  ],
  eventStart: {
    startsAt: '2026-07-18T19:35:00+10:00',
    sourceUrl: 'https://www.afl.com.au/fixture',
    observedAt: '2026-07-12T19:30:00+00:00',
  },
};

test('an event-bound piece is researched under the event rules', async () => {
  const calls = await callsOf(
    () =>
      researcher.runResearcher(
        ctx,
        article({ research: null, event_starts_at: EVENT }),
        null,
        'm',
        tracker(),
      ),
    (call) =>
      /^Synthesize/.test(call.prompt) && !/could not be used/.test(call.prompt)
        ? JSON.stringify(dossier)
        : /^Synthesize/.test(call.prompt)
          ? JSON.stringify(citedDossier)
          : '{"primary": ["fixture"]}',
  );
  const [first, retry] = calls.filter((call) => /^Synthesize/.test(call.prompt));
  // The start time in UTC and as the edition's readers tell the time.
  assert.match(
    first.prompt,
    /EVENT-BOUND PIECE\. It previews an event the topic says starts at\n2026-07-18T09:35:00\.000Z \(Saturday,? 18 July 2026 at 09:35 UTC\)/,
  );
  assert.match(first.prompt, /"eventStart": \{"startsAt": string/);
  assert.match(first.prompt, /"sourceUrl": string,\n\s+"observedAt": string \(ISO 8601/);
  // A dossier without the citations is sent back, saying what is missing.
  assert.ok(retry, 'the uncited dossier was reprompted');
  assert.match(retry.prompt, /"eventStart" is required for an event-bound piece/);
});

test('a piece that is not event-bound is not held to the event rules', async () => {
  const calls = await callsOf(() =>
    researcher.runResearcher(ctx, article({ research: null }), null, 'm', tracker()),
  );
  for (const call of calls) assert.doesNotMatch(call.prompt, /EVENT-BOUND|eventStart|observedAt/);
  assert.equal(researcher.dossierCheck('article')(dossier), null);
});

test('the event evidence check names each missing citation', () => {
  assert.deepEqual(researcher.eventEvidenceProblems(citedDossier), []);
  assert.equal(researcher.dossierCheck('article', true)(citedDossier), null);

  const problems = researcher.eventEvidenceProblems({
    ...citedDossier,
    eventStart: { startsAt: '2026-07-18 19:35', sourceUrl: 'javascript:alert(1)', observedAt: '' },
    priceObservations: [
      ...citedDossier.priceObservations,
      { ...citedDossier.priceObservations[0], observedAt: '2026-07-12' },
      { ...citedDossier.priceObservations[0], sourceUrl: '' },
    ],
  });
  assert.equal(problems.length, 4);
  assert.match(problems[0], /eventStart\.startsAt/);
  assert.match(problems[1], /eventStart\.sourceUrl/);
  assert.match(problems[2], /eventStart\.observedAt/);
  assert.match(problems[3], /^2 of 3 priceObservations lack a sourceUrl or an observedAt time/);
});

test('an observation time in the future was not observed', () => {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  try {
    assert.equal(
      researcher.isCitedObservation({ sourceUrl: 'https://odds.example/x', observedAt: '2026-07-12T21:00:00Z' }),
      false,
    );
    assert.equal(
      researcher.isCitedObservation({ sourceUrl: 'https://odds.example/x', observedAt: '2026-07-12T19:59:00Z' }),
      true,
    );
  } finally {
    mock.timers.reset();
  }
});

test('an event-bound piece quotes no approximate price', async () => {
  const problems = researcher.eventEvidenceProblems({
    ...citedDossier,
    products: [
      { name: 'Carlton', brand: '', approxPrice: '$1.91', amazonUrl: null, goSlug: 'carlton', notes: '' },
      { name: 'Collingwood', brand: '', approxPrice: '', amazonUrl: null, goSlug: 'collingwood', notes: '' },
    ],
  });
  assert.deepEqual(problems, [
    '1 product(s) carry an approxPrice - in an event-bound piece a price is quoted only as a cited priceObservation, so approxPrice is ""',
  ]);

  let products: ResearchDossier['products'] = [];
  const [discovery] = await callsOf(
    async () => {
      products = await researcher.runProductDiscovery(
        ctx,
        article({ event_starts_at: EVENT }),
        null,
        'tips',
        'm',
        tracker(),
      );
    },
    () => '{"products": [{"name": "Carlton", "brand": "", "approxPrice": "$1.91", "goSlug": "carlton", "notes": ""}]}',
  );
  assert.match(discovery.prompt, /approxPrice is always "": an event-bound piece quotes a price only where it is cited/);
  assert.deepEqual(products.map((product) => product.approxPrice), ['']);
});

test('a re-sweep keeps only the prices it can cite to the minute', () => {
  const [cited] = citedDossier.priceObservations;
  const kept = researcher.withCitedPricesOnly({
    priceObservations: [cited, { ...cited, observedAt: undefined }],
  });
  assert.deepEqual(kept.priceObservations, [cited]);
  assert.deepEqual(researcher.withCitedPricesOnly({ facts: [] }), { facts: [] });
});
