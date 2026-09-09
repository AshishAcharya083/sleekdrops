import type { Overview as OverviewData } from '../api';
import { duration, fmtCost, fmtTime, fmtTokens } from '../api';
import { Badge, Stat } from '../components';
import { usePoll } from '../hooks';

export function Overview() {
  const { data, error } = usePoll<OverviewData>('/api/overview');
  if (error) return <div className="error-banner">API unreachable: {error}</div>;
  if (!data) return <p className="muted">Loading…</p>;

  const topicCount = (status: string) =>
    Number(data.topics.find((t) => t.status === status)?.n ?? 0);
  const activeArticles = data.articles
    .filter((a) => a.stage !== 'done' && !['done', 'cancelled'].includes(a.status))
    .reduce((sum, a) => sum + Number(a.n), 0);
  const waiting = data.articles
    .filter((a) => a.status === 'waiting_approval')
    .reduce((sum, a) => sum + Number(a.n), 0);
  const failed = data.articles
    .filter((a) => a.status === 'failed')
    .reduce((sum, a) => sum + Number(a.n), 0);

  return (
    <>
      <div className="grid cols-4">
        <Stat label="Suggested topics" value={topicCount('suggested')} sub="awaiting your pick" />
        <Stat
          label="Articles in pipeline"
          value={activeArticles}
          sub={`${waiting} awaiting publish approval · ${failed} failed`}
        />
        <Stat label="Agents running" value={data.runningSessions} sub={data.workerEnabled ? 'worker enabled' : 'worker PAUSED'} />
        <Stat
          label="AI spend (30d)"
          value={fmtCost(data.usage30d.costUsd)}
          sub={`${data.usage30d.runs} runs · ${fmtTokens(data.usage30d.tokensInput)} in / ${fmtTokens(data.usage30d.tokensOutput)} out`}
        />
      </div>

      <div className="section">
        <h2>Recent agent sessions</h2>
        <div className="card table-scroll" tabIndex={0} role="region" aria-label="Recent agent sessions">
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Article</th>
                <th>Status</th>
                <th>Summary</th>
                <th>Model</th>
                <th>Cost</th>
                <th>Duration</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {data.recentSessions.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.agent}</td>
                  <td>{s.article_title ?? (s.scout_run_id ? 'topic sweep' : '—')}</td>
                  <td>
                    <Badge value={s.status} />
                  </td>
                  <td className="muted" style={{ maxWidth: 320 }}>
                    {s.error ?? s.summary ?? '…'}
                  </td>
                  <td className="mono muted">{s.model ?? '—'}</td>
                  <td className="mono">{fmtCost(s.cost_usd)}</td>
                  <td className="mono">{duration(s.started_at, s.ended_at)}</td>
                  <td className="muted">{fmtTime(s.started_at)}</td>
                </tr>
              ))}
              {data.recentSessions.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted">
                    No sessions yet — run the topic scout from the Topics tab.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
