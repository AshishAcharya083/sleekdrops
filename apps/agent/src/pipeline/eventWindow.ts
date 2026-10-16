// When an event-bound article (a match preview) may still be worked on.
//
// A preview is worth something only before its event starts, and only if a
// reader has time to see it. So no stage starts once the event is closer than
// EVENT_LEAD_HOURS - the article is held in the queue rather than claimed - and
// an article that is still unfinished at kick-off is dropped, with the reason
// on the card. "Event-bound" means `event_starts_at IS NOT NULL`, everywhere;
// every other article is untouched by this module.
//
// The publisher refuses to publish after kick-off on its own (SLE-141), so a
// run that is already past this check when the event starts still cannot put a
// stale preview on the site.
import { q } from '../db/pool.js';
import { createLogger } from '../lib/log.js';
import type { ArticleRow } from './types.js';

const log = createLogger('event-window');

/** No stage starts for an event-bound article this close to its event. */
export const EVENT_LEAD_HOURS = 6;

/** The recorded reason an unfinished event-bound article was dropped. */
export const EVENT_STARTED_ERROR = 'event started before the preview finished';

const EVENT_LEAD_MS = EVENT_LEAD_HOURS * 3_600_000;

/**
 * The claim-side rule in SQL, on the database clock: an article that is not
 * event-bound, or whose event is still more than EVENT_LEAD_HOURS away.
 */
export function stageMayStartSql(alias: string): string {
  return `(${alias}.event_starts_at IS NULL OR now() < ${alias}.event_starts_at - make_interval(hours => ${EVENT_LEAD_HOURS}))`;
}

type EventStart = string | Date | null;

export function stageMayStart(eventStartsAt: EventStart, now: Date = new Date()): boolean {
  if (eventStartsAt === null) return true;
  return now.getTime() < new Date(eventStartsAt).getTime() - EVENT_LEAD_MS;
}

export function eventStarted(eventStartsAt: EventStart, now: Date = new Date()): boolean {
  if (eventStartsAt === null) return false;
  return now.getTime() >= new Date(eventStartsAt).getTime();
}

/** Statuses an article can still move on from - everything but done and cancelled. */
const UNFINISHED = "('queued', 'running', 'failed', 'timed_out', 'waiting_approval')";

/**
 * Drop every unfinished event-bound article whose event has started. Run from
 * the worker's reaper sweep, so it reaches articles nobody is claiming: one
 * held in the queue by the lead window, one waiting for publish approval, one
 * that failed and was never retried.
 *
 * A running article is dropped the way a cancel drops it: its lease is
 * expired in the same statement, so the run holding it finds the claim gone
 * at its next heartbeat and stops without writing. 'cancelled' rather than
 * 'failed' because nothing about the content went wrong - the window closed.
 */
export async function dropStartedEvents(): Promise<number> {
  const dropped = await q<{ id: string; platform_id: string; event_starts_at: string }>(
    `UPDATE articles
     SET status = 'cancelled', error = $1,
         lease_expires_at = CASE WHEN status = 'running' THEN now() ELSE lease_expires_at END,
         updated_at = now()
     WHERE event_starts_at IS NOT NULL AND event_starts_at <= now()
       AND stage <> 'done' AND status IN ${UNFINISHED}
     RETURNING id, platform_id, event_starts_at`,
    [EVENT_STARTED_ERROR],
  );
  if (dropped.length === 0) return 0;
  await q(
    `UPDATE agent_sessions SET status = 'failed', error = $2, ended_at = now()
     WHERE article_id = ANY($1) AND status = 'running'`,
    [dropped.map((row) => row.id), EVENT_STARTED_ERROR],
  );
  for (const row of dropped) {
    log.warn('event-bound article dropped: its event started', {
      article_id: row.id,
      platform_id: row.platform_id,
      event_starts_at: row.event_starts_at,
    });
  }
  return dropped.length;
}

/**
 * The last check before a claimed stage runs, on this process's clock. The
 * claim already filtered on the database clock (stageMayStartSql), so this
 * only acts when the two disagree or the claim straddled the boundary: past
 * kick-off the article is dropped, inside the lead window the claim is handed
 * back so the article waits in the queue. Both writes are guarded on the claim.
 *
 * Returns true when the stage may run.
 */
export async function admitClaimed(article: ArticleRow, now: Date = new Date()): Promise<boolean> {
  if (stageMayStart(article.event_starts_at, now)) return true;
  const claim = [article.id, article.claimed_by];
  if (eventStarted(article.event_starts_at, now)) {
    await q(
      `UPDATE articles
       SET status = 'cancelled', error = $3, claimed_by = NULL, claimed_at = NULL,
           heartbeat_at = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'running' AND claimed_by IS NOT DISTINCT FROM $2`,
      [...claim, EVENT_STARTED_ERROR],
    );
    log.warn('event-bound article dropped at claim: its event started', {
      article_id: article.id,
      event_starts_at: article.event_starts_at,
    });
  } else {
    await q(
      `UPDATE articles
       SET status = 'queued', claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL,
           lease_expires_at = NULL
       WHERE id = $1 AND status = 'running' AND claimed_by IS NOT DISTINCT FROM $2`,
      claim,
    );
  }
  return false;
}
