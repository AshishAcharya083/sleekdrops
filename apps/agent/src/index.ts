// SleekDrops agent platform entrypoint: migrate → recover → serve + work.
import { migrate } from './db/migrate.js';
import { recoverStranded, startWorker } from './pipeline/worker.js';
import { startServer } from './api/server.js';

async function main(): Promise<void> {
  await migrate();
  await recoverStranded();
  startServer();
  startWorker();
}

main().catch((err) => {
  console.error('[agent] fatal:', err);
  process.exit(1);
});
