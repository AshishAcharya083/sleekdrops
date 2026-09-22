import { useState } from 'react';
import { EVENTS, captureError, track } from '../analytics';
import type { ArticleList, Overview as OverviewData, StuckRun } from '../api';
import {
  api,
  budgetMinutes,
  elapsedBand,
  elapsedSeconds,
  fmtCost,
  fmtSeconds,
  fmtTime,
  fmtTokens,
  isStoppable,
  sessionBudgetSeconds,
  stopControlHint,
  stopControlLabel,
  stoppedNotice,
  stuckRuns,
  timedOutSentence,
  type ElapsedBand,
} from '../api';
import { toApiError, type ApiError } from '../api-error';
import { ApiErrorBanner, Badge, Elapsed, Stat } from '../components';
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

export function Overview({ onOpenRun }: { onOpenRun?: (articleId: string) => void }) {
  const { data, error, refresh } = usePoll<OverviewData>('/api/overview');
  // The triage surface is derived from the article list, not read off the
  // overview: the agent's overview reports counts, and it is the article list
  // that carries the claim, the lease and the stage budgets a run is slow or
  // stuck against. Polled here rather than lifted into the shell so the tab
  // keeps owning its own data, the way every other tab does.
  const board = usePoll<ArticleList>('/api/articles');
  // The landing screen keeps the last payload it loaded: a failing poll adds a
  // banner above the dashboard instead of emptying it, and only a first load
  // that has never succeeded shows the placeholder.
  if (!data) {
    return error ? <ApiErrorBanner error={error} /> : <NeedsAttentionSkeleton />;
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
  /**
   * The runs that need an operator, off the two payloads this tab already
   * holds: the article list decides which runs they are, and the recent
   * sessions name the agent behind each and carry the elapsed time of a run
   * whose claim was cleared as the budget stopped it.
   */
  const stuck = board.data
    ? stuckRuns(board.data.articles, data.recentSessions, board.data.budgets)
    : undefined;

  return (
    <>
      <ApiErrorBanner error={error ?? board.error} />
      {failedSections.length > 0 && (
        <div className="warn-banner" role="status">
          The agent could not load {failedSections.map((s) => SECTION_LABELS[s] ?? s).join(', ')} -
          those figures show as unknown until it recovers.
        </div>
      )}

      {/* First on screen on purpose: a wedged run is the one thing on this tab
          that will not fix itself, so it sits above the stat row. */}
      <NeedsAttention
        runs={stuck}
        failed={!board.data && Boolean(board.error)}
        onOpenRun={onOpenRun}
        onChanged={() => {
          refresh();
          board.refresh();
        }}
      />

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
                <th>Elapsed</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {data.recentSessions.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.agent}</td>
                  <td>{s.article_title ?? (s.scout_run_id ? 'topic search' : '—')}</td>
                  <td>
                    <Badge value={s.status} />
                  </td>
                  <td className="muted" style={{ maxWidth: 320 }}>
                    {s.error ?? s.summary ?? '…'}
                  </td>
                  <td className="mono muted">{s.model ?? '—'}</td>
                  <td className="mono">{fmtCost(s.cost_usd)}</td>
                  <td>
                    {/* Against the budget its stage runs under, so a run that
                        went 2702 minutes cannot read as an ordinary duration. */}
                    <Elapsed
                      seconds={elapsedSeconds(s.started_at, s.ended_at)}
                      budgetSeconds={sessionBudgetSeconds(s, board.data?.budgets)}
                      status={s.status}
                    />
                  </td>
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
        <p className="scroll-hint">
          The table scrolls sideways for model, cost, elapsed and started - drag it, or focus it and
          use the arrow keys.
        </p>
      </div>
    </>
  );
}

/** The groups the stuck surface splits into, in the order they are read. */
const STUCK_GROUPS: Array<{ key: string; title: string; match: (run: StuckRun) => boolean }> = [
  {
    key: 'timed_out',
    title: 'Timed out - stopped by the stage budget',
    match: (run) => run.status === 'timed_out',
  },
  {
    key: 'stalled',
    title: 'Stalled - the worker holding the claim stopped reporting',
    match: (run) => run.status !== 'timed_out' && Boolean(run.lease_expired),
  },
  {
    key: 'running',
    title: 'Running long - past the soft bound, nothing has stopped it',
    match: (run) => run.status !== 'timed_out' && !run.lease_expired,
  },
];

/**
 * Worst first, and stable: the surface polls every few seconds, and a row that
 * re-sorts between aiming and clicking is how an operator stops the wrong run.
 * Elapsed time only grows, so this order does not churn; the article id breaks
 * the ties the agent's own ordering would otherwise leave free.
 */
const byLongestRunning = (a: StuckRun, b: StuckRun): number =>
  (b.elapsed_seconds ?? 0) - (a.elapsed_seconds ?? 0) || a.article_id.localeCompare(b.article_id);

/**
 * Stuck / timed out, above the stat row. A run that has wedged is the only
 * thing on this tab that will not resolve itself, and the panel's whole
 * failure mode was that it read the same as a healthy one: a 2702-minute
 * session sat in the sessions table with an error of "…" and no way out.
 *
 * `runs` is the derived list, absent only until the article list has loaded
 * once. A list that could not be loaded at all is reported as unknown rather
 * than as an all-clear the panel never checked.
 */
function NeedsAttention({
  runs,
  failed,
  onOpenRun,
  onChanged,
}: {
  runs?: StuckRun[];
  failed: boolean;
  onOpenRun?: (articleId: string) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  /** Every run this surface has stopped, and the line reporting the last one. */
  const [stoppedIds, setStoppedIds] = useState<string[]>([]);
  const [notice, setNotice] = useState<{ articleId: string; text: string } | null>(null);

  /**
   * A single row is stopped on the click, with no confirmation in front of it:
   * a dialog on every row teaches the operator to dismiss dialogs, where a
   * line that names what was hit and links back into it makes a mis-click both
   * obvious and cheap to undo. Multi-row stops would be the case for a prompt;
   * this surface has none.
   */
  const stop = async (run: StuckRun) => {
    setBusy(run.article_id);
    setError(null);
    // The notice reports the last thing that happened, so it gives way to
    // whatever this click turns out to be - another stop, or its failure.
    setNotice(null);
    try {
      // The agent's own answer for "the stage has been asked to stop but has
      // not let go yet", under either of the names it has carried.
      const res = await api<{ cancelling?: boolean; pending?: boolean }>(
        `/api/articles/${run.article_id}/cancel`,
        { method: 'POST' },
      );
      // The hold is per run, not one slot: triaging three wedged runs in a row
      // must not put the first one's control back as if it had never been hit.
      setStoppedIds((ids) => (ids.includes(run.article_id) ? ids : [...ids, run.article_id]));
      setNotice({
        articleId: run.article_id,
        text: stoppedNotice(run.title, Boolean(res?.cancelling ?? res?.pending)),
      });
      track(EVENTS.articleActioned, {
        action: 'cancel',
        article_id: run.article_id,
        stage: run.stage ?? undefined,
        status: run.status,
        surface: 'overview-stuck',
      });
      onChanged();
    } catch (e) {
      captureError(e, { action: 'cancel', article_id: run.article_id, surface: 'overview-stuck' });
      setError(toApiError(e));
    } finally {
      setBusy(null);
    }
  };

  const open = (run: StuckRun) => {
    track(EVENTS.stuckRunOpened, {
      article_id: run.article_id,
      stage: run.stage ?? undefined,
      status: run.status,
      surface: 'overview-stuck',
    });
    onOpenRun?.(run.article_id);
  };

  /**
   * The way back in from the stop notice. The run has usually left the surface
   * by then - the stop is what took it off - so it is opened by id, and the
   * triage event still reports it rather than going unrecorded.
   */
  const openStopped = (articleId: string) => {
    const run = runs?.find((r) => r.article_id === articleId);
    if (run) return open(run);
    track(EVENTS.stuckRunOpened, { article_id: articleId, surface: 'overview-stuck' });
    onOpenRun?.(articleId);
  };

  // Nothing loaded and nothing failed is the first poll, not an all-clear.
  if (!runs && !failed) return <NeedsAttentionSkeleton />;

  if (failed) {
    return (
      <section className="attn neutral" aria-label="Stuck or timed out runs">
        <div className="attn-head">
          <h2>Stuck / timed out</h2>
        </div>
        <p className="attn-empty">
          The article list could not be read this time - this surface is unknown, not clear.
        </p>
      </section>
    );
  }

  if (!runs || runs.length === 0) {
    return (
      <section className="attn calm" aria-label="Stuck or timed out runs">
        <div className="attn-head">
          <h2>Stuck / timed out</h2>
          <span className="spacer" />
          <span className="badge green">all clear</span>
        </div>
        <p className="attn-empty">
          No run is past the soft bound of its stage budget, and nothing has been stopped by it.
        </p>
      </section>
    );
  }

  return (
    <section className="attn" aria-label="Stuck or timed out runs">
      <div className="attn-head">
        <h2>Stuck / timed out</h2>
        <span className="spacer" />
        <span className="badge red">
          {runs.length} run{runs.length === 1 ? '' : 's'} need{runs.length === 1 ? 's' : ''} you
        </span>
      </div>
      {error && (
        <div style={{ margin: '12px 16px 0' }}>
          <ApiErrorBanner error={error} />
        </div>
      )}
      {notice && (
        <div className="attn-toast notice-banner" role="status">
          <span className="line">{notice.text}</span>
          <button className="btn ghost small" onClick={() => openStopped(notice.articleId)}>
            Open run to re-run
          </button>
          <button className="btn ghost small" onClick={() => setNotice(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
      {STUCK_GROUPS.map((group) => {
        const rows = runs.filter(group.match).sort(byLongestRunning);
        if (rows.length === 0) return null;
        return (
          <div className="attn-group" key={group.key}>
            <h3>{group.title}</h3>
            {rows.map((run) => (
              <StuckRow
                key={run.session_id ?? run.article_id}
                run={run}
                busy={busy === run.article_id}
                stopping={stoppedIds.includes(run.article_id)}
                onOpen={() => open(run)}
                onStop={() => void stop(run)}
              />
            ))}
          </div>
        );
      })}
    </section>
  );
}

function StuckRow({
  run,
  busy,
  stopping,
  onOpen,
  onStop,
}: {
  run: StuckRun;
  busy: boolean;
  /** This row is the one the surface just stopped, and is waiting to let go. */
  stopping: boolean;
  onOpen: () => void;
  onStop: () => void;
}) {
  const budget = run.budget_seconds;
  const minutes = budgetMinutes(budget);
  // A run whose elapsed time is on no payload the panel holds still has a band:
  // one the budget stopped is over it by definition, and a live one would not
  // be on this surface unless it were at least at the soft bound.
  const band: ElapsedBand =
    run.elapsed_seconds === null
      ? run.status === 'timed_out'
        ? 'over'
        : 'warn'
      : elapsedBand(run.elapsed_seconds, budget, run.status);
  const ran = run.elapsed_seconds === null ? null : fmtSeconds(run.elapsed_seconds);
  const running = run.status === 'running';
  // State-gated: a run the budget already stopped has nothing left to stop, so
  // most rows carry no destructive target at all.
  const stoppable = isStoppable(run.status);
  const lapsed = ran ? `Running ${ran} on a lapsed claim` : 'Its claim has lapsed';
  const why =
    run.status === 'timed_out'
      ? timedOutSentence(budget)
      : run.lease_expired
        ? `${lapsed} - nothing is renewing it, and the next worker tick stops it on the budget.`
        : band === 'over'
          ? `Still running${ran ? ` ${ran}` : ''} into a ${minutes} minute budget - nothing has stopped it.`
          : `Past half of its ${minutes} minute budget and still running.`;

  return (
    <div className="attn-row">
      <div className="who">
        <div className="agent">
          {running && <span className="live" aria-hidden="true" />} {run.agent ?? 'agent unknown'}
          {run.stage ? ` · ${run.stage}` : ''}
        </div>
        <div className="title">{run.title}</div>
        <div className="why">{why}</div>
      </div>
      <div>
        <Elapsed
          seconds={run.elapsed_seconds}
          budgetSeconds={budget}
          status={run.status}
          meter
        />
      </div>
      <div>
        <Badge value={run.status} />
      </div>
      <div className="acts">
        {/* The visible label is the same on every row, so the accessible name
            carries the run - a list of identical "Open run" buttons is
            unusable read out on its own. */}
        <button className="btn small" aria-label={`Open run: ${run.title}`} onClick={onOpen}>
          Open run
        </button>
        {stoppable && (
          // Persistent, never hover-revealed, and held off the benign link by
          // its own margin: a destructive control that materialises under the
          // pointer, or sits a thumb's width from "Open run", is the mis-click.
          <button
            className="btn danger small"
            // A stage that has been asked to stop lets go asynchronously, and
            // the stuck payload cannot say so: the surface holds its own
            // control rather than inviting the same stop a second time.
            disabled={busy || stopping}
            aria-label={`${stopControlLabel(run.status)}: ${run.title}`}
            title={stopControlHint(run.status)}
            onClick={onStop}
          >
            <span aria-hidden="true">⊘</span>
            {busy || stopping ? 'Stopping…' : stopControlLabel(run.status)}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * First load. Sized to the real surface - 44px buttons, ~20px badges - so the
 * content that arrives does not shove the stat row down the page.
 */
function NeedsAttentionSkeleton() {
  return (
    <section className="attn neutral" aria-label="Stuck or timed out runs" aria-busy="true">
      <div className="attn-head">
        <h2>Stuck / timed out</h2>
        <span className="spacer" />
        <span className="skel" style={{ width: 92, height: 20 }} />
      </div>
      <div className="attn-group">
        {[0, 1].map((i) => (
          <div className="attn-row" key={i}>
            <div className="who">
              <span className="skel" style={{ width: 120 }} />
              <div className="title">
                <span className="skel" style={{ width: '70%', height: 14 }} />
              </div>
              <div className="why">
                <span className="skel" style={{ width: '90%' }} />
              </div>
            </div>
            <div>
              <span className="skel" style={{ width: 84 }} />
            </div>
            <div>
              <span className="skel" style={{ width: 84, height: 20 }} />
            </div>
            <div className="acts">
              <span className="skel" style={{ width: 96, height: 44 }} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
