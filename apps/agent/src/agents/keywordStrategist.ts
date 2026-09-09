// Keyword strategist — decides which query the piece is built to win, by
// reading the live SERP rather than picking the prettiest phrase in the
// research dossier.
//
// This is the superseo `keyword-deep-dive` method as a pipeline stage:
//   1. propose candidates from the topic + dossier
//   2. actually read the SERP for each one (ranked results, who holds them,
//      what format wins, and the generated answer the query currently gets)
//   3. pick the winner on intent match and winnability, then spell out what
//      it takes to rank: format, length, gaps, entities, snippet target
//
// Everything downstream is built against the result, which is why it runs
// before the outliner instead of leaving keyword choice as a side effect of
// writing a brief.
import { chatJson, requireKeys, UsageTracker } from '../llm/index.js';
import { formatSerps, tavilySerpMany } from '../tools/tavily.js';
import { GEO_RULES, operatorBrief, siteContext } from './context.js';
import type { ArticleRow, KeywordPlan, TopicRow } from '../pipeline/types.js';

/** How many candidates get a live SERP read. Each one is a Tavily call. */
const CANDIDATES_TO_CHECK = 4;

const DIFFICULTY = new Set(['Easy', 'Moderate', 'Hard']);
const RISK = new Set(['Low', 'Medium', 'High']);
const SNIPPET_FORMATS = new Set(['paragraph', 'list', 'table']);

export async function runKeywordStrategist(
  article: ArticleRow,
  topic: TopicRow | null,
  model: string,
  tracker: UsageTracker,
): Promise<KeywordPlan> {
  const dossier = article.research;
  const brief = operatorBrief(topic);
  const seeds = [
    dossier?.keywords?.primary,
    ...(dossier?.keywords?.secondary ?? []),
    ...(topic?.keywords ?? []),
  ].filter(Boolean);

  // Pass 1 — candidates worth the cost of a SERP read. Deliberately cheap:
  // the expensive judgement happens after we have seen the results.
  const { candidates } = await chatJson<{ candidates: string[] }>(
    {
      model,
      system: siteContext(),
      temperature: 0.4,
      prompt: `Propose the search queries this piece could realistically be built to win.

Working title: ${article.title}
Post type: ${article.post_type} | Category: ${article.category}
Angle: ${topic?.angle ?? 'n/a'}
Keywords already in play: ${seeds.join(', ') || '(none)'}
${brief ? `\n${brief}\n` : ''}
Research summary: ${dossier?.summary ?? '(none)'}

Rules:
- Mix head terms with long-tail. A specific query we can win beats a fat one we can't.
- Include at least one commercial-investigation phrasing ("best X for Y", "X vs Y")
  and at least one question phrasing, when they fit the topic.
- Australian buyers are the audience; include an AU-qualified variant if it is natural.
- No brand-name-only queries: we cannot outrank the manufacturer's own page.

Return JSON {"candidates": string[]} — ${CANDIDATES_TO_CHECK + 3} to ${CANDIDATES_TO_CHECK + 6} queries, best first.`,
    },
    tracker,
    requireKeys<{ candidates: string[] }>('candidates'),
  );

  const shortlist = (candidates ?? [])
    .map((c) => c?.trim())
    .filter((c): c is string => Boolean(c))
    .slice(0, CANDIDATES_TO_CHECK);
  if (shortlist.length === 0) shortlist.push(article.title);

  // Pass 2 — read the SERP for each candidate. The generated answer comes back
  // for the lead candidate only: it is what a generative engine says about the
  // query today, and it costs an extra round trip.
  const serps = await tavilySerpMany(shortlist, 8, true);
  const evidence = formatSerps(serps);

  const plan = await chatJson<KeywordPlan>(
    {
      model,
      system: `${siteContext()}\n\n${GEO_RULES}`,
      temperature: 0.3,
      maxTokens: 8000,
      prompt: `You are a senior SEO strategist. Pick the ONE keyword this piece is built to
win, and specify what it takes to rank for it — for Google AND for the
generative engines (ChatGPT, Claude, Perplexity, AI Overviews).

Base every claim on the SERPs below. If a SERP came back empty, say so in the
rationale instead of inventing what ranks.

Working title: ${article.title}
Post type: ${article.post_type} | Category: ${article.category}
${brief ? `\n${brief}\n` : ''}
Research dossier:
${JSON.stringify(article.research, null, 2)}

Live SERP reads:
${evidence}

How to choose:
- Intent match first. A query whose SERP is full of a format we cannot publish
  (manufacturer product pages, Reddit threads, news aggregators) is unwinnable —
  reject it and say why.
- Prefer a query where the top results are thin, dated, or miss a subtopic we
  can cover from the dossier. That gap is the reason we can rank.
- Weigh zero-click risk: a fat informational head term whose answer sits in an
  AI Overview earns impressions, not clicks. For an affiliate piece, a
  commercial-investigation query with a smaller ceiling is usually worth more.
- wordCountTarget: average length of the top results, plus about 10%. Never pad
  to a number — this is a ceiling on ambition, not a quota.
- entities: the specific products, brands, standards, chipsets and prices the
  top pages name. Naming them explicitly is what earns citations from AI
  systems, which build knowledge graphs from entity-rich text.
- snippetTarget: the single question we want the featured snippet / AI citation
  for, its format (paragraph for "what is", list for "how", table for
  comparisons), and a 40-60 word answer written to be extracted verbatim.
  Ground it in the dossier — never invent a spec or a price to fill it.

Return JSON:
{"primaryKeyword": string,
 "rationale": string (2-4 sentences: why this beat the others, grounded in the SERPs),
 "intent": "Informational"|"Commercial Investigation"|"Transactional"|"Navigational",
 "difficulty": "Easy"|"Moderate"|"Hard",
 "zeroClickRisk": "Low"|"Medium"|"High",
 "serpFeatures": string[] (what you can see: featured snippet, People Also Ask, AI Overview, image pack, shopping, video),
 "winningFormat": string (the content type the SERP rewards),
 "wordCountTarget": number,
 "secondaryKeywords": string[] (4-8, genuinely distinct — not the primary reworded),
 "paaQuestions": string[] (3-6 long-tail questions to answer as H2/H3),
 "entities": string[] (8-15 named products, brands, specs, standards),
 "competitors": [{"url": string, "format": string, "angle": string, "strength": string}] (the top 3),
 "contentGaps": string[] (3-6 subtopics the top results handle badly),
 "snippetTarget": {"question": string, "format": "paragraph"|"list"|"table", "answer": string (40-60 words)},
 "titleOptions": string[] (2-3, each ≤60 chars, primary keyword front-loaded),
 "metaDescription": string (140-160 chars, includes the primary keyword),
 "rejected": [{"keyword": string, "reason": string}] (the candidates you did not pick)}`,
    },
    tracker,
    // normalizePlan back-fills a lot, so a fragment here degrades quietly to a
    // plan built on defaults rather than on the SERP read that was paid for.
    requireKeys<KeywordPlan>('primaryKeyword', 'wordCountTarget'),
  );

  return normalizePlan(plan, {
    fallbackKeyword: dossier?.keywords?.primary || article.title,
    aiAnswer: serps.find((s) => s.answer)?.answer ?? '',
    postType: article.post_type,
  });
}

/** Word-count floors by post type, matching the site's content contract. */
const WORD_FLOOR: Record<string, number> = { guide: 1500, roundup: 1200, article: 700 };

/**
 * Defensive normalization — the plan drives four downstream prompts and one
 * word-count target, so a malformed enum or a missing array must not reach
 * them. Exported for the tests.
 */
export function normalizePlan(
  plan: KeywordPlan,
  opts: { fallbackKeyword: string; aiAnswer: string; postType: string },
): KeywordPlan {
  const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
  const floor = WORD_FLOOR[opts.postType] ?? WORD_FLOOR.article;
  const target = Number(plan?.wordCountTarget);

  return {
    primaryKeyword: plan?.primaryKeyword?.trim() || opts.fallbackKeyword,
    rationale: plan?.rationale ?? '',
    intent: plan?.intent ?? 'Commercial Investigation',
    difficulty: DIFFICULTY.has(plan?.difficulty) ? plan.difficulty : 'Moderate',
    zeroClickRisk: RISK.has(plan?.zeroClickRisk) ? plan.zeroClickRisk : 'Medium',
    serpFeatures: list<string>(plan?.serpFeatures),
    winningFormat: plan?.winningFormat ?? opts.postType,
    // Never below the contract floor, never a runaway target the writer pads to.
    wordCountTarget: Math.min(4000, Math.max(floor, Number.isFinite(target) ? target : floor)),
    secondaryKeywords: list<string>(plan?.secondaryKeywords),
    paaQuestions: list<string>(plan?.paaQuestions),
    entities: list<string>(plan?.entities),
    competitors: list<KeywordPlan['competitors'][number]>(plan?.competitors),
    contentGaps: list<string>(plan?.contentGaps),
    snippetTarget: {
      question: plan?.snippetTarget?.question ?? '',
      format: SNIPPET_FORMATS.has(plan?.snippetTarget?.format)
        ? plan.snippetTarget.format
        : 'paragraph',
      answer: plan?.snippetTarget?.answer ?? '',
    },
    currentAiAnswer: opts.aiAnswer,
    titleOptions: list<string>(plan?.titleOptions),
    metaDescription: plan?.metaDescription ?? '',
    rejected: list<KeywordPlan['rejected'][number]>(plan?.rejected),
  };
}
