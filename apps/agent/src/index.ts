// SleekDrops agent platform entrypoint: wait for db → migrate → recover → serve + work,
// and on SIGTERM/SIGINT hand held work back to the queue before exiting.
import { setTimeout as delay } from 'node:timers/promises';
import { migrate } from './db/migrate.js';
import { databaseConnectionHint, isDatabaseConnectionError, waitForDatabase } from './db/pool.js';
import { startInsightsCollector, stopInsightsCollector } from './distribution/insights.js';
import { registerProvider } from './distribution/providers.js';
import { facebookProvider } from './distribution/providers/facebook.js';
import { startDistributionWorker, stopDistributionWorker } from './distribution/worker.js';
import { startScheduler } from './pipeline/scheduler.js';
import { startScoutWorker, stopScoutWorker } from './pipeline/scout.js';
import {
  recoverStranded,
  releaseHeldClaims,
  startWorker,
  stopWorker,
  workerId,
} from './pipeline/worker.js';
import { startServer } from './api/server.js';

/**
 * Cloud Run sends SIGTERM and kills the container 10 seconds later - on every
 * redeploy, every scale-in and every instance it recycles. Whatever is still
 * running then is gone; what matters is that the claims it held are not left
 * to lapse, because an unreleased claim is five minutes of a card nobody can
 * pick up, and the next instance boots straight past it.
 */
const SHUTDOWN_DEADLINE_MS = 9_000;
/** How long a worker poll already in flight gets to finish before claims are released anyway. */
const POLL_DRAIN_MS = 4_000;

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[agent] ${signal} received: ${workerId} is releasing its claims and exiting`);
  setTimeout(() => {
    console.error('[agent] shutdown did not finish inside its deadline; exiting anyway');
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS).unref();

  stopScoutWorker();
  stopDistributionWorker();
  stopInsightsCollector();
  await Promise.race([stopWorker(), delay(POLL_DRAIN_MS)]);
  try {
    const released = await releaseHeldClaims();
    console.log(`[agent] released ${released} claimed article(s) back to the queue`);
  } catch (err) {
    // The leases still lapse on their own, and the next reaper re-queues them.
    console.error('[agent] could not release claims at shutdown:', err);
  }
  process.exit(0);
}

async function main(): Promise<void> {
  // Before anything queries: a database that comes up seconds after the app is
  // normal in a container, and used to kill the process on the first refusal.
  await waitForDatabase();
  await migrate();
  await recoverStranded();
  startServer();
  startWorker();
  startScoutWorker();
  startScheduler();
  // Bound here rather than by an import side effect: the registry is what the
  // distribution worker's claim filter reads, so which adapters exist is a
  // decision this file makes out loud.
  registerProvider(facebookProvider);
  startDistributionWorker();
  // Its own interval, so a network that is slow to answer for insights cannot
  // hold up the queue that is trying to post.
  startInsightsCollector();
  // Only once there is work to hand back: before this the default - exit at
  // once - is right, and a shutdown that waited on a database still being
  // dialled would only delay it.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => void shutdown(signal));
  }
}

main().catch((err) => {
  if (isDatabaseConnectionError(err)) console.error(`[agent] ${databaseConnectionHint(err)}`);
  console.error('[agent] fatal:', err);
  process.exit(1);
});
