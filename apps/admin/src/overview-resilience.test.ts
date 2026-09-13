/**
 * The Overview tab used to return early on any poll error, so a single failed
 * 4s poll - a transient 500, or a 401 after the admin token was cleared - threw
 * away the payload it had just rendered and left the operator's landing screen
 * as one banner. Every other tab already rendered the banner above the data it
 * was holding.
 *
 * The panel has no component test harness (a .tsx cannot be imported by
 * node's type stripping), so these guard the sources the way the layout suites
 * already do: the page must keep its content while an error is present, the
 * placeholder must belong to the first load alone, and no tab may go back to
 * calling every failure "API unreachable".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const overview = read('./pages/Overview.tsx');
const hooks = read('./hooks.ts');
const pageDir = fileURLToPath(new URL('./pages', import.meta.url));
const pollingPages = readdirSync(pageDir)
  .filter((f) => f.endsWith('.tsx'))
  .map((f) => ({ name: f, source: readFileSync(`${pageDir}/${f}`, 'utf8') }))
  .filter((page) => page.source.includes('usePoll<'));

test('a failed poll keeps the payload the page is already showing', () => {
  const failurePath = /\.catch\(\([^)]*\) => \{([\s\S]*?)\n {6}\}\);/.exec(hooks);
  assert.ok(failurePath, 'usePoll no longer has a recognisable failure path');
  assert.doesNotMatch(failurePath[1], /setData\(/, 'a failed poll must not touch the last good data');
});

test('usePoll hands the tabs a classified failure, not a bare message', () => {
  assert.match(hooks, /error: ApiError \| null/, 'the banner needs the failure kind to describe it');
  assert.match(hooks, /setError\(toApiError\(e\)\)/);
  assert.match(hooks, /captureError\(e, \{ route: path, action: 'poll' \}\)/, 'reporting is unchanged');
  assert.match(hooks, /intervalMs = 4000/, 'the 4s cadence is unchanged');
});

test('the Overview renders its content alongside the banner, never instead of it', () => {
  assert.doesNotMatch(
    overview,
    /if \(error\) return/,
    'returning on error is exactly the bug: the stat grid and sessions table disappear',
  );
  const grid = overview.indexOf('<div className="grid cols-4">');
  const table = overview.indexOf('<table>');
  const banner = overview.lastIndexOf('<ApiErrorBanner error={error} />', grid);
  assert.ok(banner !== -1, 'the banner sits above the stat grid');
  assert.ok(grid !== -1 && table > grid, 'the stat grid and the sessions table are still rendered');
});

test('only a first load that never succeeded shows the loading placeholder', () => {
  const placeholder = /if \(!data\) \{\s*return error \? <ApiErrorBanner error=\{error\} \/> : <p className="muted">Loading…<\/p>;/;
  assert.match(
    overview,
    placeholder,
    'with no data the tab shows the failure if there is one, and the placeholder otherwise',
  );
});

test('the Overview marks the sections the agent could not load', () => {
  assert.match(overview, /data\.failedSections \?\? \[\]/, 'partial failures come back in the payload');
  assert.match(overview, /className="warn-banner"/, 'stale figures are flagged, not silently shown');
});

test('no tab explains a failure as "API unreachable" any more', () => {
  for (const { name, source } of pollingPages) {
    assert.doesNotMatch(source, /API unreachable/, `${name}: the cause comes from the failure kind`);
    assert.match(source, /<ApiErrorBanner error=\{error\} \/>/, `${name}: uses the shared banner`);
  }
});

test('every polling tab is covered by that guarantee', () => {
  assert.deepEqual(
    pollingPages.map((p) => p.name).sort(),
    ['Overview.tsx', 'Pipeline.tsx', 'Published.tsx', 'Sessions.tsx', 'Topics.tsx'],
  );
});
