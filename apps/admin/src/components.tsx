import { describeApiError, type ApiError } from './api-error';
import {
  budgetMinutes,
  elapsedBand,
  fmtSeconds,
  OUT_OF_DATE_LABEL,
  type ElapsedBand,
} from './stages';

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
  // A run the budget stopped is not a run that failed: it has partial output
  // saved and a retry that is expected to work, so it never wears the filled
  // red of a failure. Dashed outline plus the clock glyph below.
  timed_out: 'timeout',
};

/**
 * Glyphs for the statuses whose colour is load-bearing, so the difference
 * survives a monochrome screen or a red/green colour deficiency.
 */
const STATUS_GLYPH: Record<string, string> = {
  timed_out: '⏱',
  failed: '✕',
  cancelled: '⊘',
};

export function Badge({ value }: { value: string }) {
  const glyph = STATUS_GLYPH[value];
  return (
    <span className={`badge ${STATUS_COLOR[value] ?? ''}`}>
      {glyph && <span aria-hidden="true">{glyph}</span>}
      {value.replace(/_/g, ' ')}
    </span>
  );
}

/** A stage whose stored output a retry has superseded. */
export function OutOfDateBadge() {
  return (
    <span className="badge outline-amber" title="Regenerated when the retry reaches this stage">
      {OUT_OF_DATE_LABEL}
    </span>
  );
}

const BAND_MARK: Record<ElapsedBand, string> = { normal: '·', warn: '▲', over: '⏱' };
const BAND_WORD: Record<ElapsedBand, string> = {
  normal: 'within the stage budget',
  warn: 'past half the stage budget',
  over: 'past the stage budget',
};

/**
 * An elapsed time against the budget its stage runs under. The band carries a
 * glyph and prints the budget next to the figure, so the warning never rests
 * on the colour alone - and a run that has been going for 2702 minutes cannot
 * render as an ordinary duration.
 *
 * A null budget is a run this panel cannot place on a stage - a topic search,
 * or an agent it does not know. That one prints as a plain duration: there is
 * no threshold it is measured against, and printing one would be a claim the
 * panel cannot make.
 */
export function Elapsed({
  seconds,
  budgetSeconds,
  status,
  meter = false,
}: {
  seconds: number;
  budgetSeconds: number | null;
  status?: string | null;
  meter?: boolean;
}) {
  if (budgetSeconds === null) {
    return (
      <span className="elapsed unbudgeted" title={`${fmtSeconds(seconds)} - no stage budget applies`}>
        <span className="t">{fmtSeconds(seconds)}</span>
      </span>
    );
  }
  const band = elapsedBand(seconds, budgetSeconds, status);
  const minutes = budgetMinutes(budgetSeconds);
  const filled = Math.min(100, Math.round((seconds / Math.max(budgetSeconds, 1)) * 100));
  return (
    <>
      <span className={`elapsed ${band}`} title={`${fmtSeconds(seconds)} - ${BAND_WORD[band]}`}>
        <span className="mark" aria-hidden="true">
          {BAND_MARK[band]}
        </span>
        <span className="t">{fmtSeconds(seconds)}</span>
        <span className="cap">/ {minutes}m</span>
      </span>
      {meter && (
        <span className={`meter ${band}`} aria-hidden="true">
          <i style={{ width: `${filled}%` }} />
        </span>
      )}
    </>
  );
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
