import { useEffect, useState } from 'react';
import type { ArticleDetail, ArticleSummary } from '../api';
import { api, duration, fmtCost, fmtTime } from '../api';
import { Badge } from '../components';
import { usePoll } from '../hooks';

const LANES: Array<{ title: string; stages: string[] }> = [
  { title: 'Research & Brief', stages: ['research', 'outline'] },
  { title: 'Write & Optimize', stages: ['write', 'seo_review', 'edit'] },
  { title: 'Assemble & Publish', stages: ['assemble', 'image', 'publish'] },
  { title: 'Done', stages: ['done'] },
];

export function Pipeline() {
  const { data, error, refresh } = usePoll<{ articles: ArticleSummary[] }>('/api/articles');
  const [openId, setOpenId] = useState<string | null>(null);
  const articles = data?.articles ?? [];

  return (
    <>
      {error && <div className="error-banner">API unreachable: {error}</div>}
      <div className="board">
        {LANES.map((lane) => {
          const items = articles.filter((a) => lane.stages.includes(a.stage));
          return (
            <div className="lane" key={lane.title}>
              <h4>
                {lane.title} <span className="count">{items.length}</span>
              </h4>
              {items.map((a) => (
                <div className="cardlet" key={a.id} onClick={() => setOpenId(a.id)}>
                  <div>{a.title}</div>
                  <div className="meta">
                    <Badge value={a.stage} />
                    <Badge value={a.status} />
                    {a.seo_score && <span className="badge">SEO {a.seo_score}</span>}
                  </div>
                  {a.error && (
                    <div className="muted" style={{ color: 'var(--red)', marginTop: 6, fontSize: 12 }}>
                      {a.error.slice(0, 120)}
                    </div>
                  )}
                </div>
              ))}
              {items.length === 0 && <p className="muted" style={{ padding: '4px 6px', fontSize: 12 }}>empty</p>}
            </div>
          );
        })}
      </div>
      {openId && <ArticlePanel id={openId} onClose={() => setOpenId(null)} onChanged={refresh} />}
    </>
  );
}

function ArticlePanel({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<ArticleDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showDraft, setShowDraft] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [feedbackSent, setFeedbackSent] = useState(false);

  const load = () => {
    api<ArticleDetail>(`/api/articles/${id}`).then(setDetail).catch((e: Error) => setErr(e.message));
  };
  useEffect(load, [id]);

  const action = async (path: string) => {
    try {
      await api(`/api/articles/${id}/${path}`, { method: 'POST' });
      load();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const sendFeedback = async () => {
    if (!feedback.trim()) return;
    try {
      await api(`/api/articles/${id}/feedback`, {
        method: 'POST',
        body: JSON.stringify({ feedback: feedback.trim() }),
      });
      setFeedback('');
      setFeedbackSent(true);
      setTimeout(() => setFeedbackSent(false), 4000);
      load();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="detail-overlay" onClick={onClose}>
      <div className="detail-panel" onClick={(e) => e.stopPropagation()}>
        <button className="close-x" onClick={onClose}>
          ×
        </button>
        {err && <div className="error-banner">{err}</div>}
        {!detail ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <h2>{detail.article.title}</h2>
            <div className="row">
              <Badge value={detail.article.stage} />
              <Badge value={detail.article.status} />
              <span className="muted mono">{detail.article.slug ?? 'no slug yet'}</span>
              <span className="muted">rev {detail.article.revision_round}</span>
            </div>

            <div className="row" style={{ marginTop: 12 }}>
              {detail.article.status === 'waiting_approval' && (
                <button className="btn" onClick={() => action('approve-publish')}>
                  ✅ Approve & publish
                </button>
              )}
              {['failed', 'cancelled'].includes(detail.article.status) && (
                <button className="btn" onClick={() => action('retry')}>
                  Retry stage
                </button>
              )}
              {['queued', 'failed', 'waiting_approval'].includes(detail.article.status) && (
                <button className="btn danger" onClick={() => action('cancel')}>
                  Cancel
                </button>
              )}
            </div>

            {detail.article.error && (
              <div className="error-banner" style={{ marginTop: 12 }}>
                {detail.article.error}
              </div>
            )}

            {detail.article.draft_md && detail.article.status !== 'running' && (
              <div className="section">
                <h2>Feedback to the writer</h2>
                <div className="card">
                  <textarea
                    rows={3}
                    style={{ width: '100%', resize: 'vertical' }}
                    placeholder='e.g. "Lead with the Dyson, drop the price table, add a section on battery life"'
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                  />
                  <div className="row" style={{ marginTop: 8, alignItems: 'center' }}>
                    <button className="btn" disabled={!feedback.trim()} onClick={sendFeedback}>
                      Send to editor
                    </button>
                    <span className="muted" style={{ fontSize: 12 }}>
                      re-runs edit → SEO review → assemble → publish with your notes applied
                    </span>
                    {feedbackSent && <span style={{ fontSize: 12 }}>✓ queued</span>}
                  </div>
                </div>
              </div>
            )}

            {detail.article.seo_review && (
              <div className="section">
                <h2>SEO review — {detail.article.seo_review.score}/100</h2>
                <div className="card">
                  <p style={{ marginTop: 0 }}>{detail.article.seo_review.summary}</p>
                  {(detail.article.seo_review.issues ?? []).map((issue, i) => (
                    <p key={i} style={{ fontSize: 13 }}>
                      <Badge value={issue.severity} /> {issue.issue}
                      <br />
                      <span className="muted">Fix: {issue.fix}</span>
                    </p>
                  ))}
                </div>
              </div>
            )}

            {detail.article.affiliate_links && detail.article.affiliate_links.length > 0 && (
              <div className="section">
                <h2>Affiliate links</h2>
                <div className="card" style={{ padding: 0 }}>
                  <table>
                    <tbody>
                      {detail.article.affiliate_links.map((l) => (
                        <tr key={l.slug}>
                          <td className="mono">/go/{l.slug}</td>
                          <td className="mono muted" style={{ wordBreak: 'break-all' }}>
                            {l.default_url}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {detail.article.draft_md && (
              <div className="section">
                <h2>
                  Draft{' '}
                  <button className="btn secondary small" onClick={() => setShowDraft(!showDraft)}>
                    {showDraft ? 'hide' : 'show'} ({detail.article.draft_md.split(/\s+/).length} words)
                  </button>
                </h2>
                {showDraft && <pre>{detail.article.draft_md}</pre>}
              </div>
            )}

            <div className="section">
              <h2>Agent sessions</h2>
              <div className="card" style={{ padding: 0 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th>Status</th>
                      <th>Summary</th>
                      <th>Cost</th>
                      <th>Duration</th>
                      <th>Started</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.sessions.map((s) => (
                      <tr key={s.id}>
                        <td className="mono">{s.agent}</td>
                        <td>
                          <Badge value={s.status} />
                        </td>
                        <td className="muted" style={{ maxWidth: 260 }}>
                          {s.error ?? s.summary ?? '…'}
                        </td>
                        <td className="mono">{fmtCost(s.cost_usd)}</td>
                        <td className="mono">{duration(s.started_at, s.ended_at)}</td>
                        <td className="muted">{fmtTime(s.started_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
