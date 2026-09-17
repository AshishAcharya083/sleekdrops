// Corpus audit - score every page already on the site, worst first.
//
// After an AdSense reviewer names three weak articles, the useful question is
// not "are those three bad" but "what else is". Every page on the site was
// written under the same prompts, and nobody has read most of them since they
// went up. So this sweep pulls the whole published corpus out of D1, runs
// scanner v2 over each page (against the rest of the corpus, which is the only
// way site-wide sameness is visible at all) plus a reviewer pass, and writes
// one ranked report the admin panel renders.
//
// It ranks and recommends. It never rewrites anything: requalifying a page is
// a separate, explicitly operator-triggered job.
//
// The run is a detached background task, so it takes the same lease treatment
// scout_runs got - a 'running' row is a lock, and a lock a recycled instance
// can hold forever blocks every later sweep with nothing to clear it.
import { reviewPublishedArticle } from '../agents/corpusAuditor.js';
import {
  rankAudit,
  scoreAudited,
  type AuditedArticle,
  type CorpusAuditReport,
} from '../content/audit.js';
import { DEFAULT_CORPUS_LIMIT, type CorpusDocument } from '../content/corpus.js';
import { detectSlop } from '../content/slop.js';
import { q } from '../db/pool.js';
import { UsageTracker } from '../llm/index.js';
import { fetchPublishedBodies } from '../tools/d1.js';
import { modelFor } from './runner.js';
import { formatAge } from './scout.js';

/** How much of the site one sweep will read. Well past the current corpus. */
const MAX_AUDITED_ARTICLES = 200;

/** Reviewer passes in flight at once - enough to be quick, few enough to be polite. */
const REVIEW_CONCURRENCY = 3;

/** How long a run's lease survives without a heartbeat. Matches recoverStranded(). */
const LEASE_MINUTES = 30;

/** How often a live run renews its lease - well inside the stale threshold. */
const HEARTBEAT_MS = 60_000;

/** Interpolates a module constant, never caller input. */
const FRESH_LEASE = `heartbeat_at > now() - interval '${LEASE_MINUTES} minutes'`;

/** The run holding the audit lock, as an operator needs to read it. */
export interface CorpusAuditLock {
  id: string;
  /** pg reads timestamptz back as a Date; it serialises to ISO for the panel. */
  started_at: Date;
  heartbeat_at: Date;
  age_seconds: number;
  heartbeat_age_seconds: number;
}

/** A finished (or running) audit, as the panel reads it. */
export interface CorpusAuditRun {
  id: string;
  status: string;
  articles_scanned: number;
  report: CorpusAuditReport | null;
  error: string | null;
  started_at: Date;
  ended_at: Date | null;
}

const LOCK_COLUMNS = `id, started_at, heartbeat_at,
        EXTRACT(EPOCH FROM now() - started_at)::int age_seconds,
        EXTRACT(EPOCH FROM now() - heartbeat_at)::int heartbeat_age_seconds`;

/** The refusal an operator reads when a second sweep is turned away. */
export function describeCorpusAuditLock(lock: CorpusAuditLock): string {
  return (
    `a corpus audit is already in progress: run ${lock.id} started ${lock.started_at.toISOString()} ` +
    `(${formatAge(lock.age_seconds)} ago, last heartbeat ${formatAge(lock.heartbeat_age_seconds)} ago). ` +
    `A stalled run releases its lock ${LEASE_MINUTES} minutes after its last heartbeat.`
  );
}

/** The live run holding the audit lock, or null when the lock is free. */
export async function heldCorpusAuditLock(): Promise<CorpusAuditLock | null> {
  const [lock] = await q<CorpusAuditLock>(
    `SELECT ${LOCK_COLUMNS} FROM corpus_audits
     WHERE status = 'running' AND ${FRESH_LEASE}
     ORDER BY started_at DESC LIMIT 1`,
  );
  return lock ?? null;
}

/**
 * Renew a live run's lease. The `status = 'running'` guard is what stops a run
 * whose lock was already swept from putting itself back inside it.
 */
export async function renewCorpusAuditLease(id: string): Promise<boolean> {
  const renewed = await q(
    "UPDATE corpus_audits SET heartbeat_at = now() WHERE id = $1 AND status = 'running' RETURNING id",
    [id],
  );
  return renewed.length > 0;
}

/** Release audit locks whose lease expired with the process that held them. */
export async function recoverStaleCorpusAudits(): Promise<void> {
  const rows = await q<{ id: string }>(
    `UPDATE corpus_audits SET status = 'failed', error = 'process restarted mid-run', ended_at = now()
     WHERE status = 'running' AND NOT (${FRESH_LEASE})
     RETURNING id`,
  );
  if (rows.length === 0) return;
  await q(
    `UPDATE agent_sessions SET status = 'failed', error = 'process restarted mid-run', ended_at = now()
     WHERE corpus_audit_id = ANY($1) AND status = 'running'`,
    [rows.map((r) => r.id)],
  );
  console.log(`[audit] released ${rows.length} stale corpus-audit lock(s)`);
}

/** The most recent audit run, whatever state it is in. */
export async function latestCorpusAudit(): Promise<CorpusAuditRun | null> {
  const [run] = await q<CorpusAuditRun>(
    `SELECT id, status, articles_scanned, report, error, started_at, ended_at
     FROM corpus_audits ORDER BY started_at DESC LIMIT 1`,
  );
  return run ?? null;
}

/** Run `work` over `items`, at most `limit` at a time, results in input order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await work(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Score every published article. Exported for the tests and for anything that
 * wants the report without the run row around it.
 *
 * A page whose reviewer pass fails is scored on its scan alone rather than
 * dropped: a page the model choked on is not evidence that the page is fine.
 */
export async function auditPublishedCorpus(
  model: string,
  tracker: UsageTracker,
  onProgress?: (done: number, total: number) => void,
): Promise<CorpusAuditReport> {
  // fetchPublishedBodies rather than loadPublishedCorpus: the corpus loader
  // deliberately swallows a D1 failure so a review round can carry on without
  // it, and an audit that reported "0 articles, all fine" because D1 was down
  // would be worse than one that failed.
  const rows = await fetchPublishedBodies(MAX_AUDITED_ARTICLES, null);
  const documents: CorpusDocument[] = rows
    .filter((row) => typeof row.body_md === 'string' && row.body_md.trim() !== '')
    .map((row) => ({
      slug: row.slug,
      title: row.title ?? row.slug,
      body: row.body_md,
      publishedAt: row.pub_date ?? null,
    }));

  let done = 0;
  const audited = await mapWithConcurrency(
    documents,
    REVIEW_CONCURRENCY,
    async (document): Promise<AuditedArticle> => {
      // Measured against the rest of the corpus, on the same window the
      // pipeline's own review round uses, so the two scores are comparable.
      const corpus = documents
        .filter((other) => other.slug !== document.slug)
        .slice(0, DEFAULT_CORPUS_LIMIT);
      const scan = detectSlop(document.body, { corpus });

      let review = null;
      let reviewError: string | null = null;
      try {
        review = await reviewPublishedArticle(document, scan, model, tracker);
      } catch (err) {
        reviewError = err instanceof Error ? err.message : String(err);
        console.warn(`[audit] reviewer pass failed for ${document.slug}: ${reviewError}`);
      }
      done += 1;
      onProgress?.(done, documents.length);
      return scoreAudited({
        slug: document.slug,
        title: document.title,
        publishedAt: document.publishedAt,
        scan,
        review,
        reviewError,
      });
    },
  );

  return rankAudit(audited);
}

/** Starts an audit in the background; returns the corpus_audits row id. */
export async function startCorpusAudit(): Promise<string> {
  const [run] = await q<{ id: string }>('INSERT INTO corpus_audits DEFAULT VALUES RETURNING id');
  void (async () => {
    const tracker = new UsageTracker();
    const heartbeat = setInterval(() => {
      void renewCorpusAuditLease(run.id).catch((err) =>
        console.error(`[audit] heartbeat failed for run ${run.id}:`, err),
      );
    }, HEARTBEAT_MS);
    heartbeat.unref();
    // Model resolution is inside the try for the same reason the scout does
    // it: it throws when the engine toggle names Claude and no credential is
    // set, and a throw out here would leave the row on 'running' holding the
    // lock, with nothing on screen explaining why.
    let session: { id: string } | undefined;
    try {
      const model = await modelFor('corpus_auditor');
      [session] = await q<{ id: string }>(
        `INSERT INTO agent_sessions (corpus_audit_id, agent, model)
         VALUES ($1, 'corpus_auditor', $2) RETURNING id`,
        [run.id, model],
      );
      // Progress lands on the run row because the panel already polls it: a
      // sweep over the whole site takes minutes, and "auditing..." with no
      // number is indistinguishable from a sweep that has hung.
      const report = await auditPublishedCorpus(model, tracker, (scanned) => {
        void q('UPDATE corpus_audits SET articles_scanned = $2 WHERE id = $1', [
          run.id,
          scanned,
        ]).catch((err) => console.error(`[audit] progress write failed for ${run.id}:`, err));
      });
      await q(
        `UPDATE corpus_audits
            SET status = 'done', articles_scanned = $2, report = $3::jsonb, ended_at = now()
          WHERE id = $1`,
        [run.id, report.scanned, JSON.stringify(report)],
      );
      await q(
        `UPDATE agent_sessions SET status = 'done', summary = $2, tokens_input = $3,
           tokens_output = $4, cost_usd = $5, llm_calls = $6, ended_at = now()
         WHERE id = $1`,
        [
          session.id,
          report.summary.slice(0, 400),
          tracker.tokensInput,
          tracker.tokensOutput,
          tracker.costUsd,
          tracker.llmCalls,
        ],
      );
      console.log(`[audit] run ${run.id}: ${report.summary}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await q("UPDATE corpus_audits SET status = 'failed', error = $2, ended_at = now() WHERE id = $1", [
        run.id,
        message,
      ]);
      if (session) {
        await q(
          `UPDATE agent_sessions SET status = 'failed', error = $2, tokens_input = $3,
             tokens_output = $4, cost_usd = $5, llm_calls = $6, ended_at = now()
           WHERE id = $1`,
          [session.id, message, tracker.tokensInput, tracker.tokensOutput, tracker.costUsd, tracker.llmCalls],
        );
      } else {
        await q(
          `INSERT INTO agent_sessions (corpus_audit_id, agent, status, summary, error, ended_at)
           VALUES ($1, 'corpus_auditor', 'failed', 'corpus audit could not start', $2, now())`,
          [run.id, message],
        );
      }
      console.error(`[audit] run ${run.id} failed: ${message}`);
    } finally {
      clearInterval(heartbeat);
    }
  })();
  return run.id;
}
