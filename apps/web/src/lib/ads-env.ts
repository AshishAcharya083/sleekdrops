/**
 * The build-time configuration of the ad partner: this environment's publisher
 * id and the slot id of every placement the site reserves space for.
 *
 * A module of its own for the same reason `./analytics-env` and `./flags-env` are
 * - `import.meta.env` is inlined by Vite at build time and does not exist under
 * the bare `node --test` runner - which is what lets the regression suite drive
 * the real `./ads` module against a stand-in publisher id instead of
 * re-implementing it in order to test it.
 *
 * Read lazily rather than captured in module constants, so a substituted value
 * applies however the module was loaded.
 */

/**
 * Where a unit may appear. Naming the placements here rather than passing raw
 * slot ids around is what keeps the pages partner-agnostic: swapping AdSense for
 * a managed network changes this module and `./ads`, not the components.
 */
export type AdPlacement = 'articleMid' | 'articleEnd' | 'sidebar' | 'feed';

export interface AdsEnv {
  /**
   * AdSense publisher id (ca-pub-...). Empty - which is also what a value that
   * is not a publisher id reads as, see `publisherId` - disables ads everywhere,
   * silently and after a single warning, exactly as an empty ingest key disables
   * the DevTeam analytics sink.
   */
  client: string;
  /**
   * Per-placement slot id. Minted per unit in the AdSense console and different
   * per environment, so they travel the same route as the publisher id. An empty
   * slot id disables that one placement and leaves the rest running.
   */
  slots: Record<AdPlacement, string>;
}

const env = import.meta.env as ImportMetaEnv | undefined;

/**
 * Trimmed, because `scripts/generate-ads-txt.mjs` reads the same values from the
 * same variables and trims them: a value that is only whitespace has to mean
 * "unconfigured" to both of them, or the build publishes no ads.txt while the
 * page still asks the partner to serve against an id it cannot match.
 */
const trimmed = (raw: string | undefined): string => (raw ?? '').trim();

/**
 * The only shape a publisher id may take, kept identical to the check in
 * `scripts/generate-ads-txt.mjs` (which cannot import this module - it runs as
 * plain node, before the build, so the pattern is spelled out in both places).
 */
const PUBLISHER_ID_PATTERN = /^ca-pub-\d+$/;

/**
 * A configured publisher id, or `''` for a build that has none to use.
 *
 * The value is validated here and not merely trimmed, so that the two halves of
 * one setting cannot disagree: `generate-ads-txt.mjs` refuses to publish an
 * ads.txt for anything that is not `ca-pub-<digits>`, and a value it refuses
 * must not still be sent to the partner as the id to serve against - that
 * request can only ever be unmatchable, against a domain the crawler reads as
 * authorizing nobody. A typo or a wrong-environment value therefore disables ads
 * exactly the way an empty variable does, with the one `[ads]` warning `./ads`
 * prints for it.
 */
export function publisherId(raw: string | undefined): string {
  const value = trimmed(raw);
  return PUBLISHER_ID_PATTERN.test(value) ? value : '';
}

/** This build's ad configuration. */
export function adsEnv(): AdsEnv {
  return {
    client: publisherId(env?.PUBLIC_ADSENSE_CLIENT),
    slots: {
      articleMid: trimmed(env?.PUBLIC_ADSENSE_SLOT_ARTICLE_MID),
      articleEnd: trimmed(env?.PUBLIC_ADSENSE_SLOT_ARTICLE_END),
      sidebar: trimmed(env?.PUBLIC_ADSENSE_SLOT_SIDEBAR),
      feed: trimmed(env?.PUBLIC_ADSENSE_SLOT_FEED),
    },
  };
}
