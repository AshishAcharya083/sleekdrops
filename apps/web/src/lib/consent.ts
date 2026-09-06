/**
 * Consent decision logic — the pure, side-effect-free core of the gate.
 *
 * Kept separate from analytics.ts (which owns the DevTeam + GA4 sinks, localStorage and
 * the in-memory buffer) so the decision table can be unit-tested in isolation,
 * without a browser or any SDK. analytics.ts feeds it the parsed record and the
 * privacy-signal boolean and acts on the result.
 */

/**
 * The consent scope this site asks for. A visitor whose stored record carries an
 * older version is re-prompted, so bumping it destroys every consent record on
 * file - which is the right thing exactly four times:
 *
 *  - a new purpose category (a category that is not analytics),
 *  - a new vendor or recipient of the data,
 *  - a change of legal basis,
 *  - a change to what an existing category *does*.
 *
 * Nothing else. Adding a storage item that serves the already-consented analytics
 * purpose, is first-party only, is written only on grant and is deleted on
 * withdrawal is not a change of purpose, scope or recipient, so it does not bump
 * this - `sd_sid` (see `./visit`) was added under exactly those conditions.
 * Editorial changes to the storage inventory are recorded by the `updated` date on
 * `src/pages/privacy.astro` instead.
 */
export const POLICY_VERSION = 1;

/** localStorage key, mirroring the `sd-theme` convention in chrome.ts. */
export const CONSENT_KEY = 'sd-consent';

export type ConsentStatus = 'granted' | 'denied';

export interface ConsentRecord {
  v: number;
  status: ConsentStatus;
  ts: number;
}

/**
 * Which consent surface the UI should render:
 *  - `none`          a decision is already in force; render nothing
 *  - `banner`        first-visit opt-in prompt
 *  - `policy-update` stored consent predates the current policy version
 *  - `gpc`           a GPC/DNT signal was honoured; passive info card
 */
export type ConsentPrompt = 'none' | 'banner' | 'policy-update' | 'gpc';

export interface ConsentResolution {
  prompt: ConsentPrompt;
  /**
   * What to enforce immediately:
   *  - `grant`   load SDKs and flush the buffer
   *  - `deny`    drop the buffer, send nothing
   *  - `pending` keep buffering until the visitor chooses
   */
  effect: 'grant' | 'deny' | 'pending';
}

/** Parse and validate a stored consent record; returns null if absent/malformed. */
export function parseConsent(raw: string | null): ConsentRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ConsentRecord>;
    if (
      typeof parsed.v === 'number' &&
      (parsed.status === 'granted' || parsed.status === 'denied')
    ) {
      return { v: parsed.v, status: parsed.status, ts: typeof parsed.ts === 'number' ? parsed.ts : 0 };
    }
  } catch {
    /* unreadable / malformed record - treat as no consent on file */
  }
  return null;
}

/**
 * Resolve what to do on page load from the stored record and the browser's
 * privacy signal. A GPC/DNT signal always wins and counts as a decline; an
 * in-date stored record applies silently; a stale record re-prompts; otherwise
 * we show the first-visit banner and buffer until the visitor chooses.
 */
export function resolveConsent(
  record: ConsentRecord | null,
  privacySignal: boolean,
  policyVersion: number = POLICY_VERSION,
): ConsentResolution {
  if (privacySignal) return { prompt: 'gpc', effect: 'deny' };
  if (record && record.v === policyVersion) {
    return { prompt: 'none', effect: record.status === 'granted' ? 'grant' : 'deny' };
  }
  return { prompt: record ? 'policy-update' : 'banner', effect: 'pending' };
}
