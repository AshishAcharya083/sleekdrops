// The database every agent .db.test.ts runs against: whether it answers, the
// reason a suite skips when it does not, and the schema migrated before the
// first test. Import it dynamically, after the test has set the environment
// its subject reads, like the pool itself.
import { config } from '../config.js';
import { migrate } from './migrate.js';
import { probeDatabase, SKIP_REASON } from './testProbe.js';

export const reachable = await probeDatabase(config.databaseUrl);

export const skip: string | false = reachable ? false : SKIP_REASON;

if (reachable) await migrate();
