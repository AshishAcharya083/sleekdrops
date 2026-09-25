// Connected accounts: reading them, resolving their credentials, and saying
// how close their tokens are to lapsing.
//
// The credential never lives in this database. `channel_connections.token_ref`
// names a secret, and the name is resolved here at the moment it is needed:
// from the `channel_credentials` settings row (how a laptop and a test supply
// one), else from the environment, which is where Cloud Run mounts a Secret
// Manager secret. Nothing in this module returns a token to anything that
// logs, and no caller may put one in `last_error` - see redactToken.
import { getSetting, q, setSetting } from '../db/pool.js';
import { createLogger } from '../lib/log.js';
import { scrubSecrets } from '../pipeline/stageTimeout.js';
import type { ChannelConnectionRow, ChannelStatus } from './types.js';

const log = createLogger('distribution');

/**
 * How long before expiry a token counts as stale. A week is the smallest
 * window that still gives an operator a working week to re-authorise in.
 */
export const TOKEN_STALE_WINDOW_MS = 7 * 24 * 3_600_000;

/**
 * The env var a token_ref maps to when the credential comes from the
 * environment: `facebook-page-token` → `FACEBOOK_PAGE_TOKEN`. Secret Manager
 * secrets are named in kebab case and mounted on Cloud Run in upper snake, so
 * one reference covers both without a second column.
 */
export function credentialEnvName(ref: string): string {
  return ref.trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
}

/**
 * The secret `ref` names, or null when it is configured nowhere.
 *
 * Settings first: that is the one an operator can set without a redeploy, and
 * a rotated token pasted into the panel has to win over the stale value still
 * mounted in the environment.
 */
export async function resolveCredential(ref: string | null): Promise<string | null> {
  if (!ref) return null;
  const stored = await getSetting<Record<string, string>>('channel_credentials', {});
  const fromSettings = stored[ref];
  if (typeof fromSettings === 'string' && fromSettings !== '') return fromSettings;
  const fromEnv = process.env[credentialEnvName(ref)];
  return fromEnv ? fromEnv : null;
}

/**
 * A message that is safe to store on a queue row or print in a log.
 *
 * `scrubSecrets` already removes anything that matches an environment secret
 * or a known token shape; the resolved credential is passed in as well because
 * a channel token read out of the settings row is in no environment variable
 * and would otherwise survive the scan.
 */
export function redactToken(message: string, ...credentials: Array<string | null>): string {
  let text = scrubSecrets(message);
  for (const credential of credentials) {
    if (!credential || credential.length < 8) continue;
    text = text.split(credential).join('[redacted]');
  }
  return text;
}

/** How close a connection's token is to being unusable. */
export interface TokenStaleness {
  expiresAt: string | null;
  /** The token is past its expiry. Nothing may be posted with it. */
  expired: boolean;
  /** Inside TOKEN_STALE_WINDOW_MS of expiry - re-authorise before it lapses. */
  stale: boolean;
  /** Whole hours left, negative once expired. Null for a token that never expires. */
  hoursRemaining: number | null;
}

/**
 * Computed here rather than in the panel so the worker and the admin surface
 * cannot disagree about whether a connection can still post.
 */
export function tokenStaleness(expiresAt: string | null, now: Date = new Date()): TokenStaleness {
  if (!expiresAt) {
    return { expiresAt: null, expired: false, stale: false, hoursRemaining: null };
  }
  const remainingMs = new Date(expiresAt).getTime() - now.getTime();
  if (!Number.isFinite(remainingMs)) {
    // An unparseable timestamp is treated as expired: refusing to post is the
    // recoverable half of that mistake.
    return { expiresAt, expired: true, stale: true, hoursRemaining: null };
  }
  return {
    expiresAt,
    expired: remainingMs <= 0,
    stale: remainingMs <= TOKEN_STALE_WINDOW_MS,
    hoursRemaining: Math.floor(remainingMs / 3_600_000),
  };
}

/**
 * The staleness ladder the panel escalates through, calmest first: a heads-up
 * a month out, a warning inside the week the worker already treats as stale,
 * and a final day that reads the same as expired because it is one missed
 * working day from it. 'ok' covers a token that never expires or is further
 * out than a month.
 */
export type TokenTier = 'ok' | 'notice' | 'warning' | 'critical' | 'expired';

export const TOKEN_NOTICE_WINDOW_MS = 30 * 24 * 3_600_000;
export const TOKEN_CRITICAL_WINDOW_MS = 24 * 3_600_000;

export function tokenTier(expiresAt: string | null, now: Date = new Date()): TokenTier {
  const staleness = tokenStaleness(expiresAt, now);
  if (staleness.expired) return 'expired';
  if (!expiresAt) return 'ok';
  const remainingMs = new Date(expiresAt).getTime() - now.getTime();
  if (remainingMs <= TOKEN_CRITICAL_WINDOW_MS) return 'critical';
  if (staleness.stale) return 'warning';
  if (remainingMs <= TOKEN_NOTICE_WINDOW_MS) return 'notice';
  return 'ok';
}

/**
 * Where the secret a reference names is configured, never what it is. The
 * admin panel's credential readback is exactly this: present or not, and
 * whether an operator pasted it or the deployment mounted it.
 */
export type CredentialSource = 'panel' | 'environment';

export async function credentialSource(ref: string | null): Promise<CredentialSource | null> {
  if (!ref) return null;
  const stored = await getSetting<Record<string, string>>('channel_credentials', {});
  if (typeof stored[ref] === 'string' && stored[ref] !== '') return 'panel';
  return process.env[credentialEnvName(ref)] ? 'environment' : null;
}

/**
 * Keep a pasted credential under its reference in the `channel_credentials`
 * row, which /api/settings never returns. Nothing reads it back out except
 * `resolveCredential` at post time.
 */
export async function storeCredential(ref: string, value: string): Promise<void> {
  const stored = await getSetting<Record<string, string>>('channel_credentials', {});
  await setSetting('channel_credentials', { ...stored, [ref]: value });
}

/** Forget a pasted credential. A secret mounted in the environment is not ours to remove. */
export async function removeCredential(ref: string): Promise<void> {
  const stored = await getSetting<Record<string, string>>('channel_credentials', {});
  if (!(ref in stored)) return;
  const { [ref]: _removed, ...rest } = stored;
  await setSetting('channel_credentials', rest);
}

/**
 * Create the connection for one account on one network, or bring the existing
 * one back to 'active' with the reference and expiry just established. Keyed on
 * `channel_connections_account_idx`, so connecting the same Page twice is a
 * reconnect rather than a second channel posting everything twice.
 */
export async function upsertConnection(input: {
  provider: string;
  externalAccountId: string;
  displayName: string | null;
  tokenRef: string;
  expiresInSeconds: number | null;
}): Promise<ChannelConnectionRow> {
  const [row] = await q<ChannelConnectionRow>(
    `INSERT INTO channel_connections
       (provider, external_account_id, display_name, token_ref, expires_at, status)
     VALUES ($1, $2, $3, $4,
             CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(secs => $5) END,
             'active')
     ON CONFLICT (provider, external_account_id) DO UPDATE
       SET display_name = EXCLUDED.display_name, token_ref = EXCLUDED.token_ref,
           expires_at = EXCLUDED.expires_at, status = 'active', updated_at = now()
     RETURNING *`,
    [
      input.provider,
      input.externalAccountId,
      input.displayName,
      input.tokenRef,
      input.expiresInSeconds,
    ],
  );
  log.info('channel connected', {
    channel_connection_id: row.id,
    provider: row.provider,
    token_ref: row.token_ref,
  });
  return row;
}

/** Every connection that may currently be enqueued for or posted to. */
export async function activeConnections(): Promise<ChannelConnectionRow[]> {
  return q<ChannelConnectionRow>(
    `SELECT * FROM channel_connections WHERE status = 'active' ORDER BY provider, created_at`,
  );
}

export async function listConnections(): Promise<ChannelConnectionRow[]> {
  return q<ChannelConnectionRow>('SELECT * FROM channel_connections ORDER BY provider, created_at');
}

export async function getConnection(id: string): Promise<ChannelConnectionRow | null> {
  const [row] = await q<ChannelConnectionRow>('SELECT * FROM channel_connections WHERE id = $1', [
    id,
  ]);
  return row ?? null;
}

/**
 * The connection for one account on one network, however its status stands.
 *
 * Keyed the way `channel_connections_account_idx` is, because a provider call
 * that carries no queue item - reading a post's insights back, say - knows the
 * account it ran as and nothing else.
 */
export async function findConnection(
  provider: string,
  externalAccountId: string,
): Promise<ChannelConnectionRow | null> {
  const [row] = await q<ChannelConnectionRow>(
    'SELECT * FROM channel_connections WHERE provider = $1 AND external_account_id = $2',
    [provider, externalAccountId],
  );
  return row ?? null;
}

/**
 * Move a connection out of 'active' - a token the network rejected, an account
 * an operator disconnected. Logged by reference, never by value.
 */
export async function setConnectionStatus(id: string, status: ChannelStatus): Promise<void> {
  await q('UPDATE channel_connections SET status = $2, updated_at = now() WHERE id = $1', [
    id,
    status,
  ]);
  log.warn('channel connection status changed', { channel_connection_id: id, status });
}

/**
 * Record what an authenticate/refresh returned. The token value goes to
 * whatever holds the secret `token_ref` names; this only moves the expiry,
 * which is what staleness is derived from.
 */
export async function recordTokenExpiry(id: string, expiresInSeconds: number | null): Promise<void> {
  await q(
    `UPDATE channel_connections
     SET expires_at = CASE WHEN $2::int IS NULL THEN NULL ELSE now() + make_interval(secs => $2) END,
         status = 'active', updated_at = now()
     WHERE id = $1`,
    [id, expiresInSeconds],
  );
}
