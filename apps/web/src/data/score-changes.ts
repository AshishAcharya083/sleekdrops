/**
 * Every change to a published score: the score-change log on /how-we-rate and
 * the "Retested" note beside a review's score both read it.
 *
 * A score moves only through a re-check, a new method version or a correction,
 * and each move is recorded here with the old score, the new one and the
 * reason, so the log is the public record that no commercial party changed a
 * number. Empty until the first published score changes.
 */

import type { MethodVersion } from '../lib/trust.ts';

export interface ScoreChange {
  /** Slug of the review whose score changed (/blog/<slug>). */
  slug: string;
  /** The day the new score was published, YYYY-MM-DD. */
  date: string;
  /** 1-5, one decimal. */
  from: number;
  /** 1-5, one decimal. */
  to: number;
  /** The method version the new score was given under. */
  methodVersion: MethodVersion;
  /** Why it moved, in a sentence: the re-check finding, the new method or the correction. */
  reason: string;
}

/** Newest first. */
export const SCORE_CHANGES: readonly ScoreChange[] = [];

/** Newest first; changes published on the same day keep their recorded order. */
export function scoreChangesNewestFirst(changes: readonly ScoreChange[]): ScoreChange[] {
  return [...changes].sort((a, b) => b.date.localeCompare(a.date));
}

/** One review's score changes, newest first, or [] when its score never moved. */
export function scoreChangesFor(slug: string, changes: readonly ScoreChange[] = SCORE_CHANGES): ScoreChange[] {
  return scoreChangesNewestFirst(changes.filter((change) => change.slug === slug));
}
