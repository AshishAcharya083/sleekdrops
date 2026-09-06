// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import remarkGfm from 'remark-gfm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import rehypeAffiliateLinks from './src/lib/rehype-affiliate-links.mjs';
import { createSitemapPolicy, readContentIndex } from './src/lib/sitemap-policy.mjs';

const site = process.env.SITE_URL ?? 'https://sleekdrops.com';

// The posts scripts/fetch-content.mjs has written, read once at config time so
// the sitemap can carry a real `lastmod` per URL and leave out the listings not
// worth crawling. Empty before the prebuild has run (an `astro check` on a fresh
// checkout), which simply means a sitemap with no dates - never a failure.
const posts = readContentIndex(resolve(dirname(fileURLToPath(import.meta.url)), 'src/content/blog'));
const sitemapPolicy = createSitemapPolicy(posts);

// Static output — deployed to Cloudflare Pages as a plain build, no adapter
// needed (the @astrojs/cloudflare adapter is only for SSR endpoints).
export default defineConfig({
  site,
  output: 'static',
  build: {
    // `file` writes blog/<slug>.html rather than blog/<slug>/index.html. This is
    // what makes the canonical URL the one Cloudflare Pages actually serves:
    // Pages routes a request for /blog/<slug> to whichever file exists and
    // redirects to the other form, so with the default `directory` layout every
    // slash-less URL - the form `trailingSlash: 'never'`, the canonical tag, the
    // sitemap and the JSON-LD all name - answered with a 308 to /blog/<slug>/.
    // Google indexed the slash form as a result. Astro's own docs note that
    // `trailingSlash` does not reach prerendered output; the file layout does.
    format: 'file',
  },
  integrations: [
    sitemap({
      filter: sitemapPolicy.filter,
      serialize: sitemapPolicy.serialize,
    }),
  ],
  trailingSlash: 'never',
  markdown: {
    // GFM enables pipe-tables, task lists, strikethrough, and autolinks in
    // every .md file under src/content/blog/. See docs/md-rule.md for the
    // full list of supported syntax.
    remarkPlugins: [remarkGfm],
    // Every /go/<slug> link in an article body is a paid placement, and Google
    // asks for rel="sponsored" on those; the markdown pipeline is the only place
    // body links can be given it.
    rehypePlugins: [rehypeAffiliateLinks],
    shikiConfig: {
      theme: 'github-light',
      wrap: true,
    },
  },
});
