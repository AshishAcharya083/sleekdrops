// The lease a worker holds on the article it is running a stage for.
//
// A claim used to be a `claimed_by` and a `claimed_at`, both written once. That
// records who started, and nothing about whether they are still there - which
// is why a wedged stage was indistinguishable from a slow one until someone
// restarted the container. A lease is the claim plus an expiry the holder has
// to keep pushing forward: while the worker is alive it renews, and the moment
// it is not, the lease runs out on its own and the reaper can act on it.
//
// Shared by the worker (which takes the lease as it claims) and the runner
// (which renews it while the stage runs), so the two can never disagree about
// how long a claim is good for.
import { q } from '../db/pool.js';

/**
 * How long a claim stays valid without a renewal. Long enough to survive a
 * handful of missed heartbeats - a GC pause, a slow database, a redeploy of
 * the API in front of it - and far below any stage budget, so a dead worker is
 * noticed in minutes rather than at the end of the stage's hour.
 */
export const STAGE_LEASE_SECONDS = 300;

/** Renewal interval. Five chances to renew before the lease lapses. */
export const HEARTBEAT_MS = 60_000;

/** The lease columns, cleared. Spread into the update that ends a stage run. */
export const LEASE_RELEASED = {
  claimed_by: null,
  claimed_at: null,
  heartbeat_at: null,
  lease_expires_at: null,
} as const;

/**
 * Push this article's lease forward. Returns false when the row is no longer
 * running - cancelled from the panel, or already reaped - which is the
 * heartbeat's signal that its claim is gone.
 */
export async function renewLease(articleId: string): Promise<boolean> {
  const renewed = await q(
    `UPDATE articles
     SET heartbeat_at = now(), lease_expires_at = now() + make_interval(secs => $2)
     WHERE id = $1 AND status = 'running'
     RETURNING id`,
    [articleId, STAGE_LEASE_SECONDS],
  );
  return renewed.length > 0;
}

/**
 * Renew this article's lease every HEARTBEAT_MS until the returned function is
 * called. Unref'd: a heartbeat is not a reason for the process to stay alive.
 */
export function startHeartbeat(articleId: string, onError: (err: unknown) => void): () => void {
  const timer = setInterval(() => {
    void renewLease(articleId).catch(onError);
  }, HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}
