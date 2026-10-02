// Every SleekDrops agent prompt, pinned byte for byte.
//
// Each case drives a real agent entry point with fixed inputs, a fixed clock
// and a model stub that records what the agent sent - system text and prompt -
// instead of calling an engine. The recording is compared with a fixture under
// __snapshots__/prompts/. The fixtures were captured before prompts became
// platform-aware, so a difference here is a change to what SleekDrops' agents
// are told, not a refactor.
//
// Regenerate deliberately, and read the diff: UPDATE_PROMPT_SNAPSHOTS=1.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// No search, no D1 and no image upload: every external read fails fast and the
// agents fall through to their empty-evidence paths, which is deterministic.
delete process.env.TAVILY_API_KEY;
delete process.env.CLOUDFLARE_ACCOUNT_ID;
delete process.env.CLOUDFLARE_D1_TOKEN;
delete process.env.D1_DATABASE_ID;
process.env.GCS_IMAGES_BUCKET = 'prompt-snapshot-bucket';

const { UsageTracker } = await import('../llm/index.js');
const { withModelStub } = await import('../llm/modelStub.js');
const { promptContextFromSeed } = await import('./context.js');
const { scoutRequest } = await import('./topicScout.js');
const { runProductDiscovery, runResearcher } = await import('./researcher.js');
const { runKeywordStrategist } = await import('./keywordStrategist.js');
const { runAngleEditor } = await import('./angleEditor.js');
const { runOutliner } = await import('./outliner.js');
const { runWriter } = await import('./writer.js');
const { runSeoReviewer } = await import('./seoReviewer.js');
const { runEditor } = await import('./editor.js');
const { runImageAgent } = await import('./imageAgent.js');
const { selectShape, shapeRecord } = await import('../content/shapes.js');
const { sleekdropsSeed } = await import('../platform/sleekdrops/index.js');

import type { StubbedCall } from '../llm/modelStub.js';
import type {
  ArticleRow,
  ContentBrief,
  EditorialAngle,
  KeywordPlan,
  ResearchDossier,
  TopicRow,
} from '../pipeline/types.js';

const SNAPSHOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '__snapshots__', 'prompts');
const UPDATE = process.env.UPDATE_PROMPT_SNAPSHOTS === '1';
const MODEL = 'snapshot-model';
const ctx = promptContextFromSeed(sleekdropsSeed, 'au');

/** 12:00 in Sydney, so the audience's day and the server's day agree. */
const NOW = new Date('2026-07-13T02:00:00.000Z');

const dossier: ResearchDossier = {
  summary:
    'Cordless stick vacuums under A$800 split on battery longevity rather than suction. The Dyson V15 leads on measured suction, the Shark Detect Pro on value.',
  facts: [
    {
      fact: 'The Dyson V15 Detect is rated at 240AW of suction.',
      sourceUrl: 'https://www.dyson.com.au/v15-detect',
      tier: 'primary',
      date: '2026-03',
      publisher: 'Dyson',
    },
    {
      fact: 'Choice measured 61 minutes of run time on the Shark Detect Pro in eco mode.',
      sourceUrl: 'https://www.choice.com.au/stick-vacuums',
      tier: 'expert',
      date: '2026-05',
      publisher: 'Choice',
    },
  ],
  products: [
    {
      name: 'Dyson V15 Detect',
      brand: 'Dyson',
      approxPrice: 'about A$1,249',
      amazonUrl: 'https://www.amazon.com.au/dp/B09XYZ1234',
      goSlug: 'dyson-v15-detect',
      notes: 'Best measured suction.',
    },
    {
      name: 'Shark Detect Pro',
      brand: 'Shark',
      approxPrice: 'about A$799',
      amazonUrl: null,
      goSlug: 'shark-detect-pro',
      notes: 'Longest eco run time.',
    },
  ],
  failureModes: [
    {
      product: 'Dyson V15 Detect',
      failure: 'Battery capacity drops noticeably',
      timeframe: 'after 18-24 months',
      sourceUrl: 'https://www.productreview.com.au/listings/dyson-v15-detect',
      tier: 'owner',
    },
  ],
  whoShouldNotBuy: [
    {
      audience: 'Homes that are mostly thick carpet',
      reason: 'Run time on boost mode is under 10 minutes on both, per Choice.',
      sourceUrl: 'https://www.choice.com.au/stick-vacuums',
    },
  ],
  ownerComplaints: [
    {
      product: 'Shark Detect Pro',
      complaint: 'Brush roll jams on long hair',
      volume: 'recurring',
      recency: '2026',
      denominator: '41 of 388 reviews',
      kind: 'aggregate',
      sourceUrl: 'https://www.productreview.com.au/listings/shark-detect-pro',
    },
  ],
  priceObservations: [
    {
      product: 'Shark Detect Pro',
      value: 799,
      currency: 'AUD',
      retailer: 'JB Hi-Fi',
      dateChecked: '2026-07-10',
      sourceUrl: 'https://www.jbhifi.com.au/products/shark-detect-pro',
    },
  ],
  testedClaims: [
    {
      claim: 'Shark Detect Pro ran 61 minutes in eco mode',
      source: 'Choice',
      year: 2026,
      sourceUrl: 'https://www.choice.com.au/stick-vacuums',
    },
  ],
  keywords: { primary: 'best cordless stick vacuum', secondary: ['stick vacuum australia'] },
  competitorNotes: 'Top pages list specs and skip battery longevity.',
  faqIdeas: [{ question: 'How long do stick vacuum batteries last?', answerHint: '18-24 months' }],
};

const plan: KeywordPlan = {
  primaryKeyword: 'best cordless stick vacuum australia',
  rationale: 'Top results are thin on battery longevity.',
  intent: 'Commercial Investigation',
  difficulty: 'Moderate',
  zeroClickRisk: 'Low',
  serpFeatures: ['People Also Ask'],
  winningFormat: 'Buyer segments guide',
  wordCountTarget: 1800,
  secondaryKeywords: ['stick vacuum battery life'],
  paaQuestions: ['How long do cordless vacuums last?'],
  entities: ['Dyson V15 Detect', 'Shark Detect Pro', 'Choice'],
  competitors: [
    {
      url: 'https://example.com/best-stick-vacuums',
      format: 'listicle',
      angle: 'spec roundup',
      strength: 'breadth',
    },
  ],
  contentGaps: ['Battery replacement cost'],
  snippetTarget: {
    question: 'What is the best cordless stick vacuum in Australia?',
    format: 'paragraph',
    answer: 'The Shark Detect Pro for most homes.',
  },
  currentAiAnswer: 'Dyson V15 is usually recommended.',
  titleOptions: ['Best cordless stick vacuums in Australia (2026)'],
  metaDescription: 'Which cordless stick vacuum lasts.',
  rejected: [{ keyword: 'dyson v15', reason: 'brand-only query' }],
};

const angle: EditorialAngle = {
  thesis: 'Battery longevity, not suction, decides which stick vacuum is worth buying.',
  reader: 'Someone in a two-bedroom flat with mostly hard floors.',
  contrarianTake: 'The cheaper Shark outlasts the Dyson on owner evidence.',
  defensible: true,
  weakness: '',
  informationGain: [
    {
      claim: 'Battery replacement cost over three years',
      absentFrom: 'https://example.com/best-stick-vacuums',
      evidence: '41 of 388 owner reviews',
    },
  ],
  shape: 'segmented-buyers',
  shapeRationale: 'The pick changes with floor type.',
  byline: 'home',
  bylineRationale: 'A live-with-it question.',
};

const article = (overrides: Partial<ArticleRow> = {}): ArticleRow =>
  ({
    id: '11111111-2222-3333-4444-555555555555',
    topic_id: '99999999-8888-7777-6666-555555555555',
    title: 'Best cordless stick vacuums',
    slug: 'best-cordless-stick-vacuums',
    category: 'Home',
    post_type: 'guide',
    stage: 'research',
    status: 'running',
    revision_round: 0,
    research: dossier,
    keyword_plan: plan,
    editorial_angle: angle,
    structure_shape: null,
    outline: null,
    draft_md: null,
    seo_review: null,
    frontmatter: null,
    affiliate_links: null,
    hero_image_url: null,
    hero_alt: null,
    hero_image_source: null,
    feedback: null,
    error: null,
    claimed_by: null,
    claimed_at: null,
    heartbeat_at: null,
    lease_expires_at: null,
    lease_requeues: 0,
    attempt: 1,
    stale_from_stage: null,
    pub_date: null,
    published_digest: null,
    published_at: null,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    ...overrides,
  }) as ArticleRow;

const topic: TopicRow = {
  id: '99999999-8888-7777-6666-555555555555',
  title: 'Best cordless stick vacuums',
  category: 'Home',
  post_type: 'guide',
  angle: 'Battery longevity over suction',
  keywords: ['cordless stick vacuum', 'stick vacuum battery'],
  why_trending: 'EOFY sales.',
  sources: ['https://www.choice.com.au/stick-vacuums'],
  status: 'approved',
  source: 'manual',
  instructions: 'Lead with battery replacement cost.',
  research_notes: [{ name: 'notes.md', content: 'Shark battery packs cost A$129.' }],
  hero_image_url: null,
  hero_alt: null,
} as TopicRow;

// As the outliner records it on the brief and the article.
const shape = shapeRecord(
  selectShape({ platform: ctx.platform, postType: 'guide', angle, winningFormat: plan.winningFormat }),
);

const brief: ContentBrief = {
  seoTitle: 'Best cordless stick vacuums in Australia (2026)',
  dek: 'Which stick vacuum lasts, by floor type.',
  slug: 'best-cordless-stick-vacuums',
  author: 'home',
  kind: 'Buying guide',
  searchIntent: 'Commercial Investigation',
  primaryKeyword: 'best cordless stick vacuum australia',
  secondaryKeywords: ['stick vacuum battery life'],
  tags: ['vacuums'],
  wordCountTarget: 1800,
  sections: [{ heading: 'Hard floors', kind: 'segment', points: ['Shark Detect Pro'] }],
  faq: [{ question: 'How long do stick vacuum batteries last?' }],
  structureShape: shape,
} as ContentBrief;

const draft = `## Hard floors

The [Shark Detect Pro](/go/shark-detect-pro) ran 61 minutes in eco mode.[1]

## FAQ

### How long do stick vacuum batteries last?

Owners report 18-24 months.`;

const replies: Array<[RegExp, string]> = [
  [/You are the Topic Scout/, '{"topics": []}'],
  [/^Plan web research/, '{"primary": ["dyson v15 specs"], "expert": ["choice stick vacuum test"]}'],
  [/^Synthesize a research dossier/, JSON.stringify(dossier)],
  [/^Propose the search queries/, '{"candidates": ["best cordless stick vacuum australia"]}'],
  [/You are a senior SEO strategist/, JSON.stringify(plan)],
  [/You are the commissioning editor/, JSON.stringify(angle)],
  [/Create the SEO content brief/, JSON.stringify(brief)],
  [/^Grade one thing, hard/, '{"additions": [], "missing": [], "verdict": "on par"}'],
  [/^Audit every specific/, '{"claims": [], "notes": ""}'],
  [
    /Return JSON:\n\{"dimensions"/,
    JSON.stringify({
      dimensions: { evidence: 85, position: 85, structure: 85, citability: 85, links: 85 },
      score: 85,
      pass: true,
      issues: [],
      position: {
        takesStance: true,
        stance: 'The Shark outlasts the Dyson.',
        recommendsEverythingEqually: false,
        picks: [],
        notes: '',
      },
      summary: 'Solid.',
    }),
  ],
  [/products/i, '{"products": []}'],
];

function stubbed(calls: StubbedCall[]) {
  return async (call: StubbedCall): Promise<string> => {
    calls.push(call);
    if (call.kind === 'image') throw new Error('stubbed image model returns no image');
    return replies.find(([pattern]) => pattern.test(call.prompt))?.[1] ?? '{}';
  };
}

function render(calls: StubbedCall[], outcome: string): string {
  const blocks = calls.map((call, i) =>
    [
      `=== call ${i + 1}: ${call.kind} model=${call.model} temperature=${call.temperature ?? '-'} ` +
        `maxTokens=${call.maxTokens ?? '-'} json=${call.jsonMode ?? false} search=${call.search ?? false}`,
      '--- system',
      call.system ?? '',
      '--- prompt',
      call.prompt,
    ].join('\n'),
  );
  return `${blocks.join('\n\n')}\n\n=== outcome: ${outcome}\n`;
}

async function capture(name: string, run: () => Promise<unknown>): Promise<void> {
  const calls: StubbedCall[] = [];
  mock.timers.enable({ apis: ['Date'], now: NOW });
  let outcome = 'ok';
  try {
    await withModelStub(stubbed(calls), run);
  } catch (err) {
    outcome = `threw: ${(err instanceof Error ? err.message : String(err)).split('\n')[0]}`;
  } finally {
    mock.timers.reset();
  }
  const actual = render(calls, outcome);
  const file = join(SNAPSHOT_DIR, `${name}.txt`);
  if (UPDATE) {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    writeFileSync(file, actual);
    return;
  }
  assert.equal(actual, readFileSync(file, 'utf8'), `${name} prompt changed - see ${file}`);
}

const tracker = () => new UsageTracker();

// The scout's request is built from the avoid-list and the sweep it read. The
// fixture was captured against an empty topics table and a sweep with no
// search key, so those are the inputs here.
test('scout', async () => {
  await capture('scout', async () => {
    const { chatJson } = await import('../llm/index.js');
    const evidence = (await import('../tools/tavily.js')).formatSearches(
      (await import('./topicScout.js')).scoutQueries(ctx).map((query) => ({ query, results: [] })),
    );
    await chatJson({ platformId: ctx.platform.id, model: MODEL, ...scoutRequest(ctx, [], evidence) });
  });
});

test('research', async () => {
  await capture('research', () => runResearcher(ctx, article({ research: null }), topic, MODEL, tracker()));
});

test('research product discovery', async () => {
  await capture('research-discovery', () =>
    runProductDiscovery(ctx, article(), topic, 'cordless stick vacuum', MODEL, tracker()),
  );
});

test('keyword', async () => {
  await capture('keyword', () => runKeywordStrategist(ctx, article(), topic, MODEL, tracker()));
});

test('angle', async () => {
  await capture('angle', () => runAngleEditor(ctx, article(), topic, MODEL, tracker()));
});

test('outline', async () => {
  await capture('outline', () => runOutliner(ctx, article(), MODEL, tracker()));
});

test('write', async () => {
  await capture('write', () => runWriter(ctx, article({ outline: brief }), topic, MODEL, tracker()));
});

test('seo_review', async () => {
  await capture('seo_review', () =>
    runSeoReviewer(
      ctx,
      article({ outline: brief, draft_md: draft, structure_shape: shape }),
      MODEL,
      tracker(),
    ),
  );
});

test('edit', async () => {
  await capture('edit', () =>
    runEditor(
      ctx,
      article({
        outline: brief,
        draft_md: draft,
        structure_shape: shape,
        feedback: 'Name the battery price.',
        seo_review: {
          score: 72,
          pass: false,
          dimensions: { evidence: 70 },
          issues: [{ severity: 'high', issue: 'Battery cost is missing', fix: 'Add the A$129 battery' }],
        } as never,
      }),
      MODEL,
      tracker(),
    ),
  );
});

test('image', async () => {
  await capture('image', () => runImageAgent(ctx, article({ outline: brief }), MODEL));
});

