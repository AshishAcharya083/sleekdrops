/**
 * Consent decision logic — the pure, side-effect-free core of the gate.
 *
 * Kept separate from analytics.ts (which owns the DevTeam + GA4 sinks, localStorage and
 * the in-memory buffer) so the decision table can be unit-tested in isolation,
 * without a browser or any SDK. analytics.ts feeds it the parsed record and the
 * privacy-signal boolean and acts on the result; `./ads` feeds it the same two
 * things for the advertising category.
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
 *
 * Version 2 adds the `ads` category and its vendor (Google AdSense) - the first
 * and second reasons on that list at once - so every record written under the
 * analytics-only policy is re-prompted rather than read as an ads decision the
 * visitor never made.
 */
export const POLICY_VERSION = 2;

/** localStorage key, mirroring the `sd-theme` convention in chrome.ts. */
export const CONSENT_KEY = 'sd-consent';

export type ConsentStatus = 'granted' | 'denied';

/**
 * The non-essential purposes the visitor decides on, one at a time. Essential
 * storage (theme, this very record) is not a category: it is never optional and
 * is never gated.
 */
export const CONSENT_CATEGORIES = ['analytics', 'ads'] as const;

export type ConsentCategory = (typeof CONSENT_CATEGORIES)[number];

/** The visitor's decision for every category, one status each. */
export type ConsentGrants = Record<ConsentCategory, ConsentStatus>;

export interface ConsentRecord {
  v: number;
  grants: ConsentGrants;
  ts: number;
}

/**
 * A stored record as it comes back out of JSON: nothing about it is known yet.
 * Typed field by field so every check below narrows something real rather than
 * restating a shape the browser never promised.
 */
interface StoredConsent {
  v?: unknown;
  ts?: unknown;
  /** Policy version 1 wrote one status, for the one category it asked about. */
  status?: unknown;
  /** Policy version 2 onwards: one status per category. */
  grants?: unknown;
}

/**
 * Which consent surface the UI should render:
 *  - `none`          a decision is already in force; render nothing
 *  - `banner`        first-visit opt-in prompt
 *  - `policy-update` stored consent predates the current policy version
 *  - `gpc`           a GPC/DNT signal was honoured; passive info card
 */
export type ConsentPrompt = 'none' | 'banner' | 'policy-update' | 'gpc';

/**
 * What to enforce immediately for one category:
 *  - `grant`   load what the category needs and flush anything held for it
 *  - `deny`    drop what is held, send nothing, load nothing
 *  - `pending` keep holding until the visitor chooses
 */
export type ConsentEffect = 'grant' | 'deny' | 'pending';

export interface ConsentResolution {
  prompt: ConsentPrompt;
  /** What to enforce immediately, per category. */
  effects: Record<ConsentCategory, ConsentEffect>;
}

/**
 * One value per category, derived from the category. Every per-category record in
 * this module is built here, so adding a category cannot leave one of them with a
 * key - and so an effect - missing.
 */
function byCategory<T>(of: (category: ConsentCategory) => T): Record<ConsentCategory, T> {
  return Object.fromEntries(
    CONSENT_CATEGORIES.map((category) => [category, of(category)]),
  ) as Record<ConsentCategory, T>;
}

/** The same value for every category - the shape both blanket outcomes take. */
function everyCategory<T>(value: T): Record<ConsentCategory, T> {
  return byCategory(() => value);
}

/** A grant record saying the same thing about every category. */
export function uniformGrants(status: ConsentStatus): ConsentGrants {
  return everyCategory(status);
}

const isStatus = (value: unknown): value is ConsentStatus =>
  value === 'granted' || value === 'denied';

/**
 * A policy-1 record read as the per-category record it is equivalent to: the one
 * status it carries is the analytics decision, and ads - a category that did not
 * exist when it was written, and so was never put to this visitor - is denied.
 *
 * The record still re-prompts, because its version is behind (see POLICY_VERSION),
 * and that is the point of migrating it rather than discarding it: `policy-update`
 * tells the visitor their earlier choice is being revisited, where a null record
 * would show them the first-visit banner as if they had never decided.
 */
function migrateLegacy(status: unknown): ConsentGrants | null {
  if (!isStatus(status)) return null;
  return { analytics: status, ads: 'denied' };
}

/**
 * The grants a stored record carries, or null when it carries none we can read.
 * A category the record does not mention is denied - a decision that was never
 * taken is not consent - but a category it mentions with a value that is not a
 * status makes the whole record unreadable rather than silently half-applied.
 */
function readGrants(parsed: StoredConsent): ConsentGrants | null {
  if (typeof parsed.grants !== 'object' || parsed.grants === null) {
    return migrateLegacy(parsed.status);
  }
  const stored = parsed.grants as Record<string, unknown>;
  const present = CONSENT_CATEGORIES.filter((category) => stored[category] !== undefined);
  if (present.length === 0 || !present.every((category) => isStatus(stored[category]))) return null;
  return byCategory((category) => (stored[category] === 'granted' ? 'granted' : 'denied'));
}

/** Parse and validate a stored consent record; returns null if absent/malformed. */
export function parseConsent(raw: string | null): ConsentRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredConsent;
    if (typeof parsed.v !== 'number') return null;
    const grants = readGrants(parsed);
    if (!grants) return null;
    return { v: parsed.v, grants, ts: typeof parsed.ts === 'number' ? parsed.ts : 0 };
  } catch {
    /* unreadable / malformed record - treat as no consent on file */
  }
  return null;
}

/**
 * Resolve what to do on page load from the stored record and the browser's
 * privacy signal. A GPC/DNT signal always wins and counts as a decline for every
 * non-essential category; an in-date stored record applies silently, category by
 * category; a stale record re-prompts; otherwise we show the first-visit banner
 * and hold everything until the visitor chooses.
 */
export function resolveConsent(
  record: ConsentRecord | null,
  privacySignal: boolean,
  policyVersion: number = POLICY_VERSION,
): ConsentResolution {
  if (privacySignal) return { prompt: 'gpc', effects: everyCategory('deny') };
  if (record && record.v === policyVersion) {
    const effects = byCategory<ConsentEffect>((category) =>
      record.grants[category] === 'granted' ? 'grant' : 'deny',
    );
    return { prompt: 'none', effects };
  }
  return { prompt: record ? 'policy-update' : 'banner', effects: everyCategory('pending') };
}
