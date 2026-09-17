import { useState } from 'react';
import { EVENTS, captureError, track } from '../analytics';
import type {
  AuditedArticle,
  CorpusAudit,
  CorpusAuditLock,
  PublishedPost,
  RebuildResult,
  RequalifyResult,
} from '../api';
import { api, apiUpload, fmtAge, fmtTime } from '../api';
import { ApiErrorBanner, Badge } from '../components';
import { HeroImageField } from '../HeroImageField';
import { usePoll } from '../hooks';

/** Band → badge colour. The band is a recommendation, not a status. */
const BAND_COLOR: Record<string, string> = {
  requalify: 'red',
  review: 'amber',
  ok: 'green',
};

/**
 * Published - the live site's content (Cloudflare D1 posts table).
 *
 * Two things happen here that happen nowhere else. Deleting a row removes it
 * from D1 and fires the content-updated dispatch, so the next site build no
 * longer includes the page (orphaned pipeline-authored affiliate links are
 * cleaned up with it). And requalifying one sends it back through the whole
 * rebuilt pipeline at its own slug - which is the only way the pages written
 * under the old prompts, the ones an AdSense reviewer actually read, ever come
 * up to the new standard.
 *
 * The corpus audit above the table is what says which page to do that to next.
 */
export function Published() {
  const { data, error, refresh } = usePoll<{ posts: PublishedPost[] }>('/api/published', 30_000);
  // Same 30s cadence as the post list. A finished report is static and can run
  // to a few hundred KB, so there is nothing to gain from re-downloading it
  // faster than the sweep that produces it takes to run.
  const audit = usePoll<{ audit: CorpusAudit | null; lock: CorpusAuditLock | null }>(
    '/api/corpus-audit',
    30_000,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [heroFor, setHeroFor] = useState<string | null>(null);
  const posts = data?.posts ?? [];
  const editing = posts.find((p) => p.slug === heroFor) ?? null;

  const ranked = audit.data?.audit?.report?.articles ?? [];
  const scores = new Map(ranked.map((a) => [a.slug, a]));

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

  const requalify = async (slug: string, title: string) => {
    if (
      !window.confirm(
        `Requalify "${title}"?\n\n${slug} goes back to the research stage and runs the whole pipeline again - ` +
          'research, angle, outline, write, review, assemble, publish. It keeps this slug and its /go/ links. ' +
          'The page is dated as updated only if the rebuild actually moves something, and then it says what ' +
          'changed. It costs a full article run and still passes the normal publish gate.',
      )
    ) {
      return;
    }
    setBusy(slug);
    setErr(null);
    setNotice(null);
    try {
      const res = await api<RequalifyResult>(
        `/api/published/${encodeURIComponent(slug)}/requalify`,
        { method: 'POST' },
      );
      track(EVENTS.publishedPostRequalified, {
        slug,
        surface: 'published',
        article_id: res.article_id,
        created_article: res.created,
        go_slugs: res.go_slugs.length,
      });
      setNotice(
        `${slug} is back at the research stage - watch it on the Pipeline board. ` +
          `Its slug and ${res.go_slugs.length} /go/ link(s) are held for the rebuild.`,
      );
      refresh();
    } catch (e) {
      captureError(e, { action: 'published_requalify', slug, surface: 'published' });
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const startAudit = async () => {
    setErr(null);
    setNotice(null);
    try {
      await api<{ started: string }>('/api/corpus-audit', { method: 'POST' });
      track(EVENTS.corpusAuditStarted, { outcome: 'started' });
      setNotice('Corpus audit started - it scores every published page and ranks the worst first.');
      audit.refresh();
    } catch (e) {
      track(EVENTS.corpusAuditStarted, { outcome: 'locked' });
      captureError(e, { action: 'corpus_audit_start', surface: 'published' });
      setErr((e as Error).message);
    }
  };

  return (
    <>
      <ApiErrorBanner error={error} />
      {err && <div className="error-banner">{err}</div>}
      {notice && <div className="card" style={{ padding: 10, marginBottom: 12 }}>{notice}</div>}

      <CorpusAuditSection
        audit={audit.data?.audit ?? null}
        lock={audit.data?.lock ?? null}
        busy={busy}
        onRun={() => void startAudit()}
        onRequalify={(article) => void requalify(article.slug, article.title)}
      />

      <div className="section">
        <h2>Live posts</h2>
        <div className="card table-scroll" tabIndex={0} role="region" aria-label="Published posts">
          <table>
            <thead>
              <tr>
                <th>Hero</th>
                <th>Title</th>
                <th>Slug</th>
                <th>Audit</th>
                <th>Category</th>
                <th>Type</th>
                <th>Author</th>
                <th>Published</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {posts.map((p) => {
                const scored = scores.get(p.slug);
                return (
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
                    <td>
                      {scored ? (
                        <span
                          className={`badge ${BAND_COLOR[scored.band] ?? ''}`}
                          title={scored.verdict}
                        >
                          {scored.score}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
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
                          className="btn violet-outline small"
                          disabled={busy === p.slug}
                          title="Send this page back through the whole pipeline at the same slug"
                          onClick={() => void requalify(p.slug, p.title)}
                        >
                          {busy === p.slug ? 'working…' : '🔁 Requalify'}
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
                );
              })}
              {posts.length === 0 && (
                <tr>
                  <td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                    no posts in D1
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
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
 * The corpus audit: every published page scored by the deterministic scanner
 * and a reviewer pass, ranked worst first.
 *
 * It exists because fixing the pipeline fixes nothing already on the site, and
 * a reviewer who named three weak articles was reading a corpus nobody had
 * re-read since it went up. The ranking is the answer to "what next" - it
 * recommends, and the Requalify button is what acts.
 */
function CorpusAuditSection({
  audit,
  lock,
  busy,
  onRun,
  onRequalify,
}: {
  audit: CorpusAudit | null;
  lock: CorpusAuditLock | null;
  busy: string | null;
  onRun: () => void;
  onRequalify: (article: AuditedArticle) => void;
}) {
  const [open, setOpen] = useState(true);
  const running = lock !== null || audit?.status === 'running';
  const report = audit?.report ?? null;

  return (
    <div className="section">
      <h2>Corpus audit</h2>
      <div className="card">
        <div className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn" disabled={running} onClick={onRun}>
            {running ? 'auditing…' : '🔍 Audit the corpus'}
          </button>
          {running && lock && (
            <span className="muted" style={{ fontSize: 12 }}>
              run {lock.id.slice(0, 8)} started {fmtAge(lock.age_seconds)} ago
              {audit?.status === 'running' && ` · ${audit.articles_scanned} page(s) scored`}
            </span>
          )}
          {!running && audit && (
            <span className="muted" style={{ fontSize: 12 }}>
              last run {fmtTime(audit.ended_at ?? audit.started_at)} · <Badge value={audit.status} />
            </span>
          )}
          {!audit && !running && (
            <span className="muted" style={{ fontSize: 12 }}>
              never run - this scores every live page and ranks the weakest first
            </span>
          )}
        </div>

        {audit?.error && (
          <div className="error-banner" style={{ marginTop: 10 }}>
            {audit.error}
          </div>
        )}

        {report && (
          <>
            <p style={{ marginBottom: 6 }}>{report.summary}</p>
            <button className="btn secondary small" onClick={() => setOpen(!open)}>
              {open ? 'Hide the ranking' : `Show all ${report.articles.length}`}
            </button>
          </>
        )}
      </div>

      {report && open && report.articles.length > 0 && (
        <div className="card table-scroll" style={{ marginTop: 10 }} tabIndex={0} role="region" aria-label="Corpus audit ranking">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Page</th>
                <th>Score</th>
                <th>Scan</th>
                <th>Review</th>
                <th>Why</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {report.articles.map((a, i) => (
                <tr key={a.slug}>
                  <td className="muted">{i + 1}</td>
                  <td style={{ maxWidth: 280 }}>
                    <div>{a.title}</div>
                    <a
                      className="mono muted"
                      style={{ fontSize: 12 }}
                      href={`https://sleekdrops.com/blog/${a.slug}/`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {a.slug}
                    </a>
                  </td>
                  <td>
                    <span className={`badge ${BAND_COLOR[a.band] ?? ''}`}>
                      {a.score} · {a.band}
                    </span>
                  </td>
                  <td className="muted">
                    {a.scanScore} ({a.scanFindings})
                  </td>
                  <td>
                    {a.review ? (
                      <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                        {Object.entries(a.review.dimensions).map(([name, value]) => (
                          <span
                            key={name}
                            className={`badge${value >= 80 ? ' green' : value >= 60 ? ' amber' : ' red'}`}
                            title={name}
                          >
                            {name.slice(0, 4)} {value}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="muted" title={a.reviewError ?? ''}>
                        not graded
                      </span>
                    )}
                  </td>
                  <td className="muted" style={{ maxWidth: 380, fontSize: 12 }}>
                    {a.verdict}
                  </td>
                  <td>
                    <button
                      className="btn violet-outline small"
                      disabled={busy === a.slug}
                      onClick={() => onRequalify(a)}
                    >
                      {busy === a.slug ? 'working…' : '🔁 Requalify'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
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
