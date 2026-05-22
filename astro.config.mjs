// @ts-check
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import cloudflare from '@astrojs/cloudflare';

const site = process.env.SITE_URL ?? 'https://sleekdrops.com';

export default defineConfig({
  site,
  output: 'hybrid',
  adapter: cloudflare(),
  integrations: [tailwind({ applyBaseStyles: false })],
  trailingSlash: 'never',
});
