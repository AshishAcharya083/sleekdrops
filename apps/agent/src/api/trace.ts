/**
 * Request tracing for the admin API.
 *
 * The admin panel sends the trace id of its analytics session as X-Trace-Id on
 * every call (apps/admin/src/api.ts). This middleware adopts that id - or mints
 * one when the caller sent none - puts it in scope for the whole request so
 * every log line carries it, logs one line per request, and echoes it back so
 * the browser can attach the server-side id to its own error reports.
 */
import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { createLogger, runWithTrace } from '../lib/log.js';

/** Header carrying the trace id in both directions. */
export const TRACE_HEADER = 'X-Trace-Id';

/** Hono environment: the resolved trace id, readable from handlers and onError. */
export type TraceEnv = { Variables: { traceId: string } };

/**
 * Trace ids we accept from a client: alphanumeric/dash only and length-bounded.
 * Anything else is a caller mistake or an injection attempt (the id lands in
 * log lines), so it is replaced with a freshly generated id rather than trusted.
 */
const TRACE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

const log = createLogger('api');

/** Generate a trace id in the same 32-hex-character shape the panel's SDK uses. */
export function generateTraceId(): string {
  return randomUUID().replace(/-/g, '');
}

/**
 * Resolve the trace id for a request: the caller's when it is well-formed,
 * otherwise a fresh one. Pure apart from the injected generator, so it is
 * unit-tested in isolation (see trace.test.ts).
 */
export function resolveTraceId(header: string | undefined, generate = generateTraceId): string {
  const candidate = header?.trim();
  return candidate && TRACE_ID_RE.test(candidate) ? candidate : generate();
}

/**
 * Put the request's trace id in scope, log one line per request, and echo the
 * id on the response. Hono turns an uncaught route error into a response
 * further down the chain, so a failing request still gets its line here - with
 * the 500 status - alongside the stack the app's onError handler logs.
 */
export function traceMiddleware(): MiddlewareHandler<TraceEnv> {
  return async (c, next) => {
    const traceId = resolveTraceId(c.req.header(TRACE_HEADER));
    c.set('traceId', traceId);
    const startedAt = Date.now();
    await runWithTrace(traceId, async () => {
      await next();
      log.info('request', {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        duration_ms: Date.now() - startedAt,
      });
    });
    c.res.headers.set(TRACE_HEADER, traceId);
  };
}
