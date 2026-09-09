import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  KEY_FILE,
  buildSubmission,
  isValidKey,
  parseSitemapIndex,
  parseSitemapUrls,
  selectChangedUrls,
} from './indexnow.mjs';

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://sleekdrops.com</loc><lastmod>2026-09-06</lastmod></url><url><loc>https://sleekdrops.com/about</loc></url><url><loc>https://sleekdrops.com/blog/luna-2</loc><lastmod>2026-05-30</lastmod></url><url><loc>https://sleekdrops.com/blog/mics</loc><lastmod>2026-09-06</lastmod></url><url><loc>https://sleekdrops.com/blog/mattress</loc><lastmod>2026-09-05T03:00:00.000Z</lastmod></url></urlset>`;

const INDEX = `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://sleekdrops.com/sitemap-0.xml</loc></sitemap><sitemap><loc>https://sleekdrops.com/sitemap-1.xml</loc></sitemap></sitemapindex>`;

const NOW = new Date('2026-09-06T09:00:00Z');

test('parseSitemapUrls keeps every loc and the lastmod where there is one', () => {
  assert.deepEqual(parseSitemapUrls(SITEMAP), [
    { loc: 'https://sleekdrops.com', lastmod: '2026-09-06' },
    { loc: 'https://sleekdrops.com/about', lastmod: null },
    { loc: 'https://sleekdrops.com/blog/luna-2', lastmod: '2026-05-30' },
    { loc: 'https://sleekdrops.com/blog/mics', lastmod: '2026-09-06' },
    { loc: 'https://sleekdrops.com/blog/mattress', lastmod: '2026-09-05T03:00:00.000Z' },
  ]);
  assert.deepEqual(parseSitemapIndex(INDEX), [
    'https://sleekdrops.com/sitemap-0.xml',
    'https://sleekdrops.com/sitemap-1.xml',
  ]);
});

test('only URLs that changed inside the window are submitted', () => {
  const entries = parseSitemapUrls(SITEMAP);
  assert.deepEqual(selectChangedUrls(entries, { now: NOW, sinceHours: 36 }), [
    'https://sleekdrops.com',
    'https://sleekdrops.com/blog/mics',
    'https://sleekdrops.com/blog/mattress',
  ]);
  // An entry with no lastmod is never claimed as changed, however wide the window.
  assert.equal(selectChangedUrls(entries, { now: NOW, sinceHours: 24 * 365 }).includes('https://sleekdrops.com/about'), false);
  // A date published "today" is inside even a short window this evening.
  assert.deepEqual(
    selectChangedUrls([{ loc: 'https://sleekdrops.com/blog/today', lastmod: '2026-09-06' }], {
      now: new Date('2026-09-06T23:30:00Z'),
      sinceHours: 2,
    }),
    ['https://sleekdrops.com/blog/today'],
  );
  // Yesterday's date, at 08:00 the next morning with a 1-hour window: out.
  assert.deepEqual(selectChangedUrls(entries, { now: NOW, sinceHours: 1 }).includes('https://sleekdrops.com/blog/mattress'), false);
});

test('a lastmod the sitemap wrote as midnight UTC still counts for the whole of that day', () => {
  // What @astrojs/sitemap does to a day-only date. Read as an instant, the 5th
  // at 00:00Z is 38 hours before 14:00Z on the 6th and a 36-hour window would
  // miss yesterday's post; read as a day, it is inside.
  const entries = [{ loc: 'https://sleekdrops.com/blog/yesterday', lastmod: '2026-09-05T00:00:00.000Z' }];
  assert.deepEqual(selectChangedUrls(entries, { now: new Date('2026-09-06T14:00:00Z'), sinceHours: 36 }), [
    'https://sleekdrops.com/blog/yesterday',
  ]);
  // Two days on, it is not.
  assert.deepEqual(selectChangedUrls(entries, { now: new Date('2026-09-08T14:00:00Z'), sinceHours: 36 }), []);
  // A date in the future is a mistake, not a change.
  assert.deepEqual(
    selectChangedUrls([{ loc: 'https://sleekdrops.com/blog/future', lastmod: '2026-12-01' }], {
      now: new Date('2026-09-06T14:00:00Z'),
      sinceHours: 36,
    }),
    [],
  );
});

test('the submission names the host, the key and where the key file is served', () => {
  assert.deepEqual(
    buildSubmission({
      siteUrl: 'https://sleekdrops.com/',
      key: '456d5ffc02ee77b64061d062e8f5f8cf',
      urls: ['https://sleekdrops.com/blog/mics', 'https://sleekdrops.com/blog/mics'],
    }),
    {
      host: 'sleekdrops.com',
      key: '456d5ffc02ee77b64061d062e8f5f8cf',
      keyLocation: `https://sleekdrops.com/${KEY_FILE}`,
      urlList: ['https://sleekdrops.com/blog/mics'],
    },
  );
});

test('a key is 8-128 characters of letters, digits and hyphens', () => {
  assert.equal(isValidKey('456d5ffc02ee77b64061d062e8f5f8cf'), true);
  assert.equal(isValidKey('short'), false);
  assert.equal(isValidKey('has spaces in it'), false);
  assert.equal(isValidKey(''), false);
  assert.equal(isValidKey(undefined), false);
});
