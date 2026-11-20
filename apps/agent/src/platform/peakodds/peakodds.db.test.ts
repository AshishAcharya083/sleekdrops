// PeakOdds as the boot step seeds it: migrate, then seedPlatforms(), against a
// database of this file's own.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { reachable, scratchDatabase, skip } from '../../db/scratchDatabase.js';

const scratch = scratchDatabase('agent_peakodds');
if (reachable) {
  await scratch.create();
  // Everything imported below connects through this.
  process.env.DATABASE_URL = scratch.url;
}

const { getSetting, pool, setSetting } = await import('../../db/pool.js');
const { migrate } = await import('../../db/migrate.js');
const { getEdition, loadPlatform } = await import('../registry.js');
const { seedPlatforms } = await import('../profiles.js');
const { PEAKODDS_PLATFORM_ID, peakoddsSeed } = await import('./index.js');
const { AU_FOOTER, GLOBAL_FOOTER } = await import('./footers.js');

before(async () => {
  if (!reachable) return;
  await migrate();
  await seedPlatforms();
});

after(async () => {
  await pool.end();
  if (reachable) await scratch.drop();
});

test('the boot seed makes PeakOdds a platform the registry loads', { skip }, async () => {
  const platform = await loadPlatform(PEAKODDS_PLATFORM_ID);
  assert.equal(platform.name, 'PeakOdds');
  assert.equal(platform.monetisation, 'none');
  assert.deepEqual(platform.blockedTopics, ['racing']);
  assert.deepEqual(platform.blockedLinkDomains, peakoddsSeed.platform.blockedLinkDomains);
  assert.deepEqual(platform.postTypes, ['article', 'guide', 'preview']);
  assert.deepEqual(platform.publishTarget, peakoddsSeed.platform.publishTarget);
  assert.deepEqual(
    platform.editions.map(({ id, timeZone, currency, locale }) => ({ id, timeZone, currency, locale })),
    [
      { id: 'au', timeZone: 'Australia/Sydney', currency: 'AUD', locale: 'en-AU' },
      { id: 'global', timeZone: 'UTC', currency: null, locale: 'en-GB' },
    ],
  );
  assert.equal((await getEdition(PEAKODDS_PLATFORM_ID, 'au')).complianceFooter, AU_FOOTER);
  assert.equal((await getEdition(PEAKODDS_PLATFORM_ID, 'global')).complianceFooter, GLOBAL_FOOTER);
});

test('PeakOdds starts with distribution off; SleekDrops keeps its own setting', { skip }, async () => {
  assert.equal(await getSetting(PEAKODDS_PLATFORM_ID, 'distribution_enabled', 'missing'), false);
  assert.equal(await getSetting('sleekdrops', 'distribution_enabled', 'missing'), true);
});

test('a re-seed leaves an operator who turned PeakOdds distribution on alone', { skip }, async () => {
  await setSetting(PEAKODDS_PLATFORM_ID, 'distribution_enabled', true);
  try {
    await seedPlatforms();
    assert.equal(await getSetting(PEAKODDS_PLATFORM_ID, 'distribution_enabled', 'missing'), true);
  } finally {
    await setSetting(PEAKODDS_PLATFORM_ID, 'distribution_enabled', false);
  }
});
