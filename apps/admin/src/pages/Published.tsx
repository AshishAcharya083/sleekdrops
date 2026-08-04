import { useState } from 'react';
import { EVENTS, captureError, track } from '../analytics';
import type { PublishedPost } from '../api';
import { api, fmtTime } from '../api';
import { Badge } from '../components';
import { usePoll } from '../hooks';

/**
 * Published — the live site's content (Cloudflare D1 posts table). Deleting a
 * row removes it from D1 and fires the content-updated dispatch, so the next
 * site build no longer includes the page (orphaned pipeline-authored affiliate
 * links are cleaned up with it).
 */
export function Published() {
  const { data, error, refresh } = usePoll<{ posts: PublishedPost[] }>('/api/published', 30_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const posts = data?.posts ?? [];

  const remove = async (post: PublishedPost) => {
    if (!window.confirm(`Delete "${post.title}" (${post.slug}) from the site?\nThis removes it from D1 — the next build drops the page.`)) {
      return;
    }
    setBusy(post.slug);
    setErr(null);
    setNotice(null);
    try {
      const res = await api<{ removedLinks: string[]; dispatched: boolean; dispatchError?: string | null }>(
        `/api/published/${encodeURIComponent(post.slug)}`,
        { method: 'DELETE' },
      );
      track(EVENTS.publishedPostDeleted, {
        slug: post.slug,
        category: post.category,
        post_type: post.post_type,
        removed_links: res.removedLinks.length,
        status: res.dispatched ? 'rebuild_dispatched' : 'rebuild_failed',
      });
      setNotice(
        `Deleted ${post.slug}` +
          (res.removedLinks.length > 0 ? ` (+ ${res.removedLinks.length} orphaned link(s))` : '') +
          (res.dispatched ? ' — site rebuild dispatched.' : ` — rebuild NOT dispatched: ${res.dispatchError ?? 'unknown'}`),
      );
      refresh();
    } catch (e) {
      captureError(e, { action: 'published_delete', slug: post.slug, surface: 'published' });
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {error && <div className="error-banner">API unreachable: {error}</div>}
      {err && <div className="error-banner">{err}</div>}
      {notice && <div className="card" style={{ padding: 10, marginBottom: 12 }}>{notice}</div>}
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Slug</th>
              <th>Category</th>
              <th>Type</th>
              <th>Author</th>
              <th>Published</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {posts.map((p) => (
              <tr key={p.slug}>
                <td style={{ maxWidth: 320 }}>{p.title}</td>
                <td className="mono muted">
                  <a href={`https://sleekdrops.com/blog/${p.slug}/`} target="_blank" rel="noreferrer">
                    {p.slug}
                  </a>
                </td>
                <td>{p.category}</td>
                <td>{p.post_type}</td>
                <td>{p.author}</td>
                <td className="muted">{p.pub_date}</td>
                <td>
                  <Badge value={p.status} />
                </td>
                <td>
                  <button
                    className="btn danger small"
                    disabled={busy === p.slug}
                    onClick={() => remove(p)}
                  >
                    {busy === p.slug ? 'deleting…' : 'Delete'}
                  </button>
                </td>
              </tr>
            ))}
            {posts.length === 0 && (
              <tr>
                <td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  no posts in D1
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
