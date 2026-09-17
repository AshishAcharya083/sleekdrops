import type { Overview as OverviewData } from '../api';
import { duration, fmtCost, fmtTime, fmtTokens } from '../api';
import { ApiErrorBanner, Badge, Stat } from '../components';
import { usePoll } from '../hooks';

/** Human labels for the overview sections the agent reports as failed. */
const SECTION_LABELS: Record<string, string> = {
  topics: 'topic counts',
  articles: 'article counts',
  runningSessions: 'running agents',
  usage30d: '30-day usage',
  recentSessions: 'recent sessions',
  settings: 'publish settings',
};

export function Overview() {
  const { data, error } = usePoll<OverviewData>('/api/overview');
  // The landing screen keeps the last payload it loaded: a failing poll adds a
  // banner above the dashboard instead of emptying it, and only a first load
  // that has never succeeded shows the placeholder.
  if (!data) {
    return error ? <ApiErrorBanner error={error} /> : <p className="muted">Loading…</p>;
  }

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
  const failedSections = data.failedSections ?? [];
  const stale = (section: string) => failedSections.includes(section);
  /** A figure the agent could not load is shown as unknown, never as a zero. */
  const figure = (section: string, value: string | number) => (stale(section) ? '—' : value);

  return (
    <>
      <ApiErrorBanner error={error} />
      {failedSections.length > 0 && (
        <div className="warn-banner" role="status">
          The agent could not load {failedSections.map((s) => SECTION_LABELS[s] ?? s).join(', ')} -
          those figures show as unknown until it recovers.
        </div>
      )}

      <div className="grid cols-4">
        <Stat
          label="Suggested topics"
          value={figure('topics', topicCount('suggested'))}
          sub="awaiting your pick"
        />
        <Stat
          label="Articles in pipeline"
          value={figure('articles', activeArticles)}
          sub={
            stale('articles')
              ? 'not loaded'
              : `${waiting} awaiting publish approval · ${failed} failed`
          }
        />
        <Stat
          label="Agents running"
          value={figure('runningSessions', data.runningSessions)}
          sub={
            stale('settings')
              ? 'worker state not loaded'
              : data.workerEnabled
                ? 'worker enabled'
                : 'worker PAUSED'
          }
        />
        <Stat
          label="AI spend (30d)"
          value={figure('usage30d', fmtCost(data.usage30d.costUsd))}
          sub={
            stale('usage30d')
              ? 'not loaded'
              : `${data.usage30d.runs} runs · ${fmtTokens(data.usage30d.tokensInput)} in / ${fmtTokens(data.usage30d.tokensOutput)} out`
          }
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
                    {stale('recentSessions')
                      ? 'Recent sessions could not be loaded - the figures above are unaffected.'
                      : 'No sessions yet — run the topic scout from the Topics tab.'}
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
