import type { Session } from '../api';
import { duration, fmtCost, fmtTime, fmtTokens } from '../api';
import { Badge } from '../components';
import { usePoll } from '../hooks';

export function Sessions() {
  const { data, error } = usePoll<{ sessions: Session[] }>('/api/sessions?limit=100');
  const sessions = data?.sessions ?? [];

  return (
    <>
      {error && <div className="error-banner">API unreachable: {error}</div>}
      <div className="card table-scroll" tabIndex={0} role="region" aria-label="Agent sessions">
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Article</th>
              <th>Status</th>
              <th>Summary / error</th>
              <th>Model</th>
              <th>Tokens in/out</th>
              <th>Cost</th>
              <th>Duration</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id}>
                <td className="mono">{s.agent}</td>
                <td>{s.article_title ?? (s.scout_run_id ? 'topic sweep' : '—')}</td>
                <td>
                  <Badge value={s.status} />
                </td>
                <td className="muted" style={{ maxWidth: 340 }}>
                  {s.error ?? s.summary ?? '…'}
                </td>
                <td className="mono muted">{s.model ?? '—'}</td>
                <td className="mono">
                  {fmtTokens(s.tokens_input)} / {fmtTokens(s.tokens_output)}
                </td>
                <td className="mono">{fmtCost(s.cost_usd)}</td>
                <td className="mono">{duration(s.started_at, s.ended_at)}</td>
                <td className="muted">{fmtTime(s.started_at)}</td>
              </tr>
            ))}
            {sessions.length === 0 && (
              <tr>
                <td colSpan={9} className="muted">
                  No agent sessions yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
