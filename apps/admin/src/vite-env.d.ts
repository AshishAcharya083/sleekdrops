/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Default agent API base baked in at build time (Cloudflare Pages builds). */
  readonly VITE_API_BASE?: string;
  /**
   * DevTeam Analytics public ingest key (dtp_...) — must point at the same
   * DevTeam project the website reports to. Empty disables the sink silently.
   */
  readonly VITE_DEVTEAM_ANALYTICS_INGEST_KEY?: string;
  /** DevTeam Analytics ingest host. Empty disables the sink silently. */
  readonly VITE_DEVTEAM_ANALYTICS_HOST?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
