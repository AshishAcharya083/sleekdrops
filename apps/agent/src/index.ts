// SleekDrops agent platform entrypoint: wait for db → migrate → recover → serve + work.
import { migrate } from './db/migrate.js';
import { databaseConnectionHint, isDatabaseConnectionError, waitForDatabase } from './db/pool.js';
import { startInsightsCollector } from './distribution/insights.js';
import { registerProvider } from './distribution/providers.js';
import { facebookProvider } from './distribution/providers/facebook.js';
import { startDistributionWorker } from './distribution/worker.js';
import { startScheduler } from './pipeline/scheduler.js';
import { startScoutWorker } from './pipeline/scout.js';
import { recoverStranded, startWorker } from './pipeline/worker.js';
import { startServer } from './api/server.js';

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
}

main().catch((err) => {
  if (isDatabaseConnectionError(err)) console.error(`[agent] ${databaseConnectionHint(err)}`);
  console.error('[agent] fatal:', err);
  process.exit(1);
});
