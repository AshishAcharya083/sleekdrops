// Rows db tests build on, with every column the schema requires filled in.
// Each builder records what it created so a suite can remove it again.
import { randomUUID } from 'node:crypto';
import type { ArticleRow } from '../pipeline/types.js';
import { q } from './pool.js';

const insertedArticleIds: string[] = [];

/**
 * An articles row: a finished SleekDrops Australian article unless `fields`
 * says otherwise - finished, so no other db test file's worker claims it - with
 * a unique title and slug and a live lease, because a running row with no
 * lease is lapsed to any other db test file's reaper and re-queued mid-test.
 */
export async function insertArticle(fields: Partial<Record<keyof ArticleRow, unknown>> = {}): Promise<ArticleRow> {
  const tag = randomUUID().slice(0, 8);
  const row: Record<string, unknown> = {
    platform_id: 'sleekdrops',
    edition_id: 'au',
    title: `Fixture article ${tag}`,
    slug: `fixture-article-${tag}`,
    category: 'Tech',
    post_type: 'guide',
    stage: 'done',
    status: 'done',
    lease_expires_at: new Date(Date.now() + 10 * 60_000),
    ...fields,
  };
  const columns = Object.keys(row);
  const [inserted] = await q<ArticleRow>(
    `INSERT INTO articles (${columns.join(', ')})
     VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    Object.values(row),
  );
  insertedArticleIds.push(inserted.id);
  return inserted;
}

/** Remove every article this process inserted through insertArticle. */
export async function deleteInsertedArticles(): Promise<void> {
  if (insertedArticleIds.length === 0) return;
  await q('DELETE FROM articles WHERE id = ANY($1::uuid[])', [insertedArticleIds.splice(0)]);
}
