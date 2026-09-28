/**
 * The build-time configuration of the ad partner - Journey by Mediavine - and
 * the one value it needs: this site's id, the `<id>` in the script wrapper
 * `https://scripts.scriptwrapper.com/tags/<id>.js` shown in the Journey
 * dashboard under Settings → Ad Setup.
 *
 * That wrapper is the whole integration. Mediavine places, sizes, refreshes and
 * consent-gates every unit itself from that one script, so the site carries no
 * ad units, slot ids or placement rules of its own: a page component never
 * learns which network answers, and swapping the partner later touches this
 * module and `components/ads/MediavineScript.astro`, not the pages.
 *
 * A module of its own for the same reason `./analytics-env` and `./ga-env` are
 * - `import.meta.env` is inlined by Vite at build time and does not exist under
 * the bare `node --test` runner - which is what lets the rule be unit-tested
 * directly rather than inferred from rendered HTML.
 *
 * Read lazily rather than captured in module constants, so a substituted value
 * applies however the module was loaded.
 */

import { deploymentOf, type SiteDeployment } from './site-env.ts';

export interface AdsEnv {
  /** This site's Mediavine id, or `''` for a build that serves no ads. */
  siteId: string;
  /** The script wrapper URL for this build, or `''` when ads are off. */
  scriptSrc: string;
}

/** Where every Mediavine script wrapper is served from. */
export const SCRIPT_WRAPPER_ORIGIN = 'https://scripts.scriptwrapper.com';

/**
 * The only shape a site id may take: the URL-safe token Mediavine mints, which
 * is what the wrapper's path is built from. Validated and not merely trimmed,
 * for the reason `measurementId` in `./ga-env` is: a value carrying a slash, a
 * quote or whitespace would be written into a `<script src>` on every page, and
 * a value that is not this site's id requests a wrapper that serves nothing
 * while the page looks healthy.
 */
const SITE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;

/** A configured site id, or `''` for a build that has none to use. */
export function siteId(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  return SITE_ID_PATTERN.test(value) ? value : '';
}

/**
 * The site id this deployment is allowed to expose.
 *
 * The wrapper is issued for `sleekdrops.com` and, in Mediavine's words, can
 * only be used on the site it was generated for. Requiring an explicit
 * production deployment here is a second boundary behind the deploy workflow's
 * pinned-empty preview value: a repo- or organisation-level variable added
 * later cannot make `sleekdrops.pages.dev` serve this site's ads.
 */
export function siteIdForDeployment(deployment: SiteDeployment, raw: string | undefined): string {
  return deployment === 'production' ? siteId(raw) : '';
}

/** The wrapper URL for one site id, or `''` for none. */
export function scriptWrapperSrc(id: string): string {
  return id ? `${SCRIPT_WRAPPER_ORIGIN}/tags/${id}.js` : '';
}

const env = import.meta.env as ImportMetaEnv | undefined;

/** This build's ad configuration. */
export function adsEnv(): AdsEnv {
  const deployment = deploymentOf(env?.PUBLIC_SITE_ENV);
  const id = siteIdForDeployment(deployment, env?.PUBLIC_MEDIAVINE_SITE_ID);
  return { siteId: id, scriptSrc: scriptWrapperSrc(id) };
}
