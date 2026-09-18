// SleekDrops agent platform entrypoint: wait for db → migrate → recover → serve + work.
import { migrate } from './db/migrate.js';
import { databaseConnectionHint, isDatabaseConnectionError, waitForDatabase } from './db/pool.js';
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
}

main().catch((err) => {
  if (isDatabaseConnectionError(err)) console.error(`[agent] ${databaseConnectionHint(err)}`);
  console.error('[agent] fatal:', err);
  process.exit(1);
});
