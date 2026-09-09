/**
 * `/llms.txt` and `/llms-full.txt`: a curated map of what this site knows,
 * written for a retrieval agent rather than for a reader.
 *
 * Why the site needs one. The mechanic shared by ChatGPT search, Gemini AI Mode
 * and Claude's web search is that the retrieval unit is a *passage*, not a page:
 * the query is fanned out into sub-queries and what gets cited is a
 * self-contained, entity-dense passage with a source and a date on it. An agent
 * arriving at a 124-URL sitemap has no way to tell a 2,400-word roundup that
 * names prices and dates from a tag archive holding one post. These two files
 * are that signal, in the order the site would put its own work: the strongest
 * articles first, each with the one line that says what it answers.
 *
 * Two files, one corpus:
 *
 *   llms.txt      - the site description, the categories that actually have
 *                   articles, and the curated strongest articles with a
 *                   one-line summary each. Short enough to be read whole.
 *   llms-full.txt - every live article, strongest first, with a fuller summary:
 *                   what it opens by answering, what it covers, the questions it
 *                   answers outright, and when it was last checked.
 *
 * Neither reproduces an article body. The pages are already crawlable and
 * canonical, a copy of the corpus would be the same words on a second URL, and
 * the bodies are full of `/go/` affiliate redirects - the one path robots.txt
 * disallows for every crawler. Every summary here is passed through
 * `plainText`, which keeps a markdown link's label and drops its target, so no
 * affiliate hop can reach these files even from a quoted lead paragraph.
 *
 * "Strongest" is scored, not hand-picked (see `scoreArticle`): both files are
 * regenerated from the content collection on every build by
 * scripts/generate-llms-txt.mjs, so nothing here is ever hand-maintained and
 * nothing goes stale.
 *
 * Plain ESM for the same reason `sitemap-policy.mjs` is: the generator runs as
 * bare node before the build, which cannot load an Astro module.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseFrontmatter } from './sitemap-policy.mjs';

/** How many articles the curated file lists, and how many from any one category. */
export const CURATED_LIMIT = 40;
export const CURATED_PER_CATEGORY = 8;

/**
 * Below this, a page is a stub. Sending an agent to one costs it a fetch and
 * teaches it this site is thin, so the curated file leaves it out; llms-full.txt
 * still carries it, because that file is the whole corpus by definition.
 */
export const MIN_CURATED_WORDS = 400;

/** Longest lead paragraph carried into a summary, in characters. */
const LEAD_LIMIT = 320;

const CODE_FENCE = /```[\s\S]*?```/g;
const HEADING = /^(#{2,3})\s+(.+?)\s*#*$/;
const FAQ_HEADING = /^(?:faqs?|frequently asked questions)$/i;

/**
 * Markdown to prose. Link *labels* survive and link targets do not, which is
 * what keeps `/go/` redirects out of these files; images, code, inline HTML and
 * emphasis markers are dropped outright.
 *
 * Table markup goes too, while the cell text stays: a comparison table's prices
 * and runtimes are exactly the checkable figures the score counts, but its pipes
 * and alignment row are not words, and counting them made a table-heavy roundup
 * look longer than it is.
 */
export function plainText(markdown) {
  return markdown
    .replace(CODE_FENCE, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/^[ \t]*\|?[\s:|-]*\|[\s:|-]*$/gm, ' ')
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, ' ')
    .replace(/\|/g, ' ')
    .replace(/\*\*|__|[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Frontmatter and body, split at the closing fence. */
export function splitDocument(markdown) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown);
  return {
    data: parseFrontmatter(markdown) ?? {},
    body: match ? markdown.slice(match[0].length) : markdown,
  };
}

/** A sentence-boundary trim, falling back to a word boundary. */
function clamp(text, limit) {
  if (text.length <= limit) return text;
  const window = text.slice(0, limit);
  const sentence = window.lastIndexOf('. ');
  if (sentence > limit * 0.6) return window.slice(0, sentence + 1);
  return `${window.slice(0, window.lastIndexOf(' ')).trimEnd()}...`;
}

function asDate(value) {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `YYYY-MM-DD`, the form the sitemap and the article dateline both use. */
function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * The first paragraph of real prose. Every article is written to open with its
 * answer, so this is the passage an agent would want; headings, tables, lists
 * and blockquotes are skipped to reach it.
 */
function leadParagraph(body) {
  for (const block of body.replace(CODE_FENCE, '').split(/\r?\n\s*\r?\n/)) {
    const trimmed = block.trim();
    if (!trimmed || /^(#|\||[-*+]\s|>|\d+\.\s)/.test(trimmed)) continue;
    const prose = plainText(trimmed);
    if (prose.length >= 80) return clamp(prose, LEAD_LIMIT);
  }
  return '';
}

/** Parenthetical citations carrying a year - "(Dyson, 2026 spec sheet)". */
const DATED_CLAIM = /\([^)]*\b(?:19|20)\d{2}\b[^)]*\)/g;

/** A number a reader could check: a price, a measurement, a duration, a rate. */
const SPECIFIC_FIGURE =
  /(?:A?\$\s?\d[\d,.]*)|(?:\b\d[\d,.]*\s?(?:%|mm|cm|kg|g|L|ml|W|Wh|kWh|dB|Hz|kHz|GHz|MHz|mAh|GB|TB|MB|Mbps|nits|ppi|fps|hours?|hrs?|minutes?|mins?|days?|weeks?|months?|years?|inch(?:es)?)\b)/gi;

function countMatches(text, pattern) {
  return (text.match(pattern) ?? []).length;
}

/**
 * One article as both files need it. `live` mirrors `isLivePost` in ./posts.ts
 * and `toPostRecord` in ./sitemap-policy.mjs - a draft or a future-dated post is
 * not something to hand a crawler.
 */
export function toArticleRecord(slug, data, body, now = new Date()) {
  const pubDate = asDate(data.pubDate);
  const updatedDate = asDate(data.updatedDate);
  const prose = plainText(body);
  const headings = body
    .replace(CODE_FENCE, '')
    .split(/\r?\n/)
    .map((line) => HEADING.exec(line.trim()))
    .filter((match) => match !== null)
    .map((match) => ({ level: match[1].length, text: plainText(match[2]) }));

  return {
    slug,
    title: typeof data.title === 'string' ? data.title : slug,
    dek: typeof data.dek === 'string' ? plainText(data.dek) : '',
    category: typeof data.category === 'string' ? data.category : '',
    postType: typeof data.postType === 'string' ? data.postType : 'article',
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    pubDate,
    updatedDate,
    readTime: Number.isFinite(data.readTime) ? Number(data.readTime) : null,
    featured: data.featured === true,
    live: data.draft !== true && pubDate !== null && pubDate.getTime() <= now.getTime(),
    wordCount: prose ? prose.split(' ').length : 0,
    /** H2s, minus the FAQ wrapper - its questions are listed on their own. */
    sections: headings.filter((h) => h.level === 2 && !FAQ_HEADING.test(h.text)).map((h) => h.text),
    /** The FAQ pairs, which is the shape an answer engine quotes verbatim. */
    questions: headings.filter((h) => h.level === 3 && h.text.endsWith('?')).map((h) => h.text),
    hasComparisonTable: /^\s*\|/m.test(body),
    datedClaims: countMatches(body, DATED_CLAIM),
    specificFigures: countMatches(prose, SPECIFIC_FIGURE),
    lead: leadParagraph(body),
  };
}

/**
 * What each signal contributes to an article's strength. Weighted, not equal:
 * the two things the AdSense review said our weakest pages lack - checkable
 * figures and dated attribution - outweigh the two a template supplies for free,
 * a section count and a word count.
 */
export const STRENGTH_WEIGHTS = {
  /** Enough words to answer the question fully. */
  substance: 3,
  /** Claims attributed to a named source with a year. */
  evidence: 3,
  /** Prices, measurements and durations a reader could check. */
  specificity: 2,
  /** Sections, and a comparison table where the piece compares things. */
  structure: 1.5,
  /** Question/answer pairs an engine can quote outright. */
  answers: 1.5,
  /** Re-checked since publication. */
  maintained: 1,
  /** How recently that check happened. */
  recency: 1,
  /** The desk's own pick. */
  featured: 0.5,
};

const ratio = (value, full) => Math.min(value / full, 1);

/**
 * Each signal on its own, normalized to 0-1 before weighting. Exported because
 * the breakdown is the useful part when asking *why* an article ranked where it
 * did, and because a key here with no matching weight (or the reverse) would
 * quietly turn every score into NaN - which the test asserts against.
 */
export function strengthSignals(record, now = new Date()) {
  const changed = record.updatedDate ?? record.pubDate;
  const daysSinceChange = changed ? (now.getTime() - changed.getTime()) / 86_400_000 : Infinity;
  const figuresPer100Words = record.wordCount > 0 ? (record.specificFigures / record.wordCount) * 100 : 0;

  return {
    substance: ratio(record.wordCount, 1600),
    evidence: ratio(record.datedClaims, 8),
    specificity: ratio(figuresPer100Words, 2.5),
    structure: ratio(record.sections.length, 6) * 0.7 + (record.hasComparisonTable ? 0.3 : 0),
    answers: ratio(record.questions.length, 4),
    maintained: record.updatedDate ? 1 : 0,
    // Clamped at both ends: a future `updatedDate` (a scheduled re-publish) must
    // not score above a page checked today.
    recency: Math.min(1, Math.max(0, 1 - daysSinceChange / 365)),
    featured: record.featured ? 1 : 0,
  };
}

/**
 * The weighted strength score, from 0 to the sum of the weights above (13.5).
 * Deliberately made of signals already present in the published markdown:
 * nothing here needs a second source of truth, so the ranking cannot drift from
 * what the site actually published.
 */
export function scoreArticle(record, now = new Date()) {
  const signals = strengthSignals(record, now);
  const total = Object.entries(STRENGTH_WEIGHTS).reduce(
    (sum, [signal, weight]) => sum + signals[signal] * weight,
    0,
  );
  return Math.round(total * 100) / 100;
}

/** Strongest first; equal scores fall back to the most recently changed, then the slug. */
export function byStrength(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const changedA = (a.updatedDate ?? a.pubDate)?.getTime() ?? 0;
  const changedB = (b.updatedDate ?? b.pubDate)?.getTime() ?? 0;
  if (changedB !== changedA) return changedB - changedA;
  return a.slug.localeCompare(b.slug);
}

/** Every live article under `blogDir`, scored, strongest first. */
export function readArticleIndex(blogDir, now = new Date()) {
  if (!existsSync(blogDir)) return [];
  return readdirSync(blogDir)
    .filter((file) => file.endsWith('.md'))
    .map((file) => {
      const { data, body } = splitDocument(readFileSync(join(blogDir, file), 'utf8'));
      const record = toArticleRecord(file.slice(0, -'.md'.length), data, body, now);
      return { ...record, score: scoreArticle(record, now) };
    })
    .filter((record) => record.live)
    .sort(byStrength);
}

/**
 * The curated slice: strongest first, stubs left out, and no single category
 * allowed to fill the file - an agent reading it should see the breadth of the
 * site, not eight vacuum roundups.
 */
export function curate(articles, options = {}) {
  const {
    limit = CURATED_LIMIT,
    perCategory = CURATED_PER_CATEGORY,
    minWords = MIN_CURATED_WORDS,
  } = options;
  const taken = new Map();
  const curated = [];
  for (const article of [...articles].sort(byStrength)) {
    if (article.wordCount < minWords) continue;
    const used = taken.get(article.category) ?? 0;
    if (used >= perCategory) continue;
    taken.set(article.category, used + 1);
    curated.push(article);
    if (curated.length >= limit) break;
  }
  return curated;
}

/** `- [Title](url): one-line summary` - the link form the llms.txt convention uses. */
function linkLine(title, url, note) {
  return note ? `- [${title}](${url}): ${note}` : `- [${title}](${url})`;
}

function articleUrl(siteUrl, slug) {
  return `${siteUrl}/blog/${slug}`;
}

/**
 * The line that makes the file self-identifying: `generate-llms-txt.mjs` only
 * ever deletes a file carrying it, and an agent reading the file can see both
 * where it came from and how old it is.
 */
export function provenanceLine(marker, generatedAt, count) {
  return `${marker} on ${isoDay(generatedAt)} from ${count} published article${count === 1 ? '' : 's'}. Do not edit by hand.`;
}

function preamble({ siteName, description, details, deployment, marker, generatedAt, count, extra = [] }) {
  return [
    `# ${siteName}`,
    '',
    `> ${description}`,
    '',
    ...(deployment === 'production'
      ? []
      : [
          'PREVIEW DEPLOYMENT - not the live site. Every page here carries',
          '`<meta name="robots" content="noindex, nofollow">`; the links below point at the',
          'canonical site.',
          '',
        ]),
    ...details,
    '',
    ...extra,
    provenanceLine(marker, generatedAt, count),
  ];
}

/**
 * Prose the agent needs about how to read the site, held in one place. Every
 * sentence is a claim about the whole corpus, so it says only what the site can
 * stand behind for all of it: the method and the funding, not a promise about
 * what each individual article's own wording does.
 */
function siteDetails(siteUrl) {
  return [
    'Written for Australian shoppers: prices are in AUD and availability is checked on the',
    'date shown on each page. Picks are an editorial synthesis of manufacturer specs, owner',
    'reviews and expert coverage rather than a hands-on lab test. Pages carry affiliate',
    'links, disclosed on the page; a commission never decides a recommendation',
    `(${siteUrl}/disclaimer).`,
  ];
}

/**
 * `/llms.txt` - the curated entry point.
 *
 * @param {object} input
 * @param {string} input.siteName
 * @param {string} input.siteUrl canonical site URL, no trailing slash
 * @param {string} input.description one-paragraph description of the site
 * @param {Array<{name: string, slug: string, blurb: string}>} input.categories
 * @param {Array<object>} input.articles every live article, from `readArticleIndex`
 * @param {'production'|'preview'} input.deployment
 * @param {Date} input.generatedAt
 * @param {string} input.marker provenance marker naming the generator
 */
export function buildLlmsTxt({
  siteName,
  siteUrl,
  description,
  categories,
  articles,
  deployment = 'production',
  generatedAt = new Date(),
  marker,
}) {
  const site = siteUrl.replace(/\/+$/, '');
  const curated = curate(articles);
  const countsByCategory = new Map();
  for (const article of articles) {
    countsByCategory.set(article.category, (countsByCategory.get(article.category) ?? 0) + 1);
  }
  const live = categories.filter((category) => (countsByCategory.get(category.name) ?? 0) > 0);

  const categorySection =
    live.length > 0
      ? [
          '',
          '## Categories',
          '',
          ...live.map((category) => {
            const count = countsByCategory.get(category.name) ?? 0;
            return linkLine(
              category.name,
              `${site}/category/${category.slug}`,
              `${category.blurb} ${count} article${count === 1 ? '' : 's'}.`,
            );
          }),
        ]
      : [];

  // Grouped by category, strongest first inside each: an agent looking for one
  // subject reads one block rather than the whole file.
  const articleSections = live.flatMap((category) => {
    const picks = curated.filter((article) => article.category === category.name);
    if (picks.length === 0) return [];
    return [
      '',
      `## ${category.name}`,
      '',
      ...picks.map((article) =>
        linkLine(article.title, articleUrl(site, article.slug), article.dek || undefined),
      ),
    ];
  });

  return [
    ...preamble({
      siteName,
      description,
      details: siteDetails(site),
      deployment,
      marker,
      generatedAt,
      count: articles.length,
      extra: [
        'The sections below hold the strongest articles in each category rather than every',
        'article: the category pages listed first hold the rest.',
        '',
        `Fuller per-article summaries: ${site}/llms-full.txt`,
        `Every URL, with the date it last changed: ${site}/sitemap-index.xml`,
        '',
      ],
    }),
    ...categorySection,
    ...articleSections,
    '',
    // Deliberately not the convention's `## Optional` section: an agent weighing
    // whether to trust a recommendation needs the method and the funding, and
    // `## Optional` is defined as the part it may skip for a shorter context.
    '## About this site',
    '',
    linkLine('About', `${site}/about`, 'who writes this site and how a pick is made'),
    linkLine('Affiliate disclaimer', `${site}/disclaimer`, 'how the site is funded and how links are labelled'),
    linkLine('Privacy', `${site}/privacy`, 'what is collected and what is not'),
    linkLine('RSS feed', `${site}/rss.xml`, 'new articles as they publish'),
    '',
  ].join('\n');
}

/**
 * `Key: value` metadata lines, omitting the ones this article has nothing for.
 * `Updated` appears only when the post carries one, so the pair of dates never
 * claims a re-check that did not happen - the freshness date is the later of the
 * two, exactly as the sitemap's `lastmod` computes it.
 */
function articleFacts(article, url) {
  return [
    `- URL: ${url}`,
    `- Category: ${article.category}`,
    `- Type: ${article.postType}`,
    ...(article.pubDate ? [`- Published: ${isoDay(article.pubDate)}`] : []),
    ...(article.updatedDate ? [`- Updated: ${isoDay(article.updatedDate)}`] : []),
    `- Length: ${article.wordCount} words${article.readTime ? `, ${article.readTime} min read` : ''}`,
    ...(article.tags.length > 0 ? [`- Tags: ${article.tags.join(', ')}`] : []),
  ];
}

/**
 * `/llms-full.txt` - every live article, strongest first, with the fuller
 * summary llms.txt has no room for. Takes the same input as `buildLlmsTxt`.
 */
export function buildLlmsFullTxt({
  siteName,
  siteUrl,
  description,
  articles,
  deployment = 'production',
  generatedAt = new Date(),
  marker,
}) {
  const site = siteUrl.replace(/\/+$/, '');
  const ranked = [...articles].sort(byStrength);

  // One paragraph-separated entry per article, joined with a single blank line -
  // the blocks inside an entry are what the blank lines separate, so the entries
  // are assembled as text rather than as one flat line list.
  const entries = ranked.map((article) =>
    [
      `## ${article.title}`,
      articleFacts(article, articleUrl(site, article.slug)).join('\n'),
      ...(article.dek ? [`Summary: ${article.dek}`] : []),
      ...(article.lead ? [`Opens by answering: ${article.lead}`] : []),
      ...(article.sections.length > 0 ? [`Covers: ${article.sections.join('; ')}.`] : []),
      ...(article.questions.length > 0
        ? [['Answers outright:', ...article.questions.map((question) => `- ${question}`)].join('\n')]
        : []),
    ].join('\n\n'),
  );

  const preambleText = preamble({
    siteName: `${siteName} - full article summaries`,
    description,
    details: siteDetails(site),
    deployment,
    marker,
    generatedAt,
    count: articles.length,
    extra: [
      'Every live article, strongest first. Summaries only: each article page is the',
      'canonical copy of its own text, and the affiliate redirect links in its body are',
      'disallowed to every crawler in robots.txt, so nothing here reproduces a body.',
      `Curated short form: ${site}/llms.txt`,
      '',
    ],
  }).join('\n');

  return `${[preambleText, ...entries].join('\n\n')}\n`;
}
