/// <reference path="../.astro/types.d.ts" />

interface ImportMetaEnv {
  readonly BLOG_API_URL?: string;
  readonly SITE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
