import { useState } from 'react';
import type { Topic } from '../api';
import { api, fmtTime } from '../api';
import { Badge } from '../components';
import { usePoll } from '../hooks';
import { ManualTopicDrawer } from './ManualTopicDrawer';

export function Topics() {
  const { data, error, refresh } = usePoll<{ topics: Topic[] }>('/api/topics');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingDraft, setEditingDraft] = useState<Topic | null>(null);
  const [confirmApprove, setConfirmApprove] = useState<Topic | null>(null);

  const topics = data?.topics ?? [];
  const drafts = topics.filter((t) => t.status === 'draft' && t.source === 'manual');
  const suggested = topics.filter((t) => t.status === 'suggested');
  const others = topics.filter((t) => t.status !== 'suggested' && t.status !== 'draft');

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const act = async (fn: () => Promise<unknown>, label: string, ok?: string) => {
    setBusy(label);
    setNotice(null);
    try {
      await fn();
      setSelected(new Set());
      if (ok) setFlash(ok);
      refresh();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const openNew = () => {
    setEditingDraft(null);
    setDrawerOpen(true);
  };

  const openEdit = (topic: Topic) => {
    setEditingDraft(topic);
    setDrawerOpen(true);
  };

  return (
    <>
      {error && <div className="error-banner">API unreachable: {error}</div>}
      {notice && <div className="error-banner">{notice}</div>}
      {flash && <div className="notice-banner">{flash}</div>}

      <div className="row" style={{ marginBottom: 14 }}>
        <button className="btn violet" disabled={busy !== null} onClick={openNew}>
          ✍️ New manual topic
        </button>
        <button
          className="btn secondary"
          disabled={busy !== null}
          onClick={() => act(() => api('/api/scout', { method: 'POST' }), 'scout')}
        >
          {busy === 'scout' ? 'Starting…' : '🔍 Find new trending topics'}
        </button>
        <div className="spacer" style={{ flex: 1 }} />
        <span className="muted">{selected.size} selected</span>
        <button
          className="btn"
          disabled={selected.size === 0 || busy !== null}
          onClick={() =>
            act(
              () => api('/api/topics/approve', { method: 'POST', body: JSON.stringify({ ids: [...selected] }) }),
              'approve',
            )
          }
        >
          Approve → write articles
        </button>
        <button
          className="btn danger"
          disabled={selected.size === 0 || busy !== null}
          onClick={() =>
            act(
              () => api('/api/topics/reject', { method: 'POST', body: JSON.stringify({ ids: [...selected] }) }),
              'reject',
            )
          }
        >
          Reject
        </button>
      </div>

      {drafts.length > 0 && (
        <div className="section" style={{ marginTop: 0 }}>
          <h2>Draft manual topics ({drafts.length})</h2>
          <div className="card" style={{ padding: 0 }}>
            {drafts.map((t) => (
              <div className="topic-row draft-topic-row" key={t.id}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="title">
                    {t.title}
                    <span className="badge violet">✍️ Manual</span>
                    <Badge value="draft" />
                  </div>
                  {t.instructions && <div className="why clamp-2">{t.instructions}</div>}
                  {t.research_notes.length > 0 && (
                    <div className="draft-attach-note">
                      📎 {t.research_notes.length} reference
                      {t.research_notes.length > 1 ? 's' : ''}
                    </div>
                  )}
                </div>
                <span className="muted" style={{ whiteSpace: 'nowrap' }}>
                  {fmtTime(t.created_at)}
                </span>
                <div className="row-actions">
                  <button
                    className="btn approve-inline small"
                    disabled={busy !== null}
                    onClick={() => setConfirmApprove(t)}
                  >
                    Approve &amp; generate
                  </button>
                  <button className="btn ghost small" disabled={busy !== null} onClick={() => openEdit(t)}>
                    Edit
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="section" style={{ marginTop: drafts.length > 0 ? undefined : 0 }}>
        <h2>Suggested topics ({suggested.length})</h2>
        <div className="card" style={{ padding: 0 }}>
          {suggested.map((t) => (
            <label className="topic-row" key={t.id}>
              <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggle(t.id)} />
              <div style={{ flex: 1 }}>
                <div className="title">{t.title}</div>
                {t.why_trending && <div className="why">{t.why_trending}</div>}
                {t.angle && <div className="why">Angle: {t.angle}</div>}
                <div className="kw">
                  <Badge value={t.category} />
                  <Badge value={t.post_type} />
                  {(t.keywords ?? []).slice(0, 5).map((k) => (
                    <span className="badge" key={k}>
                      {k}
                    </span>
                  ))}
                </div>
              </div>
              <span className="muted" style={{ whiteSpace: 'nowrap' }}>
                {fmtTime(t.created_at)}
              </span>
            </label>
          ))}
          {suggested.length === 0 && (
            <p className="muted" style={{ padding: 16 }}>
              No suggestions waiting. Hit “Find new trending topics” to run the scout.
            </p>
          )}
        </div>
      </div>

      {others.length > 0 && (
        <div className="section">
          <h2>Decided</h2>
          <div className="card" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Topic</th>
                  <th>Category</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {others.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <div className="title-cell">
                        {t.title}
                        {t.source === 'manual' && <span className="badge violet">✍️ Manual</span>}
                      </div>
                    </td>
                    <td>{t.category}</td>
                    <td>{t.post_type}</td>
                    <td>
                      <Badge value={t.status} />
                    </td>
                    <td className="muted">{fmtTime(t.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {drawerOpen && (
        <ManualTopicDrawer
          editing={editingDraft}
          onClose={() => setDrawerOpen(false)}
          onSaved={(message) => {
            setDrawerOpen(false);
            setNotice(null);
            setFlash(message);
            refresh();
          }}
        />
      )}

      {confirmApprove && (
        <div
          className="confirm-overlay"
          onMouseDown={(e) => e.target === e.currentTarget && setConfirmApprove(null)}
        >
          <div className="confirm-modal" role="alertdialog" aria-modal="true">
            <h3>Start a generation run?</h3>
            <p className="muted">
              This approves the topic and immediately starts research and writing for:
            </p>
            <p className="confirm-topic">“{confirmApprove.title}”</p>
            <p className="muted">Generation runs cost tokens - approve only when the brief is ready.</p>
            <div className="confirm-actions">
              <button className="btn secondary" onClick={() => setConfirmApprove(null)}>
                Cancel
              </button>
              <button
                className="btn violet"
                disabled={busy !== null}
                onClick={() => {
                  const topic = confirmApprove;
                  setConfirmApprove(null);
                  act(
                    () => api(`/api/topics/${topic.id}/approve`, { method: 'POST' }),
                    'approve-draft',
                    `Topic approved - “${topic.title}” is now generating.`,
                  );
                }}
              >
                Approve &amp; generate
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
