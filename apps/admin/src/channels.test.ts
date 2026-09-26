/**
 * The Channels screen's rules: which banner a token earns, what each queue row
 * says it is waiting on, and which rows the bulk bar may touch. The agent is
 * the authority on the state itself (tier, hold reason, status); these pin how
 * the panel words it and what it lets an operator do with it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bulkOutcomeMessage,
  channelBadge,
  credentialLine,
  disconnectQueueNote,
  expiryPhrase,
  pruneSelection,
  queueStatusBadge,
  recoveryAction,
  rowReason,
  selectableIds,
  stalenessBanner,
  stalenessBanners,
  summariseSelection,
  tokenLeft,
} from './channels.ts';
import type { Channel, QueueItem } from './api.ts';

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'c1',
    provider: 'facebook',
    externalAccountId: '104857600123',
    displayName: 'SleekDrops',
    tokenRef: 'facebook-page-token',
    status: 'active',
    statusSince: '2026-10-12T03:00:00Z',
    token: { expiresAt: null, expired: false, stale: false, hoursRemaining: null },
    tokenTier: 'ok',
    adapterInstalled: true,
    credential: { stored: true, source: 'panel' },
    placement: { value: 'first_comment', setting: 'facebook_link_placement' },
    linkBudget: { used: 1, cap: 2, exhausted: false },
    counts: { all: 0, pending: 0, held: 0, failed: 0, posted: 0 },
    ...overrides,
  };
}

function expiring(hours: number, tier: Channel['tokenTier']): Channel {
  return channel({
    token: {
      expiresAt: new Date(Date.now() + hours * 3_600_000).toISOString(),
      expired: hours <= 0,
      stale: hours <= 168,
      hoursRemaining: hours,
    },
    tokenTier: tier,
  });
}

function item(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'i1',
    articleId: 'a1',
    title: 'The headphones for a quiet commute',
    slug: 'quiet-commute',
    channelConnectionId: 'c1',
    provider: 'facebook',
    placement: 'first_comment',
    status: 'pending',
    holdReason: null,
    attempts: 0,
    lastError: null,
    remotePostId: null,
    remoteUrl: null,
    scheduledAt: '2026-10-12T03:00:00Z',
    postedAt: null,
    updatedAt: '2026-10-12T03:00:00Z',
    payload: {
      caption: 'x',
      url: 'https://sleekdrops.com/blog/quiet-commute',
      placement: 'first_comment',
      imageUrl: null,
      imageSource: null,
    },
    ...overrides,
  };
}

// ── The staleness ladder ───────────────────────────────────────────────────

test('the three expiry tiers keep their colour grammar', () => {
  assert.equal(stalenessBanner(channel()), null, 'a token with no expiry earns no banner');
  assert.equal(stalenessBanner(expiring(24 * 60, 'ok')), null);

  const notice = stalenessBanner(expiring(24 * 30, 'notice'))!;
  assert.equal(notice.tone, 'info', 'a month out is a calm heads-up, never amber');
  assert.match(notice.headline, /expires in 30 days/);

  const week = stalenessBanner(expiring(24 * 5, 'warning'))!;
  assert.equal(week.tone, 'warn');
  assert.match(week.headline, /expires in 5 days/);

  const day = stalenessBanner(expiring(20, 'critical'))!;
  assert.equal(day.tone, 'error', 'the last day reads like expired');
  assert.match(day.headline, /expires in 20 hours/);

  const gone = stalenessBanner(expiring(-30, 'expired'))!;
  assert.equal(gone.tone, 'error');
  assert.match(gone.headline, /Nothing is posting/);

  for (const banner of [notice, week, day, gone]) {
    assert.ok(banner.glyph && banner.word, 'every tier carries a glyph and a word, not colour alone');
  }
});

test('a rejected token is red and says when, and a disconnected channel earns nothing', () => {
  const rejected = stalenessBanner(
    channel({ status: 'needs_reauth', counts: { all: 7, pending: 0, held: 1, failed: 6, posted: 0 } }),
  )!;
  assert.equal(rejected.tone, 'error');
  assert.match(rejected.headline, /rejected on 12 Oct/);
  assert.match(rejected.sub, /7 items are waiting/);
  assert.equal(stalenessBanner(channel({ status: 'disabled', tokenTier: 'expired' })), null);
});

test('the most urgent banner is listed first', () => {
  const order = stalenessBanners([
    { ...expiring(24 * 30, 'notice'), id: 'calm' },
    { ...expiring(-1, 'expired'), id: 'gone' },
    { ...expiring(24 * 3, 'warning'), id: 'week' },
  ]).map(({ channel: c }) => c.id);
  assert.deepEqual(order, ['gone', 'week', 'calm']);
});

test('expiry is phrased in hours for the last two days and whole days before that', () => {
  assert.equal(expiryPhrase(1), 'in 1 hour');
  assert.equal(expiryPhrase(47), 'in 47 hours');
  assert.equal(expiryPhrase(719), 'in 30 days', 'rounded up, so 29d 23h reads as the 30-day rung');
  assert.equal(tokenLeft(expiring(719, 'notice')), '30d left');
  assert.equal(tokenLeft(expiring(20, 'critical')), '20h left');
  assert.equal(tokenLeft(channel()), 'never expires');
  assert.equal(tokenLeft(expiring(-5, 'expired')), 'expired');
});

// ── Badges and the credential line ─────────────────────────────────────────

test('a healthy connection is the same green badge on every expiry tier', () => {
  for (const tier of ['ok', 'notice', 'warning', 'critical'] as const) {
    assert.deepEqual(channelBadge(expiring(100, tier)), { tone: 'green', glyph: '●', label: 'Connected' });
  }
  assert.equal(channelBadge(channel({ status: 'needs_reauth' })).tone, 'red');
  assert.equal(channelBadge(channel({ status: 'disabled' })).label, 'Disconnected');
  assert.equal(channelBadge(channel({ adapterInstalled: false })).label, 'No adapter');
});

test('a stored but rejected token loses the success tick', () => {
  assert.equal(credentialLine(channel()).state, 'set');
  const rejected = credentialLine(channel({ status: 'needs_reauth' }));
  assert.equal(rejected.state, 'stale');
  assert.equal(rejected.label, 'token stored');
  assert.equal(rejected.alert, 'rejected by Facebook since 12 Oct');
  assert.equal(credentialLine(expiring(-2, 'expired')).state, 'stale');
  const missing = credentialLine(channel({ credential: { stored: false, source: null } }));
  assert.equal(missing.state, 'missing');
  assert.equal(
    credentialLine(channel({ credential: { stored: true, source: 'environment' } })).when,
    "from the deployment's secret store",
  );
});

// ── Queue rows ─────────────────────────────────────────────────────────────

test('every hold reason leads with plain language', () => {
  assert.equal(rowReason(item({ status: 'held', holdReason: 'no_safe_image' })).heading, 'No safe image');
  assert.equal(
    rowReason(item({ status: 'held', holdReason: 'link_budget_exhausted' })).heading,
    'Body-link budget exhausted',
  );
  assert.equal(
    rowReason(item({ status: 'pending', holdReason: 'site_not_ready', lastError: 'waiting for the site: HTTP 404' }))
      .heading,
    'Site not yet serving the article',
  );
  assert.equal(
    rowReason(item({ status: 'held', lastError: 'the Page has spent its body links' })).heading,
    'Held for an operator',
    'a hold recorded before reasons existed still says it is waiting on a person',
  );
  const failed = rowReason(item({ status: 'failed', lastError: 'Facebook refused 123/photos: (#200)' }));
  assert.equal(failed.kind, 'error');
  assert.match(failed.detail!, /#200/);
  assert.equal(rowReason(item({ status: 'posted', lastError: 'comment failed; URL appended' })).kind, 'degraded');
  assert.equal(rowReason(item()).kind, 'none');
});

test('status badges pair every tint with a glyph and a word', () => {
  assert.deepEqual(queueStatusBadge(item({ status: 'held' })), { tone: 'amber', glyph: '⏸', label: 'Held' });
  assert.equal(queueStatusBadge(item({ status: 'pending', holdReason: 'site_not_ready' })).label, 'Waiting');
  assert.equal(queueStatusBadge(item({ status: 'posted', lastError: 'degraded' })).label, 'Posted, degraded');
  assert.equal(queueStatusBadge(item({ status: 'failed' })).tone, 'red');
});

// ── Selection and the bulk bar ─────────────────────────────────────────────

const rows = [
  item({ id: 'held-1', status: 'held', holdReason: 'no_safe_image' }),
  item({ id: 'held-2', status: 'held', holdReason: 'link_budget_exhausted' }),
  item({ id: 'gate', status: 'pending', holdReason: 'site_not_ready' }),
  item({ id: 'failed-1', status: 'failed' }),
  item({ id: 'queued', status: 'pending' }),
  item({ id: 'posted', status: 'posted' }),
];

test('select-all ticks the held and failed rows, never the one retrying by itself', () => {
  assert.deepEqual(selectableIds(rows), ['held-1', 'held-2', 'failed-1']);
  assert.equal(recoveryAction(rows[2]), null, 'the readiness gate needs nobody');
  assert.equal(recoveryAction(rows[0]), 'release');
  assert.equal(recoveryAction(rows[3]), 'retry');
});

test('the bulk bar counts what is actually ticked', () => {
  const summary = summariseSelection(rows, new Set(['held-1', 'failed-1', 'queued']));
  assert.equal(summary.total, 2, 'a tick on an ineligible row is not counted');
  assert.deepEqual(summary.failed, ['failed-1']);
  assert.deepEqual(summary.held, ['held-1']);
  assert.equal(summariseSelection(rows, new Set()).total, 0, 'nothing is selected at rest');
});

test('a tick on a row that stopped being eligible is dropped', () => {
  const next = [...rows.slice(0, 3), item({ id: 'failed-1', status: 'pending' })];
  assert.deepEqual([...pruneSelection(next, new Set(['held-1', 'failed-1']))], ['held-1']);
});

test('the outcome toast says how many moved and why any did not', () => {
  assert.deepEqual(bulkOutcomeMessage('retry', { updated: ['a', 'b', 'c'], skipped: [] }), {
    tone: 'ok',
    glyph: '✓',
    text: '3 items retried - back in the queue now.',
  });
  const partial = bulkOutcomeMessage('release', { updated: ['a'], skipped: ['b'] });
  assert.equal(partial.tone, 'partial');
  assert.match(partial.text, /1 item released.*1 item skipped \(no longer held/);
  assert.match(bulkOutcomeMessage('retry', { updated: [], skipped: ['a'] }).text, /^Nothing moved\./);
});

test('the disconnect note does not promise that a held item posts on reconnect', () => {
  assert.equal(
    disconnectQueueNote({ pending: 1, held: 0 }),
    '1 queued item stays in the queue and posts if you reconnect.',
  );
  const both = disconnectQueueNote({ pending: 3, held: 2 });
  assert.match(both, /^3 queued items stay in the queue and post if you reconnect\. /);
  assert.match(both, /2 held items stay in the queue, but reconnecting releases nothing/);
  assert.doesNotMatch(disconnectQueueNote({ pending: 0, held: 1 }), /post/);
  assert.equal(disconnectQueueNote({ pending: 0, held: 0 }), '');
});
