/**
 * The scout lock on the Topics tab.
 *
 * A topic sweep is a background task on the agent, and its 'running' row is
 * the lock that keeps two of them apart. When the instance holding one was
 * recycled the row stayed, every later sweep answered 409, and the panel had
 * no way to show who held the lock or to release it - the operator's only
 * recourse was a SQL console.
 *
 * The panel has no component test harness (a .tsx cannot be imported by node's
 * type stripping), so these guard the source the way the layout and resilience
 * suites already do: the tab has to read the lock route, name the run, its
 * start and its age, and clear it with the verb the agent actually routes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const topics = read('./pages/Topics.tsx');
const api = read('./api.ts');
const styles = read('./styles.css');
const events = read('./analytics.ts');

test('the Topics tab polls the lock the agent reports', () => {
  assert.match(topics, /usePoll<\{ lock: ScoutLock \| null \}>\(\s*'\/api\/scout\/lock',?\s*\)/);
  assert.match(api, /export interface ScoutLock \{/, 'the payload shape is declared, not inlined');
});

test('the banner names the run, when it started and how long it has held the lock', () => {
  const banner = /\{lock && \(([\s\S]*?)\n {6}\)\}/.exec(topics);
  assert.ok(banner, 'the tab no longer renders a lock banner');
  assert.match(banner[1], /\{lock\.id\}/, 'an operator needs the run id to look the sweep up');
  assert.match(banner[1], /fmtTime\(lock\.started_at\)/, 'and when it took the lock');
  assert.match(banner[1], /fmtAge\(lock\.age_seconds\)/, 'and how long it has held it');
  assert.match(banner[1], /fmtAge\(lock\.heartbeat_age_seconds\)/, 'and whether it is still alive');
  assert.match(banner[1], /className="warn-banner lock-banner"/, 'held, not broken - a warning');
  // The ages are recomputed on every 4s poll: a live region would re-announce
  // the whole sentence every four seconds.
  assert.doesNotMatch(banner[1], /<div[^>]*role="status"/, 'the banner is not a live region');
});

test('releasing the lock is confirmed first and uses DELETE', () => {
  assert.match(
    topics,
    /onClick=\{\(\) => setClearingLock\(true\)\}/,
    'the banner button opens the confirmation, it does not fire the request',
  );
  assert.match(
    topics,
    /\{clearingLock && lock && \(/,
    'the dialog reads the live lock, so its age stays true and a finished run closes it',
  );
  assert.match(topics, /api\('\/api\/scout\/lock', \{ method: 'DELETE' \}\)/);
  assert.match(topics, /role="alertdialog" aria-modal="true"/, 'the confirmation is a real dialog');
  assert.match(
    topics,
    /two running at once/,
    'the dialog says what clearing a genuinely live run costs',
  );
  assert.match(topics, /EVENTS\.scoutLockCleared/, 'the release is tracked like the other actions');
  assert.match(events, /scoutLockCleared: 'Scout Lock Cleared'/);
});

test('an action on the tab refreshes the lock, not just the topics', () => {
  const act = /const act = async \(([\s\S]*?)\n {2}\};/.exec(topics);
  assert.ok(act, 'the shared action helper is gone');
  assert.match(act[1], /refreshLock\(\)/, 'starting or clearing a sweep changes the lock state');
});

test('the banner keeps its button on the row rather than under the sentence', () => {
  assert.match(styles, /\.lock-banner \{[^}]*display: flex;/);
  assert.match(styles, /\.lock-banner \.lock-text \{[^}]*flex: 1;/);
});

test('fmtAge is what words the ages in the banner', () => {
  // The arithmetic itself is proven against the agent's own formatAge()
  // (apps/agent/src/pipeline/scout.ts), which words the 409; this only holds
  // the panel to using one formatter rather than inlining a second wording.
  assert.match(api, /export const fmtAge = \(seconds: number\): string =>/);
  assert.doesNotMatch(
    topics,
    /lock\.(age|heartbeat_age)_seconds\}\s*(seconds|s ago)/,
    'the banner formats ages, it does not print raw seconds',
  );
});
