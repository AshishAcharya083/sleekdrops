/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Default agent API base baked in at build time (Cloudflare Pages builds). */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
