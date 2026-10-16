/**
 * The build-time configuration of the two ad partners the site is set up for
 * while it applies to both: Google AdSense (this environment's publisher id and
 * the slot id of every placement the site reserves space for) and Journey by
 * Mediavine (this site's id, the `<id>` in its script wrapper
 * `https://scripts.scriptwrapper.com/tags/<id>.js`).
 *
 * They are independent: either id may be empty, and an empty id switches that
 * partner off entirely. Journey requires exclusivity once it serves ads - no
 * other programmatic tag and no other seller in ads.txt - so the day one of the
 * two launches, the other's variable is emptied and its code removed.
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

import { deploymentOf, type SiteDeployment } from './site-env.ts';

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
  /**
   * Journey by Mediavine site id, or `''` for a build that loads no Journey
   * wrapper - which is every build until Journey approves the site and issues
   * one, and every build that is not production.
   */
  mediavineSiteId: string;
  /** The Journey script wrapper URL for this build, or `''` when Journey is off. */
  mediavineScriptSrc: string;
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

/**
 * The publisher id this deployment is allowed to expose.
 *
 * AdSense and Google's CMP belong to the canonical production domain only.
 * Requiring an explicit production deployment here is a second safety boundary
 * behind the deploy workflow's empty preview value: a repo- or organisation-
 * level variable added later cannot make a preview claim this publisher account.
 */
export function publisherIdForDeployment(
  deployment: SiteDeployment,
  raw: string | undefined,
): string {
  return deployment === 'production' ? publisherId(raw) : '';
}

/** Where every Mediavine script wrapper is served from. */
export const MEDIAVINE_SCRIPT_ORIGIN = 'https://scripts.scriptwrapper.com';

/**
 * The only shape a Mediavine site id may take: the URL-safe token Mediavine
 * mints, which is what the wrapper's path is built from. Validated and not
 * merely trimmed, for the reason `publisherId` is: a value carrying a slash, a
 * quote or whitespace would be written into a `<script src>` on every page, and
 * a value that is not this site's id requests a wrapper that serves nothing
 * while the page looks healthy.
 */
const MEDIAVINE_SITE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;

/** A configured Mediavine site id, or `''` for a build that has none to use. */
export function mediavineSiteId(raw: string | undefined): string {
  const value = trimmed(raw);
  return MEDIAVINE_SITE_ID_PATTERN.test(value) ? value : '';
}

/**
 * The Mediavine site id this deployment is allowed to expose.
 *
 * The wrapper is issued for `sleekdrops.com` and, in Mediavine's words, can
 * only be used on the site it was generated for. Requiring an explicit
 * production deployment here is the same second boundary the publisher id has,
 * behind the deploy workflow's pinned-empty preview value: a repo- or
 * organisation-level variable added later cannot make `sleekdrops.pages.dev`
 * serve this site's ads.
 */
export function mediavineSiteIdForDeployment(
  deployment: SiteDeployment,
  raw: string | undefined,
): string {
  return deployment === 'production' ? mediavineSiteId(raw) : '';
}

/** The wrapper URL for one Mediavine site id, or `''` for none. */
export function mediavineScriptSrc(id: string): string {
  return id ? `${MEDIAVINE_SCRIPT_ORIGIN}/tags/${id}.js` : '';
}

/** This build's ad configuration. */
export function adsEnv(): AdsEnv {
  const deployment = deploymentOf(env?.PUBLIC_SITE_ENV);
  const journey = mediavineSiteIdForDeployment(deployment, env?.PUBLIC_MEDIAVINE_SITE_ID);
  return {
    client: publisherIdForDeployment(deployment, env?.PUBLIC_ADSENSE_CLIENT),
    slots: {
      articleMid: trimmed(env?.PUBLIC_ADSENSE_SLOT_ARTICLE_MID),
      articleEnd: trimmed(env?.PUBLIC_ADSENSE_SLOT_ARTICLE_END),
      sidebar: trimmed(env?.PUBLIC_ADSENSE_SLOT_SIDEBAR),
      feed: trimmed(env?.PUBLIC_ADSENSE_SLOT_FEED),
    },
    mediavineSiteId: journey,
    mediavineScriptSrc: mediavineScriptSrc(journey),
  };
}
