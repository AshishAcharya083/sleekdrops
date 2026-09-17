/**
 * Request failures, classified so the panel can say what actually went wrong.
 *
 * Every tab used to render the same "API unreachable" banner for every
 * failure, which told the operator nothing: a missing admin token, a stopped
 * agent server and a failing query all read the same. api.ts (the panel's one
 * fetch chokepoint) raises an ApiError instead, carrying the kind of failure,
 * the HTTP status and the trace id the agent returned, and describeApiError()
 * turns that into the sentence the banner shows.
 *
 * Pure and dependency-free on purpose: it is unit-tested in isolation (see
 * api-error.test.ts).
 */

/**
 * What went wrong, from the operator's point of view:
 * - `unauthorized`: the agent rejected the bearer token (or none was sent).
 * - `unreachable`: the request never got an answer (server down, CORS, DNS).
 * - `server`: the agent answered 5xx; the detail is in its logs.
 * - `request`: the call itself was refused (4xx other than 401/403).
 */
export type ApiFailureKind = 'unauthorized' | 'unreachable' | 'server' | 'request';

/** Classify a response the agent did answer with. */
export function failureKindForStatus(status: number): ApiFailureKind {
  if (status === 401 || status === 403) return 'unauthorized';
  return status >= 500 ? 'server' : 'request';
}

/** A failed API call. The message stays the raw one, for logs and dedupe. */
export class ApiError extends Error {
  readonly kind: ApiFailureKind;
  /** null when the request never reached the agent. */
  readonly status: number | null;
  /** The agent's trace id, when it returned one - it names its own log lines. */
  readonly traceId: string | null;

  constructor(
    message: string,
    detail: { kind: ApiFailureKind; status?: number | null; traceId?: string | null },
  ) {
    super(message);
    this.name = 'ApiError';
    this.kind = detail.kind;
    this.status = detail.status ?? null;
    this.traceId = detail.traceId ?? null;
  }
}

/** The `{ error, traceId }` envelope the agent answers a failed call with. */
interface ErrorEnvelope {
  error?: string;
  traceId?: string;
}

/**
 * Classify a response the agent answered with. The trace id comes from the
 * body when the agent put one there (it does on an uncaught error) and from
 * the echoed header otherwise, so a 5xx can always name its own log lines.
 * The header name is passed in - analytics.ts owns that constant.
 */
export function apiErrorFromResponse(
  res: { status: number; headers: { get(name: string): string | null } },
  body: ErrorEnvelope,
  traceHeader: string,
): ApiError {
  return new ApiError(body.error ?? `HTTP ${res.status}`, {
    kind: failureKindForStatus(res.status),
    status: res.status,
    traceId: body.traceId ?? res.headers.get(traceHeader),
  });
}

/**
 * Normalise anything a caller caught into an ApiError, so a banner never has to
 * deal with a bare Error. A value the fetch chokepoint did not classify (an
 * unreadable response body, a rejected non-Error) counts as unreachable: the
 * call produced no usable answer.
 */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ApiError(message, { kind: 'unreachable' });
}

/**
 * The banner sentence for a failure. Each kind names the thing the operator can
 * act on: the token field in the header bar, the agent process, or the trace id
 * that finds the server-side log lines.
 */
export function describeApiError(error: ApiError): string {
  switch (error.kind) {
    case 'unauthorized':
      return 'Not authorized - check the admin token in the header bar above.';
    case 'unreachable':
      return `API unreachable - the agent server is not responding (${error.message}).`;
    case 'server':
      return error.traceId
        ? `The agent server errored - trace id ${error.traceId}.`
        : 'The agent server errored - check the agent logs.';
    default:
      return `Request failed: ${error.message}`;
  }
}
