const STATUS_COLOR: Record<string, string> = {
  done: 'green',
  published: 'green',
  approved: 'green',
  running: 'blue',
  queued: 'blue',
  suggested: 'blue',
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
