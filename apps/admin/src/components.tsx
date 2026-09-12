import { describeApiError, type ApiError } from './api-error';

const STATUS_COLOR: Record<string, string> = {
  done: 'green',
  published: 'green',
  approved: 'green',
  running: 'blue',
  queued: 'blue',
  suggested: 'blue',
  draft: 'gray',
  waiting_approval: 'amber',
  failed: 'red',
  rejected: 'red',
  cancelled: 'red',
};

export function Badge({ value }: { value: string }) {
  return <span className={`badge ${STATUS_COLOR[value] ?? ''}`}>{value.replace(/_/g, ' ')}</span>;
}

export function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="card">
      <h3>{label}</h3>
      <div className="big">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

/**
 * The banner every polling tab shows when a request fails. It renders above the
 * data the tab is already holding rather than replacing it, and the sentence
 * comes from the failure's kind, so a rejected admin token, a stopped agent and
 * a 5xx never read as the same problem.
 */
export function ApiErrorBanner({ error }: { error: ApiError | null }) {
  if (!error) return null;
  return (
    <div className="error-banner" role="alert">
      {describeApiError(error)}
    </div>
  );
}
