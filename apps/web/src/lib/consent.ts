/**
 * Consent decision logic — the pure, side-effect-free core of the gate.
 *
 * Kept separate from analytics.ts (which owns the DevTeam + GA4 sinks, localStorage and
 * the in-memory buffer) so the decision table can be unit-tested in isolation,
 * without a browser or any SDK. analytics.ts feeds it the parsed record and the
 * privacy-signal boolean and acts on the result; `./ads` feeds it the same two
 * things for the advertising category.
 *
 * The model, since September 2026, is opt-out for analytics and opt-in for ads,
 * with no prompt of any kind:
 *
 *  - Anonymous analytics is ON by default. The site is Australian, where the
 *    Privacy Act does not condition first-party, aggregate analytics on a prior
 *    opt-in, and the banner that used to ask was the first thing a visitor
 *    arriving from a search result saw. It can be switched off at any time from
 *    the footer's Privacy preferences, and the withdrawal path clears everything
 *    the grant stored.
 *  - Advertising is OFF by default and stays an explicit opt-in: the ad tag writes
 *    cookies and device storage the moment it runs, which is the thing ePrivacy
 *    conditions on consent for visitors it reaches.
 *  - A Global Privacy Control / Do-Not-Track signal switches every category off,
 *    over the default and over a stored grant alike.
 */

/**
 * The policy version a stored record is stamped with. It is written for
 * provenance and no longer re-prompts anyone (there is nothing to prompt with):
 * a record from an older version is honoured for the categories it names, and a
 * category it does not name takes the site default below. Version 1 stored one
 * status, for analytics; version 2 stores one per category.
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

/**
 * What applies when the visitor has decided nothing: anonymous analytics on,
 * advertising off. Also what a stored record falls back to for a category it
 * does not mention.
 */
export const DEFAULT_GRANTS: ConsentGrants = { analytics: 'granted', ads: 'denied' };

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
 * What to enforce immediately for one category:
 *  - `grant`   load what the category needs and flush anything held for it
 *  - `deny`    drop what is held, send nothing, load nothing
 */
export type ConsentEffect = 'grant' | 'deny';

export interface ConsentResolution {
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
 * exist when it was written, and so was never put to this visitor - takes the
 * default, which is off.
 */
function migrateLegacy(status: unknown): ConsentGrants | null {
  if (!isStatus(status)) return null;
  return { ...DEFAULT_GRANTS, analytics: status };
}

/**
 * The grants a stored record carries, or null when it carries none we can read.
 * A category the record does not mention takes the site default - a decision
 * that was never taken is not a decision - but a category it mentions with a
 * value that is not a status makes the whole record unreadable rather than
 * silently half-applied.
 */
function readGrants(parsed: StoredConsent): ConsentGrants | null {
  if (typeof parsed.grants !== 'object' || parsed.grants === null) {
    return migrateLegacy(parsed.status);
  }
  const stored = parsed.grants as Record<string, unknown>;
  const present = CONSENT_CATEGORIES.filter((category) => stored[category] !== undefined);
  if (present.length === 0 || !present.every((category) => isStatus(stored[category]))) return null;
  return byCategory((category) => {
    const value = stored[category];
    return isStatus(value) ? value : DEFAULT_GRANTS[category];
  });
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
    /* unreadable / malformed record - treat as no decision on file */
  }
  return null;
}

/**
 * Resolve what to do on page load from the stored record and the browser's
 * privacy signal. A GPC/DNT signal always wins and counts as a decline for every
 * non-essential category; a stored record applies silently, category by
 * category, whatever policy version wrote it; with no record the site defaults
 * apply. Nothing is ever left pending, and nothing is ever prompted for.
 */
export function resolveConsent(
  record: ConsentRecord | null,
  privacySignal: boolean,
): ConsentResolution {
  if (privacySignal) return { effects: everyCategory('deny') };
  const grants = record?.grants ?? DEFAULT_GRANTS;
  return {
    effects: byCategory<ConsentEffect>((category) =>
      grants[category] === 'granted' ? 'grant' : 'deny',
    ),
  };
}
