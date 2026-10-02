import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PEAKODDS_PLATFORM_ID, peakoddsSeed } from './index.js';
import { PEAKODDS_POST_TYPES, PEAKODDS_SHAPES, PICKS_TABLE_COLUMNS } from './formats.js';
import {
  AU_FOOTER,
  BETSTOP,
  GAMBLER_800,
  GAMBLING_HELP_ONLINE,
  GAMCARE,
  GLOBAL_FOOTER,
  NCPG_HELPLINE,
  NZ_GAMBLING_HELPLINE,
} from './footers.js';
import { shapeById } from '../../content/shapes.js';
import type { AgentId } from '../types.js';

const { platform, editions } = peakoddsSeed;
const RACING = /\b(?:horse|greyhound|harness|thoroughbred|trots?|pacing|race ?meeting|racing|melbourne cup|caulfield|cox plate)\b/i;

test('PeakOdds is a no-monetisation platform that blocks racing', () => {
  assert.equal(platform.id, PEAKODDS_PLATFORM_ID);
  assert.equal(platform.monetisation, 'none');
  assert.deepEqual(platform.blockedTopics, ['racing']);
  assert.deepEqual(platform.postTypes, ['article', 'guide', 'preview']);
  assert.ok(platform.categories.length >= 5);
  assert.ok(!platform.categories.some((c) => RACING.test(c)), 'a racing category');
});

test('two editions: Australia in Sydney time, and a neutral Global one with no currency', () => {
  assert.deepEqual(
    editions.map(({ id, timeZone, currency, locale }) => ({ id, timeZone, currency, locale })),
    [
      { id: 'au', timeZone: 'Australia/Sydney', currency: 'AUD', locale: 'en-AU' },
      { id: 'global', timeZone: 'UTC', currency: null, locale: 'en-GB' },
    ],
  );
  assert.equal(editions[0].complianceFooter, AU_FOOTER);
  assert.equal(editions[1].complianceFooter, GLOBAL_FOOTER);
  for (const edition of editions) {
    assert.ok(edition.scoutQueries.length > 0, `${edition.id} has no scout queries`);
    assert.doesNotThrow(() => new Intl.DateTimeFormat(edition.locale, { timeZone: edition.timeZone }));
  }
});

test('no scout query, platform or edition, goes looking for racing', () => {
  for (const query of [...platform.scoutQueries, ...editions.flatMap((e) => e.scoutQueries)]) {
    assert.ok(!RACING.test(query), `racing scout query: ${query}`);
  }
});

test('the excluded formats are nowhere in the scout queries', () => {
  const EXCLUDED = /\b(?:bookmaker reviews?|best betting sites?|promo codes?|calculators?|futures|market movers?|same game multi|sgm)\b/i;
  for (const query of [...platform.scoutQueries, ...editions.flatMap((e) => e.scoutQueries)]) {
    assert.ok(!EXCLUDED.test(query), `excluded format in scout query: ${query}`);
  }
});

test('blocked link domains are bare hostnames covering the major bookmakers', () => {
  for (const domain of platform.blockedLinkDomains) {
    assert.match(domain, /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/, `${domain} is not a bare hostname`);
    assert.ok(!domain.startsWith('www.'), `${domain} carries www.`);
  }
  assert.equal(new Set(platform.blockedLinkDomains).size, platform.blockedLinkDomains.length, 'duplicate domain');
  for (const bookmaker of ['sportsbet.com.au', 'tab.com.au', 'ladbrokes.com.au', 'bet365.com', 'draftkings.com', 'stake.com']) {
    assert.ok(platform.blockedLinkDomains.includes(bookmaker), `${bookmaker} is not blocked`);
  }
});

test('the editorial rules cover every rule on the card', () => {
  const rules = platform.editorialRules;
  for (const [rule, pattern] of [
    ['18+', /18\+/],
    ['no bookmaker recommended', /No bookmaker is ever recommended/],
    ['no inducements', /No inducements/],
    ['no offshore or unlicensed operators', /offshore or unlicensed/],
    ['never framed as income', /never framed as income/],
    ['no certainty language', /No certainty language/],
    ['nothing aimed at minors', /under 18/],
    ['decimal odds with a timestamp', /decimal odds .* with the time they were seen/s],
    ['explicit time zone', /explicit time\s+zone/],
    ['subject to change', /subject to change/],
    ['prices only from odds-comparison or news sources', /odds-comparison or news sources/],
    ['bookmaker-only prices omitted', /only a bookmaker's page shows is left out/],
  ] as const) {
    assert.match(rules, pattern, rule);
  }
});

test('every agent goal is keyed by a real agent id', () => {
  const AGENTS: AgentId[] = ['scout', 'research', 'keyword', 'angle', 'outline', 'write', 'seo_review', 'edit', 'assemble', 'image'];
  for (const [id, goal] of Object.entries(platform.agentGoals)) {
    assert.ok(AGENTS.includes(id as AgentId), `unknown agent id ${id}`);
    assert.ok(goal && goal.trim().length > 20, `${id} goal is empty`);
  }
  assert.deepEqual(Object.keys(platform.agentGoals).sort(), [...AGENTS].sort());
});

test('the publish target names environment variables, never values', () => {
  assert.deepEqual(platform.publishTarget, {
    d1DatabaseIdEnv: 'PEAKODDS_D1_DATABASE_ID',
    githubRepoEnv: 'PEAKODDS_GITHUB_REPO',
    siteUrlEnv: 'PEAKODDS_SITE_URL',
    rebuildHookEnv: 'PEAKODDS_REBUILD_HOOK_URL',
  });
});

// ------------------------------------------------------------------ formats

test('preview is the post type PeakOdds adds', () => {
  assert.deepEqual(
    PEAKODDS_POST_TYPES.map((t) => t.id),
    ['preview'],
  );
  assert.match(PEAKODDS_POST_TYPES[0].description, /^preview: /);
});

test('every selected shape exists, new or reused', () => {
  const own = new Set(PEAKODDS_SHAPES.map((s) => s.id));
  for (const id of platform.articleShapes) {
    assert.ok(own.has(id) || shapeById(id), `${id} is in no catalogue`);
  }
  assert.deepEqual([...own], ['match-preview', 'round-roundup', 'player-markets']);
  assert.ok(!own.has('question-led'), 'a reused shape redefined');
  assert.ok(shapeById('question-led'), 'explainers reuse the question-led shape');
});

test('every preview layout carries summary bullets, the picks table, reasoning and a verdict - and no footer', () => {
  for (const shape of PEAKODDS_SHAPES) {
    assert.deepEqual(shape.postTypes, ['preview'], shape.id);
    assert.match(shape.id, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(shape.description.trim().length > 20, `${shape.id} has no description`);
    const kinds = shape.sections.map((s) => s.kind);
    for (const kind of ['summary', 'picks-table', 'verdict']) assert.ok(kinds.includes(kind), `${shape.id} lacks ${kind}`);
    assert.ok(
      shape.sections.some((s) => s.repeats && s.required),
      `${shape.id} has no per-pick reasoning section`,
    );
    const table = shape.sections.find((s) => s.kind === 'picks-table')!;
    assert.ok(table.purpose.includes(PICKS_TABLE_COLUMNS.join(' | ')), `${shape.id} picks table columns`);
    assert.match(table.purpose, /No bookmaker column, no stake or unit column/);
    assert.equal(shape.sections.at(-1)?.kind, 'verdict', `${shape.id} does not close on the verdict`);
    assert.ok(!kinds.some((k) => /responsible|footer|helpline/.test(k)), `${shape.id} asks the model for the footer`);
    assert.match(shape.openingStyle, /site appends/);
  }
});

// ------------------------------------------------------------------ footers

test('the AU footer carries the national message, Gambling Help Online and BetStop', () => {
  assert.match(AU_FOOTER, /18\+/);
  assert.match(AU_FOOTER, /Chances are you're about to lose\./);
  assert.match(
    AU_FOOTER,
    /For free and confidential support call 1800 858 858 or visit gamblinghelponline\.org\.au\./,
  );
  assert.ok(AU_FOOTER.includes(BETSTOP.url));
  assert.match(AU_FOOTER, /subject to change/);
});

test('the Global footer never assumes betting is legal where the reader is', () => {
  assert.match(GLOBAL_FOOTER, /18\+ \(21\+ where local law requires\)/);
  assert.match(GLOBAL_FOOTER, /Betting is illegal or restricted in some places, check your local law/);
  assert.ok(GLOBAL_FOOTER.includes(GAMCARE.phone));
  assert.ok(GLOBAL_FOOTER.includes(NCPG_HELPLINE.phone));
  assert.ok(GLOBAL_FOOTER.includes('1-800-GAMBLER'));
  assert.ok(GLOBAL_FOOTER.includes(NZ_GAMBLING_HELPLINE.phone));
  assert.match(GLOBAL_FOOTER, /local gambling support service/);
  assert.match(GLOBAL_FOOTER, /subject to change/);
  assert.doesNotMatch(GLOBAL_FOOTER, /[$£€]\s?\d/, 'a currency amount in the Global footer');
});

test('every helpline records the official page it was verified against', () => {
  for (const helpline of [GAMBLING_HELP_ONLINE, BETSTOP, GAMCARE, NCPG_HELPLINE, GAMBLER_800, NZ_GAMBLING_HELPLINE]) {
    assert.match(helpline.source, /^https:\/\//, `${helpline.name} has no source`);
    assert.match(helpline.verified, /^\d{4}-\d{2}-\d{2}$/, `${helpline.name} has no verified date`);
    assert.equal(new URL(helpline.source).hostname, new URL(helpline.url).hostname, `${helpline.name} source is off-site`);
  }
});
