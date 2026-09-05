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

const app = createApp();
const AUTH = { Authorization: 'Bearer test-admin-token' };
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
  assert.match(exposed, new RegExp(TRACE_HEADER, 'i'));
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
