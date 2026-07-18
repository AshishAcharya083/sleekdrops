import { test } from 'node:test';
import assert from 'node:assert/strict';
import { operatorBrief } from './context.js';
import type { TopicRow } from '../pipeline/types.js';

const baseTopic: TopicRow = {
  id: '00000000-0000-0000-0000-000000000000',
  title: 'Best budget standing desks',
  category: 'Home',
  post_type: 'guide',
  angle: null,
  keywords: [],
  why_trending: null,
  sources: [],
  status: 'draft',
  source: 'manual',
  instructions: null,
  research_notes: [],
};

test('operatorBrief is empty for scouted topics', () => {
  const topic: TopicRow = { ...baseTopic, source: 'scout', instructions: 'ignored', research_notes: [] };
  assert.equal(operatorBrief(topic), '');
});

test('operatorBrief is empty for a null topic', () => {
  assert.equal(operatorBrief(null), '');
});

test('operatorBrief is empty when a manual topic carries no brief', () => {
  const topic: TopicRow = { ...baseTopic, instructions: '   ', research_notes: [{ name: 'a.md', content: '  ' }] };
  assert.equal(operatorBrief(topic), '');
});

test('operatorBrief includes instructions and non-empty references, numbered', () => {
  const topic: TopicRow = {
    ...baseTopic,
    instructions: 'Focus on sub-$400 AUD options.',
    research_notes: [
      { name: 'my-picks.md', content: 'Omidesk Pro is rock solid.' },
      { name: 'blank.md', content: '   ' },
      { name: 'facts.md', content: 'FlexiSpot E7 has the best warranty.' },
    ],
  };
  const brief = operatorBrief(topic);
  assert.match(brief, /OPERATOR BRIEF/);
  assert.match(brief, /Focus on sub-\$400 AUD options\./);
  assert.match(brief, /reference 1: my-picks\.md/);
  assert.match(brief, /Omidesk Pro is rock solid\./);
  // Blank reference dropped, so facts.md becomes reference 2 (not 3).
  assert.match(brief, /reference 2: facts\.md/);
  assert.ok(!brief.includes('blank.md'));
});
