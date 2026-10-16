// Resolving a platform's publish target from the environment: every value
// comes from the variable the platform names, and a missing one fails with
// that name rather than borrowing another platform's.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/unreachable';

const { resolvePublishTarget, resolveContentTarget, resolveSiteTarget, PublishTargetError } = await import(
  './publishTarget.js'
);

const sleekdrops = {
  id: 'sleekdrops',
  publishTarget: {
    contentDatabaseUrlEnv: 'DATABASE_URL',
    githubRepoEnv: 'GITHUB_REPO',
    siteUrlEnv: 'SITE_URL',
    rebuildHookEnv: null,
  },
};
const peakodds = {
  id: 'peakodds',
  publishTarget: {
    contentDatabaseUrlEnv: 'PEAKODDS_CONTENT_DATABASE_URL',
    githubRepoEnv: 'PEAKODDS_GITHUB_REPO',
    siteUrlEnv: 'PEAKODDS_SITE_URL',
    rebuildHookEnv: 'PEAKODDS_REBUILD_HOOK_URL',
  },
};

const ENV = {
  DATABASE_URL: 'postgres://sleekdrops:sleekdrops-pw@db.example:5432/postgres',
  GITHUB_REPO: 'example/sleekdrops',
  SITE_URL: 'https://sleekdrops.example/',
  GITHUB_TOKEN: 'ghp-test',
  PEAKODDS_CONTENT_DATABASE_URL: 'postgresql://peakodds:peakodds-pw@db.example:5432/peakodds',
  PEAKODDS_GITHUB_REPO: 'example/peakodds',
  PEAKODDS_SITE_URL: 'https://peakodds.example',
  PEAKODDS_REBUILD_HOOK_URL: 'https://hooks.example/deploy-secret',
};

function withEnv(overrides: Record<string, string | undefined>, run: () => void): void {
  const saved = { ...process.env };
  Object.assign(process.env, ENV);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    process.env = saved;
  }
}

test('SleekDrops rebuilds by repository dispatch to its own repo', () => {
  withEnv({}, () => {
    assert.deepEqual(resolvePublishTarget(sleekdrops), {
      contentDatabaseUrl: 'postgres://sleekdrops:sleekdrops-pw@db.example:5432/postgres',
      githubRepo: 'example/sleekdrops',
      siteUrl: 'https://sleekdrops.example',
      rebuildHookUrl: null,
    });
  });
});

test('PeakOdds resolves only its own variables, and rebuilds through its deploy hook', () => {
  withEnv({}, () => {
    assert.deepEqual(resolvePublishTarget(peakodds), {
      contentDatabaseUrl: 'postgresql://peakodds:peakodds-pw@db.example:5432/peakodds',
      githubRepo: 'example/peakodds',
      siteUrl: 'https://peakodds.example',
      rebuildHookUrl: 'https://hooks.example/deploy-secret',
    });
  });
});

test('a missing variable throws its name, and nothing falls back to SleekDrops', () => {
  for (const name of Object.values(peakodds.publishTarget)) {
    withEnv({ [name]: undefined }, () => {
      assert.throws(() => resolvePublishTarget(peakodds), {
        name: 'PublishTargetError',
        message: `publish target for peakodds: ${name} is not set`,
      });
    });
  }
  withEnv({ PEAKODDS_CONTENT_DATABASE_URL: '  ' }, () => {
    assert.throws(() => resolveContentTarget(peakodds), /PEAKODDS_CONTENT_DATABASE_URL is not set/);
  });
});

test('a malformed value is refused without echoing it', () => {
  withEnv({ PEAKODDS_REBUILD_HOOK_URL: 'not-a-url-but-maybe-a-secret' }, () => {
    assert.throws(
      () => resolvePublishTarget(peakodds),
      (err: unknown) =>
        err instanceof PublishTargetError &&
        /PEAKODDS_REBUILD_HOOK_URL must be an http\(s\) deploy hook URL/.test(err.message) &&
        !err.message.includes('not-a-url-but-maybe-a-secret'),
    );
  });
  withEnv({ PEAKODDS_SITE_URL: 'peakodds.example' }, () => {
    assert.throws(() => resolveSiteTarget(peakodds), /PEAKODDS_SITE_URL must be an http\(s\) URL/);
  });
  withEnv({ PEAKODDS_GITHUB_REPO: 'peakodds' }, () => {
    assert.throws(() => resolvePublishTarget(peakodds), /PEAKODDS_GITHUB_REPO must be owner\/repo/);
  });
  // A D1 database id left over from before the move is the likely mistake.
  withEnv({ PEAKODDS_CONTENT_DATABASE_URL: 'b98d83ac-a2a5-42cb-a367-0cb71b902670' }, () => {
    assert.throws(
      () => resolveContentTarget(peakodds),
      (err: unknown) =>
        err instanceof PublishTargetError &&
        /PEAKODDS_CONTENT_DATABASE_URL must be a postgres:\/\/ connection string/.test(err.message) &&
        !err.message.includes('b98d83ac'),
    );
  });
});

test('the partial resolvers need only their own variable', () => {
  withEnv({ PEAKODDS_GITHUB_REPO: undefined, PEAKODDS_REBUILD_HOOK_URL: undefined }, () => {
    assert.deepEqual(resolveContentTarget(peakodds), {
      contentDatabaseUrl: 'postgresql://peakodds:peakodds-pw@db.example:5432/peakodds',
    });
    assert.deepEqual(resolveSiteTarget(peakodds), { siteUrl: 'https://peakodds.example' });
  });
});
