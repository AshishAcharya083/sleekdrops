/**
 * Pure shaping and de-duplication for runtime-error capture.
 *
 * This is the dependency-free half of the error-capture feature: it turns the
 * browser's `ErrorEvent` / `PromiseRejectionEvent` into a flat `$client_error`
 * payload and decides whether an error is fresh enough to report. It touches no
 * SDK and no globals, so it is unit-tested in isolation (see error-capture.test.ts)
 * the same way consent.ts is. The impure wiring - registering the window
 * listeners and forwarding through the consent-gated track() pipeline - lives in
 * analytics.ts, and all PII scrubbing happens at the central scrub() chokepoint.
 */

import type { EventProps } from './pii';

/** Max characters kept from a stack trace before truncation. */
export const STACK_LIMIT = 2000;

/** Window during which an identical error signature is reported at most once. */
export const DEDUPE_WINDOW_MS = 10_000;

/** Cap on distinct signatures tracked, so the dedupe map can't grow unbounded. */
export const DEDUPE_MAX_KEYS = 100;

/**
 * The flat diagnostic payload sent as `$client_error`. Free-text fields
 * (message/source/stack) are passed through verbatim here and reduced to
 * PII-safe values later by scrub(); only the stack is length-bounded up front.
 */
export interface ErrorProps extends EventProps {
  message: string;
  source?: string;
  lineno?: number;
  colno?: number;
  stack?: string;
  handled?: boolean;
}

function truncateStack(stack: string | undefined): string | undefined {
  return stack ? stack.slice(0, STACK_LIMIT) : undefined;
}

/** Shape an uncaught-error `ErrorEvent` into a `$client_error` payload. */
export function errorEventToProps(event: ErrorEvent): ErrorProps {
  const stack = event.error instanceof Error ? event.error.stack : undefined;
  return {
    message: event.message || 'Unknown error',
    source: event.filename || undefined,
    lineno: event.lineno || undefined,
    colno: event.colno || undefined,
    stack: truncateStack(stack),
  };
}

/** Shape an `unhandledrejection` event into a `$client_error` payload. */
export function rejectionToProps(event: PromiseRejectionEvent): ErrorProps {
  const reason = event.reason;
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === 'string'
        ? reason
        : 'Unhandled promise rejection';
  const stack = reason instanceof Error ? reason.stack : undefined;
  return {
    message: message || 'Unhandled promise rejection',
    handled: false,
    stack: truncateStack(stack),
  };
}

/** Stable key identifying an error for de-duplication. */
export function errorSignature(props: ErrorProps): string {
  return `${props.message}|${props.source ?? ''}|${props.lineno ?? ''}`;
}

/**
 * Rate-limits identical errors so a fault firing in a tight loop (an animation
 * frame, a scroll handler) can't flood the analytics endpoint. The same
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
