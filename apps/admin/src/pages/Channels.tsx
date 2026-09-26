import { useCallback, useEffect, useRef, useState } from 'react';
import { EVENTS, captureError, track } from '../analytics';
import type {
  Channel,
  DistributionOverview,
  LinkPlacement,
  QueueFilter,
  QueueItem,
  QueueItemDetail,
  RecoveryOutcome,
} from '../api';
import { api, fmtTime } from '../api';
import {
  articleUrl,
  bulkOutcomeMessage,
  channelBadge,
  channelName,
  credentialLine,
  disconnectQueueNote,
  FILTERS,
  HOLD_REASON_COPY,
  PLACEMENT_HINT,
  PLACEMENT_LABEL,
  placementEditable,
  providerLabel,
  pruneSelection,
  queueStatusBadge,
  recoveryAction,
  rowReason,
  selectableIds,
  stalenessBanners,
  summariseSelection,
  tokenLeft,
  type BadgeSpec,
  type Tone,
} from '../channels';
import { ApiErrorBanner } from '../components';
import { usePoll } from '../hooks';

const BANNER_CLASS: Record<Tone, string> = {
  info: 'info-banner',
  warn: 'warn-banner',
  error: 'error-banner',
};

function StatusBadge({ spec, live = false }: { spec: BadgeSpec; live?: boolean }) {
  return (
    <span className={`badge ${spec.tone}`}>
      {live ? <span className="live" aria-hidden="true" /> : <span aria-hidden="true">{spec.glyph}</span>}
      {spec.label}
    </span>
  );
}

type Overlay =
  | { kind: 'connect'; provider: string | null }
  | { kind: 'replace'; channel: Channel }
  | { kind: 'disconnect'; channel: Channel }
  | null;

/**
 * Channels - every social account the platform posts to, whether its token is
 * about to lapse, and what its queue is doing. A list rather than a tab per
 * network: a second network is one more row, and everything below the list is
 * the selected channel's.
 */
export function Channels() {
  const { data, error, refresh } = usePoll<DistributionOverview>('/api/distribution', 15_000);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const channels = data?.channels ?? [];
  const selected =
    channels.find((channel) => channel.id === selectedId) ??
    channels.find((channel) => channel.status !== 'disabled') ??
    channels[0] ??
    null;
  const connectable = data?.connectable ?? [];
  // The poll failed but an earlier one succeeded: what is on screen is the
  // last known good list, and it is marked as such rather than faded.
  const stale = error !== null && data !== null;

  const onConnected = (channel: Channel, verb: string) => {
    setOverlay(null);
    setSelectedId(channel.id);
    setNotice(`${verb} ${providerLabel(channel.provider)} · ${channelName(channel)}.`);
    refresh();
  };

  return (
    <>
      <ApiErrorBanner error={error} onRetry={refresh} />
      {notice && (
        <div className="bulk-toast ok" role="status">
          <span className="bt-icon" aria-hidden="true">
            ✓
          </span>
          <span className="bt-msg">{notice}</span>
          <button className="btn ghost small" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      {stalenessBanners(channels).map(({ channel, banner }) => (
        <div key={channel.id} className={`${BANNER_CLASS[banner.tone]} banner-row`} role={banner.tone === 'info' ? 'status' : 'alert'}>
          <span className="banner-text">
            <strong>
              <span aria-hidden="true">{banner.glyph}</span> {banner.word}.
            </strong>{' '}
            {banner.headline}
            <span className="banner-sub">{banner.sub}</span>
          </span>
          <button className="btn secondary small" onClick={() => setOverlay({ kind: 'replace', channel })}>
            Replace token
          </button>
        </div>
      ))}

      <div className="section" style={{ marginTop: 0 }}>
        <div className="section-head">
          <h2>Channels</h2>
          {connectable.length > 0 && channels.length > 0 && (
            <button className="btn small" onClick={() => setOverlay({ kind: 'connect', provider: null })}>
              + Connect a channel
            </button>
          )}
        </div>

        {!data && !error && <ChannelSkeleton />}

        {!data && error && (
          <div className="card empty-channels">
            <p className="muted">The channel list could not be loaded. Nothing here has changed.</p>
          </div>
        )}

        {data && channels.length === 0 && (
          <div className="card empty-channels">
            <h3>No channels connected</h3>
            <p className="muted">
              Published articles are queued for every connected channel. Until one is connected, nothing
              is posted anywhere and nothing waits in a queue.
            </p>
            {connectable.length === 0 ? (
              <p className="muted">No network adapter is installed on the agent, so there is nothing to connect yet.</p>
            ) : (
              <div className="row">
                {connectable.map(({ provider }) => (
                  <button
                    key={provider}
                    className="btn"
                    onClick={() => setOverlay({ kind: 'connect', provider })}
                  >
                    Connect {providerLabel(provider)}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {channels.length > 0 && (
          <div className="chan-list" role="list" aria-label="Connected channels">
            {channels.map((channel) => (
              <ChannelRow
                key={channel.id}
                channel={channel}
                selected={channel.id === selected?.id}
                stale={stale}
                onSelect={() => setSelectedId(channel.id)}
                onReplace={() => setOverlay({ kind: 'replace', channel })}
                onDisconnect={() => setOverlay({ kind: 'disconnect', channel })}
                onReconnect={() => setOverlay({ kind: 'replace', channel })}
              />
            ))}
          </div>
        )}
        {stale && (
          <p className="muted stale-note">
            Showing the last list the agent returned - it could not be refreshed just now.
          </p>
        )}
      </div>

      {selected && (
        <>
          <ChannelSettings key={`settings-${selected.id}`} channel={selected} onSaved={refresh} />
          <QueuePanel key={`queue-${selected.id}`} channel={selected} onChanged={refresh} />
        </>
      )}

      {overlay?.kind === 'connect' && (
        <CredentialDrawer
          mode="connect"
          connectable={connectable}
          initialProvider={overlay.provider}
          onClose={() => setOverlay(null)}
          onDone={(channel) => onConnected(channel, 'Connected')}
        />
      )}
      {overlay?.kind === 'replace' && (
        <CredentialDrawer
          mode="replace"
          channel={overlay.channel}
          connectable={connectable}
          initialProvider={overlay.channel.provider}
          onClose={() => setOverlay(null)}
          onDone={(channel) => onConnected(channel, 'Token replaced for')}
        />
      )}
      {overlay?.kind === 'disconnect' && (
        <DisconnectModal
          channel={overlay.channel}
          onCancel={() => setOverlay(null)}
          onDone={(message) => {
            setOverlay(null);
            setNotice(message);
            refresh();
          }}
        />
      )}
    </>
  );
}

function ChannelSkeleton() {
  return (
    <div className="chan-list" aria-busy="true" aria-label="Loading channels">
      {[0, 1].map((n) => (
        <div key={n} className="chan-row">
          <span className="chan-glyph" aria-hidden="true" />
          <div className="chan-main">
            <span className="skel" style={{ width: '40%' }} />
            <span className="skel" style={{ width: '65%', marginTop: 8 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function ChannelRow({
  channel,
  selected,
  stale,
  onSelect,
  onReplace,
  onDisconnect,
  onReconnect,
}: {
  channel: Channel;
  selected: boolean;
  stale: boolean;
  onSelect: () => void;
  onReplace: () => void;
  onDisconnect: () => void;
  onReconnect: () => void;
}) {
  const badge = channelBadge(channel);
  const credential = credentialLine(channel);
  const label = providerLabel(channel.provider);
  const waiting = channel.counts.held + channel.counts.failed;
  return (
    <div
      role="listitem"
      className={`chan-row${selected ? ' selected' : ''}${stale ? ' stale' : ''}`}
    >
      <span className="chan-glyph" aria-hidden="true">
        {label.charAt(0)}
      </span>
      <div className="chan-main">
        <button
          className="chan-name"
          aria-pressed={selected}
          aria-label={`Show ${label} · ${channelName(channel)} settings and queue`}
          onClick={onSelect}
        >
          {channelName(channel)}
        </button>
        <div className="chan-meta">
          <span>{label}</span>
          <span className="mono">{channel.externalAccountId}</span>
          <StatusBadge spec={badge} />
          {channel.status === 'active' && (
            <span className={`tok ${channel.tokenTier}`} title={channel.token.expiresAt ? `expires ${fmtTime(channel.token.expiresAt)}` : 'no expiry reported'}>
              {tokenLeft(channel)}
            </span>
          )}
          {waiting > 0 && (
            <span className="chan-waiting">
              {channel.counts.held} held · {channel.counts.failed} failed
            </span>
          )}
        </div>
        <div className="secret">
          <span className={`state ${credential.state}`}>
            {credential.state === 'set' && <span aria-hidden="true">✓ </span>}
            {credential.state === 'missing' && <span aria-hidden="true">✕ </span>}
            {credential.label}
          </span>
          <span className="mono ref">{channel.tokenRef}</span>
          {(credential.when || credential.alert) && (
            <span className="when">
              {credential.when}
              {credential.when && credential.alert ? ' · ' : ''}
              {credential.alert && <span className="alert">{credential.alert}</span>}
            </span>
          )}
        </div>
        {!channel.adapterInstalled && (
          <p className="muted chan-note">
            This agent has no {label} adapter installed, so its queue waits rather than posting.
          </p>
        )}
      </div>
      <div className="chan-actions">
        {channel.status === 'disabled' ? (
          <button className="btn secondary small" onClick={onReconnect} disabled={!channel.adapterInstalled}>
            Reconnect
          </button>
        ) : (
          <>
            <button className="btn secondary small" onClick={onReplace} disabled={!channel.adapterInstalled}>
              Replace token
            </button>
            <button className="btn danger small" onClick={onDisconnect}>
              Disconnect
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The selected channel's placement. Written to the network's own setting
 * (`<provider>_link_placement`), which the Settings tab exposes as well.
 */
function ChannelSettings({ channel, onSaved }: { channel: Channel; onSaved: () => void }) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const label = providerLabel(channel.provider);
  const key = `${channel.provider}_link_placement`;
  const inherited = channel.placement.setting !== key;
  const selectId = `placement-${channel.id}`;

  const save = async (placement: LinkPlacement) => {
    setSaving(true);
    setSaved(false);
    setErr(null);
    try {
      await api('/api/settings', { method: 'PUT', body: JSON.stringify({ [key]: placement }) });
      track(EVENTS.channelActioned, { action: 'placement_default', provider: channel.provider, placement });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      onSaved();
    } catch (e) {
      captureError(e, { action: 'placement_default', provider: channel.provider, surface: 'channels' });
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const budget = channel.linkBudget;
  return (
    <div className="section">
      <h2>Distribution settings · {label}</h2>
      <div className="card">
        <div className="settings-grid">
          <label htmlFor={selectId}>Link placement for new {label} posts</label>
          <select
            id={selectId}
            value={channel.placement.value}
            disabled={saving}
            onChange={(e) => void save(e.target.value as LinkPlacement)}
          >
            <option value="first_comment">first comment - no link in the caption (recommended)</option>
            <option value="in_body">in body - link preview card, spends body-link budget</option>
          </select>
          {budget && (
            <>
              <span className="settings-label">Body links this month</span>
              <span>
                <span className="mono">
                  {budget.used} of {budget.cap}
                </span>{' '}
                {budget.exhausted ? (
                  <span className="budget-spent">
                    <span aria-hidden="true">▲</span> spent - in-body posts go to the first comment until next month
                  </span>
                ) : (
                  <span className="muted">used</span>
                )}
              </span>
            </>
          )}
        </div>
        <p className="muted settings-note">
          {PLACEMENT_HINT[channel.placement.value]}{' '}
          {inherited
            ? 'Currently inherited from the default placement in Settings → Distribution.'
            : 'Also under Settings → Distribution.'}{' '}
          Queued items keep the placement they were queued with; change one from its row.
          {saved && <span className="saved"> Saved ✓</span>}
        </p>
        {err && <div className="field-error">{err}</div>}
      </div>
    </div>
  );
}

type BulkAction = 'retry' | 'release';

function QueuePanel({ channel, onChanged }: { channel: Channel; onChanged: () => void }) {
  const [filter, setFilter] = useState<QueueFilter>('all');
  const { data, error, refresh } = usePoll<{ items: QueueItem[] }>(
    `/api/distribution/channels/${channel.id}/queue?status=${filter}`,
    10_000,
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<{ action: BulkAction; ids: string[] } | null>(null);
  const [openItem, setOpenItem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: 'ok' | 'partial'; glyph: string; text: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);

  const items = data?.items ?? [];
  const label = providerLabel(channel.provider);
  const eligible = selectableIds(items);
  const summary = summariseSelection(items, selected);
  const allSelected = eligible.length > 0 && eligible.every((id) => selected.has(id));
  const someSelected = summary.total > 0 && !allSelected;

  // A tick on a row the latest poll no longer shows as held or failed would
  // make the bar's count a lie.
  useEffect(() => {
    setSelected((current) => {
      const next = pruneSelection(data?.items ?? [], current);
      return next.size === current.size ? current : next;
    });
  }, [data]);

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected;
  }, [someSelected]);

  const changeFilter = (next: QueueFilter) => {
    setFilter(next);
    setSelected(new Set());
  };

  const toggle = (id: string, on: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const afterMove = () => {
    refresh();
    onChanged();
  };

  const recover = async (action: BulkAction, ids: string[]) => {
    setErr(null);
    setToast(null);
    setBusy(ids.length === 1 ? ids[0] : 'bulk');
    try {
      const outcome =
        ids.length === 1
          ? await api<{ item: QueueItem }>(`/api/distribution/items/${ids[0]}/${action}`, { method: 'POST' }).then(
              (): RecoveryOutcome => ({ updated: ids, skipped: [] }),
            )
          : await api<RecoveryOutcome>('/api/distribution/items/bulk', {
              method: 'POST',
              body: JSON.stringify({ action, ids }),
            });
      track(EVENTS.distributionItemActioned, {
        action: ids.length === 1 ? action : `bulk_${action}`,
        provider: channel.provider,
        count: outcome.updated.length,
      });
      setToast(bulkOutcomeMessage(action, outcome));
      setSelected(new Set());
      afterMove();
    } catch (e) {
      captureError(e, { action: `distribution_${action}`, provider: channel.provider, surface: 'channels' });
      setErr((e as Error).message);
      refresh();
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  };

  const regionLabel = `${label} · ${channelName(channel)} distribution queue`;
  return (
    <div className="section">
      <h2>Distribution queue · {label}</h2>
      <ApiErrorBanner error={error} onRetry={refresh} />
      {err && <div className="error-banner">{err}</div>}
      {toast && (
        <div className={`bulk-toast ${toast.tone}`} role="status">
          <span className="bt-icon" aria-hidden="true">
            {toast.glyph}
          </span>
          <span className="bt-msg">{toast.text}</span>
          <button className="btn ghost small" onClick={() => setToast(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="chips" role="group" aria-label="Filter the queue by status">
        {FILTERS.map(({ value, label: chip }) => (
          <button
            key={value}
            className="chip"
            aria-pressed={filter === value}
            onClick={() => changeFilter(value)}
          >
            {chip} <span className="chip-n">{channel.counts[value]}</span>
          </button>
        ))}
      </div>

      {summary.total > 0 && (
        <div className="bulkbar" role="toolbar" aria-label="Bulk actions for the selected items">
          <span className="bb-count">
            <strong>{summary.total} selected</strong>
            <span className="muted">
              {' '}
              · {summary.failed.length} failed, {summary.held.length} held
            </span>
          </span>
          <div className="bb-actions">
            <button
              className="btn small"
              disabled={summary.failed.length === 0 || busy !== null}
              onClick={() => setConfirming({ action: 'retry', ids: summary.failed })}
            >
              Retry failed ({summary.failed.length})
            </button>
            <button
              className="btn secondary small"
              disabled={summary.held.length === 0 || busy !== null}
              onClick={() => setConfirming({ action: 'release', ids: summary.held })}
            >
              Release held ({summary.held.length})
            </button>
            <button className="btn ghost small" onClick={() => setSelected(new Set())}>
              Clear selection
            </button>
          </div>
        </div>
      )}

      <div className="queue-card">
        <div className="card table-scroll" tabIndex={0} role="region" aria-label={regionLabel}>
          <table>
            <thead>
              <tr>
                <th className="chk">
                  <label className="chk-hit">
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      className="row-check"
                      id={`select-all-${channel.id}`}
                      aria-label="Select all held and failed items shown by the current filter"
                      checked={allSelected}
                      disabled={eligible.length === 0}
                      onChange={(e) => setSelected(e.target.checked ? new Set(eligible) : new Set())}
                    />
                  </label>
                </th>
                <th>Article</th>
                <th>Status</th>
                <th>Placement</th>
                <th>Attempts</th>
                <th>Reason / last error</th>
                <th>Post</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {!data && !error && (
                <tr>
                  <td colSpan={8}>
                    <span className="skel" style={{ width: '60%' }} />
                  </td>
                </tr>
              )}
              {items.map((item) => (
                <QueueRow
                  key={item.id}
                  item={item}
                  checked={selected.has(item.id)}
                  busy={busy === item.id || busy === 'bulk'}
                  onToggle={(on) => toggle(item.id, on)}
                  onRecover={(action) => void recover(action, [item.id])}
                  onOpen={() => setOpenItem(item.id)}
                />
              ))}
              {data && items.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                    {filter === 'all'
                      ? 'nothing queued for this channel yet - published articles appear here'
                      : `no ${FILTERS.find((f) => f.value === filter)?.label.toLowerCase()} items`}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <p className="scroll-hint">Scroll the table sideways for placement and errors - the actions stay pinned on the right.</p>

      {confirming && (
        <BulkConfirm
          action={confirming.action}
          count={confirming.ids.length}
          channel={channel}
          busy={busy === 'bulk'}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void recover(confirming.action, confirming.ids)}
        />
      )}
      {openItem && (
        <ItemDrawer
          id={openItem}
          channel={channel}
          onClose={() => setOpenItem(null)}
          onChanged={afterMove}
        />
      )}
    </div>
  );
}

function QueueRow({
  item,
  checked,
  busy,
  onToggle,
  onRecover,
  onOpen,
}: {
  item: QueueItem;
  checked: boolean;
  busy: boolean;
  onToggle: (on: boolean) => void;
  onRecover: (action: BulkAction) => void;
  onOpen: () => void;
}) {
  const action = recoveryAction(item);
  const reason = rowReason(item);
  const title = item.title ?? item.slug;
  const resolvedAway = item.payload.renderedAt && item.payload.placement !== item.placement;
  return (
    <tr>
      <td className="chk">
        <label className="chk-hit">
          <input
            type="checkbox"
            className="row-check"
            aria-label={
              action
                ? `Select ${title}`
                : `${title} - nothing to retry or release${item.holdReason === 'site_not_ready' ? ', it retries by itself' : ''}`
            }
            checked={checked}
            disabled={!action}
            onChange={(e) => onToggle(e.target.checked)}
          />
        </label>
      </td>
      <td className="q-title">
        <span className="q-headline">{title}</span>
        <a className="mono q-slug" href={articleUrl(item.slug)} target="_blank" rel="noreferrer">
          {item.slug}
        </a>
      </td>
      <td>
        <StatusBadge spec={queueStatusBadge(item)} live={item.status === 'posting'} />
      </td>
      <td>
        <span className="q-placement">{PLACEMENT_LABEL[item.placement]}</span>
        {resolvedAway && (
          <span className="muted q-sub">composed {PLACEMENT_LABEL[item.payload.placement].toLowerCase()}</span>
        )}
      </td>
      <td className="mono">{item.attempts}</td>
      <td className="q-reason">
        {reason.heading && (
          <span className={`reason-head ${reason.kind}`}>
            <span aria-hidden="true">{reason.glyph}</span> {reason.heading}
          </span>
        )}
        {reason.detail && <span className={`reason-detail${reason.kind === 'error' ? ' mono' : ''}`}>{reason.detail}</span>}
        {reason.kind === 'none' && <span className="muted">—</span>}
      </td>
      <td>
        {item.remoteUrl ? (
          <a className="q-post" href={item.remoteUrl} target="_blank" rel="noreferrer">
            View post ↗
          </a>
        ) : (
          <span className="muted">{item.postedAt ? fmtTime(item.postedAt) : '—'}</span>
        )}
      </td>
      <td>
        <div className="q-actions">
          {action === 'retry' && (
            <button className="btn secondary small" disabled={busy} onClick={() => onRecover('retry')}>
              {busy ? 'retrying…' : 'Retry'}
            </button>
          )}
          {action === 'release' && (
            <button className="btn secondary small" disabled={busy} onClick={() => onRecover('release')}>
              {busy ? 'releasing…' : 'Release'}
            </button>
          )}
          <button className="btn ghost small" onClick={onOpen} aria-label={`Open ${title}`}>
            Open
          </button>
        </div>
      </td>
    </tr>
  );
}

function BulkConfirm({
  action,
  count,
  channel,
  busy,
  onCancel,
  onConfirm,
}: {
  action: BulkAction;
  count: number;
  channel: Channel;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const items = `${count} ${action === 'retry' ? 'failed' : 'held'} item${count === 1 ? '' : 's'}`;
  const blocked = channel.status !== 'active' || channel.tokenTier === 'expired';
  return (
    <div className="confirm-overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="confirm-modal wide" role="alertdialog" aria-modal="true" aria-label={`${action === 'retry' ? 'Retry' : 'Release'} ${items}`}>
        <h3>
          {action === 'retry' ? 'Retry' : 'Release'} {items}?
        </h3>
        <p>
          {action === 'retry'
            ? 'Each goes back in the queue now with a fresh round of five attempts and a fresh wait for the live page. The last error stays on the row until the next attempt replaces it.'
            : 'Each goes back in the queue now. If nothing has changed - no new image, the same spent budget - the network ladder will hold it again on its next attempt.'}
        </p>
        {blocked && (
          <p className="budget-spent">
            <span aria-hidden="true">▲</span> This channel cannot post until its token is replaced, so these wait in
            the queue until then.
          </p>
        )}
        <div className="confirm-actions">
          <button className="btn secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn" onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : `${action === 'retry' ? 'Retry' : 'Release'} ${count}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function ItemDrawer({
  id,
  channel,
  onClose,
  onChanged,
}: {
  id: string;
  channel: Channel;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<QueueItemDetail | null>(null);
  const [placement, setPlacement] = useState<LinkPlacement | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api<QueueItemDetail>(`/api/distribution/items/${id}`)
        .then((next) => {
          setDetail(next);
          setPlacement(next.item.placement);
        })
        .catch((e: unknown) => {
          captureError(e, { action: 'distribution_item_load', surface: 'channels' });
          setError((e as Error).message);
        }),
    [id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const item = detail?.item ?? null;
  const action = item ? recoveryAction(item) : null;
  const editable = item ? placementEditable(item) : false;
  const title = item ? (item.title ?? item.slug) : 'Queue item';

  const run = async (what: 'placement' | BulkAction) => {
    if (!item) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      if (what === 'placement' && placement) {
        await api(`/api/distribution/items/${item.id}/placement`, {
          method: 'PUT',
          body: JSON.stringify({ placement }),
        });
        setStatus(`Placement set to ${PLACEMENT_LABEL[placement].toLowerCase()} - the post is composed afresh on its next attempt.`);
      } else if (what !== 'placement') {
        await api(`/api/distribution/items/${item.id}/${what}`, { method: 'POST' });
        setStatus(what === 'retry' ? 'Back in the queue with a fresh round of attempts.' : 'Released - back in the queue.');
      }
      track(EVENTS.distributionItemActioned, {
        action: what,
        provider: channel.provider,
        count: 1,
        placement: what === 'placement' ? (placement ?? undefined) : undefined,
      });
      await load();
      onChanged();
    } catch (e) {
      captureError(e, { action: `distribution_${what}`, provider: channel.provider, surface: 'channels' });
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reason = item ? rowReason(item) : null;
  return (
    <div className="drawer-overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="drawer wide" role="dialog" aria-modal="true" aria-label={title}>
        <div className="drawer-head">
          <div className="htext">
            <h2>
              {title}
              {item && <StatusBadge spec={queueStatusBadge(item)} live={item.status === 'posting'} />}
            </h2>
            <p>
              {providerLabel(channel.provider)} · {channelName(channel)}
              {item && (
                <>
                  {' · '}
                  <span className="mono">{item.slug}</span>
                </>
              )}
            </p>
          </div>
          <button className="close-x" aria-label="Close" onClick={onClose} disabled={busy}>
            ×
          </button>
        </div>

        <div className="drawer-body">
          {!detail && !error && <span className="skel" style={{ width: '70%' }} />}
          {error && <div className="error-banner">{error}</div>}
          {item && reason && reason.kind !== 'none' && (
            <div className={`reason-card ${reason.kind}`}>
              {reason.heading && (
                <strong>
                  <span aria-hidden="true">{reason.glyph}</span> {reason.heading}
                </strong>
              )}
              {item.holdReason && <p>{HOLD_REASON_COPY[item.holdReason].detail}</p>}
              {reason.detail && <pre>{reason.detail}</pre>}
            </div>
          )}

          {item && (
            <>
              <div className="field">
                <label id={`placement-label-${item.id}`}>
                  Placement <span className="opt">{editable ? 'change before it is sent' : 'fixed - already sent or sending'}</span>
                </label>
                <div className="placement-options" role="radiogroup" aria-labelledby={`placement-label-${item.id}`}>
                  {(['first_comment', 'in_body'] as const).map((value) => (
                    <label key={value} className={`placement-option${placement === value ? ' on' : ''}`}>
                      <input
                        type="radio"
                        name={`placement-${item.id}`}
                        value={value}
                        checked={placement === value}
                        disabled={!editable || busy}
                        onChange={() => setPlacement(value)}
                      />
                      <span>
                        <b>{PLACEMENT_LABEL[value]}</b>
                        <span className="hint">{PLACEMENT_HINT[value]}</span>
                      </span>
                    </label>
                  ))}
                </div>
                {item.payload.renderedAt && item.payload.placement !== item.placement && (
                  <p className="hint">
                    Composed as {PLACEMENT_LABEL[item.payload.placement].toLowerCase()}: the renderer could not keep the
                    placement it was queued with.
                  </p>
                )}
              </div>

              <dl className="item-facts">
                <dt>Attempts</dt>
                <dd className="mono">{item.attempts} of 5</dd>
                <dt>{item.status === 'posted' ? 'Posted' : 'Due'}</dt>
                <dd>{fmtTime(item.status === 'posted' ? item.postedAt : item.scheduledAt)}</dd>
                <dt>Image</dt>
                <dd>
                  {item.payload.imageUrl
                    ? 'an image we may upload natively'
                    : item.payload.imageSource
                      ? `none we may upload (the hero is ${item.payload.imageSource === 'found' ? 'a found photograph' : 'an operator upload'})`
                      : 'no hero image'}
                </dd>
                <dt>Post</dt>
                <dd>
                  {item.remoteUrl ? (
                    <a href={item.remoteUrl} target="_blank" rel="noreferrer">
                      View on {providerLabel(channel.provider)} ↗
                    </a>
                  ) : (
                    <span className="muted">not posted yet</span>
                  )}
                </dd>
              </dl>

              <div className="field">
                <label>
                  Caption <span className="opt">{item.payload.renderedAt ? 'as it will be sent' : 'baseline - composed on the first attempt'}</span>
                </label>
                <pre>{item.payload.caption}</pre>
              </div>

              <div className="field">
                <label>Insights</label>
                <div className="card table-scroll" tabIndex={0} role="region" aria-label="Insights readings for this post">
                  <table>
                    <thead>
                      <tr>
                        <th>Read at</th>
                        <th>Impressions</th>
                        <th>Clicks</th>
                        <th>Reactions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail!.metrics.map((m) => (
                        <tr key={m.fetched_at}>
                          <td>{fmtTime(m.fetched_at)}</td>
                          <td className="mono">{m.impressions ?? '—'}</td>
                          <td className="mono">{m.clicks ?? '—'}</td>
                          <td className="mono">{m.reactions ?? '—'}</td>
                        </tr>
                      ))}
                      {detail!.metrics.length === 0 && (
                        <tr>
                          <td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 16 }}>
                            no readings yet - the first is taken an hour after the post lands
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="drawer-foot">
          <span className="foot-status muted" role="status">
            {status}
          </span>
          <div className="action-group" style={{ marginLeft: 'auto' }}>
            <button className="btn secondary" onClick={onClose} disabled={busy}>
              Close
            </button>
            {item && editable && placement !== item.placement && (
              <button className="btn secondary" onClick={() => void run('placement')} disabled={busy}>
                Save placement
              </button>
            )}
            {action && (
              <button className="btn" onClick={() => void run(action)} disabled={busy}>
                {action === 'retry' ? 'Retry now' : 'Release now'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Connect a channel, or replace the token behind one. The token field is a
 * password input, it is cleared the moment the request settles, and nothing the
 * agent answers with can contain it: the readback is presence only.
 */
function CredentialDrawer({
  mode,
  channel,
  connectable,
  initialProvider,
  onClose,
  onDone,
}: {
  mode: 'connect' | 'replace';
  channel?: Channel;
  connectable: DistributionOverview['connectable'];
  initialProvider: string | null;
  onClose: () => void;
  onDone: (channel: Channel) => void;
}) {
  const [provider, setProvider] = useState(initialProvider ?? connectable[0]?.provider ?? '');
  const [token, setToken] = useState('');
  const [tokenRef, setTokenRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = providerLabel(provider);
  const defaultRef = connectable.find((entry) => entry.provider === provider)?.defaultTokenRef ?? `${provider}-token`;
  const reconnecting = mode === 'replace' && channel?.status === 'disabled';
  // Without a pasted token the agent needs a secret it can already read: a
  // name typed here, or - reconnecting - the one the deployment still mounts.
  const namedSecret =
    mode === 'connect' ? tokenRef.trim() !== '' : reconnecting && channel?.credential.source === 'environment';
  const canSubmit = !busy && provider !== '' && (token.trim() !== '' || namedSecret);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      // A pasted token for an existing channel always goes through the replace
      // route, which refuses a token for a different account and brings a
      // disconnected channel back. Only a reconnect with nothing pasted - the
      // deployment still mounts the secret - is a connect by name.
      const byName = mode === 'connect' || token.trim() === '';
      const res = byName
        ? await api<{ channel: Channel }>('/api/distribution/channels', {
            method: 'POST',
            body: JSON.stringify({
              provider,
              token: token.trim() || undefined,
              tokenRef: (mode === 'connect' ? tokenRef.trim() : channel?.tokenRef) || undefined,
            }),
          })
        : await api<{ channel: Channel }>(`/api/distribution/channels/${channel!.id}/credential`, {
            method: 'PUT',
            body: JSON.stringify({ token: token.trim() }),
          });
      track(EVENTS.channelActioned, {
        action: mode === 'connect' ? 'connect' : reconnecting ? 'reconnect' : 'replace_token',
        provider,
        status: res.channel.status,
        value_present: token.trim() !== '',
      });
      onDone(res.channel);
    } catch (e) {
      captureError(e, { action: `channel_${mode}`, provider, surface: 'channels' });
      setError((e as Error).message);
    } finally {
      // Never keep the pasted value around longer than the request that needed it.
      setToken('');
      setBusy(false);
    }
  };

  const heading =
    mode === 'connect'
      ? `Connect ${label || 'a channel'}`
      : reconnecting
        ? `Reconnect ${label} · ${channelName(channel!)}`
        : `Replace the ${label} token`;

  return (
    <div className="drawer-overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="drawer" role="dialog" aria-modal="true" aria-label={heading}>
        <div className="drawer-head">
          <div className="htext">
            <h2>{heading}</h2>
            <p>
              {mode === 'connect'
                ? 'Paste an access token for the account to post as. It is checked with the network before anything is saved, so a wrong or under-scoped token is refused here rather than failing every post.'
                : `Paste the new token for ${channel ? channelName(channel) : 'this channel'}. It must post as the same account (${channel?.externalAccountId}); a token for a different account is a new channel.`}
            </p>
          </div>
          <button className="close-x" aria-label="Close" onClick={onClose} disabled={busy}>
            ×
          </button>
        </div>

        <div className="drawer-body">
          {mode === 'connect' && connectable.length > 1 && (
            <div className="field">
              <label htmlFor="connect-provider">Network</label>
              <select
                id="connect-provider"
                className="select"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                disabled={busy}
              >
                {connectable.map((entry) => (
                  <option key={entry.provider} value={entry.provider}>
                    {providerLabel(entry.provider)}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="field">
            <label htmlFor="connect-token">
              Access token {mode === 'connect' ? <span className="opt">or name a mounted secret below</span> : <span className="req">required</span>}
            </label>
            <input
              id="connect-token"
              className="input mono"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="paste the token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={busy}
            />
            <p className="hint">
              Never shown again: the panel only ever reads back whether a token is stored and where it came from.
            </p>
          </div>

          {mode === 'connect' && (
            <div className="field">
              <label htmlFor="connect-ref">
                Secret name <span className="opt">optional</span>
              </label>
              <input
                id="connect-ref"
                className="input mono"
                placeholder={defaultRef}
                value={tokenRef}
                onChange={(e) => setTokenRef(e.target.value)}
                disabled={busy}
              />
              <p className="hint">
                The name the token is stored under. It starts with <span className="mono">{provider}-</span> or{' '}
                <span className="mono">channel-</span>, and each account needs its own - a name another channel
                already uses is refused. Leave the token empty and name a secret the deployment already
                mounts (for example <span className="mono">{defaultRef}</span> → <span className="mono">{defaultRef.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}</span>)
                to connect without pasting it here.
              </p>
            </div>
          )}

          <div className="callout">
            <span className="ci" aria-hidden="true">
              ⓘ
            </span>
            <span>
              Pasted tokens are kept in the platform database under the secret name, never in a log, a queue error
              or anything this panel receives. Disconnecting deletes a pasted token.
            </span>
          </div>
          {error && (
            <div className="field-error" role="alert">
              <span aria-hidden="true">✕</span> {error}
            </div>
          )}
        </div>

        <div className="drawer-foot">
          <div className="action-group" style={{ marginLeft: 'auto' }}>
            <button className="btn secondary" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button className="btn" onClick={() => void submit()} disabled={!canSubmit}>
              {busy ? 'Checking…' : mode === 'connect' ? 'Connect' : reconnecting ? 'Reconnect' : 'Replace token'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function DisconnectModal({
  channel,
  onCancel,
  onDone,
}: {
  channel: Channel;
  onCancel: () => void;
  onDone: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = `${providerLabel(channel.provider)} · ${channelName(channel)}`;
  const queueNote = disconnectQueueNote(channel.counts);

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ credentialRemoved: boolean; environmentSecret: boolean }>(
        `/api/distribution/channels/${channel.id}`,
        { method: 'DELETE' },
      );
      track(EVENTS.channelActioned, { action: 'disconnect', provider: channel.provider, status: 'disabled' });
      onDone(
        `Disconnected ${label}.` +
          (res.credentialRemoved ? ' The pasted token was deleted.' : '') +
          (res.environmentSecret
            ? ` The token still comes from the deployment's secret store (${channel.tokenRef}) - remove it there if it should go too.`
            : ''),
      );
    } catch (e) {
      captureError(e, { action: 'channel_disconnect', provider: channel.provider, surface: 'channels' });
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="confirm-overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="confirm-modal" role="alertdialog" aria-modal="true" aria-label={`Disconnect ${label}`}>
        <h3>Disconnect {label}?</h3>
        <p>Nothing more is posted to this account, and new articles are not queued for it.</p>
        <p className="muted">
          {queueNote && `${queueNote} `}
          Posting history and insights are kept.
          {channel.credential.source === 'panel' ? ' The pasted token is deleted.' : ''}
        </p>
        {error && <div className="field-error">{error}</div>}
        <div className="confirm-actions">
          <button className="btn secondary" onClick={onCancel} disabled={busy}>
            Keep connected
          </button>
          <button className="btn danger" onClick={() => void disconnect()} disabled={busy}>
            {busy ? 'Disconnecting…' : 'Disconnect'}
          </button>
        </div>
      </div>
    </div>
  );
}
