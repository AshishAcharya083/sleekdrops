import { useState } from 'react';
import { EVENTS, captureError, track } from '../analytics';
import type {
  OfferCoverageResponse,
  OfferCoverageRow,
  OfferProvenance,
  ProductOfferRevision,
} from '../api';
import { api } from '../api';
import type { ApiError } from '../api-error';
import { ApiErrorBanner } from '../components';
import { usePoll } from '../hooks';
import {
  countErrors,
  formatOfferPrice,
  OFFER_CURRENCIES,
  offerPayload,
  offerPreview,
  validateOfferDraft,
  type OfferDraft,
  type OfferErrors,
} from '../offers';
import '../offers.css';

/**
 * Offer coverage for one card, the per-offer editor, and the reader preview.
 *
 * Why these screens exist: a product announced this morning carries no
 * affiliate-feed row and cannot be read through Amazon's Product Advertising
 * API, so nothing automatic can give it a destination or a price. An editor
 * can, in about a minute, and these screens are that minute - plus the part
 * that matters afterwards, which is being able to see before publishing which
 * products in a card still have nothing behind them.
 */
export function Offers({
  articleId,
  onClose,
  onChanged,
}: {
  articleId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { data, error, refresh } = usePoll<OfferCoverageResponse>(
    `/api/articles/${articleId}/offers`,
  );
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const rows = data?.coverage.rows ?? [];
  const openRow = rows.find((row) => row.goSlug === openSlug) ?? null;

  const saved = () => {
    refresh();
    onChanged();
  };

  return (
    <div className="offers-surface">
      <div className="stage">
        <aside className="board-behind" aria-hidden="true">
          <OfferLane rows={rows} openSlug={openSlug} />
        </aside>
        {previewing ? (
          <ReaderPreview
            data={data}
            onBack={() => setPreviewing(false)}
            onClose={onClose}
          />
        ) : openRow ? (
          <OfferEditor
            key={openRow.goSlug}
            articleId={articleId}
            row={openRow}
            history={data?.history[openRow.goSlug] ?? []}
            today={data?.today ?? new Date().toISOString().slice(0, 10)}
            onSaved={saved}
            onClose={() => setOpenSlug(null)}
          />
        ) : (
          <CoverageScreen
            articleId={articleId}
            data={data}
            error={error}
            actionError={actionError}
            onRetry={refresh}
            onEdit={setOpenSlug}
            onPreview={() => setPreviewing(true)}
            onClose={onClose}
            onActed={saved}
            onActionError={setActionError}
          />
        )}
      </div>
    </div>
  );
}

/** The context column: the card's products, with the open one marked. */
function OfferLane({ rows, openSlug }: { rows: OfferCoverageRow[]; openSlug: string | null }) {
  const shown = rows.slice(0, 3);
  const rest = rows.slice(3);
  return (
    <div className="lane">
      <h4>
        Offers <span className="count">{rows.length}</span>
      </h4>
      {shown.map((row) => (
        <div
          className={`cardlet${row.goSlug === openSlug ? ' is-open' : ''}`}
          key={row.goSlug}
        >
          <div>{row.productName}</div>
          <div className="meta">
            <SourceChip row={row} />
          </div>
        </div>
      ))}
      {rows.length === 0 && (
        <p className="muted" style={{ padding: '4px 6px', fontSize: 12 }}>
          no products yet
        </p>
      )}
      {/* The header count and the visible list have to agree; the rest are
          named rather than silently dropped. */}
      {rest.length > 0 && (
        <p className="lane-more">
          + {rest.length} more not shown ({rest.map((row) => row.productName).join(', ')})
        </p>
      )}
    </div>
  );
}

const CHIP_TITLE: Record<OfferProvenance, string> = {
  editor: 'Attached by an editor — outranks everything the pipeline builds itself.',
  resolved: 'The product page its ASIN names, on the marketplace that ASIN belongs to.',
  healed: 'A search link. It never 404s, but it is not this product’s page.',
  none: 'Nothing is attached: this product has no destination of its own.',
};

function SourceChip({ row }: { row: OfferCoverageRow }) {
  return (
    <span className={`source-chip ${row.provenance}`} title={CHIP_TITLE[row.provenance]}>
      <i aria-hidden="true" />
      {row.label}
    </span>
  );
}

/** The action a row offers, which is a different verb in each state. */
function rowAction(row: OfferCoverageRow): string {
  if (!row.offer) return row.provenance === 'resolved' ? 'Override' : 'Attach offer';
  return row.price ? 'Edit offer' : 'Add price';
}

function CoverageScreen({
  articleId,
  data,
  error,
  actionError,
  onRetry,
  onEdit,
  onPreview,
  onClose,
  onActed,
  onActionError,
}: {
  articleId: string;
  data: OfferCoverageResponse | null;
  error: ApiError | null;
  actionError: string | null;
  onRetry: () => void;
  onEdit: (slug: string) => void;
  onPreview: () => void;
  onClose: () => void;
  onActed: () => void;
  onActionError: (message: string | null) => void;
}) {
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const rows = data?.coverage.rows ?? [];
  const uncovered = rows.filter((row) => row.provenance === 'healed' || row.provenance === 'none');
  const pending = rows.filter((row) => row.pending);
  const article = data?.article;
  const awaitingApproval = article?.status === 'waiting_approval';

  const act = async (path: string, action: string) => {
    setBusy(true);
    onActionError(null);
    try {
      await api(`/api/articles/${articleId}/${path}`, { method: 'POST' });
      track(EVENTS.articleActioned, {
        action,
        article_id: articleId,
        stage: article?.stage,
        status: article?.status,
      });
      onActed();
    } catch (e) {
      captureError(e, { action, article_id: articleId, surface: 'offers' });
      onActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sendBack = async (text: string) => {
    setBusy(true);
    onActionError(null);
    try {
      await api(`/api/articles/${articleId}/feedback`, {
        method: 'POST',
        body: JSON.stringify({ feedback: text }),
      });
      track(EVENTS.articleFeedbackSubmitted, {
        article_id: articleId,
        feedback_length: text.length,
        stage: article?.stage,
      });
      setNote(null);
      onActed();
    } catch (e) {
      captureError(e, { action: 'article_feedback', article_id: articleId, surface: 'offers' });
      onActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="detail-panel">
      <div className="panel-head">
        <div className="htext">
          <h2>Offer coverage</h2>
          <div className="sub">
            {article && <span className="badge">{article.stage.replace(/_/g, ' ')}</span>}
            {article && <span className="badge">{article.status.replace(/_/g, ' ')}</span>}
            <span className="mono muted">{article?.slug ?? 'no slug yet'}</span>
          </div>
        </div>
        <button className="close-x" onClick={onClose} aria-label="Close offer coverage">
          ×
        </button>
      </div>

      <div className="panel-body">
        {actionError && (
          <div className="error-banner" role="alert">
            <span className="banner-text">{actionError}</span>
          </div>
        )}
        <ApiErrorBanner error={error} onRetry={onRetry} />

        {!data && !error && <CoverageSkeleton />}

        {data && (
          <>
            {error && (
              <p className="muted" style={{ fontSize: 12, margin: '0 0 10px' }}>
                Showing the last coverage that loaded — nothing below has been re-read since.
              </p>
            )}
            <div className={error ? 'stale-rows' : undefined}>
              <div className="coverage">
                <div className="coverage-top">
                  <span className="lead">
                    <b>
                      {data.coverage.covered} of {data.coverage.total}
                    </b>{' '}
                    product{data.coverage.total === 1 ? '' : 's'} carry an offer
                  </span>
                  {error && <span className="badge amber">not refreshed</span>}
                  <span className="hint">
                    an offer is an editor-attached link or a verified ASIN
                  </span>
                </div>
                <div className="meter" role="img" aria-label={coverageLabel(data)}>
                  {rows.map((row) => (
                    <span key={row.goSlug} className={row.provenance} />
                  ))}
                  {rows.length === 0 && <span />}
                </div>
                <div className="meter-key">
                  <span className="k-editor">
                    <i aria-hidden="true" />
                    editor {data.coverage.counts.editor}
                  </span>
                  <span className="k-resolved">
                    <i aria-hidden="true" />
                    resolved ASIN {data.coverage.counts.resolved}
                  </span>
                  <span className="k-healed">
                    <i aria-hidden="true" />
                    search link {data.coverage.counts.healed}
                  </span>
                  <span className="k-none">
                    <i aria-hidden="true" />
                    none {data.coverage.counts.none}
                  </span>
                </div>
              </div>

              {uncovered.length > 0 && (
                <div className="warn-banner">
                  <span className="banner-text">
                    <b>
                      {uncovered.length} product{uncovered.length === 1 ? '' : 's'} with no offer of{' '}
                      {uncovered.length === 1 ? 'its' : 'their'} own.
                    </b>{' '}
                    Without one the page has nowhere to send a reader but search results, and no
                    price to quote. Attach a link and a dated price before publishing.
                  </span>
                </div>
              )}
              {pending.length > 0 && (
                <div className="notice-banner">
                  <span className="banner-text">
                    <b>
                      {pending.length} attached offer{pending.length === 1 ? '' : 's'} not on the
                      page yet.
                    </b>{' '}
                    The card was assembled before{' '}
                    {pending.length === 1 ? 'it was saved' : 'they were saved'} — rebuild it to
                    carry the link and the stamp. Assembly is deterministic, so the rebuild costs
                    nothing and comes back here for approval.
                  </span>
                  <button
                    className="btn violet-outline"
                    disabled={busy}
                    onClick={() => act('reassemble', 'reassemble')}
                  >
                    Rebuild from offers
                  </button>
                </div>
              )}

              {rows.length === 0 ? (
                <div className="note-card">
                  <p className="muted" style={{ margin: 0 }}>
                    No products on this card yet. The research stage files them, and every one it
                    files turns up here with whatever destination it can be given.
                  </p>
                </div>
              ) : (
                <>
                  <div className="offer-table-card">
                    <div className="card table-scroll" tabIndex={0} role="region" aria-label="Offer coverage by product">
                      <table className="offer-table">
                        <colgroup>
                          <col className="c-product" />
                          <col className="c-offer" />
                          <col className="c-price" />
                          <col className="c-act" />
                        </colgroup>
                        <thead>
                          <tr>
                            <th>Product</th>
                            <th>Offer</th>
                            <th>Price</th>
                            <th className="act">Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((row) => (
                            <tr
                              key={row.goSlug}
                              className={
                                row.provenance === 'none' || row.provenance === 'healed'
                                  ? 'uncovered'
                                  : undefined
                              }
                            >
                              <td>
                                <span className="p-name">{row.productName}</span>
                                <span className="p-slug">/go/{row.goSlug}</span>
                                <span className="tag-line">
                                  {!row.inBody && (
                                    <span className="badge gray" title="No /go/ link in the draft">
                                      not linked in the draft
                                    </span>
                                  )}
                                  {row.preorder && <span className="badge violet">pre-order</span>}
                                </span>
                              </td>
                              <td>
                                <SourceChip row={row} />
                                {row.destination && (
                                  <span className="dest">
                                    <span className="tok" title={row.destination}>
                                      {row.destination}
                                    </span>
                                  </span>
                                )}
                                {row.destinationNote && <span className="by">{row.destinationNote}</span>}
                              </td>
                              <td>
                                {row.price ? (
                                  <>
                                    <span className="price">{row.price}</span>
                                    <span className={`asat${row.stale ? ' stale' : ''}`}>
                                      {row.asAt ? `as at ${row.asAt}` : 'undated'}
                                    </span>
                                  </>
                                ) : (
                                  <span className="muted">—</span>
                                )}
                              </td>
                              <td className="act">
                                <span className="row-actions">
                                  <button
                                    className={`btn small ${row.offer ? 'secondary' : 'violet'}`}
                                    onClick={() => onEdit(row.goSlug)}
                                  >
                                    {rowAction(row)}
                                  </button>
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Below 680px the same rows as stacked cards, so nothing has
                      to be read through a sideways scroll on a phone. */}
                  <div className="offer-cards">
                    {rows.map((row) => (
                      <div
                        className={`offer-card-item${
                          row.provenance === 'none' || row.provenance === 'healed'
                            ? ' uncovered'
                            : ''
                        }`}
                        key={row.goSlug}
                      >
                        <div className="oc-name">{row.productName}</div>
                        <span className="oc-slug">/go/{row.goSlug}</span>
                        <div className="oc-row">
                          <SourceChip row={row} />
                          {row.preorder && <span className="badge violet">pre-order</span>}
                          {row.price && (
                            <span className="oc-price">
                              {row.price}
                              {row.asAt ? ` · as at ${row.asAt}` : ''}
                            </span>
                          )}
                        </div>
                        {row.destination && (
                          <span className="oc-dest">
                            <span className="tok" title={row.destination}>
                              {row.destination}
                            </span>
                          </span>
                        )}
                        <div className="oc-actions">
                          <button
                            className={`btn small ${row.offer ? 'secondary' : 'violet'}`}
                            onClick={() => onEdit(row.goSlug)}
                          >
                            {rowAction(row)}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <ResolutionOrder />
            </div>
          </>
        )}

        {note !== null && (
          <div className="note-card" style={{ marginTop: 14 }}>
            <label htmlFor="offers-send-back" style={{ fontSize: 13, fontWeight: 600 }}>
              What should the editor change?
            </label>
            <textarea
              id="offers-send-back"
              className="textarea"
              style={{ marginTop: 6 }}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="row" style={{ marginTop: 8 }}>
              <button
                className="btn"
                disabled={busy || note.trim() === ''}
                onClick={() => sendBack(note.trim())}
              >
                Send to the editor
              </button>
              <button className="btn ghost" disabled={busy} onClick={() => setNote(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="panel-foot">
        <button className="btn ghost" onClick={onClose}>
          Open the brief
        </button>
        <button
          className="btn secondary"
          disabled={busy || note !== null}
          onClick={() => setNote(defaultSendBackNote(uncovered))}
        >
          Send back
        </button>
        <div className="action-group">
          <button className="btn secondary" onClick={onPreview}>
            Preview as a reader
          </button>
          {awaitingApproval && (
            <>
              <label className="row" style={{ gap: 8, fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                  style={{ width: 16, height: 16, accentColor: 'var(--violet)' }}
                />
                I have reviewed offer coverage
              </label>
              <button
                className="btn"
                disabled={!reviewed || busy}
                onClick={() => act('approve-publish', 'approve_publish')}
              >
                Approve &amp; publish
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function coverageLabel(data: OfferCoverageResponse): string {
  const { counts } = data.coverage;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return [
    plural(counts.editor, 'editor-attached offer', 'editor-attached offers'),
    plural(counts.resolved, 'resolved ASIN', 'resolved ASINs'),
    plural(counts.healed, 'search link', 'search links'),
    `${counts.none} with nothing attached`,
  ].join(', ');
}

/**
 * The note a "send back" starts from. The editor stage cannot attach an offer -
 * only a person can - so what it is actually being asked is whether a product
 * nothing can be earned on still deserves the recommendation.
 */
function defaultSendBackNote(uncovered: OfferCoverageRow[]): string {
  if (uncovered.length === 0) return '';
  const names = uncovered.map((row) => row.productName).join(', ');
  return (
    `These products have no offer of their own: ${names}. ` +
    'Either name a linkable alternative in their place, or make the recommendation stand ' +
    'without sending the reader anywhere.'
  );
}

function CoverageSkeleton() {
  return (
    <div className="note-card" aria-busy="true">
      <p className="muted" style={{ margin: 0 }}>
        Reading the card’s products…
      </p>
      {[0, 1, 2].map((n) => (
        <div
          key={n}
          style={{
            height: 14,
            marginTop: 12,
            borderRadius: 6,
            background: 'var(--border-strong)',
            width: `${80 - n * 15}%`,
          }}
        />
      ))}
    </div>
  );
}

/** The order the assembler actually resolves in, stated where it is reviewed. */
function ResolutionOrder() {
  return (
    <details className="explain">
      <summary>How a destination is chosen</summary>
      <div className="ex-body">
        <ol className="order">
          <li>
            <b>The offer an editor attached.</b> The only destination that can exist on
            announcement day, and the only price anyone has actually seen.
          </li>
          <li>
            <b>A resolved ASIN.</b> Verified against the live marketplace it was captured on;
            every other region gets search results for the same product.
          </li>
          <li>
            <b>A search link healed from the draft.</b> Built from the words on the link, so the
            sentence survives even when nothing resolved. It never 404s, and it is not this
            product’s page.
          </li>
        </ol>
        <p style={{ margin: '10px 0 0' }}>
          A price only reaches the page as an RRP with the day it was seen, plus a link to check
          the current one. Nothing here polls a price: a new SKU is in no feed, and Amazon’s
          Product Advertising API is gated behind three qualifying sales in 180 days.
        </p>
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// The per-offer editor
// ---------------------------------------------------------------------------

function draftFrom(row: OfferCoverageRow, today: string): OfferDraft {
  const offer = row.offer;
  return {
    productName: offer?.product_name || row.productName,
    url: offer?.url ?? '',
    price: offer?.price ? String(Number(offer.price)) : '',
    currency: offer?.currency ?? 'AUD',
    priceObservedOn: offer?.price_observed_on ?? today,
    preorder: offer?.preorder ?? false,
    releaseDate: offer?.release_date ?? '',
    merchant: offer?.merchant ?? '',
  };
}

function OfferEditor({
  articleId,
  row,
  history,
  today,
  onSaved,
  onClose,
}: {
  articleId: string;
  row: OfferCoverageRow;
  history: ProductOfferRevision[];
  today: string;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<OfferDraft>(() => draftFrom(row, today));
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A feed that has taken the record over is read-only until the operator says
  // otherwise: overwriting better data by reflex is how a launch-day guess
  // outlives its usefulness.
  const superseded = row.offer !== null && row.offer.source !== 'editor';
  const [overriding, setOverriding] = useState(false);
  const locked = superseded && !overriding;

  const errors: OfferErrors = validateOfferDraft(draft, today);
  const invalid = countErrors(errors) > 0;
  const preview = offerPreview(draft, row.offer?.source ?? 'editor');
  const set = (patch: Partial<OfferDraft>) => {
    setTouched(true);
    setDraft((current) => ({ ...current, ...patch }));
  };
  const show = (field: keyof OfferErrors) => (touched ? errors[field] : undefined);

  const save = async () => {
    if (invalid) {
      setTouched(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api(`/api/articles/${articleId}/offers/${row.goSlug}`, {
        method: 'PUT',
        body: JSON.stringify(offerPayload(draft)),
      });
      track(EVENTS.offerSaved, {
        action: row.offer ? 'updated' : 'attached',
        article_id: articleId,
        slug: row.goSlug,
        source: 'editor',
      });
      onSaved();
      onClose();
    } catch (e) {
      captureError(e, { action: 'offer_saved', article_id: articleId, surface: 'offers' });
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const detach = async () => {
    setSaving(true);
    setError(null);
    try {
      await api(`/api/articles/${articleId}/offers/${row.goSlug}`, { method: 'DELETE' });
      track(EVENTS.offerSaved, {
        action: 'detached',
        article_id: articleId,
        slug: row.goSlug,
        source: row.offer?.source ?? 'editor',
      });
      onSaved();
      onClose();
    } catch (e) {
      captureError(e, { action: 'offer_detached', article_id: articleId, surface: 'offers' });
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="detail-panel">
      <div className="panel-head">
        <div className="htext">
          <h2>{row.offer ? 'Edit the offer' : 'Attach an offer'}</h2>
          <p>
            {row.productName} · <span className="mono">/go/{row.goSlug}</span>
          </p>
        </div>
        <button className="close-x" onClick={onClose} aria-label="Close the offer editor">
          ×
        </button>
      </div>

      <div className="panel-body">
        {error && (
          <div className="error-banner" role="alert">
            <span className="banner-text">{error}</span>
          </div>
        )}
        {superseded ? (
          <div className="warn-banner">
            <span className="banner-text">
              <b>A {row.offer!.source} record has taken this over.</b> The entry made by hand is
              kept in the history below. Saving over it replaces better data with a figure nobody
              is refreshing.
            </span>
            {!overriding && (
              <button className="btn secondary" onClick={() => setOverriding(true)}>
                Override it anyway
              </button>
            )}
          </div>
        ) : (
          <div className="callout violet-callout">
            <span className="ci" aria-hidden="true">
              ↺
            </span>
            <span>
              <b>Feed data will take over.</b> When the merchant publishes this SKU, the feed
              overwrites what you enter here — and this entry stays in the history below, so the
              price the page quoted on launch day is still readable afterwards.
            </span>
          </div>
        )}

        <div className="field" style={{ marginTop: 14 }}>
          <label htmlFor="offer-url">
            Affiliate URL <span className="req">required</span>
          </label>
          <input
            id="offer-url"
            className={`input mono${show('url') ? ' invalid' : ''}`}
            placeholder="https://www.example.com.au/product/…"
            value={draft.url}
            disabled={locked}
            onChange={(e) => set({ url: e.target.value })}
          />
          {show('url') ? (
            <p className="field-error">{errors.url}</p>
          ) : (
            <p className="hint">
              The deep link as the program gave it to you. An Amazon product URL is fine — it is
              stored as its ASIN so the redirect can add the right tag per marketplace. Never paste
              one that already carries <code>?tag=</code>.
            </p>
          )}
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="offer-price">
              Price <span className="opt">optional</span>
            </label>
            <input
              id="offer-price"
              className={`input${show('price') ? ' invalid' : ''}`}
              inputMode="decimal"
              placeholder="2899"
              value={draft.price}
              disabled={locked}
              onChange={(e) => set({ price: e.target.value })}
            />
            {show('price') && <p className="field-error">{errors.price}</p>}
          </div>
          <div className="field">
            <label htmlFor="offer-currency">Currency</label>
            <select
              id="offer-currency"
              className="select"
              value={draft.currency}
              disabled={locked}
              onChange={(e) => set({ currency: e.target.value })}
            >
              {OFFER_CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="offer-observed">Price seen on</label>
            <input
              id="offer-observed"
              className={`input${show('priceObservedOn') ? ' invalid' : ''}`}
              type="date"
              max={today}
              value={draft.priceObservedOn}
              disabled={locked}
              onChange={(e) => set({ priceObservedOn: e.target.value })}
            />
            {show('priceObservedOn') && <p className="field-error">{errors.priceObservedOn}</p>}
          </div>
        </div>

        <div className="field">
          <label className="check" htmlFor="offer-preorder">
            <input
              id="offer-preorder"
              type="checkbox"
              checked={draft.preorder}
              disabled={locked}
              onChange={(e) => set({ preorder: e.target.checked })}
            />
            This is a pre-order
          </label>
          <p className="hint">
            The reader is told the release date and that the charge happens on dispatch, not today.
          </p>
        </div>

        {draft.preorder && (
          <div className="field">
            <label htmlFor="offer-release">
              Release date <span className="req">required</span>
            </label>
            <input
              id="offer-release"
              className={`input${show('releaseDate') ? ' invalid' : ''}`}
              type="date"
              value={draft.releaseDate}
              disabled={locked}
              onChange={(e) => set({ releaseDate: e.target.value })}
            />
            {show('releaseDate') && <p className="field-error">{errors.releaseDate}</p>}
          </div>
        )}

        <div className="field">
          <label htmlFor="offer-merchant">
            Merchant <span className="opt">optional</span>
          </label>
          <input
            id="offer-merchant"
            className="input"
            placeholder="Amazon AU"
            value={draft.merchant}
            disabled={locked}
            onChange={(e) => set({ merchant: e.target.value })}
          />
          <p className="hint">Named on the button and in the price-check link.</p>
        </div>

        <div className="section">
          <h2>What the reader gets</h2>
          <div className="preview-frame">
            {invalid ? (
              <p className="reader-placeholder" style={{ margin: 0 }}>
                Awaiting a valid offer — until the fields above are right, this product still sends
                the reader to a search page with no price on it.
              </p>
            ) : (
              <ReaderOffer
                name={draft.productName || row.productName}
                preview={preview}
              />
            )}
          </div>
        </div>

        {history.length > 0 && (
          <div className="section">
            <h2>Offer history</h2>
            <div className="history-table-card">
              <div className="card table-scroll" tabIndex={0} role="region" aria-label="Every version of this offer">
                <table>
                  <thead>
                    <tr>
                      <th>Saved</th>
                      <th>Source</th>
                      <th>Price</th>
                      <th>Observed</th>
                      <th>By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((revision) => (
                      <tr key={revision.id}>
                        <td className="mono">{revision.saved_at.slice(0, 10)}</td>
                        <td>
                          <span className={`source-chip ${revision.source === 'editor' ? 'editor' : 'resolved'}`}>
                            <i aria-hidden="true" />
                            {revision.source}
                          </span>
                        </td>
                        <td className="mono">
                          {formatOfferPrice(revision.price, revision.currency) ?? '—'}
                        </td>
                        <td className="mono">{revision.price_observed_on ?? '—'}</td>
                        <td className="muted">{revision.entered_by ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            {/* The same history as cards on a phone, where five columns would
                truncate the one figure the row exists to show. */}
            <div className="history-cards">
              {history.map((revision) => (
                <div className="history-card" key={revision.id}>
                  <div className="hc-top">
                    <span className="mono">{revision.saved_at.slice(0, 10)}</span>
                    <span className={`source-chip ${revision.source === 'editor' ? 'editor' : 'resolved'}`}>
                      <i aria-hidden="true" />
                      {revision.source}
                    </span>
                  </div>
                  <div className="hc-price">
                    {formatOfferPrice(revision.price, revision.currency) ?? 'no price'}
                  </div>
                  <div className="hc-meta">
                    observed {revision.price_observed_on ?? '—'} · by {revision.entered_by ?? '—'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="panel-foot">
        <span className={`foot-status${touched && invalid ? ' invalid' : ''}`}>
          {saving ? (
            <>
              <span className="spinner" aria-hidden="true" />
              Saving…
            </>
          ) : touched && invalid ? (
            `${countErrors(errors)} field${countErrors(errors) === 1 ? '' : 's'} to fix`
          ) : row.offer ? (
            `Attached ${row.offer.updated_at.slice(0, 10)} by ${row.offer.entered_by ?? 'operator'}`
          ) : (
            'Nothing attached yet'
          )}
        </span>
        <div className="action-group">
          {row.offer && (
            <button className="btn ghost" disabled={saving} onClick={detach}>
              Detach
            </button>
          )}
          <button className="btn secondary" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button className="btn violet" disabled={saving || locked} onClick={save}>
            {saving && <span className="spinner" aria-hidden="true" />}
            Save offer
          </button>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The reader preview
// ---------------------------------------------------------------------------

/** One offer as the site renders it — the site's palette and type, not ours. */
function ReaderOffer({
  name,
  preview,
}: {
  name: string;
  preview: ReturnType<typeof offerPreview>;
}) {
  if (preview.preorder) {
    return (
      <div className="reader-callout">
        <div>
          <div className="r-eyebrow">Pre-order</div>
          <h4>{name}</h4>
        </div>
        <div className="cta">
          {preview.priceLabel && <div className="price">{preview.priceLabel}</div>}
          <span className="reader-cta-btn">{preview.ctaLabel}</span>
          <p className="price-stamp">
            {preview.stamp && (
              <>
                <span>{preview.stamp}</span>
                <span aria-hidden="true">·</span>
              </>
            )}
            <span className="check-link">
              <span className="lbl">{preview.checkLabel}</span>
            </span>
          </p>
        </div>
        <p className="preorder-line">{preview.releaseNote}</p>
      </div>
    );
  }
  return (
    <div className="reader-strip">
      <div className="s-text">
        <span className="s-name">{name}</span>
        {preview.priceLabel && <span className="s-price">{preview.priceLabel}</span>}
        {preview.stamp && (
          <span className="s-stamp">
            {preview.stamp}
            {preview.datedReason ? ` · ${preview.datedReason}` : ''}
          </span>
        )}
      </div>
      <span className="check-link">
        <span className="lbl">{preview.checkLabel}</span>
      </span>
    </div>
  );
}

/** Every offer on the card, as a reader would meet it. */
function ReaderPreview({
  data,
  onBack,
  onClose,
}: {
  data: OfferCoverageResponse | null;
  onBack: () => void;
  onClose: () => void;
}) {
  const withOffers = (data?.coverage.rows ?? []).filter((row) => row.offer !== null);
  return (
    <section className="detail-panel">
      <div className="panel-head">
        <div className="htext">
          <h2>What the reader sees</h2>
          <p>
            The offers on <span className="mono">{data?.article.slug ?? 'this card'}</span>, in the
            site’s own type and colour.
          </p>
        </div>
        <button className="close-x" onClick={onClose} aria-label="Close offer coverage">
          ×
        </button>
      </div>
      <div className="panel-body">
        {withOffers.length === 0 ? (
          <div className="note-card">
            <p className="muted" style={{ margin: 0 }}>
              No offers attached yet, so a reader gets a search link and no price. Attach one and it
              shows up here.
            </p>
          </div>
        ) : (
          withOffers.map((row) => (
            <div key={row.goSlug}>
              <p className="preview-label">/go/{row.goSlug}</p>
              <div className="preview-frame">
                <ReaderOffer
                  name={row.productName}
                  preview={offerPreview(
                    {
                      productName: row.productName,
                      url: row.offer!.url,
                      price: row.offer!.price ? String(Number(row.offer!.price)) : '',
                      currency: row.offer!.currency,
                      priceObservedOn: row.offer!.price_observed_on ?? '',
                      preorder: row.offer!.preorder,
                      releaseDate: row.offer!.release_date ?? '',
                      merchant: row.offer!.merchant ?? '',
                    },
                    row.offer!.source,
                    row.stale,
                  )}
                />
              </div>
            </div>
          ))
        )}
      </div>
      <div className="panel-foot">
        <button className="btn secondary" onClick={onBack}>
          Back to offers
        </button>
      </div>
    </section>
  );
}
