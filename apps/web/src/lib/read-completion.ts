/**
 * Read completion - one engagement signal per article page view, and
 * deliberately only one.
 *
 * The publisher-grade version of this measurement (Chartbeat's Engaged Time)
 * counts only seconds the tab was actually in front of the reader and pauses on
 * blur, which is why it disagrees with a naive time-on-page. The pragmatic
 * equivalent implemented here is a two-part gate: the reader has to cross a
 * sentinel at the end of the article body **and** to have accrued at least
 * `READ_ACTIVE_MS` of active time. Scroll alone says nothing - a short deal page
 * is fully scrolled the moment it loads - and time alone says nothing either,
 * because a tab left open overnight accrues plenty of it.
 *
 * What this deliberately is not: a 25/50/75/90 scroll ladder. That multiplies
 * event volume roughly fourfold per page view, measures page length rather than
 * reader interest, and is superseded by the gate above.
 *
 * Pure and injectable (the `./visit` pattern): the clock is a parameter, so the
 * gate and the bucketing are unit-tested without a DOM or a timer. The impure
 * half - the IntersectionObserver and the visibility listener - lives in
 * `src/scripts/chrome.ts`.
 */

/** Active time a reader must accrue before reaching the end counts as a read. */
export const READ_ACTIVE_MS = 30_000;

/** The bucket labels reported as the `active_time` property. */
export type ActiveTimeBucket = '0-15s' | '15-60s' | '60s+';

const FIFTEEN_SECONDS_MS = 15_000;
const SIXTY_SECONDS_MS = 60_000;

/**
 * Report active time as one of three buckets rather than as raw milliseconds.
 * A millisecond count is effectively unique per page view, which makes it
 * unusable as an analytics dimension and expensive to store; three buckets
 * answer the only question asked of it - skim, read, or study.
 */
export function activeTimeBucket(elapsedMs: number): ActiveTimeBucket {
  if (!(elapsedMs >= FIFTEEN_SECONDS_MS)) return '0-15s';
  if (elapsedMs < SIXTY_SECONDS_MS) return '15-60s';
  return '60s+';
}

/**
 * A stopwatch that runs only while the page is in front of the reader.
 *
 * Starts running, because a page load the reader is looking at is the normal
 * case; a caller that knows the document opened hidden - a background tab
 * restore - pauses it immediately rather than waiting for a visibility change
 * that may be minutes away.
 */
export class ActiveTime {
  private accruedMs = 0;
  private since: number | null;

  constructor(startedAtMs: number) {
    this.since = startedAtMs;
  }

  /** Stop accruing - the tab was hidden or the window lost focus. */
  pause(atMs: number): void {
    if (this.since === null) return;
    this.accruedMs += Math.max(0, atMs - this.since);
    this.since = null;
  }

  /** Start accruing again. A resume while already running is a no-op. */
  resume(atMs: number): void {
    if (this.since !== null) return;
    this.since = atMs;
  }

  /** Active milliseconds accrued so far. */
  elapsed(atMs: number): number {
    return this.since === null ? this.accruedMs : this.accruedMs + Math.max(0, atMs - this.since);
  }
}

/**
 * The two-part gate, and the guarantee that it opens at most once per page
 * view: `shouldEmit` returns true for exactly one call, however many times the
 * sentinel is crossed or the timer re-checks.
 */
export class ReadCompletionGate {
  private reachedEnd = false;
  private emitted = false;

  /** Record that the reader crossed the end-of-body sentinel. */
  reachEnd(): void {
    this.reachedEnd = true;
  }

  /**
   * True the first time both halves of the gate hold: the sentinel was crossed
   * and `activeMs` has reached the threshold.
   */
  shouldEmit(activeMs: number): boolean {
    if (this.emitted || !this.reachedEnd || activeMs < READ_ACTIVE_MS) return false;
    this.emitted = true;
    return true;
  }
}
