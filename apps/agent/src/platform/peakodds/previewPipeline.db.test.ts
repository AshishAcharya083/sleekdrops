// One Australian and one Global PeakOdds preview through the real runner's
// assemble stage, against Postgres seeded the way boot seeds it: the edition's
// footer lands on the stored draft, the stalest "As at" lands on
// articles.odds_as_at, and a preview linking a bookmaker fails with the reason
// on the card instead of moving on.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { pool, q } = await import('../../db/pool.js');
const { migrate } = await import('../../db/migrate.js');
const { seedPlatforms } = await import('../profiles.js');
const { runStage } = await import('../../pipeline/runner.js');
const { AU_FOOTER, GLOBAL_FOOTER } = await import('./footers.js');

import type { ArticleRow, ContentBrief } from '../../pipeline/types.js';

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';
if (reachable) {
  await migrate();
  await seedPlatforms();
}

const inserted: string[] = [];
after(async () => {
  if (reachable) {
    await q('DELETE FROM agent_sessions WHERE article_id = ANY($1::uuid[])', [inserted]);
    await q('DELETE FROM articles WHERE id = ANY($1::uuid[])', [inserted]);
  }
  await pool.end();
});

/** "YYYY-MM-DD HH:MM UTC", the way a picks table states when a price was seen. */
function asAtUtc(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const olderPrice = new Date(Date.now() - 3 * 3_600_000);
const newerPrice = new Date(Date.now() - 3_600_000);
olderPrice.setUTCSeconds(0, 0);
newerPrice.setUTCSeconds(0, 0);
const kickOff = new Date(Date.now() + 3 * 86_400_000);

function draft(extra = ''): string {
  return `- Swans v Lions at the SCG, ${kickOff.toISOString().slice(0, 16).replace('T', ' ')} UTC.
- The Lions have lost their first-choice ruck.
- The lean: Swans at the line.

## The picks

| Market | Selection | Indicative odds (decimal) | As at |
| --- | --- | --- | --- |
| Line | Swans -6.5 | 1.90 | ${asAtUtc(newerPrice)} |
| Head to head | Swans | 1.65 | ${asAtUtc(olderPrice)} |

## Why the Swans at the line

Their midfield won the contested ball by 18 in the last meeting.${extra}

## Verdict

A lean, not a certainty: the Swans' pressure game suits a ruck-less Lions side, and the prices are subject to change.`;
}

async function insertPreview(editionId: 'au' | 'global', body: string): Promise<ArticleRow> {
  const slug = `swans-v-lions-preview-${randomUUID().slice(0, 8)}`;
  const brief: ContentBrief = {
    seoTitle: 'Swans v Lions tips and preview',
    dek: 'A ruck-less Lions side, and why the line is the lean rather than the head to head.',
    slug,
    author: 'desk',
    kind: 'Match preview',
    searchIntent: 'Informational',
    primaryKeyword: 'swans v lions tips',
    secondaryKeywords: [],
    tags: ['afl'],
    wordCountTarget: 900,
    sections: [],
    faq: [],
  };
  const [row] = await q<ArticleRow>(
    `INSERT INTO articles (platform_id, edition_id, title, category, post_type, stage, status, claimed_by, claimed_at,
                           event_starts_at, outline, draft_md)
     VALUES ('peakodds', $1, $2, 'AFL', 'preview', 'assemble', 'running', 'test-worker', now(), $3, $4, $5)
     RETURNING *`,
    [editionId, brief.seoTitle, kickOff.toISOString(), JSON.stringify(brief), body],
  );
  inserted.push(row.id);
  return row;
}

async function reload(id: string): Promise<ArticleRow> {
  return (await q<ArticleRow>('SELECT * FROM articles WHERE id = $1', [id]))[0];
}

for (const [editionId, footer, otherFooter] of [
  ['au', AU_FOOTER, GLOBAL_FOOTER],
  ['global', GLOBAL_FOOTER, AU_FOOTER],
] as const) {
  test(`${editionId} edition: a preview assembles with its footer and its odds_as_at`, { skip }, async () => {
    const article = await insertPreview(editionId, draft());
    await runStage(await reload(article.id));

    const assembled = await reload(article.id);
    assert.equal(assembled.status, 'queued', assembled.error ?? '');
    assert.equal(assembled.stage, 'image');
    assert.ok(assembled.draft_md?.startsWith(draft()), 'the draft itself is untouched');
    assert.ok(assembled.draft_md?.includes(footer), 'the edition footer is appended');
    assert.ok(!assembled.draft_md?.includes(otherFooter));
    assert.equal(assembled.odds_as_at?.toISOString(), olderPrice.toISOString(), 'the stalest price');
    assert.equal(assembled.frontmatter?.postType, 'preview');
  });
}

test('a preview linking a bookmaker fails assembly with the reason on the card', { skip }, async () => {
  const article = await insertPreview('au', draft(' [Compare prices](https://www.sportsbet.com.au/betting/afl)'));
  await runStage(await reload(article.id));

  const failed = await reload(article.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.stage, 'assemble');
  assert.match(failed.error ?? '', /blocked domain[\s\S]*sportsbet\.com\.au/);
  assert.equal(failed.odds_as_at, null);
  assert.ok(!failed.draft_md?.includes(AU_FOOTER), 'nothing from the failed pass is stored');
});
