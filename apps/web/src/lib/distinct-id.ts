/**
 * Resolving the one identity experiments have to bucket on: the distinct id the
 * DevTeam analytics SDK actually stamps on this visitor's events.
 *
 * `createAnalytics()` mints a throwaway `anon_*` id synchronously and only swaps
 * in the visitor's persisted id when its storage restore resolves, so
 * `getDistinctId()` read in the same tick as the client is created returns a
 * value that is discarded on the next page load. Bucketing on it would re-roll a
 * returning visitor's variant on every load while their events kept reporting
 * the persisted id - the silent failure where every experiment reads 0%.
 *
 * The restore only awaits storage that answers synchronously (localStorage, or
 * the SDK's in-memory fallback when it is unavailable), so it has always settled
 * by the next macrotask.
 *
 * It lives beside `./analytics` rather than inside it so that timing can be
 * tested against a real DevTeam client.
 */

/** The part of the DevTeam `AnalyticsClient` surface this module needs. */
export interface DistinctIdSource {
  getDistinctId(): string;
}

/** Hand `use` the distinct id the SDK reports once its storage restore has settled. */
export function whenDistinctIdRestored(
  client: DistinctIdSource,
  use: (distinctId: string) => void,
): void {
  setTimeout(() => use(client.getDistinctId()), 0);
}
