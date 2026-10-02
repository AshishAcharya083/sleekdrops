/**
 * How the platform selection is wired through the panel. The rules themselves
 * are unit-tested in platform.test.ts; the panel has no component harness (a
 * .tsx cannot be imported by node's type stripping), so - as in
 * overview-resilience.test.ts - these guard the sources: the one request
 * function sends the header, a switch empties every poll and remounts the
 * page, nothing renders before a platform is chosen, and every page reads its
 * lists off the selected platform instead of SleekDrops' constants.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const api = read('./api.ts');
const hooks = read('./hooks.ts');
const app = read('./App.tsx');
const topics = read('./pages/Topics.tsx');
const published = read('./pages/Published.tsx');
const pipeline = read('./pages/Pipeline.tsx');
const drawer = read('./pages/ManualTopicDrawer.tsx');
const settings = read('./pages/Settings.tsx');
const profile = read('./pages/PlatformProfile.tsx');
const pageDir = fileURLToPath(new URL('./pages', import.meta.url));

/** The body of `async function request` in api.ts. */
function requestBody(): string {
  const start = api.indexOf('async function request<T>(');
  assert.ok(start !== -1, 'api.ts no longer has its request function');
  const end = api.indexOf('\n}\n', start);
  return api.slice(start, end);
}

test('the single request function adds X-Platform to every call it sends', () => {
  const body = requestBody();
  const inject = body.indexOf('Object.assign(headers, platformHeaders(path, method, getPlatform()));');
  const send = body.indexOf('await fetch(');
  assert.ok(inject !== -1, 'request() must apply the platform header rule');
  assert.ok(inject < send, 'the header is added before the request leaves');
  // Both the JSON client and the multipart upload go through it.
  assert.match(api, /export async function api<T>[\s\S]*?return request<T>\(/);
  assert.match(api, /export async function apiUpload<T>[\s\S]*?return request<T>\(/);
  assert.equal(api.match(/\bfetch\(/g)?.length, 1, 'no second fetch can skip the header');
});

test('no page fetches around the request function', () => {
  for (const file of readdirSync(pageDir).filter((f) => f.endsWith('.tsx'))) {
    assert.doesNotMatch(read(`./pages/${file}`), /\bfetch\(/, `${file} must call api(), not fetch()`);
  }
});

test('the selection lives in memory per tab and is persisted on switch', () => {
  assert.match(api, /const platformSelection = createPlatformSelection\(localStorage\);/);
  assert.match(api, /export function setPlatform\(platformId: string\): boolean \{\s*return platformSelection\.select\(platformId\);/);
});

test('a switch empties every poll and drops a response for the previous platform', () => {
  assert.match(hooks, /const requestedFor = getPlatform\(\);/);
  assert.match(hooks, /if \(!alive\.current \|\| getPlatform\(\) !== requestedFor\) return;/);
  assert.match(hooks, /alive\.current && getPlatform\(\) === requestedFor\) setError/);
  assert.match(hooks, /onPlatformChange\(\(\) => \{\s*setData\(null\);\s*setError\(null\);/);
});

test('every page is remounted under the selected platform, and none renders without one', () => {
  assert.match(app, /<PlatformContext\.Provider value=\{platform\}>\s*<Fragment key=\{platform\.id\}>/);
  assert.match(app, /\{platform \? \(\s*<PlatformContext\.Provider/, 'pages wait for a platform');
  for (const page of ['Overview', 'Topics', 'Pipeline', 'Published', 'Channels', 'Sessions', 'SettingsPage']) {
    const at = app.indexOf(`<${page}`);
    assert.ok(at > app.indexOf('<Fragment key={platform.id}>'), `${page} is inside the keyed tree`);
    assert.ok(at < app.indexOf('</Fragment>'), `${page} is inside the keyed tree`);
  }
  assert.match(app, /if \(!setPlatform\(next\.id\)\) return;/, 'a switch goes through the selection');
});

test('the switcher is built from GET /api/platforms and nothing is hardcoded', () => {
  assert.match(app, /api<PlatformList>\(PLATFORMS_PATH\)/);
  assert.match(app, /resolveSelection\(listed, getPlatform\(\)\)/);
  assert.doesNotMatch(app, /SleekDrops|sleekdrops|peakodds/i, 'the title and selection come from the API');
  assert.match(app, /\{platform && `\$\{platform\.name\} `\}/, 'the title shows the selected platform');
  assert.match(app, /aria-pressed=\{p\.id === platformId\}/, 'one click per platform, state announced');
});

test('the shell has a loading, an error and an empty state of its own', () => {
  assert.match(app, /<ApiErrorBanner error=\{platformsError\} onRetry=\{loadPlatforms\} \/>/);
  assert.match(app, /Loading platforms…/);
  assert.match(app, /lists no platforms yet/);
});

test('Channels and Offers follow the selected platform', () => {
  assert.match(app, /const tabs = platform \? visibleTabs\(TABS, platform\) : TABS;/);
  assert.match(app, /\{tabs\.map\(\(t\) =>/);
  assert.match(pipeline, /onOpenOffers=\{offersEnabled\(platform\) \? \(\) => setOffersFor\(openId\) : null\}/);
  assert.match(pipeline, /\{onOpenOffers && \(\s*<div className="section">\s*<h2>\s*Offer coverage/);
  assert.match(settings, /onSaved\?\.\(\);/, 'saving settings re-reads distribution_enabled');
});

test("topic categories and post types are the selected platform's", () => {
  assert.doesNotMatch(api, /TOPIC_CATEGORIES|TOPIC_POST_TYPES/);
  assert.match(drawer, /platform\.categories\.map/);
  assert.match(drawer, /platform\.post_types\.map/);
  assert.match(drawer, /edition_id: editionId,/);
  assert.match(drawer, /\.\.\.\(eventStartsAt \? \{ event_starts_at: eventStartsAt \} : \{\}\)/);
});

test('Topics and Published show the edition, the event time and Expired', () => {
  for (const [name, source] of [['Topics', topics], ['Published', published]]) {
    assert.match(source, /<EditionEvent/, `${name} renders the edition and event`);
    assert.match(source, /eventStartsAt=\{(t|p)\.event_starts_at\}/, `${name} passes the kick-off`);
    assert.match(source, /<th>Edition \/ event<\/th>/, `${name} has the column`);
  }
  assert.doesNotMatch(published, /https:\/\/sleekdrops\.com/, 'a PeakOdds slug must not link to SleekDrops');
});

test('the profile editor saves against the version it loaded and handles the 409', () => {
  assert.match(profile, /profileSaveBody\(current\.version, author, form\)/);
  assert.match(profile, /method: 'PUT'/);
  assert.match(profile, /error\.status === 409/);
  assert.match(profile, /conflictMessage\(/);
  assert.match(profile, /setProfileAuthor\(author\)/, 'the author is remembered after a save');
  assert.match(profile, /api<ProfileVersionList>\('\/api\/platform\/profile\/versions'\)/);
  assert.match(settings, /<PlatformProfileEditor \/>/);
});
