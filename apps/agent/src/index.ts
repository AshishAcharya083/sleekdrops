// SleekDrops agent platform entrypoint: migrate → recover → serve + work.
import { migrateWhenReady } from './db/boot.js';
import { startScheduler } from './pipeline/scheduler.js';
import { startScoutWorker } from './pipeline/scout.js';
import { recoverStranded, startWorker } from './pipeline/worker.js';
import { startServer } from './api/server.js';

async function main(): Promise<void> {
  await migrateWhenReady();
  await recoverStranded();
  startServer();
  startWorker();
  startScoutWorker();
  startScheduler();
}

main().catch((err) => {
  console.error('[agent] fatal:', err);
  process.exit(1);
});
