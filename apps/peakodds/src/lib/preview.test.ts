import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PeakOddsPost } from './posts.ts';
import { articleStructuredData, buildPreview, jsonLdText, peakDrawing } from './preview.ts';

const KICK_OFF = new Date('2026-11-21T08:35:00Z');

function preview(overrides: Partial<PeakOddsPost> = {}): PeakOddsPost {
  return {
    slug: 'harbour-city-v-ridgeway-united',
    title: 'Harbour City v Ridgeway United: a home streak meets a stubborn defence',
    description: 'Unbeaten at home since August.',
    sport: 'Football',
    postType: 'preview',
    editionId: 'au',
    author: 'PeakOdds Editorial Team',
    tags: [],
    pubDate: '2026-11-19',
    updatedDate: null,
    eventStartsAt: KICK_OFF,
    oddsAsAt: new Date('2026-11-18T11:40:00Z'),
    body: [
      '| Market | Selection | Indicative odds (decimal) | As at |',
      '| --- | --- | --- | --- |',
      '| Match result | Harbour City | 2.10 | 2026-11-18 22:40 AEDT |',
    ].join('\n'),
    ...overrides,
  };
}

test('a preview is current until the moment before kick-off', () => {
  assert.equal(buildPreview(preview(), new Date(KICK_OFF.getTime() - 1)).expired, false);
});

test('a preview expires at the instant of kick-off', () => {
  assert.equal(buildPreview(preview(), KICK_OFF).expired, true);
});

test('a preview stays expired after kick-off', () => {
  assert.equal(buildPreview(preview(), new Date(KICK_OFF.getTime() + 1)).expired, true);
});

test('a preview with no event start never expires', () => {
  assert.equal(buildPreview(preview({ eventStartsAt: null }), new Date('2099-01-01T00:00:00Z')).expired, false);
});

test('the page model carries the recognised picks, or none when the table falls back', () => {
  assert.equal(buildPreview(preview(), KICK_OFF).picks.length, 1);
  assert.deepEqual(buildPreview(preview({ oddsAsAt: null }), KICK_OFF).picks, []);
});

test('football codes kick off and every other sport starts', () => {
  for (const sport of ['Football', 'AFL', 'NRL', 'Rugby Union', 'Soccer']) {
    assert.equal(buildPreview(preview({ sport }), KICK_OFF).startLabel, 'Kick-off', sport);
  }
  for (const sport of ['Tennis', 'Cricket', 'Horse Racing', 'Basketball']) {
    assert.equal(buildPreview(preview({ sport }), KICK_OFF).startLabel, 'Start', sport);
  }
});

test('the sport reads in lower case mid-sentence, except an abbreviation', () => {
  assert.equal(buildPreview(preview({ sport: 'Rugby Union' }), KICK_OFF).sportInSentence, 'rugby union');
  assert.equal(buildPreview(preview({ sport: 'AFL' }), KICK_OFF).sportInSentence, 'AFL');
});

test('article structured data comes from the post, with its edition language and PeakOdds as publisher', () => {
  const url = 'https://peakodds.example/au/harbour-city-v-ridgeway-united';
  assert.deepEqual(articleStructuredData(preview({ description: '' }), { locale: 'en-AU' }, url), {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: 'Harbour City v Ridgeway United: a home streak meets a stubborn defence',
    description: 'Harbour City v Ridgeway United: a home streak meets a stubborn defence',
    author: { '@type': 'Organization', name: 'PeakOdds Editorial Team' },
    datePublished: '2026-11-19',
    dateModified: '2026-11-19',
    inLanguage: 'en-AU',
    mainEntityOfPage: url,
    publisher: { '@type': 'Organization', name: 'PeakOdds' },
  });
  assert.equal(
    articleStructuredData(preview({ updatedDate: '2026-11-20' }), { locale: 'en-GB' }, url).dateModified,
    '2026-11-20',
  );
});

test('structured data text cannot close its script element', () => {
  const text = jsonLdText({ headline: 'Swans </script><script>alert(1)</script>' });
  assert.doesNotMatch(text, /</);
  assert.deepEqual(JSON.parse(text), { headline: 'Swans </script><script>alert(1)</script>' });
});

test('a peak stands as high as its chance, with a contour line every 10%', () => {
  const peak = peakDrawing(48);
  assert.deepEqual(peak.summit, { x: 36, y: 27.92 });
  assert.equal(peak.outline, '0,50 13,38.96 20,42.05 36,27.92 49,39.4 55,41.17 64,50');
  assert.equal(peak.contours, 'M5.42 45.4H59.31M10.83 40.8H17.17M21.42 40.8H53.75M26.63 36.2H45.38M31.83 31.6H40.17');
  assert.deepEqual(peakDrawing(100).summit, { x: 36, y: 4 });
  assert.deepEqual(peakDrawing(0), { summit: { x: 36, y: 50 }, outline: '0,50 13,50 20,50 36,50 49,50 55,50 64,50', contours: '' });
});
