// Postbuild step: copy dist/sitemap-index.xml to dist/sitemap.xml so the
// sitemap is also reachable at the conventional /sitemap.xml path.
//
// @astrojs/sitemap hardcodes the output filename to sitemap-index.xml; we
// can't change that via config. Serving the same content under both URLs
// avoids relying on a _redirects rewrite (which has been flaky for path
// rewrites in practice) and gives Google a real file to fetch.
//
// The copied file is still a sitemap INDEX that references sitemap-0.xml,
// so the structure remains valid — Google sees /sitemap.xml as an index,
// follows it to /sitemap-0.xml, and reads the URL list from there.

import { copyFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, '../dist');
const SOURCE = resolve(DIST, 'sitemap-index.xml');
const TARGET = resolve(DIST, 'sitemap.xml');

if (!existsSync(SOURCE)) {
  console.warn(
    `[copy-sitemap] No sitemap-index.xml found at ${SOURCE}. Did @astrojs/sitemap run? Skipping copy.`
  );
  process.exit(0);
}

copyFileSync(SOURCE, TARGET);
console.log(`[copy-sitemap] Copied ${SOURCE} -> ${TARGET}`);
