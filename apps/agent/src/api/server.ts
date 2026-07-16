// Admin API — everything the admin panel (apps/admin) needs to observe and
// steer the pipeline. Also serves the built admin SPA in production.
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { config } from '../config.js';
import { getSetting, q, setSetting } from '../db/pool.js';
import { isScoutRunning, startScoutRun } from '../pipeline/scout.js';

const ADMIN_DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../../../admin/dist');

export function createApp(): Hono {
  const app = new Hono();
  // Chrome's Local Network Access: the Pages-hosted admin (https) calling a
  // localhost agent API needs this header on the CORS preflight response.
  app.use('*', async (c, next) => {
    await next();
    if (c.req.header('Access-Control-Request-Private-Network')) {
      c.res.headers.set('Access-Control-Allow-Private-Network', 'true');
    }
  });
  app.use('*', cors());

  // Optional bearer auth on the API (set ADMIN_TOKEN to enable).
  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/health' || !config.adminToken) return next();
    const auth = c.req.header('Authorization') ?? '';
    if (auth !== `Bearer ${config.adminToken}`) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return next();
  });

  app.get('/api/health', async (c) => {
    try {
      await q('SELECT 1');
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false, error: 'database unreachable' }, 503);
    }
  });

  app.get('/api/overview', async (c) => {
    const [topicCounts, articleCounts, running, usage, recent, settings] = await Promise.all([
      q<{ status: string; n: string }>('SELECT status, count(*) n FROM topics GROUP BY status'),
      q<{ stage: string; status: string; n: string }>(
        "SELECT stage, status, count(*) n FROM articles GROUP BY stage, status",
      ),
      q<{ n: string }>("SELECT count(*) n FROM agent_sessions WHERE status = 'running'"),
      q<{ cost: string; tin: string; tout: string; runs: string }>(
        `SELECT COALESCE(sum(cost_usd), 0) cost, COALESCE(sum(tokens_input), 0) tin,
                COALESCE(sum(tokens_output), 0) tout, count(*) runs
         FROM agent_sessions WHERE started_at > now() - interval '30 days'`,
      ),
      q(
        `SELECT s.id, s.agent, s.model, s.status, s.summary, s.error, s.cost_usd,
                s.tokens_input, s.tokens_output, s.started_at, s.ended_at, a.title article_title
         FROM agent_sessions s LEFT JOIN articles a ON a.id = s.article_id
         ORDER BY s.started_at DESC LIMIT 12`,
      ),
      Promise.all([
        getSetting('publish_mode', 'approval'),
        getSetting('worker_enabled', true),
      ]),
    ]);
    return c.json({
      topics: topicCounts,
      articles: articleCounts,
      runningSessions: Number(running[0]?.n ?? 0),
      usage30d: {
        costUsd: Number(usage[0]?.cost ?? 0),
        tokensInput: Number(usage[0]?.tin ?? 0),
        tokensOutput: Number(usage[0]?.tout ?? 0),
        runs: Number(usage[0]?.runs ?? 0),
      },
      recentSessions: recent,
      publishMode: settings[0],
      workerEnabled: settings[1],
    });
  });

  // ── Topics ────────────────────────────────────────────────────────────────
  app.get('/api/topics', async (c) => {
    const status = c.req.query('status');
    const rows = status
      ? await q('SELECT * FROM topics WHERE status = $1 ORDER BY created_at DESC LIMIT 200', [status])
      : await q('SELECT * FROM topics ORDER BY created_at DESC LIMIT 200');
    return c.json({ topics: rows });
  });

  // Approve one or many topics → each becomes an article queued at research.
  app.post('/api/topics/approve', async (c) => {
    const { ids } = (await c.req.json()) as { ids: string[] };
    if (!Array.isArray(ids) || ids.length === 0) return c.json({ error: 'ids required' }, 400);
    const created: unknown[] = [];
    for (const id of ids) {
      const [topic] = await q<{ id: string; title: string; category: string; post_type: string }>(
        "UPDATE topics SET status = 'approved', updated_at = now() WHERE id = $1 AND status = 'suggested' RETURNING id, title, category, post_type",
        [id],
      );
      if (!topic) continue;
      const [article] = await q(
        `INSERT INTO articles (topic_id, title, category, post_type)
         VALUES ($1, $2, $3, $4) RETURNING id, title, stage, status`,
        [topic.id, topic.title, topic.category, topic.post_type],
      );
      created.push(article);
    }
    return c.json({ created });
  });

  app.post('/api/topics/reject', async (c) => {
    const { ids } = (await c.req.json()) as { ids: string[] };
    if (!Array.isArray(ids) || ids.length === 0) return c.json({ error: 'ids required' }, 400);
    await q(
      "UPDATE topics SET status = 'rejected', updated_at = now() WHERE id = ANY($1) AND status = 'suggested'",
      [ids],
    );
    return c.json({ ok: true });
  });

  // ── Topic scout ───────────────────────────────────────────────────────────
  app.post('/api/scout', async (c) => {
    if (await isScoutRunning()) return c.json({ error: 'a scout run is already in progress' }, 409);
    const id = await startScoutRun();
    return c.json({ started: id });
  });

  app.get('/api/scout-runs', async (c) => {
    const rows = await q('SELECT * FROM scout_runs ORDER BY started_at DESC LIMIT 20');
    return c.json({ runs: rows });
  });

  // ── Articles (the pipeline board) ────────────────────────────────────────
  app.get('/api/articles', async (c) => {
    const rows = await q(
      `SELECT id, topic_id, title, slug, category, post_type, stage, status,
              revision_round, error, published_at, created_at, updated_at,
              (seo_review ->> 'score') seo_score
       FROM articles ORDER BY updated_at DESC LIMIT 200`,
    );
    return c.json({ articles: rows });
  });

  app.get('/api/articles/:id', async (c) => {
    const [article] = await q('SELECT * FROM articles WHERE id = $1', [c.req.param('id')]);
    if (!article) return c.json({ error: 'not found' }, 404);
    const sessions = await q(
      'SELECT * FROM agent_sessions WHERE article_id = $1 ORDER BY started_at ASC',
      [article.id],
    );
    return c.json({ article, sessions });
  });

  app.post('/api/articles/:id/retry', async (c) => {
    const rows = await q(
      `UPDATE articles SET status = 'queued', error = NULL, updated_at = now()
       WHERE id = $1 AND status IN ('failed', 'cancelled') RETURNING id`,
      [c.req.param('id')],
    );
    return rows.length > 0 ? c.json({ ok: true }) : c.json({ error: 'not retryable' }, 409);
  });

  app.post('/api/articles/:id/approve-publish', async (c) => {
    const rows = await q(
      `UPDATE articles SET status = 'queued', updated_at = now()
       WHERE id = $1 AND stage = 'publish' AND status = 'waiting_approval' RETURNING id`,
      [c.req.param('id')],
    );
    return rows.length > 0 ? c.json({ ok: true }) : c.json({ error: 'not awaiting approval' }, 409);
  });

  app.post('/api/articles/:id/cancel', async (c) => {
    const rows = await q(
      `UPDATE articles SET status = 'cancelled', updated_at = now()
       WHERE id = $1 AND status IN ('queued', 'failed', 'waiting_approval') RETURNING id`,
      [c.req.param('id')],
    );
    return rows.length > 0 ? c.json({ ok: true }) : c.json({ error: 'not cancellable' }, 409);
  });

  // ── Sessions & usage ─────────────────────────────────────────────────────
  app.get('/api/sessions', async (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);
    const rows = await q(
      `SELECT s.*, a.title article_title, a.slug article_slug
       FROM agent_sessions s LEFT JOIN articles a ON a.id = s.article_id
       ORDER BY s.started_at DESC LIMIT $1`,
      [limit],
    );
    return c.json({ sessions: rows });
  });

  app.get('/api/usage', async (c) => {
    const [byAgent, byModel, daily] = await Promise.all([
      q(
        `SELECT agent, count(*) runs, COALESCE(sum(tokens_input), 0) tokens_input,
                COALESCE(sum(tokens_output), 0) tokens_output, COALESCE(sum(cost_usd), 0) cost_usd
         FROM agent_sessions GROUP BY agent ORDER BY cost_usd DESC`,
      ),
      q(
        `SELECT COALESCE(model, 'unknown') model, count(*) runs,
                COALESCE(sum(tokens_input), 0) tokens_input,
                COALESCE(sum(tokens_output), 0) tokens_output, COALESCE(sum(cost_usd), 0) cost_usd
         FROM agent_sessions GROUP BY model ORDER BY cost_usd DESC`,
      ),
      q(
        `SELECT date_trunc('day', started_at)::date day, count(*) runs,
                COALESCE(sum(cost_usd), 0) cost_usd
         FROM agent_sessions WHERE started_at > now() - interval '30 days'
         GROUP BY day ORDER BY day DESC`,
      ),
    ]);
    return c.json({ byAgent, byModel, daily });
  });

  // ── Settings ─────────────────────────────────────────────────────────────
  app.get('/api/settings', async (c) => {
    const rows = await q<{ key: string; value: unknown }>('SELECT key, value FROM settings');
    return c.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
  });

  app.put('/api/settings', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const allowed = [
      'models',
      'publish_mode',
      'max_revision_rounds',
      'worker_enabled',
      'llm',
      'scout_interval_hours',
    ];
    for (const key of allowed) {
      if (!(key in body)) continue;
      if (key === 'publish_mode' && !['approval', 'auto', 'draft'].includes(String(body[key]))) {
        return c.json({ error: 'publish_mode must be approval | auto | draft' }, 400);
      }
      await setSetting(key, body[key]);
    }
    const rows = await q<{ key: string; value: unknown }>('SELECT key, value FROM settings');
    return c.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
  });

  // ── Admin SPA (built apps/admin) ─────────────────────────────────────────
  const staticRoot = relative(process.cwd(), ADMIN_DIST) || '.';
  app.use('/assets/*', serveStatic({ root: staticRoot }));
  app.get('*', (c) => {
    try {
      return c.html(readFileSync(resolve(ADMIN_DIST, 'index.html'), 'utf8'));
    } catch {
      return c.text(
        'Admin UI not built yet. Run: pnpm --filter @sleekdrops/admin build (or use pnpm dev:admin for the dev server).',
        200,
      );
    }
  });

  return app;
}

export function startServer(): void {
  const app = createApp();
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`[api] admin API + panel on http://localhost:${info.port}`);
  });
}
