/// <reference path="../.astro/types.d.ts" />

interface ImportMetaEnv {
  readonly SITE_URL?: string;
  readonly BLOG_API_URL?: string;
  /** Mixpanel publishable project token. Empty disables analytics. */
  readonly PUBLIC_Mixpanel__ProjectToken?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
