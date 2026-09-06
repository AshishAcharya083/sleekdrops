/**
 * Structured logging for the agent platform.
 *
 * One JSON object per line on stdout/stderr — Cloud Run's logging agent parses
 * those into structured entries, and locally they stay greppable (`| jq`,
 * `grep '"trace_id":"…"'`). Every line carries the scope it came from and, when
 * a request is in flight, that request's trace id: the same id the admin panel
 * sent as X-Trace-Id and reports to DevTeam Analytics, so a client-side error
 * leads straight to the server-side lines of its request.
 *
 * The trace id travels through AsyncLocalStorage for the lifetime of the HTTP
 * request. It deliberately does not reach the pipeline worker: an HTTP request
 * and a stage run are decoupled by a database poll, so the join back to
 * asynchronous work is the entity id (topic/article) that the enqueue-point log
 * line records next to the trace id.
 *
 * There is no server-side analytics SDK and no server ingest key here - stdout
 * is the sink, and correlation is achieved by the shared trace id alone.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured detail attached to a log line. Undefined values are dropped. */
export type LogFields = Record<string, unknown>;

const traceStorage = new AsyncLocalStorage<string>();

/** Run `fn` with `traceId` in scope, so every log line inside it carries it. */
export function runWithTrace<T>(traceId: string, fn: () => T): T {
  return traceStorage.run(traceId, fn);
}

/** The trace id of the request currently in scope, if any. */
export function currentTraceId(): string | undefined {
  return traceStorage.getStore();
}

/**
 * Keys the line owns. A field may not overwrite them - a stray `trace_id` in a
 * caller's fields would quietly break the correlation the whole feature exists
 * for, which is worse than dropping that one field.
 */
const RESERVED_KEYS = new Set(['level', 'time', 'scope', 'message', 'trace_id']);

/**
 * Render one structured log line. Pure, so the wire format is unit-tested
 * without capturing stdout (see log.test.ts). Keys are ordered level → time →
 * scope → message → trace_id → fields so lines stay readable unparsed, and
 * `undefined` fields are omitted rather than serialised as null.
 *
 * Never throws: a value that cannot be serialised (circular, a BigInt) must not
 * be able to take down the request that was only trying to log itself.
 */
export function formatLogLine(
  level: LogLevel,
  scope: string,
  message: string,
  fields?: LogFields,
  traceId?: string,
  timestamp = new Date().toISOString(),
): string {
  const line: Record<string, unknown> = { level, time: timestamp, scope, message };
  if (traceId) line.trace_id = traceId;
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value === undefined || RESERVED_KEYS.has(key)) continue;
    line[key] = value instanceof Error ? value.message : value;
  }
  try {
    return JSON.stringify(line);
  } catch {
    return JSON.stringify({ ...line, ...unserialisableFields(fields) });
  }
}

/** Replace every field with a placeholder, keeping the line's own keys intact. */
function unserialisableFields(fields?: LogFields): LogFields {
  const out: LogFields = {};
  for (const key of Object.keys(fields ?? {})) {
    if (!RESERVED_KEYS.has(key)) out[key] = '[unserialisable]';
  }
  return out;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

function write(level: LogLevel, scope: string, message: string, fields?: LogFields): void {
  const line = formatLogLine(level, scope, message, fields, currentTraceId());
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** A logger bound to one scope, e.g. `createLogger('api')`. */
export function createLogger(scope: string): Logger {
  return {
    debug: (message, fields) => write('debug', scope, message, fields),
    info: (message, fields) => write('info', scope, message, fields),
    warn: (message, fields) => write('warn', scope, message, fields),
    error: (message, fields) => write('error', scope, message, fields),
  };
}
