// What the stage was asking a model for when it stopped.
//
// A timed-out stage with "stopped after 60 minutes" on it tells an operator
// nothing they can act on; "stopped after 60 minutes, waiting on claude-opus-5
// with web search, retry 2 of 3, in flight for 41m" names the thing that hung.
// Nothing in the chat path carries the stage's identity - agents call chat()
// with options and nothing else - so the note travels the way the request
// logger's trace id does, through AsyncLocalStorage, and the stage keeps a
// direct reference to the record so it can read it from outside the async
// context when its deadline fires.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface LlmCall {
  model: string;
  search: boolean;
  /** 1-based, within chat()'s own retry budget. */
  attempt: number;
  attemptsAllowed: number;
  startedAt: number;
  /**
   * When the call came back, if it did. The distinction is the whole value of
   * the note: "still waiting on the model" and "the model answered half an
   * hour ago and the stage stopped somewhere after it" are different faults,
   * and reporting the second as the first sends an operator to the wrong place.
   */
  endedAt?: number;
}

/** The mutable record one stage run writes its in-flight call into. */
export interface LlmCallTrace {
  last: LlmCall | null;
}

const traceStorage = new AsyncLocalStorage<LlmCallTrace>();

export function newLlmCallTrace(): LlmCallTrace {
  return { last: null };
}

/** Run `fn` with `trace` in scope, so every chat() inside it records itself. */
export function withLlmCallTrace<T>(trace: LlmCallTrace, fn: () => T): T {
  return traceStorage.run(trace, fn);
}

/** Record the call about to be made. No-op outside a stage run. */
export function noteLlmCall(call: LlmCall): void {
  const trace = traceStorage.getStore();
  if (trace) trace.last = call;
}

/** Record that the call came back, however it came back. */
export function noteLlmCallEnded(endedAt = Date.now()): void {
  const last = traceStorage.getStore()?.last;
  if (last && last.endedAt === undefined) last.endedAt = endedAt;
}

/**
 * The in-flight call as a sentence, for the timeout message. Empty when the
 * stage never reached a model - which is itself worth reading, because it says
 * the stage hung somewhere other than an LLM.
 */
export function describeLlmCall(call: LlmCall | null, now = Date.now()): string {
  if (!call) return '';
  const retry =
    call.attempt > 1 ? `, retry ${call.attempt - 1} of ${call.attemptsAllowed - 1}` : '';
  const head = `${call.model}${call.search ? ' with web search' : ''}${retry}`;
  const since = (from: number) => formatDuration(Math.max(0, (now - from) / 1000));
  return call.endedAt === undefined
    ? `${head}, still in flight after ${since(call.startedAt)}`
    : `${head}, which answered ${since(call.endedAt)} ago - the stage stopped after it`;
}

/** Seconds as the operator reads them: "41m 12s", "9s", "1h 3m". */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${rest}s`;
  return `${rest}s`;
}
