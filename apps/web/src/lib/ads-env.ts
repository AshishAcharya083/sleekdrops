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
   * AdSense publisher id (ca-pub-...). Empty disables ads everywhere, silently
   * and after a single warning, exactly as an empty ingest key disables the
   * DevTeam analytics sink.
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
 * Trimmed, because `scripts/generate-ads-txt.mjs` reads the same publisher id
 * from the same variable and trims it: a value that is only whitespace has to
 * mean "unconfigured" to both of them, or the build publishes no ads.txt while
 * the page still asks the partner to serve against an id it cannot match.
 */
const trimmed = (raw: string | undefined): string => (raw ?? '').trim();

/** This build's ad configuration. */
export function adsEnv(): AdsEnv {
  return {
    client: trimmed(env?.PUBLIC_ADSENSE_CLIENT),
    slots: {
      articleMid: trimmed(env?.PUBLIC_ADSENSE_SLOT_ARTICLE_MID),
      articleEnd: trimmed(env?.PUBLIC_ADSENSE_SLOT_ARTICLE_END),
      sidebar: trimmed(env?.PUBLIC_ADSENSE_SLOT_SIDEBAR),
      feed: trimmed(env?.PUBLIC_ADSENSE_SLOT_FEED),
    },
  };
}
