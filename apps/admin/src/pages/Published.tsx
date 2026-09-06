import { useState } from 'react';
import { EVENTS, captureError, track } from '../analytics';
import type { PublishedPost, RebuildResult } from '../api';
import { api, apiUpload, fmtTime } from '../api';
import { Badge } from '../components';
import { HeroImageField } from '../HeroImageField';
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
  const [heroFor, setHeroFor] = useState<string | null>(null);
  const posts = data?.posts ?? [];
  const editing = posts.find((p) => p.slug === heroFor) ?? null;

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
              <th>Hero</th>
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
                <td>
                  {p.hero_image ? (
                    <img className="hero-thumb" src={p.hero_image} alt="" loading="lazy" />
                  ) : (
                    <span className="hero-thumb empty" title="no hero image — the site renders its cover fill">
                      —
                    </span>
                  )}
                </td>
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
                  <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                    <button
                      className="btn secondary small"
                      disabled={busy === p.slug}
                      onClick={() => setHeroFor(p.slug)}
                    >
                      {p.hero_image ? '🖼️ Change hero' : '🖼️ Add hero'}
                    </button>
                    <button
                      className="btn danger small"
                      disabled={busy === p.slug}
                      onClick={() => remove(p)}
                    >
                      {busy === p.slug ? 'deleting…' : 'Delete'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {posts.length === 0 && (
              <tr>
                <td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  no posts in D1
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <PostHeroDrawer
          post={editing}
          onClose={() => setHeroFor(null)}
          onSaved={(message) => {
            setErr(null);
            setNotice(message);
            refresh();
          }}
        />
      )}
    </>
  );
}

/**
 * Hero image for a post that is already live. This edits the D1 row itself
 * rather than a pipeline article, which is the only way to re-image the older
 * posts — most of what is on the site was written before the agent platform and
 * has no article behind it. Saving fires a site rebuild.
 */
function PostHeroDrawer({
  post,
  onClose,
  onSaved,
}: {
  post: PublishedPost;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [alt, setAlt] = useState(post.hero_alt ?? '');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** How it went, including whether the site will actually pick it up. */
  const rebuildNote = (what: string, res: RebuildResult): string =>
    `${what} for ${post.slug}` +
    (res.dispatched
      ? ' — site rebuild dispatched (~90s to live).'
      : ` — saved in D1, but the rebuild was NOT dispatched: ${res.dispatchError ?? 'unknown'}`);

  /** Attach a file, or (file omitted) re-label the hero already there. */
  const save = async (file: File | null) => {
    setBusy(true);
    setError(null);
    setStatus(file ? 'uploading…' : 'saving alt text…');
    const action = file ? 'hero_image_attached' : 'hero_alt_saved';
    try {
      const res = await apiUpload<RebuildResult>(
        `/api/published/${encodeURIComponent(post.slug)}/hero-image`,
        { file, fields: { alt: alt.trim() } },
      );
      track(EVENTS.publishedHeroUpdated, {
        action,
        slug: post.slug,
        category: post.category,
        post_type: post.post_type,
        status: res.dispatched ? 'rebuild_dispatched' : 'rebuild_failed',
      });
      onSaved(rebuildNote(file ? 'New hero image saved' : 'Alt text saved', res));
      onClose();
    } catch (e) {
      captureError(e, { action, slug: post.slug, surface: 'published' });
      setError((e as Error).message);
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Remove the hero image from "${post.title}"?\nThe page falls back to its cover fill.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api<RebuildResult>(
        `/api/published/${encodeURIComponent(post.slug)}/hero-image`,
        { method: 'DELETE' },
      );
      track(EVENTS.publishedHeroUpdated, {
        action: 'hero_image_removed',
        slug: post.slug,
        category: post.category,
        post_type: post.post_type,
        status: res.dispatched ? 'rebuild_dispatched' : 'rebuild_failed',
      });
      onSaved(rebuildNote('Hero image removed', res));
      onClose();
    } catch (e) {
      captureError(e, { action: 'hero_image_removed', slug: post.slug, surface: 'published' });
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="detail-overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="detail-panel">
        <button className="close-x" aria-label="Close" onClick={onClose} disabled={busy}>
          ×
        </button>
        <h2>{post.title}</h2>
        <div className="row">
          <Badge value={post.status} />
          <span className="muted mono">{post.slug}</span>
        </div>

        <div className="section">
          <h2>Hero image</h2>
          <div className="card">
            <HeroImageField
              label={null}
              url={post.hero_image}
              alt={alt}
              busy={busy}
              status={status}
              error={error}
              onPick={(file) => void save(file)}
              onRemove={() => void remove()}
              onAltChange={setAlt}
              hint="Saved straight onto the live post and pushed out with a site rebuild (~90s). Works for posts written before the agent platform, which have no pipeline article behind them."
            />
            {post.hero_image && alt.trim() !== (post.hero_alt ?? '') && (
              <button className="btn secondary small" disabled={busy} onClick={() => void save(null)}>
                Save alt text
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
