// The one place a platform or edition is looked up. Lookups are strict: an
// unknown or missing id throws, because there is no default platform - a
// caller that does not know which brand it is working for must not be handed
// one.
import type pg from 'pg';
import { pool, q } from '../db/pool.js';
import { SLEEKDROPS_PROFILE } from './sleekdrops/index.js';
import {
  type Edition,
  MONETISATION_MODES,
  type MonetisationMode,
  type Platform,
  type PlatformProfile,
} from './types.js';

export class UnknownPlatformError extends Error {
  constructor(id: unknown) {
    super(
      typeof id === 'string' && id.trim()
        ? `unknown platform "${id}"`
        : 'no platform id given - every lookup must name its platform',
    );
    this.name = 'UnknownPlatformError';
  }
}

export class UnknownEditionError extends Error {
  constructor(platformId: string, editionId: unknown) {
    super(
      typeof editionId === 'string' && editionId.trim()
        ? `unknown edition "${editionId}" for platform "${platformId}"`
        : `no edition id given for platform "${platformId}"`,
    );
    this.name = 'UnknownEditionError';
  }
}

/** Every profile seeded from code. A new platform adds its profile here. */
export const SEED_PROFILES: readonly PlatformProfile[] = [SLEEKDROPS_PROFILE];

/**
 * Profiles change only when an operator edits one, and every stage of every
 * article reads one, so they are cached. The window bounds how long another
 * instance keeps serving a profile edited elsewhere.
 */
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { platform: Platform; loadedAt: number }>();

/** Drop cached profiles - after an edit, so the next lookup reads the database. */
export function clearPlatformCache(): void {
  cache.clear();
}

interface PlatformDbRow {
  id: string;
  name: string;
  brand_text: string;
  audience: string;
  categories: string[];
  post_types: string[];
  article_shapes: string[];
  editorial_rules: string;
  monetisation: string;
  blocked_link_domains: string[];
  scout_queries: string[];
  agent_goals: Record<string, string>;
  d1_database_id_env: string;
  rebuild_hook_env: string;
  site_url_env: string;
  github_repo_env: string;
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

function isMonetisationMode(value: unknown): value is MonetisationMode {
  return (MONETISATION_MODES as readonly unknown[]).includes(value);
}

/** Throws unless `timeZone` is an IANA zone this runtime can format dates in. */
function assertTimeZone(edition: Pick<Edition, 'platformId' | 'id' | 'timeZone'>): void {
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
    platformId: row.platform_id,
    id: row.id,
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
  if (!isMonetisationMode(row.monetisation)) {
    throw new Error(`platform "${row.id}" has an unknown monetisation mode "${row.monetisation}"`);
  }
  return deepFreeze({
    id: row.id,
    name: row.name,
    brandText: row.brand_text,
    audience: row.audience,
    categories: row.categories,
    postTypes: row.post_types,
    articleShapes: row.article_shapes,
    editorialRules: row.editorial_rules,
    monetisation: row.monetisation,
    blockedLinkDomains: row.blocked_link_domains,
    scoutQueries: row.scout_queries,
    agentGoals: row.agent_goals,
    publishTarget: {
      d1DatabaseIdEnv: row.d1_database_id_env,
      rebuildHookEnv: row.rebuild_hook_env,
      siteUrlEnv: row.site_url_env,
      githubRepoEnv: row.github_repo_env,
    },
    editions,
    profileVersion: row.profile_version,
  });
}

/** Read platforms (all of them, or just `id`) fresh from the database and cache them. */
async function readPlatforms(id?: string): Promise<Platform[]> {
  const [platformRows, editionRows] = await Promise.all([
    q<PlatformDbRow>(
      `SELECT p.*,
              (SELECT v.id FROM platform_profile_versions v
                WHERE v.platform_id = p.id ORDER BY v.version DESC LIMIT 1) AS profile_version
         FROM platforms p
        WHERE $1::text IS NULL OR p.id = $1
        ORDER BY p.created_at, p.id`,
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

function requireId(id: unknown): string {
  if (typeof id !== 'string' || !id.trim()) throw new UnknownPlatformError(id);
  return id;
}

/**
 * The platform `id`, with its editions. Throws UnknownPlatformError for a
 * missing or unknown id. The result is shared and frozen.
 */
export async function loadPlatform(id: string): Promise<Platform> {
  const platformId = requireId(id);
  const cached = cache.get(platformId);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached.platform;
  const [platform] = await readPlatforms(platformId);
  if (!platform) throw new UnknownPlatformError(platformId);
  return platform;
}

/** Every platform with its editions, oldest first. */
export async function listPlatforms(): Promise<Platform[]> {
  return readPlatforms();
}

/**
 * One edition of one platform. Throws for an unknown platform or an edition it
 * does not have. An edition inserted since the platform was cached is found:
 * a miss is re-checked against the database before it is reported.
 */
export async function getEdition(platformId: string, editionId: string): Promise<Edition> {
  const find = (platform: Platform) => platform.editions.find((e) => e.id === editionId);
  const platform = await loadPlatform(platformId);
  if (typeof editionId !== 'string' || !editionId.trim()) {
    throw new UnknownEditionError(platform.id, editionId);
  }
  let edition = find(platform);
  if (!edition) {
    const [fresh] = await readPlatforms(platform.id);
    edition = fresh && find(fresh);
  }
  if (!edition) throw new UnknownEditionError(platform.id, editionId);
  return edition;
}

function validateProfile(profile: PlatformProfile, author: string): void {
  requireId(profile.id);
  if (!author.trim()) throw new Error('a profile version needs an author');
  if (!isMonetisationMode(profile.monetisation)) {
    throw new Error(`platform "${profile.id}" has an unknown monetisation mode "${profile.monetisation}"`);
  }
  for (const edition of profile.editions) {
    if (edition.platformId !== profile.id) {
      throw new Error(`edition "${edition.id}" belongs to "${edition.platformId}", not "${profile.id}"`);
    }
    assertTimeZone(edition);
  }
}

/** Upsert the platform and its editions and append the version recording it. */
async function writeProfile(
  client: pg.PoolClient,
  profile: PlatformProfile,
  author: string,
): Promise<number> {
  const target = profile.publishTarget;
  // The upsert locks the platform row for the rest of the transaction, which
  // is what serialises two edits racing for the next version number.
  await client.query(
    `INSERT INTO platforms
       (id, name, brand_text, audience, categories, post_types, article_shapes, editorial_rules,
        monetisation, blocked_link_domains, scout_queries, agent_goals,
        d1_database_id_env, rebuild_hook_env, site_url_env, github_repo_env)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10::jsonb, $11::jsonb,
             $12::jsonb, $13, $14, $15, $16)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name, brand_text = EXCLUDED.brand_text, audience = EXCLUDED.audience,
       categories = EXCLUDED.categories, post_types = EXCLUDED.post_types,
       article_shapes = EXCLUDED.article_shapes, editorial_rules = EXCLUDED.editorial_rules,
       monetisation = EXCLUDED.monetisation, blocked_link_domains = EXCLUDED.blocked_link_domains,
       scout_queries = EXCLUDED.scout_queries, agent_goals = EXCLUDED.agent_goals,
       d1_database_id_env = EXCLUDED.d1_database_id_env,
       rebuild_hook_env = EXCLUDED.rebuild_hook_env, site_url_env = EXCLUDED.site_url_env,
       github_repo_env = EXCLUDED.github_repo_env, updated_at = now()`,
    [
      profile.id,
      profile.name,
      profile.brandText,
      profile.audience,
      JSON.stringify(profile.categories),
      JSON.stringify(profile.postTypes),
      JSON.stringify(profile.articleShapes),
      profile.editorialRules,
      profile.monetisation,
      JSON.stringify(profile.blockedLinkDomains),
      JSON.stringify(profile.scoutQueries),
      JSON.stringify(profile.agentGoals),
      target.d1DatabaseIdEnv,
      target.rebuildHookEnv,
      target.siteUrlEnv,
      target.githubRepoEnv,
    ],
  );
  // Editions are upserted, never deleted: articles keep referencing an
  // edition a later profile no longer lists.
  for (const edition of profile.editions) {
    await client.query(
      `INSERT INTO editions
         (platform_id, id, name, time_zone, currency, locale, scout_queries, compliance_footer)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       ON CONFLICT (platform_id, id) DO UPDATE SET
         name = EXCLUDED.name, time_zone = EXCLUDED.time_zone, currency = EXCLUDED.currency,
         locale = EXCLUDED.locale, scout_queries = EXCLUDED.scout_queries,
         compliance_footer = EXCLUDED.compliance_footer, updated_at = now()`,
      [
        profile.id,
        edition.id,
        edition.name,
        edition.timeZone,
        edition.currency,
        edition.locale,
        JSON.stringify(edition.scoutQueries),
        edition.complianceFooter,
      ],
    );
  }
  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO platform_profile_versions (platform_id, version, profile, author)
     SELECT $1, COALESCE(MAX(version), 0) + 1, $2::jsonb, $3
       FROM platform_profile_versions WHERE platform_id = $1
     RETURNING id`,
    [profile.id, JSON.stringify(profile), author],
  );
  return rows[0].id;
}

async function inTransaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Save a platform's whole profile as its new current version, recording who
 * made the edit. Returns the platform_profile_versions id.
 */
export async function savePlatformProfile(profile: PlatformProfile, author: string): Promise<number> {
  validateProfile(profile, author);
  try {
    return await inTransaction((client) => writeProfile(client, profile, author));
  } finally {
    cache.delete(profile.id);
  }
}

/**
 * Write each seed profile that has never been saved. A platform with any
 * version already is left alone: from its first save on, the database copy is
 * the one operators edit, and a deploy must not put the code copy back over it.
 */
export async function seedPlatforms(): Promise<void> {
  for (const profile of SEED_PROFILES) validateProfile(profile, 'seed');
  await inTransaction(async (client) => {
    // Instances booting together would otherwise both see "never seeded".
    await client.query("SELECT pg_advisory_xact_lock(hashtext('platform_seed'))");
    for (const profile of SEED_PROFILES) {
      const { rowCount } = await client.query(
        'SELECT 1 FROM platform_profile_versions WHERE platform_id = $1 LIMIT 1',
        [profile.id],
      );
      if (rowCount === 0) await writeProfile(client, profile, 'seed');
    }
  });
  clearPlatformCache();
}
