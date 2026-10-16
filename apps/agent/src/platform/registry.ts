// The one place a platform or edition is looked up. Lookups are strict: an
// unknown or missing id throws, because there is no default platform - a
// caller that does not know which brand it is working for must not be handed
// one.
import { q } from '../db/pool.js';
import {
  type AgentId,
  type Edition,
  MONETISATION_MODES,
  type Platform,
  type PublishTargetRef,
  type TopicClass,
} from './types.js';

/** Thrown for a missing, empty or unknown platform id, and for an edition the platform does not have. */
export class UnknownPlatformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownPlatformError';
  }
}

/**
 * Profiles change only when an operator edits one, and every stage of every
 * article reads one, so they are cached. Writers clear the cache; the window
 * bounds how long another instance keeps serving a profile edited elsewhere.
 */
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { platform: Platform; loadedAt: number }>();

/** Drop cached platforms. Every writer to platforms, editions or platform_profile_versions calls this. */
export function clearPlatformCache(): void {
  cache.clear();
}

interface PlatformDbRow {
  id: string;
  name: string;
  byline_name: string;
  brand_text: string;
  audience: string;
  categories: string[];
  post_types: string[];
  article_shapes: string[];
  editorial_rules: string;
  monetisation: string;
  blocked_link_domains: string[];
  blocked_topics: TopicClass[];
  scout_queries: string[];
  agent_goals: Partial<Record<AgentId, string>>;
  publish_target: PublishTargetRef;
  profile_version: number | null;
}

interface EditionDbRow {
  platform_id: string;
  id: string;
  name: string;
  time_zone: string;
  currency: string | null;
  locale: string;
  scout_queries: string[];
  compliance_footer: string;
}

/** Throws unless `timeZone` is an IANA zone this runtime can format dates in. */
function assertTimeZone(edition: Edition): void {
  try {
    new Intl.DateTimeFormat('en', { timeZone: edition.timeZone });
  } catch {
    throw new Error(
      `edition "${edition.id}" of platform "${edition.platformId}" has an invalid time zone "${edition.timeZone}"`,
    );
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function toEdition(row: EditionDbRow): Edition {
  const edition: Edition = {
    id: row.id,
    platformId: row.platform_id,
    name: row.name,
    timeZone: row.time_zone,
    currency: row.currency,
    locale: row.locale,
    scoutQueries: row.scout_queries,
    complianceFooter: row.compliance_footer,
  };
  assertTimeZone(edition);
  return edition;
}

function toPlatform(row: PlatformDbRow, editions: Edition[]): Platform {
  const monetisation = MONETISATION_MODES.find((mode) => mode === row.monetisation);
  if (!monetisation) {
    throw new Error(`platform "${row.id}" has an unknown monetisation mode "${row.monetisation}"`);
  }
  if (row.profile_version === null) {
    throw new Error(`platform "${row.id}" has no profile version - it was never seeded`);
  }
  return deepFreeze({
    id: row.id,
    name: row.name,
    bylineName: row.byline_name,
    brandText: row.brand_text,
    audience: row.audience,
    categories: row.categories,
    postTypes: row.post_types,
    articleShapes: row.article_shapes,
    editorialRules: row.editorial_rules,
    monetisation,
    blockedLinkDomains: row.blocked_link_domains,
    blockedTopics: row.blocked_topics,
    scoutQueries: row.scout_queries,
    agentGoals: row.agent_goals,
    publishTarget: row.publish_target,
    profileVersion: row.profile_version,
    editions,
  });
}

/** Read platforms (all of them, or just `id`) fresh from the database and cache them. */
async function readPlatforms(id?: string): Promise<Platform[]> {
  const [platformRows, editionRows] = await Promise.all([
    q<PlatformDbRow>(
      `SELECT * FROM platforms WHERE $1::text IS NULL OR id = $1 ORDER BY created_at, id`,
      [id ?? null],
    ),
    q<EditionDbRow>(
      `SELECT * FROM editions WHERE $1::text IS NULL OR platform_id = $1 ORDER BY created_at, id`,
      [id ?? null],
    ),
  ]);
  const loadedAt = Date.now();
  return platformRows.map((row) => {
    const editions = editionRows.filter((e) => e.platform_id === row.id).map(toEdition);
    const platform = toPlatform(row, editions);
    cache.set(platform.id, { platform, loadedAt });
    return platform;
  });
}

function isMissing(id: unknown): boolean {
  return typeof id !== 'string' || !id.trim();
}

/**
 * The platform `id`, with its editions. Throws UnknownPlatformError for a
 * missing, empty or unknown id. The result is shared and frozen.
 */
export async function loadPlatform(id: string): Promise<Platform> {
  if (isMissing(id)) {
    throw new UnknownPlatformError('no platform id given - every lookup must name its platform');
  }
  const cached = cache.get(id);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached.platform;
  const [platform] = await readPlatforms(id);
  if (!platform) throw new UnknownPlatformError(`unknown platform: ${id}`);
  return platform;
}

/** Every platform with its editions, oldest first. */
export async function listPlatforms(): Promise<Platform[]> {
  return readPlatforms();
}

/**
 * One edition of one platform. Throws UnknownPlatformError for an unknown
 * platform or an edition it does not have. An edition inserted since the
 * platform was cached is found: a miss is re-checked against the database.
 */
export async function getEdition(platformId: string, editionId: string): Promise<Edition> {
  const platform = await loadPlatform(platformId);
  if (isMissing(editionId)) {
    throw new UnknownPlatformError(`no edition id given for platform: ${platform.id}`);
  }
  const find = (p: Platform | undefined) => p?.editions.find((e) => e.id === editionId);
  const edition = find(platform) ?? find((await readPlatforms(platform.id))[0]);
  if (!edition) throw new UnknownPlatformError(`unknown edition: ${platform.id}/${editionId}`);
  return edition;
}
