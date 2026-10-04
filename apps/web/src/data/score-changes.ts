/**
 * Every change to a published score, for the score-change log on /how-we-rate.
 *
 * A score moves only through a re-check or a correction, and each move is
 * recorded here with the old score, the new one and the reason, so the log is
 * the public record that no commercial party changed a number. Empty until the
 * first published score changes; the page renders its empty state until then.
 */

export interface ScoreChange {
  /** The day the new score was published, YYYY-MM-DD. */
  date: string;
  /** Slug of the review whose score changed (/blog/<slug>). */
  reviewSlug: string;
  /** The review's title as the log prints it. */
  reviewTitle: string;
  from: number;
  to: number;
  /** Why it moved, in a sentence: the re-check finding or the correction. */
  reason: string;
}

export const SCORE_CHANGES: readonly ScoreChange[] = [];
