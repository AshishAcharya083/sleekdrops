/**
 * Pure de-duplication for the panel's error reports.
 *
 * This is the dependency-free half of error capture, mirroring
 * apps/web/src/lib/error-capture.ts: it decides whether an error is fresh
 * enough to report, so the 4s usePoll loop hitting an unreachable API cannot
 * flood the sink. It touches no SDK and no globals, so it is unit-tested in
 * isolation (see error-report.test.ts); redaction happens at the scrub()
 * chokepoint and the impure wiring lives in analytics.ts.
 */

import type { EventProps } from './scrub';

/** Window during which an identical error signature is reported at most once. */
export const DEDUPE_WINDOW_MS = 10_000;

/** Cap on distinct signatures tracked, so the dedupe map can't grow unbounded. */
export const DEDUPE_MAX_KEYS = 100;

/**
 * Stable key identifying an error for de-duplication. Built from the message
 * plus the structural attributes that distinguish one failing call from
 * another, so a repeatedly failing poll collapses to one report per window
 * while a different route or status still gets through.
 */
export function errorSignature(message: string, attributes?: EventProps): string {
  const at = attributes ?? {};
  return [message, at.source ?? '', at.route ?? '', at.http_status ?? ''].join('|');
}

/**
 * Rate-limits identical errors so a fault firing in a loop (the usePoll
 * interval, a retrying request) can't flood the analytics endpoint. The same
 * signature is admitted at most once per DEDUPE_WINDOW_MS; the backing map is
 * cleared wholesale once it reaches DEDUPE_MAX_KEYS so it can't grow unbounded.
 */
export class ErrorDeduper {
  private readonly lastReported = new Map<string, number>();

  shouldReport(signature: string, now: number): boolean {
    const previous = this.lastReported.get(signature);
    if (previous !== undefined && now - previous < DEDUPE_WINDOW_MS) return false;

    if (!this.lastReported.has(signature) && this.lastReported.size >= DEDUPE_MAX_KEYS) {
      this.lastReported.clear();
    }
    this.lastReported.set(signature, now);
    return true;
  }
}
