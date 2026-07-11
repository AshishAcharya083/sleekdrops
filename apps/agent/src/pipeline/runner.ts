// Stage runner — executes one pipeline stage for one claimed article,
// records an agent_session (model, tokens, cost, duration), and routes the
// article to its next stage. Verdict-driven, bounded revision loop —
// a light version of devteam-platform's card lane pattern.
import { config } from '../config.js';
import { getSetting, q } from '../db/pool.js';
import { llmSettings, UsageTracker } from '../llm/openrouter.js';
import { runAssembler } from '../agents/assembler.js';
import { runEditor } from '../agents/editor.js';
import { runOutliner } from '../agents/outliner.js';
import { runPublisher } from '../agents/publisher.js';
import { runResearcher } from '../agents/researcher.js';
import { runSeoReviewer } from '../agents/seoReviewer.js';
import { runWriter } from '../agents/writer.js';
import type { ArticleRow, Stage, TopicRow } from './types.js';

const STAGE_AGENT: Record<Exclude<Stage, 'done'>, string> = {
  research: 'researcher',
  outline: 'outliner',
  write: 'writer',
  seo_review: 'seo_reviewer',
  edit: 'editor',
  assemble: 'assembler',
  publish: 'publisher',
};

export async function modelFor(agent: string): Promise<string> {
  const overrides = await getSetting<Record<string, string>>('models', {});
  if (overrides[agent]) return overrides[agent];
  const provider = await llmSettings();
  return provider.default_model || config.modelDefault;
}

async function updateArticle(id: string, fields: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await q(`UPDATE articles SET ${sets}, updated_at = now() WHERE id = $1`, [
    id,
    ...keys.map((k) => fields[k]),
  ]);
}

/** Ensure the brief's slug doesn't collide with another article. */
async function uniqueSlug(articleId: string, want: string): Promise<string> {
  for (let n = 0; n < 20; n++) {
    const candidate = n === 0 ? want : `${want}-${n + 1}`;
    const clash = await q('SELECT 1 FROM articles WHERE slug = $1 AND id <> $2', [
      candidate,
      articleId,
    ]);
    if (clash.length === 0) return candidate;
  }
  return `${want}-${articleId.slice(0, 8)}`;
}

export async function runStage(article: ArticleRow): Promise<void> {
  const stage = article.stage;
  if (stage === 'done') return;
  const agent = STAGE_AGENT[stage];
  const model = agent === 'publisher' ? null : await modelFor(agent);
  const tracker = new UsageTracker();

  const [session] = await q<{ id: string }>(
    `INSERT INTO agent_sessions (article_id, agent, model) VALUES ($1, $2, $3) RETURNING id`,
    [article.id, agent, model],
  );

  const finishSession = async (status: 'done' | 'failed', summary: string, error?: string) => {
    await q(
      `UPDATE agent_sessions SET status = $2, summary = $3, error = $4,
         tokens_input = $5, tokens_output = $6, cost_usd = $7, llm_calls = $8,
         model = COALESCE($9, model), ended_at = now()
       WHERE id = $1`,
      [
        session.id,
        status,
        summary,
        error ?? null,
        tracker.tokensInput,
        tracker.tokensOutput,
        tracker.costUsd,
        tracker.llmCalls,
        tracker.models.size > 0 ? [...tracker.models].join(',') : null,
      ],
    );
  };

  try {
    let next: { stage: Stage; status: string } = { stage: 'done', status: 'done' };
    let summary = '';

    switch (stage) {
      case 'research': {
        const topic = article.topic_id
          ? (await q<TopicRow>('SELECT * FROM topics WHERE id = $1', [article.topic_id]))[0] ?? null
          : null;
        const dossier = await runResearcher(article, topic, model!, tracker);
        await updateArticle(article.id, { research: JSON.stringify(dossier) });
        summary = `${dossier.facts?.length ?? 0} facts, ${dossier.products?.length ?? 0} products, primary keyword "${dossier.keywords?.primary}"`;
        next = { stage: 'outline', status: 'queued' };
        break;
      }
      case 'outline': {
        const brief = await runOutliner(article, model!, tracker);
        brief.slug = await uniqueSlug(article.id, brief.slug);
        await updateArticle(article.id, {
          outline: JSON.stringify(brief),
          slug: brief.slug,
          title: brief.seoTitle,
        });
        summary = `"${brief.seoTitle}" — ${brief.sections?.length ?? 0} sections, target ${brief.wordCountTarget} words`;
        next = { stage: 'write', status: 'queued' };
        break;
      }
      case 'write': {
        const draft = await runWriter(article, model!, tracker);
        await updateArticle(article.id, { draft_md: draft });
        summary = `draft written (${draft.split(/\s+/).length} words)`;
        next = { stage: 'seo_review', status: 'queued' };
        break;
      }
      case 'seo_review': {
        const review = await runSeoReviewer(article, model!, tracker);
        const maxRounds = await getSetting<number>('max_revision_rounds', 2);
        if (!review.pass && article.revision_round >= maxRounds) {
          review.forcedThrough = true;
        }
        await updateArticle(article.id, { seo_review: JSON.stringify(review) });
        summary = `score ${review.score}/100, ${review.pass ? 'PASS' : 'FAIL'} (${review.issues.length} issues)${review.forcedThrough ? ' — max revisions reached, proceeding' : ''}`;
        next =
          review.pass || review.forcedThrough
            ? { stage: 'assemble', status: 'queued' }
            : { stage: 'edit', status: 'queued' };
        break;
      }
      case 'edit': {
        const revised = await runEditor(article, model!, tracker);
        await updateArticle(article.id, {
          draft_md: revised,
          revision_round: article.revision_round + 1,
        });
        summary = `revision round ${article.revision_round + 1} applied`;
        next = { stage: 'seo_review', status: 'queued' };
        break;
      }
      case 'assemble': {
        const assembled = await runAssembler(article, model!, tracker);
        await updateArticle(article.id, {
          frontmatter: JSON.stringify(assembled.frontmatter),
          affiliate_links: JSON.stringify(assembled.affiliateLinks),
        });
        const publishMode = await getSetting<string>('publish_mode', 'approval');
        summary = `frontmatter + ${assembled.affiliateLinks.length} affiliate link(s) validated`;
        next =
          publishMode === 'approval'
            ? { stage: 'publish', status: 'waiting_approval' }
            : { stage: 'publish', status: 'queued' };
        break;
      }
      case 'publish': {
        const result = await runPublisher(article);
        await updateArticle(article.id, { published_at: new Date().toISOString() });
        if (article.topic_id) {
          await q("UPDATE topics SET status = 'approved', updated_at = now() WHERE id = $1", [
            article.topic_id,
          ]);
        }
        summary = `${result.slug} → D1 as '${result.d1Status}'${result.dispatched ? ', site rebuild dispatched' : ''}`;
        next = { stage: 'done', status: 'done' };
        break;
      }
    }

    await finishSession('done', summary);
    await updateArticle(article.id, {
      stage: next.stage,
      status: next.status,
      error: null,
      claimed_by: null,
      claimed_at: null,
    });
    console.log(`[pipeline] ${article.id} ${stage} done → ${next.stage}/${next.status}: ${summary}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishSession('failed', `${stage} failed`, message);
    await updateArticle(article.id, {
      status: 'failed',
      error: message,
      claimed_by: null,
      claimed_at: null,
    });
    console.error(`[pipeline] ${article.id} ${stage} FAILED: ${message}`);
  }
}
