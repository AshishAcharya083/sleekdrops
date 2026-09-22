// The lease a worker holds on the article it is running a stage for.
//
// A claim used to be a `claimed_by` and a `claimed_at`, both written once. That
// records who started, and nothing about whether they are still there - which
// is why a wedged stage was indistinguishable from a slow one until someone
// restarted the container. A lease is the claim plus an expiry the holder has
// to keep pushing forward: while the worker is alive it renews, and the moment
// it is not, the lease runs out on its own and the reaper can act on it.
//
// The renewal is conditional on the claim it was taken under, and that is the
// load-bearing part. A renewal that updates no row means the article is no
// longer this run's: it was reaped, cancelled, or claimed by someone else. The
// run that discovers this has to stop and write nothing, because whatever it
// is holding describes an article that has moved on - a late answer landing on
// top of the claim that replaced it is how a timed-out run resurrects itself.
//
// Shared by the worker (which takes the lease as it claims) and the runner
// (which renews it while the stage runs), so the two can never disagree about
// how long a claim is good for.
import { q } from '../db/pool.js';
import { STAGE_HEARTBEAT_SECONDS } from './budgets.js';

/**
 * How long a claim stays valid without a renewal. Long enough to survive a
 * handful of missed heartbeats - a GC pause, a slow database, a redeploy of
 * the API in front of it - and far below any stage budget, so a dead worker is
 * noticed in minutes rather than at the end of the stage's hour.
 */
export const STAGE_LEASE_SECONDS = 300;

/** Renewal interval. Ten chances to renew before the lease lapses. */
export const HEARTBEAT_MS = STAGE_HEARTBEAT_SECONDS * 1000;

/** What a run is told when the article it was working is no longer its own. */
export const LEASE_LOST_MESSAGE = 'lease lost - the run was cancelled or reaped';

/**
 * The claim this run was holding is gone. Routed like a timeout - the stage is
 * abandoned where it stands - but recorded as a failed session, because
 * something else has already written the outcome this article actually has.
 */
export class LeaseLostError extends Error {
  constructor() {
    super(LEASE_LOST_MESSAGE);
    this.name = 'LeaseLostError';
  }
}

/** The lease columns, cleared. Spread into the update that ends a stage run. */
export const LEASE_RELEASED = {
  claimed_by: null,
  claimed_at: null,
  heartbeat_at: null,
  lease_expires_at: null,
} as const;

/**
 * Push this article's lease forward, but only for the claim that took it.
 * Returns false when the row is no longer running under `claimedBy` -
 * cancelled from the panel, reaped, or claimed again by another worker - which
 * is the heartbeat's signal that this run's claim is gone.
 */
export async function renewLease(articleId: string, claimedBy: string): Promise<boolean> {
  const renewed = await q(
    `UPDATE articles
     SET heartbeat_at = now(), lease_expires_at = now() + make_interval(secs => $3)
     WHERE id = $1 AND status = 'running' AND claimed_by = $2
     RETURNING id`,
    [articleId, claimedBy, STAGE_LEASE_SECONDS],
  );
  return renewed.length > 0;
}

/**
 * The claim a run is working under. Every write that run makes is conditional
 * on it still holding: same row, same status, same holder.
 */
export interface ClaimedArticle {
  id: string;
  status: string;
  claimed_by: string | null;
}

/**
 * Write to the article this run is working, and only while the claim it
 * started under still holds. A run that was reaped, cancelled or claimed again
 * can still be in flight - a promise has no cancel - and nothing it produces
 * after that describes the article any more.
 *
 * `claimed_by` carries a token unique to the claim (worker.ts
 * `claimIdentity()`), so "claimed again by the same worker process" fails this
 * guard exactly as another worker's claim does.
 */
export async function updateClaimed(
  article: ClaimedArticle,
  fields: Record<string, unknown>,
): Promise<boolean> {
  const keys = Object.keys(fields);
  const sets = keys.map((key, i) => `${key} = $${i + 4}`).join(', ');
  const applied = await q(
    `UPDATE articles SET ${sets}, updated_at = now()
     WHERE id = $1 AND status = $2 AND claimed_by IS NOT DISTINCT FROM $3
     RETURNING id`,
    [article.id, article.status, article.claimed_by ?? null, ...keys.map((key) => fields[key])],
  );
  return applied.length > 0;
}

/**
 * The same question without a write, for the work that happens outside the
 * database: whether this run may still act for this article at all. The
 * publisher asks it before pushing to the live site, because that push is not
 * an article write the guard above could drop.
 */
export async function claimHeld(article: ClaimedArticle): Promise<boolean> {
  const held = await q(
    `SELECT 1 FROM articles
      WHERE id = $1 AND status = $2 AND claimed_by IS NOT DISTINCT FROM $3`,
    [article.id, article.status, article.claimed_by ?? null],
  );
  return held.length > 0;
}

/**
 * Renew this article's lease every HEARTBEAT_MS until the returned function is
 * called, and say so the first time a renewal finds the claim gone. Unref'd: a
 * heartbeat is not a reason for the process to stay alive. The interval is a
 * parameter only so a test can watch a claim being lost without waiting out a
 * real one.
 *
 * A renewal that throws is reported and retried - a database blip is not proof
 * the claim is gone, and the lease has several renewals' worth of slack for
 * exactly that. Only a renewal that succeeds in updating nothing is proof.
 */
export function startHeartbeat(
  articleId: string,
  claimedBy: string,
  handlers: { onLost: () => void; onError: (err: unknown) => void },
  intervalMs: number = HEARTBEAT_MS,
): () => void {
  const timer = setInterval(() => {
    void renewLease(articleId, claimedBy)
      .then((held) => {
        if (held) return;
        clearInterval(timer);
        handlers.onLost();
      })
      .catch(handlers.onError);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
