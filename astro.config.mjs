// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

const site = process.env.SITE_URL ?? 'https://sleekdrops.com';

// Static output — deployed to Cloudflare Pages as a plain build, no adapter
// needed (the @astrojs/cloudflare adapter is only for SSR endpoints).
export default defineConfig({
  site,
  output: 'static',
  integrations: [sitemap()],
  trailingSlash: 'never',
  markdown: {
    shikiConfig: {
      theme: 'github-light',
      wrap: true,
    },
  },
});
