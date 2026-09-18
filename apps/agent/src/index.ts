// SleekDrops agent platform entrypoint: wait for db → migrate → recover → serve + work.
import { migrate } from './db/migrate.js';
import { databaseTarget, isDatabaseUnreachableError, waitForDatabase } from './db/pool.js';
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
  if (isDatabaseUnreachableError(err)) {
    console.error(
      `[agent] no Postgres answering at ${databaseTarget()} - set DATABASE_URL to a reachable ` +
        'Postgres (or PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE). Note port 5544 is the ' +
        'docker-compose host mapping from `pnpm db:up`: it is not valid inside a container.',
    );
  }
  console.error('[agent] fatal:', err);
  process.exit(1);
});
