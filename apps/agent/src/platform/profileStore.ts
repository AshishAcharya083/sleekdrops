// The editable part of a platform's profile, and its version history.
//
// Every save is a new `platform_profile_versions` row carrying the whole
// editable snapshot, its author and its time, applied to `platforms` and
// `editions` in the same transaction. What an article was written under is
// therefore always recoverable: `articles.profile_version` points at the row.
//
// Only prompt-facing text is editable here. Categories, post types, shapes,
// monetisation, blocked domains and topics, the publish target and an
// edition's time zone, locale and currency shape what the pipeline produces
// and where it goes, so they change in code, not from the panel.
import { z } from 'zod';
import { pool, q } from '../db/pool.js';
import { clearPlatformCache } from './registry.js';
import type { AgentId, Platform } from './types.js';

export const AGENT_IDS: readonly AgentId[] = [
  'scout',
  'research',
  'keyword',
  'angle',
  'outline',
  'write',
  'seo_review',
  'edit',
  'assemble',
  'image',
];

export interface EditableEdition {
  id: string;
  scout_queries: string[];
  compliance_footer: string;
}

export interface EditableProfile {
  brand_text: string;
  audience: string;
  editorial_rules: string;
  agent_goals: Partial<Record<AgentId, string>>;
  scout_queries: string[];
  editions: EditableEdition[];
}

export interface ProfileVersion {
  version: number;
  author: string;
  created_at: string;
  profile: EditableProfile;
}

export interface ProfileUpdate {
  baseVersion: number;
  author: string;
  profile: EditableProfile;
}

/** The PUT was valid but written against a version that is no longer current. */
export class StaleProfileError extends Error {
  constructor(readonly currentVersion: number) {
    super('profile changed since you loaded it');
  }
}

const MAX_TEXT_CHARS = 20_000;
const MAX_QUERIES = 100;
const MAX_QUERY_CHARS = 300;
const MAX_AUTHOR_CHARS = 100;

// Prose is stored exactly as typed: trimming it would change the bytes of
// every prompt built from it on the first save, even one that edited nothing.
const prose = z.string().max(MAX_TEXT_CHARS);
const required = prose.refine((value) => value.trim() !== '', 'must not be empty');
const queries = z.array(z.string().trim().min(1).max(MAX_QUERY_CHARS)).max(MAX_QUERIES);

// Strict, so a field that is not editable (categories, monetisation, ...)
// is refused by name instead of being silently dropped from a save the
// operator thinks included it.
const profileSchema = z
  .object({
    brand_text: required,
    audience: prose,
    editorial_rules: required,
    agent_goals: z.record(z.string().max(MAX_TEXT_CHARS)),
    scout_queries: queries,
    editions: z.array(
      z
        .object({ id: z.string(), scout_queries: queries, compliance_footer: prose })
        .strict(),
    ),
  })
  .strict();

const updateSchema = z.object({
  base_version: z.number().int().positive(),
  author: z.string().trim().min(1).max(MAX_AUTHOR_CHARS),
  profile: z.unknown(),
});

function describeIssue(prefix: string, issue: z.ZodIssue): string {
  const path = [prefix, ...issue.path].filter((part) => part !== '').join('.');
  if (issue.code === 'unrecognized_keys') {
    return `${issue.keys.map((key) => [path, key].join('.')).join(', ')} not editable`;
  }
  return `${path}: ${issue.message}`;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Read a PUT body against the platform it is for. Editions the body leaves
 * out keep their current text; an edition the platform does not have, or one
 * named twice, is refused.
 */
export function parseProfileUpdate(body: unknown, platform: Platform): Parsed<ProfileUpdate> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'expected a JSON body with base_version, author and profile' };
  }
  const envelope = updateSchema.safeParse(body);
  if (!envelope.success) return { ok: false, error: describeIssue('', envelope.error.issues[0]) };
  const parsed = profileSchema.safeParse(envelope.data.profile);
  if (!parsed.success) return { ok: false, error: describeIssue('profile', parsed.error.issues[0]) };
  const profile = parsed.data;

  const goals: Partial<Record<AgentId, string>> = {};
  for (const [agent, goal] of Object.entries(profile.agent_goals)) {
    if (!(AGENT_IDS as readonly string[]).includes(agent)) {
      return { ok: false, error: `unknown agent id: ${agent}` };
    }
    // An emptied goal is a goal removed, not a blank line in the prompt.
    if (goal.trim() !== '') goals[agent as AgentId] = goal;
  }

  const seen = new Set<string>();
  for (const edition of profile.editions) {
    if (!platform.editions.some((own) => own.id === edition.id)) {
      return { ok: false, error: `edition ${edition.id} does not belong to ${platform.id}` };
    }
    if (seen.has(edition.id)) return { ok: false, error: `edition ${edition.id} is listed twice` };
    seen.add(edition.id);
  }

  return {
    ok: true,
    value: {
      baseVersion: envelope.data.base_version,
      author: envelope.data.author,
      profile: { ...profile, agent_goals: goals },
    },
  };
}

interface VersionRow {
  version: number;
  author: string;
  created_at: Date;
  profile: EditableProfile;
}

function toProfileVersion(row: VersionRow): ProfileVersion {
  return {
    version: row.version,
    author: row.author,
    created_at: row.created_at.toISOString(),
    profile: row.profile,
  };
}

/** The version in force, or null for a platform that has none recorded. */
export async function currentProfileVersion(platformId: string): Promise<ProfileVersion | null> {
  const [row] = await q<VersionRow>(
    `SELECT v.version, v.author, v.created_at, v.profile
       FROM platforms p JOIN platform_profile_versions v ON v.id = p.profile_version
      WHERE p.id = $1`,
    [platformId],
  );
  return row ? toProfileVersion(row) : null;
}

/** Every version of a platform's profile, newest first. */
export async function listProfileVersions(platformId: string): Promise<ProfileVersion[]> {
  const rows = await q<VersionRow>(
    `SELECT version, author, created_at, profile FROM platform_profile_versions
      WHERE platform_id = $1 ORDER BY version DESC`,
    [platformId],
  );
  return rows.map(toProfileVersion);
}

/**
 * Record `update` as the next version and put it in force, or throw
 * StaleProfileError when someone else saved since `baseVersion` was loaded.
 * The platform row is locked for the whole transaction, so two saves from the
 * same base cannot both succeed.
 */
export async function saveProfileVersion(
  platformId: string,
  update: ProfileUpdate,
): Promise<ProfileVersion> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: current } = await client.query<{ version: number | null }>(
      `SELECT v.version
         FROM platforms p LEFT JOIN platform_profile_versions v ON v.id = p.profile_version
        WHERE p.id = $1
        FOR UPDATE OF p`,
      [platformId],
    );
    const currentVersion = current[0]?.version ?? 0;
    if (currentVersion !== update.baseVersion) throw new StaleProfileError(currentVersion);

    const { rows: editions } = await client.query<EditableEdition>(
      `SELECT id, scout_queries, compliance_footer FROM editions
        WHERE platform_id = $1 ORDER BY id`,
      [platformId],
    );
    const edited = new Map(update.profile.editions.map((edition) => [edition.id, edition]));
    const profile: EditableProfile = {
      ...update.profile,
      editions: editions.map((edition) => edited.get(edition.id) ?? edition),
    };

    const { rows: inserted } = await client.query<VersionRow & { id: number }>(
      `INSERT INTO platform_profile_versions (platform_id, version, profile, author)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING id, version, author, created_at, profile`,
      [platformId, currentVersion + 1, JSON.stringify(profile), update.author],
    );
    await client.query(
      `UPDATE platforms
          SET brand_text = $2, audience = $3, editorial_rules = $4,
              agent_goals = $5::jsonb, scout_queries = $6::jsonb, profile_version = $7
        WHERE id = $1`,
      [
        platformId,
        profile.brand_text,
        profile.audience,
        profile.editorial_rules,
        JSON.stringify(profile.agent_goals),
        JSON.stringify(profile.scout_queries),
        inserted[0].id,
      ],
    );
    for (const edition of profile.editions) {
      await client.query(
        `UPDATE editions SET scout_queries = $3::jsonb, compliance_footer = $4
          WHERE platform_id = $1 AND id = $2`,
        [platformId, edition.id, JSON.stringify(edition.scout_queries), edition.compliance_footer],
      );
    }
    await client.query('COMMIT');
    clearPlatformCache();
    return toProfileVersion(inserted[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
