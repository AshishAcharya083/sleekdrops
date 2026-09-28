/**
 * The Channels screen's rules and wording: which banner a token earns, what a
 * queue row is waiting on, and which rows a bulk action may touch.
 *
 * Pure and dependency-free, the same way stages.ts and offers.ts are, so every
 * sentence an operator reads here is pinned by channels.test.ts rather than by
 * a screenshot. Nothing in this file names a network: a second provider gets
 * the same banners, badges and hold reasons by existing.
 */
import type {
  Channel,
  DistributionStatus,
  HoldReason,
  LinkPlacement,
  QueueFilter,
  QueueItem,
  RecoveryOutcome,
} from './api';

/** 'facebook' → 'Facebook'. The provider string is the only name the agent sends. */
export function providerLabel(provider: string): string {
  return provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : provider;
}

export function channelName(channel: Pick<Channel, 'displayName' | 'externalAccountId'>): string {
  return channel.displayName?.trim() || channel.externalAccountId;
}

export const PLACEMENT_LABEL: Record<LinkPlacement, string> = {
  first_comment: 'First comment',
  in_body: 'In body',
};

export const PLACEMENT_HINT: Record<LinkPlacement, string> = {
  first_comment:
    'The caption carries no link and says it is in the first comment. Needs an image we may upload; costs no body-link budget.',
  in_body:
    'The link goes in the caption and earns the link preview card. Spends one unit of the monthly body-link budget where the network rations it.',
};

/** "in 30 days", "in 20 hours" - whole days once there are two or more of them. */
export function expiryPhrase(hoursRemaining: number): string {
  if (hoursRemaining < 48) {
    const hours = Math.max(1, hoursRemaining);
    return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `in ${Math.ceil(hoursRemaining / 24)} days`;
}

/** The short chip beside a channel: "30d left", "20h left", "expired", "never expires". */
export function tokenLeft(channel: Pick<Channel, 'token' | 'tokenTier'>): string {
  const hours = channel.token.hoursRemaining;
  if (channel.tokenTier === 'expired') return 'expired';
  if (!channel.token.expiresAt || hours === null) return 'never expires';
  return hours < 48 ? `${Math.max(1, hours)}h left` : `${Math.ceil(hours / 24)}d left`;
}

/** "12 Oct" - the day a state began, for "rejected since" and "expired" lines. */
export function shortDate(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

export type Tone = 'info' | 'warn' | 'error';

export interface StalenessBanner {
  tone: Tone;
  /** Text-default glyph, so the tier never rests on its colour. */
  glyph: string;
  /** The tier's word, read before the sentence. */
  word: string;
  headline: string;
  sub: string;
}

/**
 * The banner a channel's token earns, or null for none.
 *
 * Three tiers, and the colour grammar is fixed: the 30-day heads-up is info
 * blue so it never reads as urgent, the seven-day warning is amber, and the
 * last day reads red like an expired or rejected token, because one missed
 * working day turns it into one. A disconnected channel earns nothing - it is
 * off because someone chose that.
 */
export function stalenessBanner(channel: Channel): StalenessBanner | null {
  if (channel.status === 'disabled') return null;
  const who = `${providerLabel(channel.provider)} · ${channelName(channel)}`;
  const waiting = channel.counts.pending + channel.counts.held + channel.counts.failed;
  const stuck =
    waiting > 0
      ? ` ${waiting} item${waiting === 1 ? ' is' : 's are'} waiting in its queue.`
      : '';

  if (channel.status === 'needs_reauth') {
    return {
      tone: 'error',
      glyph: '✕',
      word: 'Rejected',
      headline: `${who}: the token was rejected on ${shortDate(channel.statusSince)}. Nothing is posting to this channel.`,
      sub: `Replace the token below, then retry the failed items from the queue.${stuck}`,
    };
  }
  const hours = channel.token.hoursRemaining;
  switch (channel.tokenTier) {
    case 'expired':
      return {
        tone: 'error',
        glyph: '✕',
        word: 'Expired',
        headline: `${who}: the token expired on ${shortDate(channel.token.expiresAt)}. Nothing is posting to this channel.`,
        sub: `Replace the token below; queued items post again once it is accepted.${stuck}`,
      };
    case 'critical':
      return {
        tone: 'error',
        glyph: '⏱',
        word: 'Expires today',
        headline: `${who}: the token expires ${expiryPhrase(hours ?? 0)}.`,
        sub: 'After that nothing posts to this channel until the token is replaced.',
      };
    case 'warning':
      return {
        tone: 'warn',
        glyph: '▲',
        word: 'Expires this week',
        headline: `${who}: the token expires ${expiryPhrase(hours ?? 0)}.`,
        sub: 'After that nothing posts to this channel until the token is replaced.',
      };
    case 'notice':
      return {
        tone: 'info',
        glyph: 'ⓘ',
        word: 'Heads-up',
        headline: `${who}: the token expires ${expiryPhrase(hours ?? 0)}.`,
        sub: 'Posting is unaffected until then. Replace it from the channel row below before it lapses.',
      };
    default:
      return null;
  }
}

/** Most urgent first, so the banner an operator reads first is the one that matters. */
export function stalenessBanners(channels: Channel[]): Array<{ channel: Channel; banner: StalenessBanner }> {
  const rank: Record<Tone, number> = { error: 0, warn: 1, info: 2 };
  return channels
    .map((channel) => ({ channel, banner: stalenessBanner(channel) }))
    .filter((entry): entry is { channel: Channel; banner: StalenessBanner } => entry.banner !== null)
    .sort((a, b) => rank[a.banner.tone] - rank[b.banner.tone]);
}

export interface BadgeSpec {
  /** A `.badge` colour class. */
  tone: 'green' | 'amber' | 'red' | 'blue' | 'gray';
  glyph: string;
  label: string;
}

/**
 * The connection badge. A healthy connection is the same green whatever its
 * token's expiry tier - the tier lives in the separate expiry chip, so two
 * channels in the same state never differ by colour alone.
 */
export function channelBadge(channel: Channel): BadgeSpec {
  if (channel.status === 'disabled') return { tone: 'gray', glyph: '⊘', label: 'Disconnected' };
  if (channel.status === 'needs_reauth') return { tone: 'red', glyph: '✕', label: 'Needs new token' };
  if (channel.tokenTier === 'expired') return { tone: 'red', glyph: '✕', label: 'Token expired' };
  if (!channel.adapterInstalled) return { tone: 'amber', glyph: '▲', label: 'No adapter' };
  return { tone: 'green', glyph: '●', label: 'Connected' };
}

export interface CredentialLine {
  /** set: stored and working. stale: stored but refused. missing: nothing stored. */
  state: 'set' | 'stale' | 'missing';
  label: string;
  /** Where it came from, or what is wrong with it. */
  when: string;
  /** The part of `when` that is a failure, set in red. */
  alert: string | null;
}

/**
 * Presence-only credential readback. A token the network has refused keeps
 * its "stored" wording but loses the green tick, so a stored-and-rejected
 * credential never reads as a success beside the notice that it failed.
 */
export function credentialLine(channel: Channel): CredentialLine {
  const source =
    channel.credential.source === 'environment'
      ? "from the deployment's secret store"
      : 'pasted in this panel';
  if (!channel.credential.stored) {
    return {
      state: 'missing',
      label: 'no token stored',
      when: channel.status === 'disabled' ? 'removed when disconnected' : '',
      alert: channel.status === 'disabled' ? null : 'nothing can post until one is added',
    };
  }
  if (channel.status === 'needs_reauth') {
    return {
      state: 'stale',
      label: 'token stored',
      when: source,
      alert: `rejected by ${providerLabel(channel.provider)} since ${shortDate(channel.statusSince)}`,
    };
  }
  if (channel.tokenTier === 'expired') {
    return {
      state: 'stale',
      label: 'token stored',
      when: source,
      alert: `expired ${shortDate(channel.token.expiresAt)}`,
    };
  }
  return { state: 'set', label: 'token stored', when: source, alert: null };
}

/** The status column. Every tint carries a glyph and a word as well. */
export function queueStatusBadge(item: Pick<QueueItem, 'status' | 'holdReason' | 'lastError'>): BadgeSpec {
  const byStatus: Record<DistributionStatus, BadgeSpec> = {
    pending: { tone: 'blue', glyph: '◷', label: 'Queued' },
    posting: { tone: 'blue', glyph: '↻', label: 'Posting' },
    posted: { tone: 'green', glyph: '✓', label: 'Posted' },
    failed: { tone: 'red', glyph: '✕', label: 'Failed' },
    held: { tone: 'amber', glyph: '⏸', label: 'Held' },
  };
  if (item.status === 'pending' && item.holdReason === 'site_not_ready') {
    return { tone: 'amber', glyph: '◷', label: 'Waiting' };
  }
  if (item.status === 'posted' && item.lastError) {
    return { tone: 'amber', glyph: '!', label: 'Posted, degraded' };
  }
  return byStatus[item.status];
}

export interface ReasonCopy {
  glyph: string;
  heading: string;
  detail: string;
}

/**
 * Why a held item is held, in the operator's terms. The provider's own
 * sentence still renders underneath, but the heading is what says whether the
 * fix is an image, next month, or nothing at all.
 */
export const HOLD_REASON_COPY: Record<HoldReason, ReasonCopy> = {
  no_safe_image: {
    glyph: '▨',
    heading: 'No safe image',
    detail:
      'There is no image we may upload for this post, and the link could not go in the body instead because this month’s body-link budget is spent. Add a hero image to the article, or release it next month.',
  },
  link_budget_exhausted: {
    glyph: '⊘',
    heading: 'Body-link budget exhausted',
    detail:
      'This account has used its body links for the month, and there is no safe image to post with the link in a comment instead. Release it next month, or add a hero image to the article.',
  },
  site_not_ready: {
    glyph: '◷',
    heading: 'Site not yet serving the article',
    detail:
      'The live page is not serving this article yet - the site rebuild is usually still running. It is checked again automatically and fails if the page never appears.',
  },
};

export interface RowReason {
  kind: 'hold' | 'error' | 'degraded' | 'none';
  glyph: string | null;
  heading: string | null;
  /** The agent's own words, when there are any worth showing. */
  detail: string | null;
}

export function rowReason(item: Pick<QueueItem, 'status' | 'holdReason' | 'lastError'>): RowReason {
  if (item.holdReason) {
    const copy = HOLD_REASON_COPY[item.holdReason];
    return { kind: 'hold', glyph: copy.glyph, heading: copy.heading, detail: item.lastError };
  }
  if (item.status === 'held') {
    // Held before reasons were recorded: the provider's sentence is all there is.
    return { kind: 'hold', glyph: '⏸', heading: 'Held for an operator', detail: item.lastError };
  }
  if (item.status === 'failed') {
    return { kind: 'error', glyph: '✕', heading: null, detail: item.lastError ?? 'failed with no error recorded' };
  }
  if (item.status === 'posted' && item.lastError) {
    return { kind: 'degraded', glyph: '!', heading: 'Posted in a reduced form', detail: item.lastError };
  }
  if (item.status === 'pending' && item.lastError) {
    // Backing off after a failed attempt: the retry is automatic.
    return { kind: 'error', glyph: '↻', heading: 'Retrying automatically', detail: item.lastError };
  }
  return { kind: 'none', glyph: null, heading: null, detail: null };
}

/**
 * The manual move a row offers, which is also whether its checkbox is live:
 * retry for a failed item, release for a held one. An item waiting on the site
 * offers neither - it moves by itself.
 */
export function recoveryAction(item: Pick<QueueItem, 'status'>): 'retry' | 'release' | null {
  if (item.status === 'failed') return 'retry';
  if (item.status === 'held') return 'release';
  return null;
}

/** Whether a row's placement may still be changed: anything not posted or mid-post. */
export function placementEditable(item: Pick<QueueItem, 'status'>): boolean {
  return item.status === 'pending' || item.status === 'held' || item.status === 'failed';
}

/** The rows a header select-all ticks: every held or failed item the filter shows. */
export function selectableIds(items: QueueItem[]): string[] {
  return items.filter((item) => recoveryAction(item) !== null).map((item) => item.id);
}

export interface SelectionSummary {
  total: number;
  failed: string[];
  held: string[];
}

/** The live count the bulk bar prints, from the rows actually ticked. */
export function summariseSelection(items: QueueItem[], selected: ReadonlySet<string>): SelectionSummary {
  const failed: string[] = [];
  const held: string[] = [];
  for (const item of items) {
    if (!selected.has(item.id)) continue;
    if (item.status === 'failed') failed.push(item.id);
    else if (item.status === 'held') held.push(item.id);
  }
  return { total: failed.length + held.length, failed, held };
}

/** Drop ticks for rows the latest poll no longer shows as eligible. */
export function pruneSelection(items: QueueItem[], selected: ReadonlySet<string>): Set<string> {
  const eligible = new Set(selectableIds(items));
  return new Set([...selected].filter((id) => eligible.has(id)));
}

export const FILTERS: ReadonlyArray<{ value: QueueFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Queued' },
  { value: 'held', label: 'Held' },
  { value: 'failed', label: 'Failed' },
  { value: 'posted', label: 'Posted' },
];

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The toast after a bulk move - how many moved, and why any did not. */
export function bulkOutcomeMessage(
  action: 'retry' | 'release',
  outcome: RecoveryOutcome,
): { tone: 'ok' | 'partial'; glyph: string; text: string } {
  const verb = action === 'retry' ? 'retried' : 'released';
  const moved = `${plural(outcome.updated.length, 'item')} ${verb} - back in the queue now.`;
  if (outcome.skipped.length === 0) return { tone: 'ok', glyph: '✓', text: moved };
  const why = action === 'retry' ? 'no longer failed' : 'no longer held';
  return {
    tone: 'partial',
    glyph: '▲',
    text: `${outcome.updated.length === 0 ? 'Nothing moved.' : moved} ${plural(outcome.skipped.length, 'item')} skipped (${why} by the time you confirmed).`,
  };
}

/**
 * What the disconnect modal says becomes of a channel's queue. A queued item
 * posts once the channel is back; a held one does not, because only a release
 * moves it out of held - reconnecting is not one.
 */
export function disconnectQueueNote(counts: { pending: number; held: number }): string {
  const notes: string[] = [];
  if (counts.pending > 0) {
    const one = counts.pending === 1;
    notes.push(
      `${plural(counts.pending, 'queued item')} ${one ? 'stays' : 'stay'} in the queue and ${one ? 'posts' : 'post'} if you reconnect.`,
    );
  }
  if (counts.held > 0) {
    notes.push(
      `${plural(counts.held, 'held item')} ${counts.held === 1 ? 'stays' : 'stay'} in the queue, but reconnecting releases nothing: an item held for you still needs its own release.`,
    );
  }
  return notes.join(' ');
}

/** Where the article sits on the live site, for the row's title link. */
export function articleUrl(slug: string): string {
  return `https://sleekdrops.com/blog/${slug}/`;
}
