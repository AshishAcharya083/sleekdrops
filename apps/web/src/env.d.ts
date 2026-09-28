/// <reference path="../.astro/types.d.ts" />

interface ImportMetaEnv {
  readonly SITE_URL?: string;
  readonly BLOG_API_URL?: string;
  /**
   * Which deployment this build is. Only the exact string `production` is
   * indexable; anything else (unset included) is treated as a preview and
   * noindexed. See src/lib/site-env.ts.
   */
  readonly PUBLIC_SITE_ENV?: string;
  /**
   * Google Analytics 4 measurement id (`G-...`) for THIS environment's property.
   * Empty - or anything that is not a `G-` measurement id - disables the GA4
   * sink silently after one warning.
   */
  readonly PUBLIC_GA4_ID?: string;
  /** DevTeam Analytics public ingest key (dtp_...). Ignored by production builds. */
  readonly PUBLIC_DEVTEAM_ANALYTICS_INGEST_KEY?: string;
  /** DevTeam Analytics ingest host. Defaults to http://localhost:6080. */
  readonly PUBLIC_DEVTEAM_ANALYTICS_HOST?: string;
  /** `true` renders DevTeam feedback in configured non-production builds. */
  readonly PUBLIC_DEVTEAM_ANALYTICS_FEEDBACK?: string;
  /** DevTeam A/B Testing flag-delivery host. Empty disables experiments. */
  readonly PUBLIC_DEVTEAM_FLAGS_HOST?: string;
  /** DevTeam A/B Testing per-environment client key. Empty disables experiments. */
  readonly PUBLIC_DEVTEAM_FLAGS_CLIENT_KEY?: string;
  /**
   * Journey by Mediavine site id - the `<id>` in the script wrapper
   * `https://scripts.scriptwrapper.com/tags/<id>.js`. Empty, or any build that
   * is not production, serves no ads and loads no partner script.
   */
  readonly PUBLIC_MEDIAVINE_SITE_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
