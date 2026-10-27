// Where one platform publishes: its content database, its site, its
// repository and what rebuilds it. The platform row only names the environment variables that
// hold these (platform/types.ts); this is the one place they are read, at the
// moment a publish needs them. Nothing falls back to another platform's value
// or to a built-in default - a PeakOdds piece with no PeakOdds database
// configured must fail, not land in SleekDrops'.
import { listPlatforms, loadPlatform } from './registry.js';
import type { Platform } from './types.js';

export interface ResolvedPublishTarget {
  /**
   * Postgres connection string of the database holding the platform's posts
   * and affiliate_links tables. A credential: never logged, never put in an
   * error message - those name the variable it came from instead.
   */
  contentDatabaseUrl: string;
  /** owner/repo the content-updated dispatch is sent to. */
  githubRepo: string;
  /** Origin the site deploys to, with no trailing slash. */
  siteUrl: string;
  /** A deploy hook to POST, or null to send the repository dispatch instead. */
  rebuildHookUrl: string | null;
}

/**
 * The credential a repository-dispatch rebuild is fired with. A platform with
 * no rebuildHookEnv rebuilds by dispatch to its own repo; one that names a
 * variable must hold a deploy-hook URL there.
 */
export const DISPATCH_TOKEN_ENV = 'GITHUB_TOKEN';

export class PublishTargetError extends Error {
  constructor(platformId: string, problem: string) {
    super(`publish target for ${platformId}: ${problem}`);
    this.name = 'PublishTargetError';
  }
}

type TargetSource = Pick<Platform, 'id' | 'publishTarget'>;

function required(platform: TargetSource, envName: string): string {
  const value = process.env[envName]?.trim();
  if (!value) throw new PublishTargetError(platform.id, `${envName} is not set`);
  return value;
}

function httpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

// The two parts some callers need on their own, so that a read of what is
// published (the corpus scan, the scout's avoid-list) or a distribution check
// against the live site does not also demand the rebuild credentials. Each
// throws like resolvePublishTarget when its variable is missing.

export function resolveContentTarget(
  platform: TargetSource,
): Pick<ResolvedPublishTarget, 'contentDatabaseUrl'> {
  const envName = platform.publishTarget.contentDatabaseUrlEnv;
  const contentDatabaseUrl = required(platform, envName);
  // Named in the message by variable only: the value carries a password. A
  // leftover D1 database id is the likely mistake, and it is not a URL.
  if (!/^postgres(ql)?:\/\//.test(contentDatabaseUrl)) {
    throw new PublishTargetError(platform.id, `${envName} must be a postgres:// connection string`);
  }
  return { contentDatabaseUrl };
}

export function resolveSiteTarget(platform: TargetSource): Pick<ResolvedPublishTarget, 'siteUrl'> {
  const envName = platform.publishTarget.siteUrlEnv;
  const siteUrl = required(platform, envName).replace(/\/+$/, '');
  if (!httpUrl(siteUrl)) throw new PublishTargetError(platform.id, `${envName} must be an http(s) URL`);
  return { siteUrl };
}

/** Read `platform`'s publish target from the environment. Throws PublishTargetError naming the first variable missing. */
export function resolvePublishTarget(platform: TargetSource): ResolvedPublishTarget {
  const ref = platform.publishTarget;
  const { contentDatabaseUrl } = resolveContentTarget(platform);

  const githubRepo = required(platform, ref.githubRepoEnv);
  if (!/^[\w.-]+\/[\w.-]+$/.test(githubRepo)) {
    throw new PublishTargetError(platform.id, `${ref.githubRepoEnv} must be owner/repo`);
  }

  const { siteUrl } = resolveSiteTarget(platform);

  let rebuildHookUrl: string | null = null;
  if (ref.rebuildHookEnv === null) {
    required(platform, DISPATCH_TOKEN_ENV);
  } else {
    const hook = required(platform, ref.rebuildHookEnv);
    // Named in the message by variable only: a deploy hook URL is a credential.
    if (!httpUrl(hook)) {
      throw new PublishTargetError(platform.id, `${ref.rebuildHookEnv} must be an http(s) deploy hook URL`);
    }
    rebuildHookUrl = hook;
  }

  return { contentDatabaseUrl, githubRepo, siteUrl, rebuildHookUrl };
}

/** The publish target of the platform `platformId`. */
export async function publishTargetFor(platformId: string): Promise<ResolvedPublishTarget> {
  return resolvePublishTarget(await loadPlatform(platformId));
}

/** The content database of the platform `platformId`. */
export async function contentTargetFor(
  platformId: string,
): Promise<Pick<ResolvedPublishTarget, 'contentDatabaseUrl'>> {
  return resolveContentTarget(await loadPlatform(platformId));
}

/** The site of the platform `platformId`. */
export async function siteTargetFor(platformId: string): Promise<Pick<ResolvedPublishTarget, 'siteUrl'>> {
  return resolveSiteTarget(await loadPlatform(platformId));
}

/**
 * The target, refused when another platform's configuration points at the
 * same content database or site. Two brands sharing either is always a
 * misconfiguration - an env var copied from one platform to the other - and
 * publishing through it would put one brand's piece on the other's site.
 */
export async function resolveIsolatedPublishTarget(platform: TargetSource): Promise<ResolvedPublishTarget> {
  const target = resolvePublishTarget(platform);
  for (const other of await listPlatforms()) {
    if (other.id === platform.id) continue;
    const otherRef = other.publishTarget;
    const otherDatabase = process.env[otherRef.contentDatabaseUrlEnv]?.trim();
    if (otherDatabase && otherDatabase === target.contentDatabaseUrl) {
      throw new PublishTargetError(
        platform.id,
        `${platform.publishTarget.contentDatabaseUrlEnv} names the same content database as ${other.id}'s ${otherRef.contentDatabaseUrlEnv}`,
      );
    }
    const otherSite = process.env[otherRef.siteUrlEnv]?.trim().replace(/\/+$/, '');
    if (otherSite && otherSite === target.siteUrl) {
      throw new PublishTargetError(
        platform.id,
        `${platform.publishTarget.siteUrlEnv} names the same site as ${other.id}'s ${otherRef.siteUrlEnv}`,
      );
    }
  }
  return target;
}
