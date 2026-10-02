// Contract tests for the admin API as the panel actually calls it: real Hono
// app, real headers, real verbs. The database deliberately points nowhere, so
// the routes that touch it exercise the uncaught-error path end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/unreachable';
process.env.ADMIN_TOKEN = 'test-admin-token';
// Declared (empty) so a developer's own .env can't switch hero-image storage on
// mid-test - dotenv leaves keys that already exist in the environment alone.
process.env.GCS_IMAGES_BUCKET = '';

const { createApp } = await import('./server.js');
const { TRACE_HEADER } = await import('./trace.js');
const { PLATFORM_HEADER } = await import('./platform.js');
const { UnknownPlatformError } = await import('../platform/registry.js');

type Platform = import('../platform/types.js').Platform;

function fixturePlatform(id: string, overrides: Partial<Platform> = {}): Platform {
  return {
    id,
    name: id,
    bylineName: `${id} Editorial Team`,
    brandText: `${id} brand`,
    audience: `${id} readers`,
    categories: ['Tech', 'Home'],
    postTypes: ['article', 'guide'],
    articleShapes: [],
    editorialRules: 'Be accurate.',
    monetisation: 'amazon',
    blockedLinkDomains: [],
    blockedTopics: [],
    scoutQueries: [],
    agentGoals: {},
    publishTarget: {
      d1DatabaseIdEnv: 'D1_DATABASE_ID',
      githubRepoEnv: 'GITHUB_REPO',
      siteUrlEnv: 'SITE_URL',
      rebuildHookEnv: null,
    },
    profileVersion: 1,
    editions: [
      {
        id: 'au',
        platformId: id,
        name: 'Australia',
        timeZone: 'Australia/Sydney',
        currency: 'AUD',
        locale: 'en-AU',
        scoutQueries: [],
        complianceFooter: '',
      },
    ],
    ...overrides,
  };
}

// The database points nowhere, so platforms resolve from fixtures - as they
// would from the registry's cache on a server that has answered before.
const PLATFORMS = new Map<string, Platform>([
  ['sleekdrops', fixturePlatform('sleekdrops')],
  [
    'peakodds',
    fixturePlatform('peakodds', {
      name: 'PeakOdds',
      categories: ['AFL', 'NRL'],
      postTypes: ['preview', 'guide'],
      monetisation: 'none',
      blockedTopics: ['racing'],
    }),
  ],
]);
const app = createApp({
  loadPlatform: async (id) => {
    const platform = PLATFORMS.get(id);
    if (!platform) throw new UnknownPlatformError(`unknown platform: ${id}`);
    return platform;
  },
});
// Every admin call names its platform, exactly as the panel sends it.
const AUTH = { Authorization: 'Bearer test-admin-token', [PLATFORM_HEADER]: 'sleekdrops' };
const CLIENT_TRACE_ID = '0199b3e7c2f97c9aa4b1d2e3f4a5b6c7';

/** Drive one request and collect the JSON log lines it wrote to stdout/stderr. */
async function call(
  path: string,
  init?: RequestInit,
): Promise<{ res: Response; logs: Array<Record<string, unknown>> }> {
  const logs: Array<Record<string, unknown>> = [];
  const capture = (line: unknown) => {
    if (typeof line === 'string' && line.startsWith('{')) logs.push(JSON.parse(line));
  };
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  try {
    const res = await app.fetch(new Request(`http://localhost${path}`, init));
    return { res, logs };
  } finally {
    Object.assign(console, original);
  }
}

test('echoes the trace id the panel sent and logs the request under it', async () => {
  const { res, logs } = await call('/api/health', { headers: { [TRACE_HEADER]: CLIENT_TRACE_ID } });

  assert.equal(res.headers.get(TRACE_HEADER), CLIENT_TRACE_ID);
  const request = logs.find((l) => l.message === 'request');
  assert.ok(request, 'the middleware logs one request line');
  assert.equal(request.trace_id, CLIENT_TRACE_ID);
  assert.equal(request.method, 'GET');
  assert.equal(request.path, '/api/health');
  assert.equal(request.status, res.status);
  assert.equal(typeof request.duration_ms, 'number');
});

test('mints a trace id when the panel sends none (analytics disabled)', async () => {
  const { res, logs } = await call('/api/health');

  const traceId = res.headers.get(TRACE_HEADER);
  assert.match(traceId ?? '', /^[0-9a-f]{32}$/);
  assert.equal(logs.find((l) => l.message === 'request')?.trace_id, traceId);
});

test('a rejected trace id is replaced, so a hostile header cannot poison a log line', async () => {
  const { res, logs } = await call('/api/health', {
    headers: { [TRACE_HEADER]: 'abc"} {"level":"error","message":"injected"' },
  });

  assert.match(res.headers.get(TRACE_HEADER) ?? '', /^[0-9a-f]{32}$/);
  assert.equal(logs.some((l) => l.message === 'injected'), false);
});

test('an unauthorized call is still traced', async () => {
  const { res, logs } = await call('/api/topics', { headers: { [TRACE_HEADER]: CLIENT_TRACE_ID } });

  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'unauthorized' });
  assert.equal(res.headers.get(TRACE_HEADER), CLIENT_TRACE_ID);
  assert.equal(logs.find((l) => l.message === 'request')?.trace_id, CLIENT_TRACE_ID);
});

test('an uncaught route error returns the { error } shape plus the trace id', async () => {
  const { res, logs } = await call('/api/topics', {
    headers: { ...AUTH, [TRACE_HEADER]: CLIENT_TRACE_ID },
  });

  assert.equal(res.status, 500);
  const body = (await res.json()) as { error?: string; traceId?: string };
  // apps/admin/src/api.ts reads body.error - that contract must not change.
  assert.equal(typeof body.error, 'string');
  assert.equal(body.traceId, CLIENT_TRACE_ID);
  assert.equal(res.headers.get(TRACE_HEADER), CLIENT_TRACE_ID);

  const failure = logs.find((l) => l.message === 'unhandled route error');
  assert.ok(failure, 'the failure is logged server-side');
  assert.equal(failure.trace_id, CLIENT_TRACE_ID);
  assert.equal(failure.path, '/api/topics');
  assert.equal(failure.level, 'error');
  assert.equal(typeof failure.stack, 'string');
  assert.equal(
    body.error?.includes('127.0.0.1'),
    false,
    'the response stays generic; the detail lives in the log line',
  );
});

test('an unauthorized overview call names the auth failure the panel reacts to', async () => {
  const { res } = await call('/api/overview', { headers: { [TRACE_HEADER]: CLIENT_TRACE_ID } });

  // The panel turns this exact 401 into "check the admin token" rather than
  // "API unreachable" (apps/admin/src/api-error.ts).
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'unauthorized' });
});

test('a database outage degrades the overview instead of blanking the dashboard', async () => {
  const { res, logs } = await call('/api/overview', {
    headers: { ...AUTH, [TRACE_HEADER]: CLIENT_TRACE_ID },
  });

  assert.equal(res.status, 200, 'the landing screen must not collapse to a 500');
  const body = (await res.json()) as Record<string, unknown> & { failedSections: string[] };
  assert.deepEqual(body.failedSections, [
    'articles',
    'recentSessions',
    'runningSessions',
    'settings',
    'topics',
    'usage30d',
  ]);
  // Every field the panel reads is still there, at its fallback.
  assert.deepEqual(body.topics, []);
  assert.deepEqual(body.articles, []);
  assert.deepEqual(body.recentSessions, []);
  assert.equal(body.runningSessions, 0);
  assert.deepEqual(body.usage30d, { costUsd: 0, tokensInput: 0, tokensOutput: 0, runs: 0 });
  assert.equal(body.publishMode, 'approval');
  assert.equal(body.workerEnabled, true);

  const failures = logs.filter((l) => l.message === 'overview section failed');
  assert.equal(failures.length, 6, 'each failing section is attributable on its own');
  for (const line of failures) {
    assert.equal(line.trace_id, CLIENT_TRACE_ID);
    assert.equal(typeof line.section, 'string');
    assert.equal(typeof line.error, 'string');
  }
  assert.equal(
    JSON.stringify(body).includes('127.0.0.1'),
    false,
    'the response stays generic; the detail lives in the log line',
  );
});

test('a POST that enqueues work is traced the same way', async () => {
  const { res, logs } = await call('/api/topics/approve', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json', [TRACE_HEADER]: CLIENT_TRACE_ID },
    body: JSON.stringify({ ids: ['0d1c8f5a-3c2b-4a5e-9f10-2b3c4d5e6f70'] }),
  });

  assert.equal(res.status, 500);
  assert.equal(res.headers.get(TRACE_HEADER), CLIENT_TRACE_ID);
  assert.equal(logs.find((l) => l.message === 'unhandled route error')?.method, 'POST');
});

test('the CORS preflight lets X-Trace-Id through and back', async () => {
  const { res } = await call('/api/topics/approve', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://sleekdrops-admin.pages.dev',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': TRACE_HEADER,
    },
  });

  const allowed = res.headers.get('Access-Control-Allow-Headers') ?? '';
  const exposed = res.headers.get('Access-Control-Expose-Headers') ?? '';
  assert.match(allowed, new RegExp(TRACE_HEADER, 'i'));
  assert.match(allowed, /Authorization/i);
  assert.match(allowed, new RegExp(PLATFORM_HEADER, 'i'));
  assert.match(exposed, new RegExp(TRACE_HEADER, 'i'));
});

// ── Platform scoping ────────────────────────────────────────────────────────
// Every admin route answers for exactly one platform, named in X-Platform.

const BEARER = { Authorization: 'Bearer test-admin-token' };

test('an admin call without X-Platform is refused, with no default platform', async () => {
  for (const [method, path] of [
    ['GET', '/api/overview'],
    ['GET', '/api/topics'],
    ['POST', '/api/topics/manual'],
    ['GET', '/api/settings'],
    ['GET', '/api/platform/profile'],
    ['PUT', '/api/platform/profile'],
    ['GET', '/api/platform/profile/versions'],
  ]) {
    const { res } = await call(path, { method, headers: BEARER });
    assert.equal(res.status, 400, `${method} ${path}`);
    assert.deepEqual(await res.json(), { error: 'X-Platform header is required' });
  }
});

test('an empty X-Platform counts as missing', async () => {
  const { res } = await call('/api/topics', { headers: { ...BEARER, [PLATFORM_HEADER]: '  ' } });

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'X-Platform header is required' });
});

test('an unknown platform is named in the refusal', async () => {
  const { res } = await call('/api/topics', { headers: { ...BEARER, [PLATFORM_HEADER]: 'nope' } });

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'unknown platform: nope' });
});

test('a bad token is still a 401 before the platform is looked at', async () => {
  const { res } = await call('/api/topics', { headers: { [PLATFORM_HEADER]: 'nope' } });

  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'unauthorized' });
});

test('health and the platform list answer without X-Platform', async () => {
  for (const path of ['/api/health', '/api/platforms']) {
    const { res } = await call(path, { headers: BEARER });
    // The database is unreachable here, so neither is a 200 - but neither is
    // the 400 a scoped route gives.
    assert.notEqual(res.status, 400, path);
  }
});

/** A manual topic exactly as the drawer posts it. */
function manualTopic(platform: string, body: Record<string, unknown>): RequestInit {
  return {
    method: 'POST',
    headers: { ...BEARER, [PLATFORM_HEADER]: platform, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

test('a manual topic must name one of its platform\'s editions', async () => {
  for (const edition_id of [undefined, 'global']) {
    const { res } = await call(
      '/api/topics/manual',
      manualTopic('sleekdrops', { title: 'Best robot vacuums', edition_id }),
    );
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'edition_id must be one of: au' });
  }
});

test('a manual topic is checked against its platform\'s categories and post types', async () => {
  const category = await call(
    '/api/topics/manual',
    manualTopic('peakodds', { title: 'Grand final preview', edition_id: 'au', category: 'Tech' }),
  );
  assert.equal(category.res.status, 400);
  assert.deepEqual(await category.res.json(), { error: 'category must be one of: AFL, NRL' });

  const postType = await call(
    '/api/topics/manual',
    manualTopic('sleekdrops', { title: 'Best robot vacuums', edition_id: 'au', post_type: 'preview' }),
  );
  assert.equal(postType.res.status, 400);
  assert.deepEqual(await postType.res.json(), { error: 'post_type must be one of: article, guide' });
});

test('a manual topic\'s event time must carry an offset', async () => {
  const { res } = await call(
    '/api/topics/manual',
    manualTopic('peakodds', {
      title: 'Grand final preview',
      edition_id: 'au',
      event_starts_at: '2026-10-03T19:30:00',
    }),
  );
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /event_starts_at/);
});

test('a racing topic is refused on a platform that blocks racing', async () => {
  for (const body of [
    { title: 'Melbourne Cup tips', edition_id: 'au' },
    { title: 'Tuesday big race', edition_id: 'au', instructions: 'Cover the Melbourne Cup field' },
  ]) {
    const { res } = await call('/api/topics/manual', manualTopic('peakodds', body));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'racing topics are not covered on PeakOdds' });
  }
});

/** A profile save exactly as the editor sends it. */
function profilePut(body: unknown): RequestInit {
  return {
    method: 'PUT',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

const EDITABLE = {
  brand_text: 'SleekDrops brand',
  audience: 'Australian shoppers',
  editorial_rules: 'Be accurate.',
  agent_goals: { write: 'Write tight.' },
  scout_queries: ['best gadgets'],
  editions: [{ id: 'au', scout_queries: [], compliance_footer: '' }],
};

test('a profile save that is not the contracted shape is refused before anything is written', async () => {
  const cases: Array<[unknown, RegExp]> = [
    [null, /base_version/],
    [{ author: 'Ana', profile: EDITABLE }, /base_version/],
    [{ base_version: 1, author: '  ', profile: EDITABLE }, /author/],
    [{ base_version: 1, author: 'x'.repeat(101), profile: EDITABLE }, /author/],
    [{ base_version: 1, author: 'Ana', profile: { ...EDITABLE, brand_text: ' ' } }, /brand_text/],
    [{ base_version: 1, author: 'Ana', profile: { ...EDITABLE, scout_queries: 'one' } }, /scout_queries/],
  ];
  for (const [body, error] of cases) {
    const { res } = await call('/api/platform/profile', profilePut(body));
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(((await res.json()) as { error: string }).error, error);
  }
});

test('a profile save naming an unknown agent is refused', async () => {
  const { res } = await call(
    '/api/platform/profile',
    profilePut({ base_version: 1, author: 'Ana', profile: { ...EDITABLE, agent_goals: { publish: 'x' } } }),
  );
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'unknown agent id: publish' });
});

test('a profile save naming another platform\'s edition is refused', async () => {
  const { res } = await call(
    '/api/platform/profile',
    profilePut({
      base_version: 1,
      author: 'Ana',
      profile: { ...EDITABLE, editions: [{ id: 'global', scout_queries: [], compliance_footer: '' }] },
    }),
  );
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'edition global does not belong to sleekdrops' });
});

test('a profile save cannot reach the fields that are not editable', async () => {
  for (const extra of [{ categories: ['Crypto'] }, { monetisation: 'none' }, { blocked_topics: [] }]) {
    const { res } = await call(
      '/api/platform/profile',
      profilePut({ base_version: 1, author: 'Ana', profile: { ...EDITABLE, ...extra } }),
    );
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /not editable/);
  }
  const { res } = await call(
    '/api/platform/profile',
    profilePut({
      base_version: 1,
      author: 'Ana',
      profile: { ...EDITABLE, editions: [{ ...EDITABLE.editions[0], time_zone: 'UTC' }] },
    }),
  );
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'profile.editions.0.time_zone not editable' });
});

// ── Hero image drop ─────────────────────────────────────────────────────────
// Every rejection below happens before the route reaches the database, which is
// what makes them assertable here (and what keeps a bad upload cheap).

const ARTICLE_ID = '0d1c8f5a-3c2b-4a5e-9f10-2b3c4d5e6f70';
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(0)]);

/** A multipart body shaped exactly like the panel's upload. */
function heroForm(parts: { file?: { bytes: Uint8Array; name: string; type: string }; alt?: string }): FormData {
  const form = new FormData();
  if (parts.file) {
    form.set('file', new Blob([parts.file.bytes], { type: parts.file.type }), parts.file.name);
  }
  if (parts.alt !== undefined) form.set('alt', parts.alt);
  return form;
}

test('a hero-image drop that is not really an image is refused, not stored', async () => {
  const { res } = await call(`/api/articles/${ARTICLE_ID}/hero-image`, {
    method: 'POST',
    headers: AUTH,
    body: heroForm({ file: { bytes: new TextEncoder().encode('<html>gotcha</html>'), name: 'hero.png', type: 'image/png' } }),
  });

  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /JPEG, PNG or WebP/);
});

test('a real image is refused with an actionable message when storage is unconfigured', async () => {
  const { res } = await call(`/api/articles/${ARTICLE_ID}/hero-image`, {
    method: 'POST',
    headers: AUTH,
    body: heroForm({ file: { bytes: PNG_BYTES, name: 'hero.png', type: 'image/png' }, alt: 'A hero' }),
  });

  assert.equal(res.status, 503);
  assert.match(((await res.json()) as { error: string }).error, /GCS_IMAGES_BUCKET/);
});

test('a topic hero-image drop with no file part is refused', async () => {
  const { res } = await call(`/api/topics/${ARTICLE_ID}/hero-image`, {
    method: 'POST',
    headers: AUTH,
    body: heroForm({ alt: 'alt only' }),
  });

  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /"file" part/);
});

test('a live post cannot be re-imaged with something that is not an image', async () => {
  const { res } = await call('/api/published/best-budget-mattress-australia/hero-image', {
    method: 'POST',
    headers: AUTH,
    body: heroForm({ file: { bytes: new TextEncoder().encode('%PDF-1.4'), name: 'hero.jpg', type: 'image/jpeg' } }),
  });

  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /JPEG, PNG or WebP/);
});

test('a hero-image drop without a token is rejected like every other route', async () => {
  const { res } = await call(`/api/articles/${ARTICLE_ID}/hero-image`, {
    method: 'POST',
    body: heroForm({ file: { bytes: PNG_BYTES, name: 'hero.png', type: 'image/png' } }),
  });

  assert.equal(res.status, 401);
});

// ── Retry controls ──────────────────────────────────────────────────────────
// The stage body param is validated before the route reaches the database,
// which is what makes these assertable here - and what keeps a mistyped stage
// from costing a query. The panel keys its copy off these exact strings.

/** A retry action exactly as the panel sends it: POST, bearer, JSON body. */
function retryCall(body?: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

test('a retry-stage call with no stage is refused before anything is queued', async () => {
  const { res } = await call(`/api/articles/${ARTICLE_ID}/retry-stage`, retryCall());

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'stage required' });
});

test('a retry-stage call naming a stage that does not exist says which one', async () => {
  const { res } = await call(`/api/articles/${ARTICLE_ID}/retry-stage`, retryCall({ stage: 'polish' }));

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'unknown stage "polish"' });
});

test('done is not something a run can be retried from', async () => {
  const { res } = await call(`/api/articles/${ARTICLE_ID}/retry-stage`, retryCall({ stage: 'done' }));

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'done is not a runnable stage' });
});

test('the publisher cannot be reached through the isolated stage test', async () => {
  const { res } = await call(`/api/articles/${ARTICLE_ID}/test-stage`, retryCall({ stage: 'publish' }));

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'the publish stage cannot be tested in isolation' });
});

test('the retry controls are behind the admin token like every other route', async () => {
  for (const path of ['retry-stage', 'test-stage', 'rerun-all', 'cancel']) {
    const { res } = await call(`/api/articles/${ARTICLE_ID}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'write' }),
    });
    assert.equal(res.status, 401, `${path} must require the token`);
  }
});
