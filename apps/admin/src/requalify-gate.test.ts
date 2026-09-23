/**
 * The Requalify button on the Published tab, and the one row it must not offer
 * itself on.
 *
 * Requalifying rebuilds a page that is already on the site and republishes it
 * at the same address. D1 also holds rows that are not on the site - anything
 * parked as a draft - and the publisher marks what it finishes as published,
 * so running the job on one of those would put a withheld page up rather than
 * rebuild a live one. The agent refuses it with a 409 and stays the authority;
 * the panel's job is to not spend the operator's click finding that out.
 *
 * The panel has no component test harness (a .tsx cannot be imported by node's
 * type stripping), so this guards the source the way the layout and lock
 * suites already do.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const published = readFileSync(
  fileURLToPath(new URL('./pages/Published.tsx', import.meta.url)),
  'utf8',
);

/** The one Requalify button in the published-posts table, with its props. */
const listButton = /onClick=\{\(\) => void requalify\(p\.slug, p\.title\)\}/.exec(published);
const listButtonProps = (): string => {
  assert.ok(listButton, 'the published list no longer has a per-row Requalify button');
  const start = published.lastIndexOf('<button', listButton.index);
  return published.slice(start, listButton.index);
};

test('the published list only offers Requalify on a page that is live', () => {
  assert.match(
    listButtonProps(),
    /disabled=\{busy === p\.slug \|\| p\.status !== LIVE_STATUS\}/,
    'a draft row would be published by the rebuild, not requalified by it',
  );
  assert.match(published, /const LIVE_STATUS = 'published';/);
});

test('and says why when it is disabled', () => {
  const props = listButtonProps();
  assert.match(props, /title=\{/, 'a disabled button with no explanation is a dead end');
  assert.match(props, /not live/, 'the title names the reason the row cannot be requalified');
  assert.match(props, /\$\{p\.status\}/, 'and what the row actually is');
});
