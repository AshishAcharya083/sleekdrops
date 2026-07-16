// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import remarkGfm from 'remark-gfm';

const site = process.env.SITE_URL ?? 'https://sleekdrops.com';

// Static output — deployed to Cloudflare Pages as a plain build, no adapter
// needed (the @astrojs/cloudflare adapter is only for SSR endpoints).
export default defineConfig({
  site,
  output: 'static',
  integrations: [sitemap()],
  trailingSlash: 'never',
  markdown: {
    // GFM enables pipe-tables, task lists, strikethrough, and autolinks in
    // every .md file under src/content/blog/. See docs/md-rule.md for the
    // full list of supported syntax.
    remarkPlugins: [remarkGfm],
    shikiConfig: {
      theme: 'github-light',
      wrap: true,
    },
  },
});
