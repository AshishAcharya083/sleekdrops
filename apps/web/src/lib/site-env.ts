/**
 * Which deployment this build is, and the one thing that hangs off the answer:
 * whether search engines may index what it publishes.
 *
 * A module of its own for the same reason `./ads-env`, `./ga-env` and
 * `./flags-env` are - `import.meta.env` is inlined by Vite at build time and does
 * not exist under the bare `node --test` runner - which is what lets the rule be
 * unit-tested directly rather than inferred from rendered HTML.
 *
 * The rule exists because `develop` and `main` are deliberately kept at the same
 * code level, so the preview deploy renders the *same pages* as production from
 * the *same* live editorial content. Left indexable, that is a complete second
 * copy of the site on a host Google has no reason to prefer - which splits the
 * ranking signals of every page against itself, and to a reviewer looking at an
 * AdSense application reads as scraped or duplicated content on a domain the
 * account does not own.
 *
 * Fail-safe direction: **only an explicit `production` is indexable.** An unset,
 * empty, misspelled or unrecognised value is treated as a preview and noindexed,
 * so a new preview environment added later is safe by default rather than safe
 * only if someone remembers this file. The inverse failure - production silently
 * noindexing itself because the variable went missing - would be far more
 * expensive and is caught by a test over the deploy workflows instead (see
 * site-env.test.ts), which fails CI rather than quietly de-listing the site.
 */

export type SiteDeployment = 'production' | 'preview';

export interface SiteEnv {
  /** Which deployment this is. Anything not explicitly production is a preview. */
  deployment: SiteDeployment;
  /** Whether crawlers may index this build. True only for production. */
  indexable: boolean;
}

const env = import.meta.env as ImportMetaEnv | undefined;

/**
 * The only value that means "this is the real site".
 *
 * Spelled out here and again in `scripts/generate-robots.mjs`, which cannot
 * import this module - it runs as plain node before the build, the same
 * constraint `generate-ads-txt.mjs` has with `publisherId()`. The two must agree:
 * a build that renders `noindex` on every page while publishing a robots.txt
 * inviting the crawler in is not a contradiction that fails anywhere, it is just
 * a preview that leaks.
 */
export const PRODUCTION = 'production';

/** This deployment, from the raw variable. Anything unrecognised is a preview. */
export function deploymentOf(raw: string | undefined): SiteDeployment {
  return (raw ?? '').trim() === PRODUCTION ? 'production' : 'preview';
}

/** This build's deployment configuration. */
export function siteEnv(): SiteEnv {
  const deployment = deploymentOf(env?.PUBLIC_SITE_ENV);
  return { deployment, indexable: deployment === 'production' };
}
