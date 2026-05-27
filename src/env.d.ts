/// <reference path="../.astro/types.d.ts" />

interface ImportMetaEnv {
  readonly SITE_URL?: string;
  readonly BLOG_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
