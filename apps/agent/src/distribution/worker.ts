// Distribution worker — polls the queue, opens the readiness gate, and hands
// each item to whichever provider owns it.
//
// Same shape as pipeline/worker.ts and pipeline/scheduler.ts: an unref'd
// setInterval, one `tick` that does the work, and a settings flag that stops
// it without a redeploy. What is different is what a tick is allowed to do -
// every item it touches ends in a public post, so nothing here retries
// forever, and nothing that fails writes what it was authenticating with.
import { config } from '../config.js';
import { getSetting } from '../db/pool.js';
import { createLogger } from '../lib/log.js';
import { isReapTick } from '../pipeline/worker.js';
import {
  getConnection,
  redactToken,
  resolveCredential,
  setConnectionStatus,
} from './channels.js';
import { getProvider, registeredProviders } from './providers.js';
import {
  articleUrl,
  claimNextItem,
  holdItem,
  markFailed,
  markPosted,
  recoverStrandedItems,
  releaseItem,
  retriesExhausted,
  retryDelaySeconds,
  startPostAttempt,
  startReadinessClock,
} from './queue.js';
import {
  checkReadiness,
  fetchPage,
  readinessWindowExpired,
  READINESS_RETRY_SECONDS,
  READINESS_WINDOW_SECONDS,
  type PageFetcher,
} from './readiness.js';
import {
  PermanentProviderError,
  ProviderHoldError,
  type DistributionItem,
  type SocialProvider,
} from './types.js';

const log = createLogger('distribution');

/** How many items one tick will process, so a backlog cannot monopolise a poll. */
const MAX_ITEMS_PER_TICK = 5;

/**
 * What happened to one item.
 *
 * 'waiting' is the readiness gate still closed, 'retry' a spent attempt that
 * has more, 'blocked' a connection that cannot post at all until an operator
 * acts, 'held' an item a provider's ladder parked for one. Returned rather
 * than only logged so the loop is testable without reading the database back.
 */
export type ItemOutcome = 'posted' | 'waiting' | 'retry' | 'failed' | 'blocked' | 'held';

/** Everything the loop touches that a test needs to stand in for. */
export interface DistributionDeps {
  fetchPage?: PageFetcher;
  now?: () => Date;
  resolveProvider?: (name: string) => SocialProvider | null;
  availableProviders?: () => string[];
}

/**
 * Take one claimed item as far as it can go this pass.
 *
 * Order matters: the credential is resolved before the gate, because a channel
 * with no usable token should stop consuming polls rather than spend five
 * minutes proving the site is up first.
 */
export async function processItem(
  item: DistributionItem,
  deps: DistributionDeps = {},
): Promise<ItemOutcome> {
  const now = deps.now ?? (() => new Date());
  const resolveProvider = deps.resolveProvider ?? getProvider;

  const provider = resolveProvider(item.provider);
  if (!provider) {
    // Only reachable if an adapter is unregistered between the claim filter
    // and here. Costs no attempt: the absence is ours, not the network's.
    await releaseItem(item.id, retryDelaySeconds(1), `no adapter registered for ${item.provider}`);
    return 'blocked';
  }

  const connection = await getConnection(item.channelConnectionId);
  if (!connection) {
    await markFailed(item.id, 'the channel connection this item was queued for is gone');
    return 'failed';
  }

  const accessToken = await resolveCredential(connection.token_ref);
  if (!accessToken) {
    // The secret the connection names is configured nowhere. That is an
    // operator action, so the connection leaves the rotation and says why -
    // by reference, never by value.
    await setConnectionStatus(connection.id, 'needs_reauth');
    await releaseItem(
      item.id,
      retryDelaySeconds(1),
      `no credential found for ${connection.token_ref}; the connection needs re-authorising`,
    );
    return 'blocked';
  }

  const readinessStartedAt = await startReadinessClock(item.id);
  const readiness = await checkReadiness(
    articleUrl(item.slug),
    item.payload.expected,
    deps.fetchPage ?? fetchPage,
  );
  if (!readiness.ready) {
    if (readinessWindowExpired(readinessStartedAt, now())) {
      const message = `readiness gate never opened within ${READINESS_WINDOW_SECONDS}s: ${readiness.reason}`;
      await markFailed(item.id, message);
      log.warn('distribution item abandoned at the readiness gate', {
        queue_item_id: item.id,
        slug: item.slug,
        provider: item.provider,
        reason: readiness.reason,
      });
      return 'failed';
    }
    await releaseItem(item.id, READINESS_RETRY_SECONDS, `waiting for the site: ${readiness.reason}`);
    return 'waiting';
  }

  // Spent before the call, not after it: a worker that dies mid-post has
  // already paid for the attempt it made, so recovery cannot hand the same
  // item an unbounded supply of them.
  const attempts = await startPostAttempt(item.id);
  try {
    const receipt = await provider.post({
      accessToken,
      externalAccountId: connection.external_account_id,
      item,
    });
    // A degraded post still lands, but the panel has to be able to see that it
    // did so in a reduced form - so the note is never dropped for want of a
    // provider filling it in, and it goes through the same scrub as an error
    // does: it is written to the same column an operator reads.
    const note = receipt.degraded
      ? redactToken(receipt.note ?? 'posted in a reduced form', accessToken)
      : undefined;
    await markPosted(item.id, receipt.remotePostId, note);
    log.info('distributed', {
      queue_item_id: item.id,
      slug: item.slug,
      provider: item.provider,
      placement: item.placement,
      remote_post_id: receipt.remotePostId,
      degraded: receipt.degraded ?? false,
    });
    return 'posted';
  } catch (err) {
    const message = redactToken(err instanceof Error ? err.message : String(err), accessToken);
    if (err instanceof ProviderHoldError) {
      // Not a failure: the provider is telling us this item must not go out as
      // it stands and that no retry changes that. It waits in the panel.
      await holdItem(item.id, message);
      log.warn('distribution item held', {
        queue_item_id: item.id,
        slug: item.slug,
        provider: item.provider,
        reason: message,
      });
      return 'held';
    }
    const permanent = err instanceof PermanentProviderError;
    if (permanent || retriesExhausted(attempts)) {
      await markFailed(
        item.id,
        permanent ? message : `${message} (${attempts} attempt(s), giving up)`,
      );
      log.error('distribution failed', {
        queue_item_id: item.id,
        slug: item.slug,
        provider: item.provider,
        attempts,
        permanent,
        error: message,
      });
      return 'failed';
    }
    const delay = retryDelaySeconds(attempts);
    await releaseItem(item.id, delay, message);
    log.warn('distribution attempt failed, retrying', {
      queue_item_id: item.id,
      slug: item.slug,
      provider: item.provider,
      attempts,
      retry_in_seconds: delay,
      error: message,
    });
    return 'retry';
  }
}

let ticks = 0;
let stopped = false;

/** One poll: recover what a dead worker left, then drain what is due. */
export async function distributionTick(deps: DistributionDeps = {}): Promise<ItemOutcome[]> {
  if (stopped) return [];
  ticks += 1;
  // Before the enable check, exactly as the pipeline worker reaps before it:
  // an item stranded in 'posting' stays invisible for as long as nobody looks,
  // whether or not the queue is currently allowed to take new work.
  if (isReapTick(ticks)) await recoverStrandedItems();

  if (!(await getSetting<boolean>('distribution_enabled', true))) return [];

  const providers = (deps.availableProviders ?? registeredProviders)();
  if (providers.length === 0) return [];

  const outcomes: ItemOutcome[] = [];
  for (let n = 0; n < MAX_ITEMS_PER_TICK; n++) {
    const item = await claimNextItem(providers);
    if (!item) break;
    outcomes.push(await processItem(item, deps));
  }
  return outcomes;
}

export function startDistributionWorker(): void {
  // One tick at a time. A tick can spend a readiness fetch on every item it
  // claims, so it can easily outlive the poll interval, and a second tick
  // entering behind it would only queue more of the same waiting.
  let ticking = false;
  const interval = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void distributionTick()
      .catch((err) => console.error('[distribution] tick failed:', err))
      .finally(() => {
        ticking = false;
      });
  }, config.distribution.pollMs);
  interval.unref();
  console.log(
    `[distribution] queue worker polling every ${config.distribution.pollMs}ms ` +
      `(readiness window ${READINESS_WINDOW_SECONDS}s)`,
  );
}

export function stopDistributionWorker(): void {
  stopped = true;
}
