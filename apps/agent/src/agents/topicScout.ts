// Topic Scout — finds trending topics we have NOT covered yet. Sweeps the
// live web via Tavily, cross-checks against published D1 posts and every
// previous suggestion, and writes new suggestions for the admin to approve.
//
// One run scouts one edition of one platform: the platform's own queries
// first, then the edition's, and every suggestion is filed against both.
import { q } from '../db/pool.js';
import { chatJson, type ChatOptions, requireKeys, UsageTracker } from '../llm/index.js';
import { fetchPublishedPosts } from '../tools/d1.js';
import { formatSearches, tavilySearchMany } from '../tools/tavily.js';
import { parseOffsetTimestamp, slugify } from '../content/contract.js';
import { getPostTypes } from '../content/catalogue.js';
import {
  type PromptContext,
  editionMarket,
  moneyExample,
  siteContext,
  SOURCE_DISCIPLINE,
  verificationRules,
  withAgentGoal,
} from './context.js';
import type { TopicSuggestion } from '../pipeline/types.js';
import { resolveD1Target } from '../platform/publishTarget.js';
import { blockedTopicReason } from '../platform/topicRules.js';

function normalizeTitle(title: string): string {
  return slugify(title);
}

/** What one edition's sweep searches for: the platform's queries, then the edition's. */
export function scoutQueries(ctx: PromptContext): string[] {
  return [...ctx.platform.scoutQueries, ...ctx.edition.scoutQueries];
}

/** The scout's request to the model, without the model and the platform id. Pure, for the tests. */
export function scoutRequest(
  ctx: PromptContext,
  avoid: readonly string[],
  evidence: string,
): Pick<ChatOptions, 'system' | 'temperature' | 'search' | 'prompt'> {
  const { platform } = ctx;
  const market = editionMarket(ctx.edition);
  const budget = moneyExample(ctx.edition, 500, 'narrowSymbol');
  // The reply schema leaves out eventStartsAt so a platform without
  // event-bound posts keeps its prompt; one with them asks for it in its
  // scout goal, and the parser below accepts it either way.
  return {
    system: withAgentGoal(
      ctx,
      'scout',
      `${siteContext(ctx)}\n\n${SOURCE_DISCIPLINE}\n\n${verificationRules(ctx.edition)}`,
    ),
    temperature: 0.8,
    search: true,
    prompt: `You are the Topic Scout. From the live search evidence below, propose 6-10 NEW
content topics for ${platform.name} that are trending RIGHT NOW.

Rules:
- Every topic must be grounded in the evidence — cite the source URLs you used.
- Check before you propose. The sweep below is broad and a little stale by the
  time you read it: search the products or trends you are about to suggest and
  confirm they are current, ${market ? `actually on sale in ${market.place}` : 'still available'}, and not a rerun of
  something that peaked last year. A topic built on a dead product wastes the
  whole pipeline behind it.
- Specific beats generic: "Best budget robot vacuums${budget ? ` under ${budget}` : ''} (2026)" beats "robot vacuums".
- postType must be one of: ${getPostTypes(platform).map((type) => type.id).join(', ')}. category one of: ${platform.categories.join(', ')}.
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
  };
}

export async function runTopicScout(
  ctx: PromptContext,
  model: string,
  tracker: UsageTracker,
  scoutRunId: string | null = null,
): Promise<TopicSuggestion[]> {
  const { platform, edition } = ctx;
  // Build the avoid-list: everything published on the site + every topic the
  // scout has ever suggested for this platform (approved, rejected or pending
  // alike).
  const [published, previous] = await Promise.all([
    Promise.resolve(platform)
      .then(resolveD1Target)
      .then(fetchPublishedPosts)
      .catch(() => [] as Array<{ slug: string; title: string }>),
    q<{ title: string }>(
      'SELECT title FROM topics WHERE platform_id = $1 ORDER BY created_at DESC LIMIT 200',
      [platform.id],
    ),
  ]);
  const avoid = [
    ...published.map((p) => p.title),
    ...previous.map((t) => t.title),
  ];

  const searches = await tavilySearchMany(scoutQueries(ctx), 6);
  const evidence = formatSearches(searches);

  const suggestions = await chatJson<{ topics: TopicSuggestion[] }>(
    { platformId: platform.id, model, ...scoutRequest(ctx, avoid, evidence) },
    tracker,
    // Without this a fragment reply inserts nothing and the sweep reports
    // "0 new topics" — indistinguishable from a genuinely quiet week.
    requireKeys<{ topics: TopicSuggestion[] }>('topics'),
  );

  const postTypes = getPostTypes(platform).map((type) => type.id);
  // Deterministic dedupe on normalized title against the platform's topics;
  // the unique index is the final guard against races.
  const inserted: TopicSuggestion[] = [];
  for (const topic of suggestions.topics ?? []) {
    if (!topic?.title || !platform.categories.includes(topic.category)) continue;
    if (!postTypes.includes(topic.postType)) topic.postType = postTypes[0];
    // A hard block, applied to what the model returned rather than trusted to
    // the queries: a sweep broad enough to surface racing must still file none.
    const subject = [topic.title, topic.angle ?? '', ...[topic.keywords ?? []].flat()].join('\n');
    if (blockedTopicReason(platform, subject)) continue;
    // An event-bound suggestion is only as good as its start time: one that
    // cannot be read, or has already passed, would schedule a preview of
    // nothing, so the suggestion is dropped rather than filed undated.
    let eventStartsAt: Date | null = null;
    if (topic.eventStartsAt !== undefined && topic.eventStartsAt !== null) {
      eventStartsAt = parseOffsetTimestamp(topic.eventStartsAt);
      if (!eventStartsAt || eventStartsAt.getTime() <= Date.now()) continue;
    }
    const rows = await q(
      `INSERT INTO topics (platform_id, edition_id, scout_run_id, title, norm_title, category, post_type,
                           angle, keywords, why_trending, sources, event_starts_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb, $12)
       ON CONFLICT (platform_id, norm_title) DO NOTHING
       RETURNING id`,
      [
        platform.id,
        edition.id,
        scoutRunId,
        topic.title,
        normalizeTitle(topic.title),
        topic.category,
        topic.postType,
        topic.angle ?? '',
        JSON.stringify(topic.keywords ?? []),
        topic.whyTrending ?? '',
        JSON.stringify(topic.sources ?? []),
        eventStartsAt?.toISOString() ?? null,
      ],
    );
    if (rows.length > 0) inserted.push(topic);
  }
  return inserted;
}
