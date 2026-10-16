/**
 * The platform profile editor: what it sends, when it counts as changed, who
 * signs a version, what a refused (409) save tells the operator, and how the
 * history names what each version changed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_GOALS,
  authorProblem,
  conflictMessage,
  formToProfile,
  isProfileDirty,
  profileChanges,
  profileSaveBody,
  profileToForm,
  type EditableProfile,
} from './profile.ts';

function profile(overrides: Partial<EditableProfile> = {}): EditableProfile {
  return {
    brand_text: 'PeakOdds is an independent sports tips site.\n',
    audience: 'Punters who want reasoning, not hype.',
    editorial_rules: '- No bookmaker referrals.',
    agent_goals: { write: 'Lead with the verdict.' },
    scout_queries: ['AFL round preview', 'NRL tips'],
    editions: [
      { id: 'au', scout_queries: ['A-League preview'], compliance_footer: 'Gamble responsibly. 18+.' },
      { id: 'global', scout_queries: [], compliance_footer: '18+ (21+ where local law requires).' },
    ],
    ...overrides,
  };
}

test('the goals offered are exactly the agents the API accepts', () => {
  assert.deepEqual(
    AGENT_GOALS.map((g) => g.id),
    ['scout', 'research', 'keyword', 'angle', 'outline', 'write', 'seo_review', 'edit', 'assemble', 'image'],
  );
});

test('an untouched form sends back exactly the profile it loaded', () => {
  const loaded = profile();
  assert.deepEqual(formToProfile(profileToForm(loaded)), loaded);
  assert.equal(isProfileDirty(profileToForm(loaded), loaded), false);
});

test('prose is sent as typed, so a field nobody touched cannot change a prompt', () => {
  const form = profileToForm(profile());
  form.agent_goals.research = 'Cite the kick-off source.';
  const sent = formToProfile(form);
  assert.equal(sent.brand_text, 'PeakOdds is an independent sports tips site.\n', 'the trailing newline survives');
  assert.equal(sent.agent_goals.research, 'Cite the kick-off source.');
});

test('query lists are one per line, trimmed, blank lines dropped', () => {
  const form = profileToForm(profile());
  form.scout_queries = '  AFL round preview \n\nNRL tips\n  \nBBL fixtures';
  form.editions[1].scout_queries = 'Premier League preview\n';
  const sent = formToProfile(form);
  assert.deepEqual(sent.scout_queries, ['AFL round preview', 'NRL tips', 'BBL fixtures']);
  assert.deepEqual(sent.editions[1].scout_queries, ['Premier League preview']);
});

test('a blank goal is no goal, rather than an empty instruction', () => {
  const form = profileToForm(profile());
  form.agent_goals.write = '   ';
  assert.deepEqual(formToProfile(form).agent_goals, {});
  assert.equal(isProfileDirty(form, profile()), true, 'removing a goal is a change');
});

test('editing any field marks the form dirty, reverting it clears that', () => {
  const loaded = profile();
  const form = profileToForm(loaded);
  form.editions[0].compliance_footer = 'Gamble responsibly. 18+. Call 1800 858 858.';
  assert.equal(isProfileDirty(form, loaded), true);
  form.editions[0].compliance_footer = loaded.editions[0].compliance_footer;
  assert.equal(isProfileDirty(form, loaded), false);
});

test('every version is signed by a named author of at most 100 characters', () => {
  assert.match(authorProblem('') ?? '', /name/);
  assert.match(authorProblem('   ') ?? '', /name/);
  assert.match(authorProblem('x'.repeat(101)) ?? '', /100/);
  assert.equal(authorProblem('x'.repeat(100)), null);
  assert.equal(authorProblem('Sam'), null);
});

test('a save names the version it was edited from, and the trimmed author', () => {
  const form = profileToForm(profile());
  form.audience = 'Australian punters.';
  const body = profileSaveBody(4, '  Sam Lee  ', form);
  assert.equal(body.base_version, 4);
  assert.equal(body.author, 'Sam Lee');
  assert.equal(body.profile.audience, 'Australian punters.');
  assert.deepEqual(Object.keys(body).sort(), ['author', 'base_version', 'profile']);
  assert.deepEqual(Object.keys(body.profile).sort(), [
    'agent_goals',
    'audience',
    'brand_text',
    'editions',
    'editorial_rules',
    'scout_queries',
  ]);
});

test('a refused save says nothing was saved and which version is current', () => {
  assert.match(conflictMessage(7), /version 7 is now current/);
  assert.match(conflictMessage(7), /Nothing was saved/);
  assert.match(conflictMessage(null), /a newer version/);
});

test('the history names what each version changed', () => {
  const v1 = profile();
  const v2 = profile({
    agent_goals: { write: 'Lead with the verdict.', scout: 'Skip futures markets.' },
    editions: [v1.editions[0], { ...v1.editions[1], compliance_footer: '18+. Check your local law.' }],
  });
  const names = (id: string) => ({ au: 'Australia', global: 'Global' })[id] ?? id;
  assert.deepEqual(profileChanges(null, v1), ['Initial version']);
  assert.deepEqual(profileChanges(v1, v2, names), ['Topic scout goal', 'Global compliance footer']);
  assert.deepEqual(profileChanges(v2, v2, names), []);
  assert.deepEqual(profileChanges(v1, profile({ brand_text: 'New', scout_queries: [] })), [
    'Brand text',
    'Scout queries',
  ]);
});
