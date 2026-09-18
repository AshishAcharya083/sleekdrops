// The container's CMD is `pnpm --filter @sleekdrops/agent start`, i.e. this
// entrypoint - so the boot contract is tested the way the container runs it:
// spawn src/index.ts and watch what the process actually does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENTRYPOINT = join(PACKAGE_ROOT, 'src', 'index.ts');

/** The live database this sandbox/CI provides, or nothing. */
const liveUrl = process.env.DATABASE_URL ?? '';

async function probe(connectionString: string): Promise<unknown> {
  const probePool = new pg.Pool({ connectionString, max: 1 });
  const result = await probePool
    .query('SELECT 1')
    .then(() => undefined)
    .catch((err: unknown) => err);
  await probePool.end();
  return result;
}

const reachable = liveUrl ? (await probe(liveUrl)) === undefined : false;

/** A trust-auth server has no credential error to fail fast on. */
async function rejectsWrongPassword(): Promise<boolean> {
  const wrongPassword = new URL(liveUrl);
  wrongPassword.password = 'definitely-not-the-password';
  return (await probe(wrongPassword.href)) !== undefined;
}

const skip = !reachable
  ? 'no reachable DATABASE_URL - start Postgres to run these'
  : (await rejectsWrongPassword())
    ? false
    : 'this Postgres accepts any password - no credential error to surface';

interface Booted {
  child: ChildProcess;
  output: () => string;
  waitFor: (pattern: RegExp, timeoutMs?: number) => Promise<void>;
  exited: Promise<number | null>;
}

function bootAgent(databaseUrl: string): Booted {
  const child = spawn(process.execPath, ['--import', 'tsx', ENTRYPOINT], {
    cwd: PACKAGE_ROOT,
    // PORT 0 keeps a booting agent off a port another suite may want; neither
    // case here gets far enough to serve anyway.
    env: { ...process.env, DATABASE_URL: databaseUrl, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const waiters: Array<() => void> = [];
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => {
      output += chunk;
      for (const notify of waiters.splice(0)) notify();
    });
  }
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  return {
    child,
    output: () => output,
    exited,
    waitFor: (pattern, timeoutMs = 30_000) =>
      new Promise((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error(`never matched ${pattern}. Output:\n${output}`)),
          timeoutMs,
        );
        const check = (): void => {
          if (!pattern.test(output)) {
            waiters.push(check);
            return;
          }
          clearTimeout(deadline);
          resolve();
        };
        check();
        void exited.then(check);
      }),
  };
}

test('boot retries an unreachable database instead of exiting', { timeout: 60_000 }, async () => {
  // Port 1 is unbound, so every connection is refused - the shape of the
  // failure that used to kill the process before the server ever listened.
  const agent = bootAgent('postgres://unused:unused@127.0.0.1:1/unreachable');
  try {
    await agent.waitFor(/database not reachable yet, retrying/);
    await agent.waitFor(/"attempt":2/);
    assert.equal(agent.child.exitCode, null, 'the agent exited instead of waiting for Postgres');
    assert.doesNotMatch(agent.output(), /\[agent\] fatal/);
  } finally {
    agent.child.kill('SIGKILL');
    await agent.exited;
  }
});

test(
  'boot fails fast on a credential error rather than waiting out the window',
  { skip, timeout: 60_000 },
  async () => {
    const wrongPassword = new URL(liveUrl);
    wrongPassword.password = 'definitely-not-the-password';
    const agent = bootAgent(wrongPassword.href);
    const startedAt = Date.now();
    const exitCode = await agent.exited;

    assert.equal(exitCode, 1);
    assert.ok(
      Date.now() - startedAt < 25_000,
      'an authentication failure was retried instead of surfacing immediately',
    );
    assert.match(agent.output(), /\[agent\] fatal/);
    assert.match(agent.output(), /password authentication failed/i);
    assert.doesNotMatch(agent.output(), /retrying/);
  },
);
