// The corpus audit: the sweep, its lock, and the ranked report the admin panel
// reads off it.
//
// Fixing the pipeline fixes nothing already on the site, so the operator's
// question after an AdSense rejection is "which of the pages I already have
// are the worst". Answering it is a background sweep over D1, which means it
// is also a lock, a run row and an HTTP contract - none of which is provable
// in memory. Postgres is real here, the model is deliberately unreachable (a
// reviewer pass that cannot run is a first-class outcome, not a broken audit),
// and D1 is stubbed at its REST boundary.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
process.env.D1_DATABASE_ID = 'test-database';
process.env.CLOUDFLARE_D1_TOKEN = 'test-d1-token';
// Before config.js loads: the audit must never reach a live model from here.
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { getSetting, pool, q } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { UsageTracker } = await import('../llm/index.js');
const {
  auditPublishedCorpus,
  heldCorpusAuditLock,
  latestCorpusAudit,
  recoverStaleCorpusAudits,
  renewCorpusAuditLease,
} = await import('./corpusAudit.js');
const { recoverStranded } = await import('./worker.js');
const { createApp } = await import('../api/server.js');

import type { CorpusAuditReport } from '../content/audit.js';

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

if (reachable) await migrate();

/** A Claude token in the database would make these tests call a live model. */
const credentialled =
  reachable && (await getSetting<{ claude_token?: string }>('llm', {})).claude_token;
const offlineSkip = credentialled
  ? 'the database carries a Claude token - these tests must not reach a live model'
  : skip;

const app = createApp();
const AUTH = { Authorization: 'Bearer test-admin-token' };

const created: string[] = [];
const realFetch = globalThis.fetch;

after(async () => {
  globalThis.fetch = realFetch;
  if (reachable) {
    await q('DELETE FROM agent_sessions WHERE corpus_audit_id = ANY($1)', [created]);
    await q('DELETE FROM corpus_audits WHERE id = ANY($1)', [created]);
  }
  await pool.end();
});

/** A page whose every tell the scanner knows by name. */
const SLOPPY = [
  '## What to know',
  '',
  'In this comprehensive guide we delve into the robust, cutting-edge landscape of stick vacuums.',
  'Moreover, these seamless machines leverage state-of-the-art suction to elevate your cleaning.',
  'Furthermore, the myriad of options can feel overwhelming, but we utilise expert analysis.',
  'Additionally, this showcases a pivotal shift that is truly a game-changer for every home.',
  '',
  '## Our picks',
  '',
  'Each model showcases seamless performance and robust build quality across the board.',
  'Moreover, every option here delivers, so you simply cannot go wrong whichever you pick.',
].join('\n');

/** A page written the way the rules ask for: named sources, figures, dates. */
const CLEAN = [
  '## Which speaker holds up outdoors',
  '',
  'Choice tested 18 portable speakers in March 2026 and found the Sony XB100 held IP67 sealing',
  'after 30 immersion cycles, while two rivals failed at 11. JB Hi-Fi listed it at $98 on 3 March 2026.',
  '',
  '## Where it falls down',
  '',
  'Of 412 ProductReview.com.au reviews, 37 report the charging port failing inside nine months.',
  'Skip it if you want stereo pairing: the firmware drops the second speaker above 8 metres.',
].join('\n');

const POSTS = [
  { slug: 'cordless-stick-vacuums', title: 'Best cordless stick vacuums', body_md: SLOPPY, pub_date: '2026-01-04' },
  { slug: 'waterproof-bluetooth-speakers', title: 'Best portable waterproof Bluetooth speakers', body_md: CLEAN, pub_date: '2026-02-08' },
];

/** Answer the corpus read; anything else is a statement this sweep should not make. */
function stubD1(posts: typeof POSTS): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.ok(String(input).includes('api.cloudflare.com'), 'only D1 is stubbed here');
    const { sql } = JSON.parse(String(init?.body)) as { sql: string };
    assert.match(sql, /FROM posts/, `unexpected D1 statement: ${sql}`);
    return Response.json({ success: true, result: [{ results: posts }] });
  }) as typeof fetch;
}

/** A run whose last heartbeat was `minutesAgo` minutes ago. */
async function seedRunningAudit(minutesAgo: number): Promise<string> {
  const [run] = await q<{ id: string }>(
    `INSERT INTO corpus_audits (status, started_at, heartbeat_at)
     VALUES ('running', now() - make_interval(mins => $1), now() - make_interval(mins => $1))
     RETURNING id`,
    [minutesAgo],
  );
  created.push(run.id);
  await q(
    `INSERT INTO agent_sessions (corpus_audit_id, agent, started_at)
     VALUES ($1, 'corpus_auditor', now() - make_interval(mins => $2))`,
    [run.id, minutesAgo],
  );
  return run.id;
}

const postAudit = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await app.fetch(
    new Request('http://localhost/api/corpus-audit', { method: 'POST', headers: AUTH }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

interface AuditBody {
  audit: {
    id: string;
    status: string;
    articles_scanned: number;
    report: CorpusAuditReport | null;
    error: string | null;
  } | null;
  lock: { id: string } | null;
}

const getAudit = async (): Promise<AuditBody> => {
  const res = await app.fetch(new Request('http://localhost/api/corpus-audit', { headers: AUTH }));
  assert.equal(res.status, 200);
  return (await res.json()) as AuditBody;
};

const statusOf = async (id: string): Promise<{ status: string; error: string | null }> => {
  const [row] = await q<{ status: string; error: string | null }>(
    'SELECT status, error FROM corpus_audits WHERE id = $1',
    [id],
  );
  return row;
};

test('the sweep scores every published page and ranks the worst first', { skip: offlineSkip }, async () => {
  stubD1(POSTS);
  const report = await auditPublishedCorpus('claude-opus-5', new UsageTracker());

  assert.equal(report.scanned, 2);
  assert.deepEqual(
    report.articles.map((a) => a.slug),
    ['cordless-stick-vacuums', 'waterproof-bluetooth-speakers'],
    'the page written in AI vocabulary ranks below the one with named sources in it',
  );
  const [worst] = report.articles;
  assert.ok(worst.scanScore < 70, 'the flagged page is below the scanner pass mark');
  assert.equal(worst.band, 'requalify');
  assert.deepEqual(report.requalify, ['cordless-stick-vacuums']);
  assert.ok(
    worst.worstRules.some((rule) => /delve/.test(rule.rule)),
    'the report names what cost the page, not only how much',
  );

  // The model is deliberately unreachable. A page the reviewer could not grade
  // is still ranked on its scan, because "the model timed out" is not evidence
  // that the page is fine.
  for (const article of report.articles) {
    assert.equal(article.review, null);
    assert.match(String(article.reviewError), /not configured/i);
  }
});

test('the sweep reports progress while it runs', { skip: offlineSkip }, async () => {
  stubD1(POSTS);
  const seen: Array<[number, number]> = [];
  await auditPublishedCorpus('claude-opus-5', new UsageTracker(), (done, total) =>
    seen.push([done, total]),
  );
  // The panel polls the run row, and "auditing..." with no number is
  // indistinguishable from a sweep that has hung.
  assert.deepEqual(seen, [
    [1, 2],
    [2, 2],
  ]);
});

test('a page with an empty body is not audited as a perfect one', { skip: offlineSkip }, async () => {
  stubD1([...POSTS, { slug: 'empty', title: 'Empty', body_md: '   ', pub_date: '2026-03-01' }]);
  const report = await auditPublishedCorpus('claude-opus-5', new UsageTracker());
  assert.equal(report.scanned, 2);
  assert.equal(
    report.articles.some((a) => a.slug === 'empty'),
    false,
  );
});

test('a fresh run holds the lock and the refusal names it', { skip }, async () => {
  const id = await seedRunningAudit(0);

  const { lock } = await getAudit();
  assert.equal(lock?.id, id);

  const { status, body } = await postAudit();
  assert.equal(status, 409);
  const message = String(body.error);
  assert.ok(message.includes(id), 'the refusal names the run holding the lock');
  assert.match(message, /\d+[smh].*ago/, 'and how long it has held it');
  assert.equal((body.lock as { id: string }).id, id);

  await q("UPDATE corpus_audits SET status = 'failed', ended_at = now() WHERE id = $1", [id]);
});

test('a run whose lease expired holds nothing, and the sweep retires it', { skip }, async () => {
  const stale = await seedRunningAudit(31);
  assert.equal(await heldCorpusAuditLock(), null, 'a dead run is not the lock holder');

  // recoverStranded() is the boot-time pass; it releases audit locks alongside
  // the stranded articles and scout runs it re-queues.
  await recoverStranded();

  const swept = await statusOf(stale);
  assert.equal(swept.status, 'failed');
  assert.equal(swept.error, 'process restarted mid-run');
  const [session] = await q<{ status: string }>(
    'SELECT status FROM agent_sessions WHERE corpus_audit_id = $1',
    [stale],
  );
  assert.equal(session.status, 'failed', 'the sweep leaves no phantom session running');

  assert.equal(await renewCorpusAuditLease(stale), false, 'a swept run cannot heartbeat back in');
});

test('a live run renews its own lease', { skip }, async () => {
  const id = await seedRunningAudit(31);
  assert.equal(await heldCorpusAuditLock(), null);

  assert.equal(await renewCorpusAuditLease(id), true);
  assert.equal((await heldCorpusAuditLock())?.id, id, 'and holds the lock again');

  await q("UPDATE corpus_audits SET status = 'failed', ended_at = now() WHERE id = $1", [id]);
});

test('a started sweep ends itself and gives the lock back', { skip: offlineSkip }, async () => {
  stubD1(POSTS);
  const { status, body } = await postAudit();
  assert.equal(status, 200);
  const id = String(body.started);
  created.push(id);

  await waitForTerminal(id);
  assert.equal(await heldCorpusAuditLock(), null, 'the next sweep is not blocked by this one');

  // No Claude credential: the run cannot resolve its model, and says so where
  // an operator will read it rather than sitting on 'running' forever.
  const finished = await statusOf(id);
  assert.equal(finished.status, 'failed');
  assert.match(String(finished.error), /not configured/i);
  const [session] = await q<{ status: string; agent: string }>(
    'SELECT status, agent FROM agent_sessions WHERE corpus_audit_id = $1',
    [id],
  );
  assert.equal(session.agent, 'corpus_auditor', 'the sweep accounts for its own spend');
  assert.equal(session.status, 'failed');

  const seen = await getAudit();
  assert.equal(seen.audit?.id, id, 'the panel reads the latest run whatever state it ended in');
  assert.equal(seen.lock, null);
});

test('a finished report is what the panel reads back', { skip }, async () => {
  const report = {
    generatedAt: '2026-09-17T00:00:00.000Z',
    scanned: 1,
    articles: [],
    bands: { requalify: 1, review: 0, ok: 0 },
    requalify: ['beef-tallow-skincare'],
    summary: '1 published article(s) scored: 1 to requalify, 0 worth a read, 0 holding up.',
  };
  const [run] = await q<{ id: string }>(
    `INSERT INTO corpus_audits (status, articles_scanned, report, ended_at)
     VALUES ('done', 1, $1::jsonb, now()) RETURNING id`,
    [JSON.stringify(report)],
  );
  created.push(run.id);

  const { audit } = await getAudit();
  assert.equal(audit?.id, run.id);
  assert.equal(audit.status, 'done');
  assert.equal(audit.articles_scanned, 1);
  assert.deepEqual(audit.report?.requalify, ['beef-tallow-skincare']);
});

test('the audit needs the same admin token every other route does', { skip }, async () => {
  const res = await app.fetch(new Request('http://localhost/api/corpus-audit', { method: 'POST' }));
  assert.equal(res.status, 401);
});

/** The sweep is a background task: wait for it to leave 'running' on its own. */
async function waitForTerminal(id: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await statusOf(id)).status !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`corpus audit ${id} never reached a terminal status`);
}
