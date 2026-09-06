// Topic Scout — finds trending topics we have NOT covered yet. Sweeps the
// live web via Tavily, cross-checks against published D1 posts and every
// previous suggestion, and writes new suggestions for the admin to approve.
import { q } from '../db/pool.js';
import { chatJson, UsageTracker } from '../llm/index.js';
import { fetchPublishedPosts } from '../tools/d1.js';
import { formatSearches, tavilySearchMany } from '../tools/tavily.js';
import { CATEGORIES, POST_TYPES, slugify } from '../content/contract.js';
import { siteContext, SOURCE_DISCIPLINE, VERIFICATION_RULES } from './context.js';
import type { TopicSuggestion } from '../pipeline/types.js';

const SCOUT_QUERIES = [
  'trending products Australia this week',
  'best selling gadgets this month',
  'viral home products people are buying right now',
  'trending health and wellness products this month',
  'what products are trending on social media right now Australia',
  'new product releases worth buying this month',
];

function normalizeTitle(title: string): string {
  return slugify(title);
}

export async function runTopicScout(
  model: string,
  tracker: UsageTracker,
  scoutRunId: string | null = null,
): Promise<TopicSuggestion[]> {
  // Build the avoid-list: everything published on the site + every topic the
  // scout has ever suggested (approved, rejected or pending alike).
  const [published, previous] = await Promise.all([
    fetchPublishedPosts().catch(() => [] as Array<{ slug: string; title: string }>),
    q<{ title: string }>('SELECT title FROM topics ORDER BY created_at DESC LIMIT 200'),
  ]);
  const avoid = [
    ...published.map((p) => p.title),
    ...previous.map((t) => t.title),
  ];

  const searches = await tavilySearchMany(SCOUT_QUERIES, 6);
  const evidence = formatSearches(searches);

  const suggestions = await chatJson<{ topics: TopicSuggestion[] }>(
    {
      model,
      system: `${siteContext()}\n\n${SOURCE_DISCIPLINE}\n\n${VERIFICATION_RULES}`,
      temperature: 0.8,
      search: true,
      prompt: `You are the Topic Scout. From the live search evidence below, propose 6-10 NEW
content topics for SleekDrops that are trending RIGHT NOW.

Rules:
- Every topic must be grounded in the evidence — cite the source URLs you used.
- Check before you propose. The sweep below is broad and a little stale by the
  time you read it: search the products or trends you are about to suggest and
  confirm they are current, actually on sale in Australia, and not a rerun of
  something that peaked last year. A topic built on a dead product wastes the
  whole pipeline behind it.
- Specific beats generic: "Best budget robot vacuums under $500 (2026)" beats "robot vacuums".
- postType must be one of: ${POST_TYPES.join(', ')}. category one of: ${CATEGORIES.join(', ')}.
- Spread across at least 3 categories.
- DO NOT suggest anything overlapping these already-covered or already-suggested topics:
${avoid.length > 0 ? avoid.map((t) => `  - ${t}`).join('\n') : '  (none yet)'}

Live search evidence:
${evidence}

Return JSON: {"topics": [{"title": string, "category": string, "postType": string,
"angle": string (the specific take/audience for the piece),
"keywords": string[] (3-6 target search keywords),
"whyTrending": string (1-2 sentences grounded in the evidence),
"sources": string[] (2-4 URLs from the evidence)}]}`,
    },
    tracker,
  );

  // Deterministic dedupe on normalized title against the whole topics table;
  // the unique index is the final guard against races.
  const inserted: TopicSuggestion[] = [];
  for (const topic of suggestions.topics ?? []) {
    if (!topic?.title || !CATEGORIES.includes(topic.category as never)) continue;
    if (!POST_TYPES.includes(topic.postType as never)) topic.postType = 'article';
    const rows = await q(
      `INSERT INTO topics (scout_run_id, title, norm_title, category, post_type, angle, keywords, why_trending, sources)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb)
       ON CONFLICT (norm_title) DO NOTHING
       RETURNING id`,
      [
        scoutRunId,
        topic.title,
        normalizeTitle(topic.title),
        topic.category,
        topic.postType,
        topic.angle ?? '',
        JSON.stringify(topic.keywords ?? []),
        topic.whyTrending ?? '',
        JSON.stringify(topic.sources ?? []),
      ],
    );
    if (rows.length > 0) inserted.push(topic);
  }
  return inserted;
}
