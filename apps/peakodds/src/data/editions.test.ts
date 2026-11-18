import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EDITIONS, editionHref, getEdition, isEditionId, type EditionId } from './editions.ts';

test('the editions match the agent: Australia in Sydney time, and Global in UTC', () => {
  // The same literals as the editions parity test in
  // apps/agent/src/platform/peakodds/peakodds.test.ts.
  assert.deepEqual(
    EDITIONS.map(({ id, name, timeZone, locale }) => ({ id, name, timeZone, locale })),
    [
      { id: 'au', name: 'Australia', timeZone: 'Australia/Sydney', locale: 'en-AU' },
      { id: 'global', name: 'Global', timeZone: 'UTC', locale: 'en-GB' },
    ],
  );
});

test('only the known edition ids are editions', () => {
  assert.equal(isEditionId('au'), true);
  assert.equal(isEditionId('global'), true);
  assert.equal(isEditionId('uk'), false);
  assert.equal(isEditionId(''), false);
});

test('an unknown edition id is refused rather than defaulted', () => {
  assert.equal(getEdition('global').name, 'Global');
  assert.throws(() => getEdition('uk' as EditionId), /Unknown PeakOdds edition 'uk'/);
});

test('edition links have no trailing slash and keep each segment as given', () => {
  assert.equal(editionHref('au'), '/au');
  assert.equal(editionHref('global', 'liverpool-v-arsenal-preview'), '/global/liverpool-v-arsenal-preview');
  assert.equal(editionHref('au', 'afl', 'round-12'), '/au/afl/round-12');
});
