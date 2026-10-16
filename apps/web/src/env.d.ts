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
  /** Google AdSense publisher id (ca-pub-...). Empty disables ads everywhere. */
  readonly PUBLIC_ADSENSE_CLIENT?: string;
  /** Slot id of the mid-article unit. Empty disables that placement only. */
  readonly PUBLIC_ADSENSE_SLOT_ARTICLE_MID?: string;
  /** Slot id of the end-of-article unit. Empty disables that placement only. */
  readonly PUBLIC_ADSENSE_SLOT_ARTICLE_END?: string;
  /** Slot id of the sticky sidebar unit. Empty disables that placement only. */
  readonly PUBLIC_ADSENSE_SLOT_SIDEBAR?: string;
  /** Slot id of the in-feed card unit. Empty disables that placement only. */
  readonly PUBLIC_ADSENSE_SLOT_FEED?: string;
  /**
   * Journey by Mediavine site id - the `<id>` in the script wrapper
   * `https://scripts.scriptwrapper.com/tags/<id>.js`. Empty, or any build that
   * is not production, loads no Journey wrapper. Independent of the AdSense
   * publisher id: the two coexist while the site applies to both.
   */
  readonly PUBLIC_MEDIAVINE_SITE_ID?: string;
  /**
   * Optional URL of the authorised-sellers file Journey issues, fetched by
   * scripts/generate-ads-txt.mjs on a production build instead of the committed
   * copy at ads/ads.txt. Build-time only; never reaches the browser.
   */
  readonly ADS_TXT_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
