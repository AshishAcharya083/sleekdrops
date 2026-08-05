/// <reference path="../.astro/types.d.ts" />

interface ImportMetaEnv {
  readonly SITE_URL?: string;
  readonly BLOG_API_URL?: string;
  /** DevTeam Analytics public ingest key (dtp_...). Empty disables the sink. */
  readonly PUBLIC_Devteam__IngestKey?: string;
  /** DevTeam Analytics ingest host. Defaults to http://localhost:6080. */
  readonly PUBLIC_Devteam__Host?: string;
  /** DevTeam A/B Testing flag-delivery host. Empty disables experiments. */
  readonly PUBLIC_AbTesting__Host?: string;
  /** DevTeam A/B Testing per-environment client key. Empty disables experiments. */
  readonly PUBLIC_AbTesting__ClientKey?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
