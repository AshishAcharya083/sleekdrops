// SleekDrops agent platform entrypoint: wait for the database → migrate →
// recover → serve + work.
import { MISSING_DATABASE_URL, config } from './config.js';
import { migrate } from './db/migrate.js';
import { pgErrorCode, waitForDatabase } from './db/pool.js';
import { startScheduler } from './pipeline/scheduler.js';
import { startScoutWorker } from './pipeline/scout.js';
import { recoverStranded, startWorker } from './pipeline/worker.js';
import { startServer } from './api/server.js';

async function main(): Promise<void> {
  if (!config.databaseUrl) {
    console.error(`[agent] ${MISSING_DATABASE_URL}`);
    process.exit(1);
  }
  // One legible line before the first query: a DSN aimed at the wrong Postgres
  // is then obvious without reading a pg-pool stack.
  console.log(`[agent] database ${config.databaseLabel}`);
  await waitForDatabase();
  await migrate();
  await recoverStranded();
  startServer();
  startWorker();
  startScoutWorker();
  startScheduler();
}

main().catch((err) => {
  if (pgErrorCode(err) === 'ECONNREFUSED') {
    console.error(
      `[agent] nothing is listening at ${config.databaseLabel} -` +
        ' check DATABASE_URL for this environment',
    );
  }
  console.error('[agent] fatal:', err);
  process.exit(1);
});
