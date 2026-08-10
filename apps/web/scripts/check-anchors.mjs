// Fails the build when any generated page contains an in-page anchor whose
// target does not render.
//
// The homepage hero used to link to `#today`, an id emitted only while there was
// an active drop; with the deals list empty the button was inert. That class of
// defect is invisible to `astro check` and to any unit test, because it is a
// property of the *rendered* HTML, so it is checked here over `dist/` after the
// build. Run automatically by package.json -> scripts.build.
//
// Requires Node's type stripping (see the `check:anchors` script) because the
// rule itself lives in src/lib/anchor-integrity.ts, where it is unit-tested.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findBrokenAnchors } from '../src/lib/anchor-integrity.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'dist');

function fail(message) {
  console.error(`\n[check-anchors] ${message}\n`);
  process.exit(1);
}

function htmlFilesIn(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return htmlFilesIn(full);
    return entry.isFile() && entry.name.endsWith('.html') ? [full] : [];
  });
}

if (!existsSync(DIST)) {
  fail(`Missing ${DIST}. Run \`pnpm build\` first.`);
}

const pages = htmlFilesIn(DIST);
if (pages.length === 0) fail(`No HTML pages found in ${DIST}.`);

const failures = pages
  .map((file) => ({ file: relative(ROOT, file), broken: findBrokenAnchors(readFileSync(file, 'utf8')) }))
  .filter(({ broken }) => broken.length > 0);

if (failures.length > 0) {
  const detail = failures
    .map(({ file, broken }) => `  ${file}\n${broken.map((b) => `    ${b.href} → no element with id="${b.id}"`).join('\n')}`)
    .join('\n');
  fail(`In-page references with no target in the rendered HTML:\n${detail}\n\nAn anchor CTA must only render when its target does.`);
}

console.log(`[check-anchors] ${pages.length} page(s) checked - every in-page anchor resolves.`);
