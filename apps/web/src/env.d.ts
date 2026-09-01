/// <reference path="../.astro/types.d.ts" />

interface ImportMetaEnv {
  readonly SITE_URL?: string;
  readonly BLOG_API_URL?: string;
  /** DevTeam Analytics public ingest key (dtp_...). Empty disables the sink. */
  readonly PUBLIC_DEVTEAM_ANALYTICS_INGEST_KEY?: string;
  /** DevTeam Analytics ingest host. Defaults to http://localhost:6080. */
  readonly PUBLIC_DEVTEAM_ANALYTICS_HOST?: string;
  /** `true` renders the DevTeam in-app feedback widget. Anything else hides it. */
  readonly PUBLIC_DEVTEAM_ANALYTICS_FEEDBACK?: string;
  /** DevTeam A/B Testing flag-delivery host. Empty disables experiments. */
  readonly PUBLIC_DEVTEAM_FLAGS_HOST?: string;
  /** DevTeam A/B Testing per-environment client key. Empty disables experiments. */
  readonly PUBLIC_DEVTEAM_FLAGS_CLIENT_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
