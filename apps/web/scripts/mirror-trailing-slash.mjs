// Writes the trailing-slash copy of every page, so that neither form of a URL
// redirects to the other.
//
// Fixes ERR_TOO_MANY_REDIRECTS on the live site: browsers that read a page
// before `build.format: 'file'` reversed the URL shape still hold Cloudflare
// Pages' uncached-forever 308 from /blog/<slug> to /blog/<slug>/, and the server
// now answers that with a 308 straight back. The rule, and the whole story, is
// in src/lib/trailing-slash-mirror.mjs, where it is unit-tested.
//
// Runs last in package.json -> scripts.build, after check-anchors, so the
// anchor check reads one copy of each page rather than two.

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { planTrailingSlashMirrors } from '../src/lib/trailing-slash-mirror.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'dist');

function fail(message) {
  console.error(`\n[mirror-trailing-slash] ${message}\n`);
  process.exit(1);
}

/** Every .html file under `dir`, as POSIX paths relative to it. */
function htmlPathsIn(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return htmlPathsIn(join(dir, entry.name), `${prefix}${entry.name}/`);
    }
    return entry.isFile() && entry.name.endsWith('.html') ? [`${prefix}${entry.name}`] : [];
  });
}

if (!existsSync(DIST)) {
  fail(`Missing ${DIST}. Run \`pnpm build\` first.`);
}

const pages = htmlPathsIn(DIST);
if (pages.length === 0) fail(`No HTML pages found in ${DIST}.`);

const plan = planTrailingSlashMirrors(pages);

for (const { source, mirror } of plan) {
  const target = join(DIST, ...mirror.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(DIST, ...source.split('/')), target);
}

console.log(
  `[mirror-trailing-slash] ${plan.length} of ${pages.length} pages now answer at both /path and /path/ ` +
    `(${DIST.split(sep).pop()}/).`,
);
