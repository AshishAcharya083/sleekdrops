import { test } from 'node:test';
import assert from 'node:assert/strict';

import { blockedTopicReason } from './topicRules.js';

const blocksRacing = { name: 'PeakOdds', blockedTopics: ['racing'] as const };
const blocksNothing = { name: 'SleekDrops', blockedTopics: [] };

test('horse, greyhound and harness racing are blocked, whole-word and case-insensitive', () => {
  for (const text of [
    'Horse racing tips for Saturday at Randwick',
    'Melbourne Cup 2026 field and tips',
    'Thoroughbred form guide: Rosehill',
    'Caulfield Cup quaddie',
    'Greyhound tips from The Meadows',
    'GREYHOUNDS: best bets tonight',
    'Harness racing preview: Menangle Saturday night',
    'Trots tips for Gloucester Park',
    'Pacing Cup preview',
    'Race meeting preview: Flemington',
    'Spring racing carnival best bets',
    'Kentucky Derby contenders',
  ]) {
    assert.equal(
      blockedTopicReason(blocksRacing, text),
      'racing topics are not covered on PeakOdds',
      text,
    );
  }
});

test('plain "race" and other sport are let through', () => {
  for (const text of [
    'Premier League title race: who has the run-in?',
    'The race to the playoffs: NBA Western Conference',
    'Bulldogs v Roosters tips: can the Dogs bounce back?',
    'Arsenal have won five on the trot - can they make it six?',
    'How Melbourne harness their pace on the counter',
    'Formula 1 Singapore Grand Prix preview',
    'Horsens v Brondby preview',
    'Embracing the underdog: State of Origin game 2',
  ]) {
    assert.equal(blockedTopicReason(blocksRacing, text), null, text);
  }
});

test('a platform that blocks nothing lets racing through', () => {
  assert.equal(blockedTopicReason(blocksNothing, 'Melbourne Cup sweepstakes kit'), null);
});
