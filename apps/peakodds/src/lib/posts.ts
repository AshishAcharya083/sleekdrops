// The site's one reader of posts. scripts/fetch-content.mjs copies PeakOdds'
// published `posts` rows from Supabase into CONTENT_CACHE_FILE before a build;
// every page reads them through getEditionPosts and getPost, which turn each
// row into a typed PeakOddsPost or fail the build naming the post.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isEditionId, type EditionId } from '../data/editions.ts';

export type PeakOddsPostType = 'article' | 'guide' | 'preview';

export interface PeakOddsPost {
  readonly slug: string;
  readonly title: string;
  /** Frontmatter dek, or '' when the post has none. */
  readonly description: string;
  /** The post's category display name, e.g. 'AFL', 'Rugby Union'. */
  readonly sport: string;
  readonly postType: PeakOddsPostType;
  readonly editionId: EditionId;
  readonly author: string;
  /** Frontmatter tags, or [] when the post has none. */
  readonly tags: readonly string[];
  /** 'YYYY-MM-DD', the published calendar day. */
  readonly pubDate: string;
  /** 'YYYY-MM-DD', or null when the post was never revised. */
  readonly updatedDate: string | null;
  /** When the event the post previews starts; null for a post with no event. */
  readonly eventStartsAt: Date | null;
  /** When the post's prices were seen; null when no price was recorded. */
  readonly oddsAsAt: Date | null;
  /** Raw markdown, with the edition footer already appended by the agent. */
  readonly body: string;
}

/** The `posts` columns a PeakOddsPost is built from, in Supabase Data API `select` form. */
export const POST_ROW_COLUMNS =
  'slug,title,category,post_type,author,pub_date,updated_date,edition_id,event_starts_at,odds_as_at,frontmatter_json,body_md';

/** Where fetch-content.mjs leaves the rows, relative to the app root (the build's working directory). */
export const CONTENT_CACHE_FILE = '.content-cache/posts.json';

const POST_TYPES: readonly PeakOddsPostType[] = ['article', 'guide', 'preview'];
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Published posts of one edition, newest pubDate first, then slug ascending. */
export async function getEditionPosts(editionId: EditionId): Promise<PeakOddsPost[]> {
  const posts = await loadPosts();
  return posts.filter((post) => post.editionId === editionId);
}

export async function getPost(editionId: EditionId, slug: string): Promise<PeakOddsPost | undefined> {
  const posts = await getEditionPosts(editionId);
  return posts.find((post) => post.slug === slug);
}

/** Every cached post, in listing order. Fails when the cache is missing or any row is malformed. */
export async function loadPosts(cacheFile: string = resolve(CONTENT_CACHE_FILE)): Promise<PeakOddsPost[]> {
  let text: string;
  try {
    text = await readFile(cacheFile, 'utf8');
  } catch (error) {
    throw new Error(
      `No PeakOdds content at ${cacheFile}. Run \`pnpm --filter @sleekdrops/peakodds fetch-content\` first.`,
      { cause: error },
    );
  }
  return parsePostRows(JSON.parse(text));
}

/**
 * Supabase `posts` rows as typed posts, newest pubDate first, then slug. Throws
 * on the first malformed row, naming its slug: a post with no edition or an
 * unknown one has nowhere on the site to go, and guessing one would show it
 * to the wrong audience.
 */
export function parsePostRows(rows: unknown): PeakOddsPost[] {
  if (!Array.isArray(rows)) throw new Error('PeakOdds posts must be a JSON array of rows');
  return rows.map(parsePostRow).sort(byListingOrder);
}

function byListingOrder(a: PeakOddsPost, b: PeakOddsPost): number {
  if (a.pubDate !== b.pubDate) return a.pubDate < b.pubDate ? 1 : -1;
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

function parsePostRow(row: unknown, index: number): PeakOddsPost {
  if (!isRecord(row)) throw new Error(`PeakOdds post row ${index} is not an object`);
  const slug = row.slug;
  if (typeof slug !== 'string' || slug === '') throw new Error(`PeakOdds post row ${index} has no slug`);
  const field = rowReader(slug, row);

  const editionId = row.edition_id;
  if (editionId === null || editionId === undefined || editionId === '') {
    throw new Error(`PeakOdds post '${slug}' has no edition_id`);
  }
  if (typeof editionId !== 'string' || !isEditionId(editionId)) {
    throw new Error(`PeakOdds post '${slug}' has an unknown edition_id '${String(editionId)}'`);
  }

  const postType = field.string('post_type');
  if (!isPostType(postType)) throw new Error(`PeakOdds post '${slug}' has an unknown post_type '${postType}'`);

  const frontmatter = field.frontmatter();
  return {
    slug,
    title: field.string('title'),
    description: optionalString(frontmatter.dek) ?? '',
    sport: field.string('category'),
    postType,
    editionId,
    author: field.string('author'),
    tags: Array.isArray(frontmatter.tags) ? frontmatter.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    pubDate: field.calendarDay('pub_date'),
    updatedDate: field.optionalCalendarDay('updated_date'),
    eventStartsAt: field.optionalInstant('event_starts_at'),
    oddsAsAt: field.optionalInstant('odds_as_at'),
    body: field.string('body_md'),
  };
}

/** Reads one row's columns, naming the post and the column in every refusal. */
function rowReader(slug: string, row: Record<string, unknown>) {
  const invalid = (column: string, expected: string): Error =>
    new Error(`PeakOdds post '${slug}' has an invalid ${column}: expected ${expected}`);

  const string = (column: string): string => {
    const value = row[column];
    if (typeof value !== 'string') throw invalid(column, 'text');
    return value;
  };

  const calendarDay = (column: string): string => {
    const value = row[column];
    if (typeof value !== 'string' || !CALENDAR_DAY.test(value)) throw invalid(column, 'a YYYY-MM-DD date');
    return value;
  };

  const isAbsent = (column: string): boolean => row[column] === null || row[column] === undefined;

  return {
    string,
    calendarDay,
    optionalCalendarDay: (column: string): string | null => (isAbsent(column) ? null : calendarDay(column)),
    optionalInstant: (column: string): Date | null => {
      if (isAbsent(column)) return null;
      const value = row[column];
      const instant = typeof value === 'string' ? new Date(value) : null;
      if (!instant || Number.isNaN(instant.getTime())) throw invalid(column, 'a timestamp');
      return instant;
    },
    /** frontmatter_json: an object from the Data API (JSONB), or JSON text. */
    frontmatter: (): Record<string, unknown> => {
      const value = row.frontmatter_json;
      let parsed: unknown = value;
      if (typeof value === 'string') {
        try {
          parsed = JSON.parse(value);
        } catch {
          throw invalid('frontmatter_json', 'valid JSON');
        }
      }
      if (!isRecord(parsed)) throw invalid('frontmatter_json', 'a JSON object');
      return parsed;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPostType(value: string): value is PeakOddsPostType {
  return POST_TYPES.some((postType) => postType === value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
