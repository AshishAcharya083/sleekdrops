/**
 * The selected platform: which blog every request, list and setting in the
 * panel belongs to. The agent scopes each admin route by the X-Platform header
 * and has no default, so the panel always names one - the operator's choice,
 * or the first platform GET /api/platforms returns when there is none.
 *
 * The choice is held in memory per browser tab and only persisted to
 * localStorage, so a second tab switched to another platform cannot change
 * which platform this tab's requests are sent for.
 *
 * Pure and dependency-free on purpose: it is unit-tested in isolation (see
 * platform.test.ts), the same way stages.ts and channels.ts are.
 */

export const PLATFORM_HEADER = 'X-Platform';

/** Matches the panel's other `sleekdrops_*` localStorage keys. */
export const PLATFORM_STORAGE_KEY = 'sleekdrops_platform';

/** The one route the panel calls before it knows which platform it is on. */
export const PLATFORMS_PATH = '/api/platforms';

export type MonetisationMode = 'amazon' | 'none';

/** One edition of a platform, as GET /api/platforms reports it. */
export interface EditionInfo {
  id: string;
  name: string;
  /** IANA zone the edition's event times are entered and shown in. */
  time_zone: string;
  /** BCP 47, e.g. en-AU or en-GB. */
  locale: string;
  /** ISO 4217, or null for an edition that quotes no currency amounts. */
  currency: string | null;
}

export interface PlatformInfo {
  id: string;
  name: string;
  monetisation: MonetisationMode;
  /** The platform's distribution_enabled setting; a missing row reads false. */
  distribution_enabled: boolean;
  categories: string[];
  post_types: string[];
  editions: EditionInfo[];
}

/** GET /api/platforms */
export interface PlatformList {
  platforms: PlatformInfo[];
}

/** The X-Platform header a request carries, if any. */
export function platformHeaders(
  path: string,
  method: string,
  platformId: string | null,
): Record<string, string> {
  const route = path.split(/[?#]/)[0];
  if (method.toUpperCase() === 'GET' && route === PLATFORMS_PATH) return {};
  return platformId ? { [PLATFORM_HEADER]: platformId } : {};
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type PlatformListener = (platformId: string) => void;

export interface PlatformSelection {
  get(): string | null;
  /**
   * Make `platformId` the selected platform: persist it and tell every
   * subscriber, so cached data from the previous platform is dropped. Returns
   * false when it was already selected and nothing changed.
   */
  select(platformId: string): boolean;
  subscribe(listener: PlatformListener): () => void;
}

export function createPlatformSelection(storage: KeyValueStore): PlatformSelection {
  let current = storage.getItem(PLATFORM_STORAGE_KEY) || null;
  const listeners = new Set<PlatformListener>();
  return {
    get: () => current,
    select(platformId) {
      if (platformId === current) return false;
      current = platformId;
      storage.setItem(PLATFORM_STORAGE_KEY, platformId);
      for (const listener of [...listeners]) listener(platformId);
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * The platform the panel opens on: the remembered one while the agent still
 * lists it, otherwise the first one listed. Null only when there are none.
 */
export function resolveSelection(
  platforms: readonly PlatformInfo[],
  storedId: string | null,
): PlatformInfo | null {
  return platforms.find((p) => p.id === storedId) ?? platforms[0] ?? null;
}

/** Offers are affiliate links; a platform with no monetisation has none. */
export const offersEnabled = (platform: PlatformInfo): boolean => platform.monetisation !== 'none';

export const channelsEnabled = (platform: PlatformInfo): boolean => platform.distribution_enabled;

/** The tabs the selected platform shows: Channels only while it distributes. */
export function visibleTabs<T extends string>(tabs: readonly T[], platform: PlatformInfo): T[] {
  return tabs.filter((tab) => tab !== 'Channels' || channelsEnabled(platform));
}

export function findEdition(platform: PlatformInfo, editionId: string | null | undefined): EditionInfo | null {
  return platform.editions.find((e) => e.id === editionId) ?? null;
}

/** An event-bound piece whose kick-off has passed. */
export function isEventExpired(eventStartsAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!eventStartsAt) return false;
  const startsAt = Date.parse(eventStartsAt);
  return Number.isFinite(startsAt) && startsAt <= now;
}

/** An event time as the edition's readers see it, zone always named. */
export function fmtEventTime(iso: string, edition: Pick<EditionInfo, 'time_zone' | 'locale'> | null): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const timeZone = edition?.time_zone ?? 'UTC';
  try {
    return new Intl.DateTimeFormat(edition?.locale, {
      timeZone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

const WALL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** Minutes east of UTC that `timeZone` is at the instant `ms`. */
function zoneOffsetMinutes(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const field = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  const wallAsUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour'),
    field('minute'),
    field('second'),
  );
  return Math.round((wallAsUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** `YYYY-MM-DDTHH:mm` of the instant as `offsetMinutes` reads it. */
function wallTime(ms: number, offsetMinutes: number): string {
  const d = new Date(ms + offsetMinutes * 60_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * A `<input type="datetime-local">` value, read as wall time in the edition's
 * zone, as ISO 8601 with that zone's offset - what the API takes for
 * event_starts_at. Null for an empty or malformed value.
 */
export function zonedInputToIso(value: string, timeZone: string): string | null {
  const m = WALL_TIME.exec(value.trim());
  if (!m) return null;
  const wallAsUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  // The offset depends on the instant, which depends on the offset: one
  // correction settles it everywhere except inside a daylight-saving gap,
  // where the wall time does not exist and the later reading is taken.
  let offset = zoneOffsetMinutes(wallAsUtc, timeZone);
  offset = zoneOffsetMinutes(wallAsUtc - offset * 60_000, timeZone);
  const instant = wallAsUtc - offset * 60_000;
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${wallTime(instant, offset)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** The inverse: an ISO instant as a datetime-local value in `timeZone`. */
export function isoToZonedInput(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return wallTime(ms, zoneOffsetMinutes(ms, timeZone));
}

/**
 * Where a published slug lives on the platform's site. The platform list does
 * not carry a site URL, so only the sites the panel knows get a link; anything
 * else renders the slug as text rather than a link to the wrong site.
 */
const SITE_ORIGINS: Readonly<Record<string, string>> = {
  sleekdrops: 'https://sleekdrops.com',
};

export function siteArticleUrl(platformId: string, slug: string): string | null {
  const origin = SITE_ORIGINS[platformId];
  return origin ? `${origin}/blog/${slug}/` : null;
}
