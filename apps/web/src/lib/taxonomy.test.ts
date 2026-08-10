/**
 * Taxonomy parity - the guard that makes docs/analytics-events.md canonical by
 * enforcement rather than by assertion.
 *
 * Three ways an event name can drift, each of which this file fails the build
 * on:
 *
 *  1. A constant in the `EVENTS` map with no section in the taxonomy doc.
 *  2. A documented product event with no constant in the `EVENTS` map.
 *  3. A `data-track` dispatch site in a `.astro` component that hardcodes the
 *     event-name string instead of interpolating an `EVENTS.*` reference.
 *
 * (3) is the one hole the compiler cannot close: `track()` takes the taxonomy
 * union, so every code call site is type-checked, but a `data-track` attribute
 * reaches the dispatcher as a runtime string. chrome.ts drops an unknown name
 * at runtime; this test catches it before it ships.
 *
 * Both sources are read as text. `analytics.ts` cannot be imported here - it
 * pulls in the DevTeam SDK and reads Vite's `import.meta.env`, neither of which
 * exists under the bare `node --test` runner - and regex over the two files is
 * proportionate for a shape this small.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const libDir = fileURLToPath(new URL('.', import.meta.url));
const srcDir = join(libDir, '..');
const docPath = join(srcDir, '..', 'docs', 'analytics-events.md');

/**
 * Doc sections that deliberately have no `EVENTS` constant: the two platform
 * events (contracts with the analytics platform, not product taxonomy), the
 * sticky experiment stamp, and the theme state property. Listed by exact name
 * rather than by a `$`-prefix rule, so a new platform-shaped section still has
 * to be exempted consciously instead of slipping through on its spelling.
 */
const SECTIONS_WITHOUT_A_CONSTANT = new Set([
  '$experiment_viewed',
  '$client_error',
  '$exp_<experimentKey> (sticky property)',
  'theme (state property)',
]);

/** Every event name in the `EVENTS` map, read out of the module source. */
function parseEventNames(source: string): string[] {
  const map = /export const EVENTS = \{([\s\S]*?)\} as const;/.exec(source);
  assert.ok(map, 'no `export const EVENTS = { ... } as const;` map in src/lib/analytics.ts');
  const names = [...map[1].matchAll(/^\s*\w+:\s*'([^']+)',?\s*$/gm)].map((m) => m[1]);
  // An entry the regex fails to read would weaken the guard without failing it,
  // so every line in the map that is not blank or a comment has to have parsed.
  const entries = map[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^(\/\/|\/?\*)/.test(line));
  assert.equal(names.length, entries.length, `unreadable entry in the EVENTS map: ${map[1]}`);
  return names;
}

/** The `### ` headings inside the doc's `## Events` section, backticks stripped. */
function parseDocumentedSections(doc: string): string[] {
  const events = /\n## Events\n([\s\S]*?)\n## /.exec(doc);
  assert.ok(events, 'no `## Events` section in docs/analytics-events.md');
  const sections = [...events[1].matchAll(/^### (.+)$/gm)].map((m) =>
    m[1].replace(/`/g, '').trim(),
  );
  assert.ok(sections.length > 0, 'parsed no `### ` event sections out of the taxonomy doc');
  return sections;
}

/** Names documented in `doc` that `source` has no constant for, and vice versa. */
function drift(source: string, doc: string): { undocumented: string[]; unnamed: string[] } {
  const named = parseEventNames(source);
  const documented = parseDocumentedSections(doc);
  return {
    undocumented: named.filter((name) => !documented.includes(name)),
    unnamed: documented.filter(
      (section) => !named.includes(section) && !SECTIONS_WITHOUT_A_CONSTANT.has(section),
    ),
  };
}

const analyticsSource = (): string => readFileSync(join(libDir, 'analytics.ts'), 'utf8');
const taxonomyDoc = (): string => readFileSync(docPath, 'utf8');

interface DispatchSite {
  /** The source expression the dispatch site assigns the event name from. */
  readonly expression: string;
  /** Where it was written, for the failure message. */
  readonly context: string;
}

/**
 * Every place an `.astro` component names an event for the `[data-track]`
 * dispatcher, in both spellings the codebase uses: the plain `data-track=`
 * attribute, and the `track` key of a `data={{ ... }}` passthrough object.
 *
 * The lookbehind on the object form is what keeps `'track-props':` - and the
 * `data-track-props` attribute - from being read as a dispatch site.
 */
function dispatchSites(source: string, file: string): DispatchSite[] {
  const sites: DispatchSite[] = [];
  const attribute = /data-track=(?:\{([^}]*)\}|("[^"]*"|'[^']*'))/g;
  const objectKey = /(?<![-\w'"])track:\s*([^,}\n]+)/g;
  for (const [, braced, quoted] of source.matchAll(attribute)) {
    sites.push({ expression: (braced ?? quoted).trim(), context: `${file} (data-track=)` });
  }
  for (const [, value] of source.matchAll(objectKey)) {
    sites.push({ expression: value.trim(), context: `${file} (data={{ track: ... }})` });
  }
  return sites;
}

const EVENTS_REFERENCE = /^EVENTS\.\w+$/;

function astroFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return astroFiles(path);
    return entry.name.endsWith('.astro') ? [path] : [];
  });
}

test('the EVENTS map and the taxonomy doc name exactly the same events', () => {
  // Both directions in one assertion, so a rename that breaks each of them
  // reports both halves rather than only the first to fail.
  assert.deepEqual(
    drift(analyticsSource(), taxonomyDoc()),
    { undocumented: [], unnamed: [] },
    'undocumented: EVENTS constants with no "### <Event Name>" section in ' +
      'docs/analytics-events.md; unnamed: documented events with no constant in the EVENTS map',
  );
});

test('the parity check catches drift in either direction', () => {
  const source = `export const EVENTS = {
  pageView: 'Page Viewed',
  ghost: 'Ghost Event',
} as const;`;
  const doc = '\n## Events\n\n### Page Viewed\n\n### Orphan Event\n\n### $client_error\n\n## Next\n';
  assert.deepEqual(drift(source, doc), {
    undocumented: ['Ghost Event'],
    unnamed: ['Orphan Event'],
  });
});

test('the parity check exempts the platform and state-property sections by name', () => {
  const source = "export const EVENTS = {\n  pageView: 'Page Viewed',\n} as const;";
  const doc = [
    '',
    '## Events',
    '',
    '### Page Viewed',
    '',
    '### $experiment_viewed',
    '',
    '### $client_error',
    '',
    '### `$exp_<experimentKey>` (sticky property)',
    '',
    '### `theme` (state property)',
    '',
    '## Next',
    '',
  ].join('\n');
  assert.deepEqual(drift(source, doc), { undocumented: [], unnamed: [] });
  // A new `$`-prefixed section is not exempt just for looking like a platform event.
  assert.deepEqual(drift(source, doc.replace('## Next', '### $new_platform_event\n\n## Next')), {
    undocumented: [],
    unnamed: ['$new_platform_event'],
  });
});

test('every .astro data-track dispatch site names an EVENTS constant', () => {
  const sites = astroFiles(srcDir).flatMap((file) =>
    dispatchSites(readFileSync(file, 'utf8'), file.slice(srcDir.length + 1)),
  );
  // A scanner that matched nothing would pass this vacuously forever.
  assert.ok(sites.length > 0, 'found no [data-track] dispatch sites to check');
  const hardcoded = sites.filter((site) => !EVENTS_REFERENCE.test(site.expression));
  assert.deepEqual(
    hardcoded.map((site) => `${site.context}: ${site.expression}`),
    [],
    'data-track dispatch sites must interpolate an EVENTS.* constant, not a literal',
  );
});

test('the dispatch scanner catches a hardcoded name in either spelling', () => {
  const sample = `
    <a data-track="Hero CTA Clickd" data-track-props={JSON.stringify({ cta: 'x' })}>a</a>
    <Button data={{ track: 'Deal Card Clicked', 'track-props': JSON.stringify({ slug: 's' }) }} />
    <a data-track={EVENTS.heroCtaClick}>ok</a>
  `;
  const found = dispatchSites(sample, 'sample.astro');
  assert.deepEqual(found.map((site) => site.expression).sort(), [
    '"Hero CTA Clickd"',
    "'Deal Card Clicked'",
    'EVENTS.heroCtaClick',
  ]);
  assert.equal(found.filter((site) => !EVENTS_REFERENCE.test(site.expression)).length, 2);
});
