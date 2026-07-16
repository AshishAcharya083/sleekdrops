import { useState } from 'react';
import type { Topic } from '../api';
import { api, fmtTime } from '../api';
import { Badge } from '../components';
import { usePoll } from '../hooks';

export function Topics() {
  const { data, error, refresh } = usePoll<{ topics: Topic[] }>('/api/topics');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const topics = data?.topics ?? [];
  const suggested = topics.filter((t) => t.status === 'suggested');
  const others = topics.filter((t) => t.status !== 'suggested');

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const act = async (fn: () => Promise<unknown>, label: string) => {
    setBusy(label);
    setNotice(null);
    try {
      await fn();
      setSelected(new Set());
      refresh();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {error && <div className="error-banner">API unreachable: {error}</div>}
      {notice && <div className="error-banner">{notice}</div>}

      <div className="row" style={{ marginBottom: 14 }}>
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

      <div className="section" style={{ marginTop: 0 }}>
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
                    <td>{t.title}</td>
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
    </>
  );
}
