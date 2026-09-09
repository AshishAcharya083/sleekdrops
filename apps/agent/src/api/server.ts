// Admin API — everything the admin panel (apps/admin) needs to observe and
// steer the pipeline. Also serves the built admin SPA in production.
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { config } from '../config.js';
import { CATEGORIES, POST_TYPES, slugify } from '../content/contract.js';
import { getSetting, q, setSetting } from '../db/pool.js';
import { createLogger, runWithTrace } from '../lib/log.js';
import { clearLlmSettingsCache, engineStatus } from '../llm/index.js';
import { isScoutRunning, startScoutRun } from '../pipeline/scout.js';
import type { ReferenceMaterial } from '../pipeline/types.js';
import { deleteD1Post, getD1PostHero, listD1Posts, setD1PostHero } from '../tools/d1.js';
import { gcsConfigured } from '../tools/gcs.js';
import { dispatchContentUpdated } from '../tools/github.js';
import {
  MAX_HERO_IMAGE_BYTES,
  readHeroImageUpload,
  storeHeroImage,
  type HeroImageUpload,
} from '../tools/heroImages.js';
import { TRACE_HEADER, traceMiddleware, type TraceEnv } from './trace.js';

const log = createLogger('api');

/** Reference-material limits - mirror the admin upload guard (multiple .md,
 *  up to 5 files, 2 MB each) so the API is safe even without the UI. */
const MAX_REFERENCES = 5;
const MAX_REFERENCE_BYTES = 2 * 1024 * 1024;

type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

/** What an approval reads off the topic to seed the article it creates. */
interface ApprovedTopic {
  id: string;
  title: string;
  category: string;
  post_type: string;
  hero_image_url: string | null;
  hero_alt: string | null;
}

function validateReferences(input: unknown): Validated<ReferenceMaterial[]> {
  if (input === undefined || input === null) return { ok: true, value: [] };
  if (!Array.isArray(input)) return { ok: false, error: 'references must be an array' };
  if (input.length > MAX_REFERENCES) {
    return { ok: false, error: `at most ${MAX_REFERENCES} reference materials allowed` };
  }
  const value: ReferenceMaterial[] = [];
  for (const raw of input) {
    if (typeof raw !== 'object' || raw === null) {
      return { ok: false, error: 'each reference must be an object' };
    }
    const { name, content } = raw as { name?: unknown; content?: unknown };
    if (typeof content !== 'string' || content.trim() === '') {
      return { ok: false, error: 'each reference needs non-empty markdown content' };
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_REFERENCE_BYTES) {
      return { ok: false, error: 'each reference must be 2 MB or smaller' };
    }
    const safeName =
      typeof name === 'string' && name.trim() ? name.trim().slice(0, 200) : `reference-${value.length + 1}.md`;
    value.push({ name: safeName, content });
  }
  return { ok: true, value };
}

/** Alt text is a caption, not prose - the site falls back to the title anyway. */
const MAX_ALT_CHARS = 300;

/** Room for the multipart envelope on top of the image itself. */
const MULTIPART_OVERHEAD = 64 * 1024;

const NO_IMAGE_STORAGE =
  'hero-image storage is not configured - set GCS_IMAGES_BUCKET on the agent platform';

interface HeroImageBody {
  /** Absent when the request is an alt-text-only edit. */
  upload: HeroImageUpload | null;
  alt: string | null;
}

type HeroImageParse =
  | { ok: true; value: HeroImageBody }
  | { ok: false; error: string; status: 400 | 413 };

/**
 * Read a hero-image drop off a multipart request: the `file` part (vetted for
 * format, magic bytes and size) plus an optional `alt` part. The file is
 * optional so the same route also carries an alt-text-only edit.
 */
async function readHeroImageBody(c: Context<TraceEnv>): Promise<HeroImageParse> {
  const limitMb = MAX_HERO_IMAGE_BYTES / 1024 / 1024;
  // Bound the read before it happens - parseBody() buffers the whole body.
  if (Number(c.req.header('Content-Length') ?? 0) > MAX_HERO_IMAGE_BYTES + MULTIPART_OVERHEAD) {
    return { ok: false, status: 413, error: `image too large - the limit is ${limitMb} MB` };
  }

  let body: Awaited<ReturnType<typeof c.req.parseBody>>;
  try {
    body = await c.req.parseBody();
  } catch {
    return { ok: false, status: 400, error: 'expected a multipart/form-data body' };
  }

  const alt = typeof body.alt === 'string' ? body.alt.trim().slice(0, MAX_ALT_CHARS) : '';
  const file = body.file;
  if (file === undefined || file === null || file === '') {
    return { ok: true, value: { upload: null, alt: alt || null } };
  }
  if (typeof file === 'string' || Array.isArray(file)) {
    return { ok: false, status: 400, error: 'the "file" part must be a single uploaded file' };
  }

  const checked = readHeroImageUpload(file.type, Buffer.from(await file.arrayBuffer()));
  if (!checked.ok) return { ok: false, status: 400, error: checked.error };
  return { ok: true, value: { upload: checked.value, alt: alt || null } };
}

/**
 * Mirror a live post's new hero onto the pipeline article that wrote it, when
 * there is one. Without this, re-publishing that article (or one more editor
 * pass) would quietly restore the image the operator just replaced.
 */
async function syncArticleHero(
  slug: string,
  heroImage: string | null,
  heroAlt: string | null,
): Promise<void> {
  const patch = heroImage
    ? JSON.stringify({ heroImage, ...(heroAlt ? { heroAlt } : {}) })
    : null;
  await q(
    `UPDATE articles
        SET hero_image_url = $2,
            hero_alt       = $3,
            frontmatter    = CASE
                               WHEN frontmatter IS NULL THEN NULL
                               WHEN $4::jsonb IS NULL THEN frontmatter - 'heroImage' - 'heroAlt'
                               ELSE (frontmatter - 'heroAlt') || $4::jsonb
                             END,
            updated_at     = now()
      WHERE slug = $1`,
    [slug, heroImage, heroAlt, patch],
  );
}

/**
 * Ask GitHub to rebuild the site. The D1 write has already happened by the time
 * this runs, so a failed dispatch is reported rather than thrown - the operator
 * needs to know the change is saved but not yet live.
 */
async function requestRebuild(): Promise<{
  body: { dispatched: boolean; dispatchError: string | null };
  logged: { dispatched: boolean };
}> {
  try {
    await dispatchContentUpdated();
    return { body: { dispatched: true, dispatchError: null }, logged: { dispatched: true } };
  } catch (err) {
    return {
      body: { dispatched: false, dispatchError: err instanceof Error ? err.message : String(err) },
      logged: { dispatched: false },
    };
  }
}

const ADMIN_DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../../../admin/dist');

export function createApp(): Hono<TraceEnv> {
  const app = new Hono<TraceEnv>();
  // Chrome's Local Network Access: the Pages-hosted admin (https) calling a
  // localhost agent API needs this header on the CORS preflight response.
  app.use('*', async (c, next) => {
    await next();
    if (c.req.header('Access-Control-Request-Private-Network')) {
      c.res.headers.set('Access-Control-Allow-Private-Network', 'true');
    }
  });
  // Explicit CORS: X-Trace-Id has to survive the preflight from the Cloudflare
  // Pages origin, and the browser has to be allowed to read the echoed id back.
  app.use(
    '*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', TRACE_HEADER],
      exposeHeaders: [TRACE_HEADER],
      maxAge: 86_400,
    }),
  );

  // Trace correlation: adopt (or mint) the panel's X-Trace-Id before anything
  // else on /api/*, so even a 401 is logged under the caller's id.
  app.use('/api/*', traceMiddleware());

  app.onError((err, c) => {
    const traceId = c.get('traceId') ?? '';
    runWithTrace(traceId, () =>
      log.error('unhandled route error', {
        method: c.req.method,
        path: c.req.path,
        error: err.message,
        stack: err.stack,
      }),
    );
    // Same { error } shape apps/admin/src/api.ts already reads, plus the trace
    // id so the panel can point its own error report at these log lines. The
    // message stays generic - the detail is in the log line, not the response.
    return c.json({ error: 'internal server error', traceId }, 500, { [TRACE_HEADER]: traceId });
  });

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
      const [topic] = await q<ApprovedTopic>(
        `UPDATE topics SET status = 'approved', updated_at = now()
         WHERE id = $1 AND status = 'suggested'
         RETURNING id, title, category, post_type, hero_image_url, hero_alt`,
        [id],
      );
      if (!topic) continue;
      const [article] = await q<{ id: string }>(
        `INSERT INTO articles (topic_id, title, category, post_type, hero_image_url, hero_alt)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, title, stage, status`,
        [topic.id, topic.title, topic.category, topic.post_type, topic.hero_image_url, topic.hero_alt],
      );
      // Pipeline work is picked up later by the worker's database poll, so the
      // entity ids logged here are what join those [pipeline] lines back to
      // this request's trace id.
      log.info('article queued from topic approval', { topic_id: topic.id, article_id: article.id });
      created.push(article);
    }
    return c.json({ created });
  });

  // Manual operator topic: hand-written topic + instructions + markdown
  // references, stored as a draft with NO article row (the staged-review guard -
  // approval is a separate, explicit step). Passing an `id` edits an existing
  // draft in place instead of creating a new one.
  app.post('/api/topics/manual', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      id?: string;
      title?: string;
      instructions?: string;
      category?: string;
      post_type?: string;
      hero_alt?: string;
      references?: unknown;
    } | null;
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);

    const title = body.title?.trim();
    if (!title) return c.json({ error: 'title is required' }, 400);
    const normTitle = slugify(title);
    if (!normTitle) return c.json({ error: 'title must contain letters or numbers' }, 400);

    const category = body.category?.trim() || CATEGORIES[0];
    if (!(CATEGORIES as readonly string[]).includes(category)) {
      return c.json({ error: `category must be one of: ${CATEGORIES.join(', ')}` }, 400);
    }
    const postType = body.post_type?.trim() || 'article';
    if (!(POST_TYPES as readonly string[]).includes(postType)) {
      return c.json({ error: `post_type must be one of: ${POST_TYPES.join(', ')}` }, 400);
    }

    const refs = validateReferences(body.references);
    if (!refs.ok) return c.json({ error: refs.error }, 400);

    const instructions = body.instructions?.trim() || null;
    const notes = JSON.stringify(refs.value);
    // The hero image itself is uploaded separately (it needs a row to hang
    // off); its alt text rides along with the rest of the brief so editing it
    // never means re-uploading the file.
    const heroAlt = body.hero_alt?.trim().slice(0, MAX_ALT_CHARS) || null;

    try {
      if (body.id) {
        const [updated] = await q(
          `UPDATE topics
             SET title = $2, norm_title = $3, category = $4, post_type = $5,
                 instructions = $6, research_notes = $7::jsonb, hero_alt = $8, updated_at = now()
           WHERE id = $1 AND source = 'manual' AND status = 'draft'
           RETURNING *`,
          [body.id, title, normTitle, category, postType, instructions, notes, heroAlt],
        );
        if (!updated) return c.json({ error: 'draft topic not found' }, 404);
        return c.json({ topic: updated });
      }
      const [topic] = await q(
        `INSERT INTO topics
           (title, norm_title, category, post_type, source, status, instructions,
            research_notes, hero_alt)
         VALUES ($1, $2, $3, $4, 'manual', 'draft', $5, $6::jsonb, $7)
         RETURNING *`,
        [title, normTitle, category, postType, instructions, notes, heroAlt],
      );
      return c.json({ topic }, 201);
    } catch (err) {
      if (err instanceof Error && /duplicate key|unique/i.test(err.message)) {
        return c.json({ error: 'a topic with a similar title already exists' }, 409);
      }
      throw err;
    }
  });

  // Approve a single draft manual topic → create its article at stage=research.
  // The costly generation run only ever fires here, never on topic capture.
  app.post('/api/topics/:id/approve', async (c) => {
    const [topic] = await q<ApprovedTopic>(
      `UPDATE topics SET status = 'approved', updated_at = now()
       WHERE id = $1 AND status = 'draft'
       RETURNING id, title, category, post_type, hero_image_url, hero_alt`,
      [c.req.param('id')],
    );
    if (!topic) return c.json({ error: 'draft topic not found or already approved' }, 409);
    const [article] = await q<{ id: string }>(
      `INSERT INTO articles (topic_id, title, category, post_type, hero_image_url, hero_alt)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, title, stage, status`,
      [topic.id, topic.title, topic.category, topic.post_type, topic.hero_image_url, topic.hero_alt],
    );
    log.info('article queued from manual topic approval', {
      topic_id: topic.id,
      article_id: article.id,
    });
    return c.json({ article });
  });

  // Hero image for a draft manual topic - the operator drops the photo while
  // briefing the piece, and approval copies it onto the article. Alt text is
  // part of the brief payload above, not of this upload.
  app.post('/api/topics/:id/hero-image', async (c) => {
    const parsed = await readHeroImageBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    if (!parsed.value.upload) return c.json({ error: 'expected an image in the "file" part' }, 400);
    if (!gcsConfigured()) return c.json({ error: NO_IMAGE_STORAGE }, 503);

    const id = c.req.param('id');
    const [topic] = await q<{ id: string }>(
      "SELECT id FROM topics WHERE id = $1 AND source = 'manual' AND status = 'draft'",
      [id],
    );
    if (!topic) return c.json({ error: 'draft topic not found' }, 404);

    const url = await storeHeroImage('topic', id, parsed.value.upload);
    const [updated] = await q(
      'UPDATE topics SET hero_image_url = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [id, url],
    );
    log.info('hero image attached to topic', { topic_id: id });
    return c.json({ topic: updated });
  });

  app.delete('/api/topics/:id/hero-image', async (c) => {
    const [updated] = await q<{ id: string }>(
      `UPDATE topics SET hero_image_url = NULL, hero_alt = NULL, updated_at = now()
       WHERE id = $1 AND source = 'manual' AND status = 'draft'
       RETURNING id`,
      [c.req.param('id')],
    );
    if (!updated) return c.json({ error: 'draft topic not found' }, 404);
    return c.json({ ok: true });
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
    log.info('scout run started', { scout_run_id: id });
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
              hero_image_url, (seo_review ->> 'score') seo_score
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
    if (rows.length === 0) return c.json({ error: 'not retryable' }, 409);
    log.info('article re-queued for retry', { article_id: rows[0].id });
    return c.json({ ok: true });
  });

  app.post('/api/articles/:id/approve-publish', async (c) => {
    const rows = await q(
      `UPDATE articles SET status = 'queued', updated_at = now()
       WHERE id = $1 AND stage = 'publish' AND status = 'waiting_approval' RETURNING id`,
      [c.req.param('id')],
    );
    if (rows.length === 0) return c.json({ error: 'not awaiting approval' }, 409);
    log.info('article publish approved', { article_id: rows[0].id });
    return c.json({ ok: true });
  });

  app.post('/api/articles/:id/cancel', async (c) => {
    const rows = await q(
      `UPDATE articles SET status = 'cancelled', updated_at = now()
       WHERE id = $1 AND status IN ('queued', 'failed', 'waiting_approval') RETURNING id`,
      [c.req.param('id')],
    );
    return rows.length > 0 ? c.json({ ok: true }) : c.json({ error: 'not cancellable' }, 409);
  });

  // Admin feedback → one editor pass. Requires a draft to edit; works on done
  // (published) articles too — the piece re-runs edit → seo_review → assemble
  // → image → publish, upserting the same D1 slug.
  app.post('/api/articles/:id/feedback', async (c) => {
    const { feedback } = (await c.req.json()) as { feedback?: string };
    if (!feedback?.trim()) return c.json({ error: 'feedback required' }, 400);
    const rows = await q(
      `UPDATE articles
       SET feedback = $2, stage = 'edit', status = 'queued', error = NULL, updated_at = now()
       WHERE id = $1 AND status <> 'running' AND draft_md IS NOT NULL
       RETURNING id`,
      [c.req.param('id'), feedback.trim()],
    );
    if (rows.length === 0) {
      return c.json({ error: 'article has no draft yet or is currently running' }, 409);
    }
    log.info('article re-queued for an editor pass', { article_id: rows[0].id });
    return c.json({ ok: true });
  });

  // ── Hero image (operator drop) ───────────────────────────────────────────
  // The image agent can't always find a photo worth publishing, so the panel
  // lets an operator attach one by hand at any point before (or after) the
  // publish. It lands in its own column as well as in frontmatter, so a
  // re-assembly can't lose it and the image stage knows to stand down.
  //
  // The file part is optional: posting alt text alone re-labels the image
  // that is already attached.
  app.post('/api/articles/:id/hero-image', async (c) => {
    const parsed = await readHeroImageBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    if (parsed.value.upload && !gcsConfigured()) {
      return c.json({ error: NO_IMAGE_STORAGE }, 503);
    }

    const id = c.req.param('id');
    const [article] = await q<{ id: string; status: string; hero_image_url: string | null }>(
      'SELECT id, status, hero_image_url FROM articles WHERE id = $1',
      [id],
    );
    if (!article) return c.json({ error: 'article not found' }, 404);
    if (article.status === 'running') {
      return c.json({ error: 'the article is mid-stage - try again when it finishes' }, 409);
    }

    const url = parsed.value.upload
      ? await storeHeroImage('article', id, parsed.value.upload)
      : article.hero_image_url;
    if (!url) return c.json({ error: 'attach an image file first' }, 400);

    const { alt } = parsed.value;
    // One statement, so a stage that starts mid-request can't have its own
    // frontmatter write clobbered by a stale read-modify-write here. heroAlt is
    // dropped before the merge because a JSON null would fail the site's
    // frontmatter schema, where the key is optional-but-string.
    const [updated] = await q(
      `UPDATE articles
          SET hero_image_url = $2,
              hero_alt       = $3,
              frontmatter    = CASE WHEN frontmatter IS NULL THEN NULL
                                    ELSE (frontmatter - 'heroAlt') || $4::jsonb END,
              updated_at     = now()
        WHERE id = $1 AND status <> 'running'
        RETURNING id, hero_image_url, hero_alt, stage, status, published_at`,
      [id, url, alt, JSON.stringify({ heroImage: url, ...(alt ? { heroAlt: alt } : {}) })],
    );
    if (!updated) {
      return c.json({ error: 'the article just started running - try again when it finishes' }, 409);
    }
    log.info('hero image set on article', {
      article_id: id,
      action: parsed.value.upload ? 'upload' : 'alt_only',
    });
    return c.json({ article: updated });
  });

  // Detach: the piece falls back to whatever the image agent finds on its next
  // pass, or to the generated cover fill.
  app.delete('/api/articles/:id/hero-image', async (c) => {
    const [updated] = await q<{ id: string }>(
      `UPDATE articles
          SET hero_image_url = NULL,
              hero_alt       = NULL,
              frontmatter    = CASE WHEN frontmatter IS NULL THEN NULL
                                    ELSE frontmatter - 'heroImage' - 'heroAlt' END,
              updated_at     = now()
        WHERE id = $1 AND status <> 'running'
        RETURNING id`,
      [c.req.param('id')],
    );
    if (!updated) return c.json({ error: 'article not found, or mid-stage' }, 409);
    log.info('hero image removed from article', { article_id: c.req.param('id') });
    return c.json({ ok: true });
  });

  // Re-run the publish stage for an already-published article. It is
  // deterministic and LLM-free, so this is the cheap way to push a hero image
  // dropped after publication out to the live site (unlike the feedback loop,
  // which pays for an editor pass).
  app.post('/api/articles/:id/republish', async (c) => {
    const rows = await q<{ id: string }>(
      `UPDATE articles SET stage = 'publish', status = 'queued', error = NULL, updated_at = now()
       WHERE id = $1 AND stage = 'done' AND status = 'done'
         AND slug IS NOT NULL AND draft_md IS NOT NULL AND frontmatter IS NOT NULL
       RETURNING id`,
      [c.req.param('id')],
    );
    if (rows.length === 0) {
      return c.json({ error: 'only a finished, published article can be republished' }, 409);
    }
    log.info('article re-queued for publish', { article_id: rows[0].id });
    return c.json({ ok: true });
  });

  // ── Published site content (Cloudflare D1 — what the website builds from) ─
  app.get('/api/published', async (c) => {
    const posts = await listD1Posts();
    return c.json({ posts });
  });

  // Hero image on a post that is already live. The pipeline only knows about
  // articles it wrote itself; most of what is on the site predates it and has
  // no articles row at all, so this route edits the published D1 row directly -
  // it is the only way to re-image an older post. When a pipeline article does
  // exist for the slug, its copy is updated too, so a later re-publish can't
  // push the old image back over this one.
  //
  // As with the article route, the file part is optional: alt text on its own
  // re-labels the hero already there.
  app.post('/api/published/:slug/hero-image', async (c) => {
    const parsed = await readHeroImageBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    if (parsed.value.upload && !gcsConfigured()) return c.json({ error: NO_IMAGE_STORAGE }, 503);

    const slug = c.req.param('slug');
    const current = await getD1PostHero(slug);
    if (!current) return c.json({ error: 'no live post with that slug' }, 404);

    const heroImage = parsed.value.upload
      ? await storeHeroImage('post', slug, parsed.value.upload)
      : current.heroImage;
    if (!heroImage) return c.json({ error: 'attach an image file first' }, 400);
    const heroAlt = parsed.value.alt;

    await setD1PostHero(slug, { heroImage, heroAlt });
    await syncArticleHero(slug, heroImage, heroAlt);
    const rebuild = await requestRebuild();
    log.info('hero image set on a live post', {
      slug,
      action: parsed.value.upload ? 'upload' : 'alt_only',
      ...rebuild.logged,
    });
    return c.json({ post: { slug, hero_image: heroImage, hero_alt: heroAlt }, ...rebuild.body });
  });

  app.delete('/api/published/:slug/hero-image', async (c) => {
    const slug = c.req.param('slug');
    const removed = await setD1PostHero(slug, { heroImage: null, heroAlt: null });
    if (!removed) return c.json({ error: 'no live post with that slug' }, 404);
    await syncArticleHero(slug, null, null);
    const rebuild = await requestRebuild();
    log.info('hero image removed from a live post', { slug, ...rebuild.logged });
    return c.json({ ok: true, ...rebuild.body });
  });

  app.delete('/api/published/:slug', async (c) => {
    const result = await deleteD1Post(c.req.param('slug'));
    if (!result) return c.json({ error: 'not found' }, 404);
    // Rebuild so the site actually drops the page; deletion already succeeded,
    // so a dispatch failure is reported, not thrown.
    let dispatched = false;
    let dispatchError: string | null = null;
    try {
      await dispatchContentUpdated();
      dispatched = true;
    } catch (err) {
      dispatchError = err instanceof Error ? err.message : String(err);
    }
    return c.json({ ok: true, removedLinks: result.removedLinks, dispatched, dispatchError });
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
        `SELECT date_trunc('day', started_at)::date AS day, count(*) runs,
                COALESCE(sum(cost_usd), 0) cost_usd
         FROM agent_sessions WHERE started_at > now() - interval '30 days'
         GROUP BY day ORDER BY day DESC`,
      ),
    ]);
    return c.json({ byAgent, byModel, daily });
  });

  // ── Settings ─────────────────────────────────────────────────────────────
  // `engines` is derived, not stored: whether each engine actually has a
  // credential and where it came from (never the value). The panel needs it to
  // warn that the selected engine cannot run — the failure that used to show
  // up only as an unexplained gemini-2.5-flash in the Sessions table.
  app.get('/api/settings', async (c) => {
    const [rows, engines] = await Promise.all([
      q<{ key: string; value: unknown }>('SELECT key, value FROM settings'),
      engineStatus(),
    ]);
    return c.json({ ...Object.fromEntries(rows.map((r) => [r.key, r.value])), engines });
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
    clearLlmSettingsCache();
    // Same shape as the GET: saving a token must refresh the readiness the
    // panel just warned about, without a reload.
    const [rows, engines] = await Promise.all([
      q<{ key: string; value: unknown }>('SELECT key, value FROM settings'),
      engineStatus(),
    ]);
    return c.json({ ...Object.fromEntries(rows.map((r) => [r.key, r.value])), engines });
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
    log.info('admin API + panel listening', { url: `http://localhost:${info.port}` });
  });
}
