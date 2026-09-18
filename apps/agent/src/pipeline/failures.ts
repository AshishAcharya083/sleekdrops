// Stage failure taxonomy — why a stage failed, and whether running it again
// could possibly help.
//
// Every stage failure used to look the same on the card: status 'failed', a
// message, and a human to decide what it meant. Two kinds of failure were
// hiding in there. A model that replies with malformed JSON twice, a socket
// that resets, a provider that answers 429 — none of those say anything about
// the article, and the card that died on one would very likely have passed on
// the next run. A contract violation, an evidence shortfall or a validation
// error says something true about the content: running it again spends a full
// stage to reach the same verdict.
//
// So: `transient` is retried here with backoff, `genuine` goes straight to
// failed. The default is `genuine` — transient is recognised only by an
// explicit signature below, because mistaking a real content problem for a
// hiccup burns three stage runs and still ends up failed, while mistaking a
// hiccup for a content problem only costs what it costs today.
import { EvidenceGateError } from '../content/evidence.js';

export type FailureClass = 'transient' | 'genuine';

export interface FailureVerdict {
  readonly failureClass: FailureClass;
  /** The signature that matched, for the pipeline log. Null when genuine. */
  readonly signal: string | null;
}

/** Attempts one stage gets in a single run: the first plus two retries. */
export const MAX_STAGE_ATTEMPTS = 3;

const RETRY_BASE_MS = 2_000;

/**
 * How long to wait after `attempt` (1-based) failed transiently. Exponential,
 * because the faults this covers — a rate limit, a provider wobbling on 5xx —
 * are the ones that clear with time rather than with immediacy.
 */
export function stageRetryDelayMs(attempt: number): number {
  return RETRY_BASE_MS * 2 ** (attempt - 1);
}

/**
 * The faults that are the pipeline's, not the content's.
 *
 * Order does not matter; the first match names the failure in the log. Each
 * entry is a signature we actually throw or actually receive — not a guess at
 * what an error might say. Anything unrecognised is genuine by default, which
 * is why new throws from other stages need no entry here to behave correctly.
 */
const TRANSIENT_SIGNATURES: ReadonlyArray<{ signal: string; pattern: RegExp }> = [
  // extractJson's own two refusals, plus whatever JSON.parse says about a
  // reply that is malformed rather than merely cut short ("Expected ',' or
  // ']' after array element in JSON at position 2546" is the one that killed
  // a card).
  //
  // Matched on JSON.parse's own phrasings rather than on the words "not valid
  // JSON", which also appear in deliberate refusals to overwrite stored data.
  {
    signal: 'parse',
    pattern:
      /Truncated JSON|No JSON value in LLM response|\bin JSON at position\b|Unexpected (?:token|end of JSON input|non-whitespace character)/i,
  },
  // requireKeys / ShapeCheck complaints: well-formed JSON of the wrong shape.
  { signal: 'shape', pattern: /Expected a JSON object|Missing required field/i },
  // An engine that answered with nothing at all, or stopped before it did.
  {
    signal: 'engine',
    pattern: /returned an empty completion|ended without a result message|turn budget before answering/i,
  },
  { signal: 'timeout', pattern: /\bETIMEDOUT\b|\bTimeoutError\b|\bAbortError\b|aborted|timed out|timeout/i },
  {
    signal: 'transport',
    pattern: /\bECONNRESET\b|\bECONNREFUSED\b|\bENOTFOUND\b|\bEAI_AGAIN\b|\bEPIPE\b|fetch failed|socket hang up|network error/i,
  },
  // Provider 429/5xx. Matched through an HTTP-status spelling rather than a
  // bare number, so an error quoting a price or a token count is not mistaken
  // for a throttled provider.
  {
    signal: 'rate-limit',
    pattern: /\bHTTP[ :/]?(?:429|5\d\d)\b|\bstatus (?:429|5\d\d)\b|rate.?limit|too many requests|overloaded|service unavailable/i,
  },
];

/** Message, name and errno of the error and everything it was caused by. */
function describe(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
    if (!(current instanceof Error)) {
      parts.push(String(current));
      break;
    }
    parts.push(current.name, current.message);
    const code = (current as NodeJS.ErrnoException).code;
    if (code) parts.push(code);
    // `fetch failed` carries the real socket error here, and nowhere else.
    current = current.cause;
  }
  return parts.join(' | ');
}

export function classifyFailure(err: unknown): FailureVerdict {
  // The evidence gate has already spent its own bounded re-sweep before it
  // throws, so a stage-level retry would buy nothing and cost a full research
  // pass. It is terminal by construction, whatever its message happens to say.
  // The name is checked alongside the class because that is what the gate
  // guarantees to keep; `instanceof` alone would quietly stop matching if the
  // error ever crossed a second copy of the module.
  if (err instanceof EvidenceGateError || (err instanceof Error && err.name === 'EvidenceGateError')) {
    return { failureClass: 'genuine', signal: null };
  }

  const text = describe(err);
  // A missing credential or a missing env var is the one failure that reads
  // like a config problem and is one: no amount of retrying supplies it.
  if (/not configured|no credential|is not set|env missing/i.test(text)) {
    return { failureClass: 'genuine', signal: null };
  }
  const match = TRANSIENT_SIGNATURES.find((s) => s.pattern.test(text));
  return match
    ? { failureClass: 'transient', signal: match.signal }
    : { failureClass: 'genuine', signal: null };
}
