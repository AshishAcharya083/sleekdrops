import { useEffect, useState } from 'react';
import { EVENTS, captureError, track } from '../analytics';
import type { ArticleDetail, ArticleSummary, KeywordPlan } from '../api';
import { api, apiUpload, duration, fmtCost, fmtTime } from '../api';
import { Badge } from '../components';
import { HeroImageField } from '../HeroImageField';
import { usePoll } from '../hooks';

const LANES: Array<{ title: string; stages: string[] }> = [
  { title: 'Research & Brief', stages: ['research', 'keyword', 'outline'] },
  { title: 'Write & Optimize', stages: ['write', 'seo_review', 'edit'] },
  { title: 'Assemble & Publish', stages: ['assemble', 'image', 'publish'] },
  { title: 'Done', stages: ['done'] },
];

export function Pipeline() {
  const { data, error, refresh } = usePoll<{ articles: ArticleSummary[] }>('/api/articles');
  const [openId, setOpenId] = useState<string | null>(null);
  const articles = data?.articles ?? [];

  return (
    <>
      {error && <div className="error-banner">API unreachable: {error}</div>}
      <div className="board">
        {LANES.map((lane) => {
          const items = articles.filter((a) => lane.stages.includes(a.stage));
          return (
            <div className="lane" key={lane.title}>
              <h4>
                {lane.title} <span className="count">{items.length}</span>
              </h4>
              {items.map((a) => (
                <div className="cardlet" key={a.id} onClick={() => setOpenId(a.id)}>
                  <div>{a.title}</div>
                  <div className="meta">
                    <Badge value={a.stage} />
                    <Badge value={a.status} />
                    {a.seo_score && <span className="badge">SEO {a.seo_score}</span>}
                    {a.hero_image_url && <span className="badge violet">🖼️ hero</span>}
                  </div>
                  {a.error && (
                    <div className="muted" style={{ color: 'var(--red)', marginTop: 6, fontSize: 12 }}>
                      {a.error.slice(0, 120)}
                    </div>
                  )}
                </div>
              ))}
              {items.length === 0 && <p className="muted" style={{ padding: '4px 6px', fontSize: 12 }}>empty</p>}
            </div>
          );
        })}
      </div>
      {openId && <ArticlePanel id={openId} onClose={() => setOpenId(null)} onChanged={refresh} />}
    </>
  );
}

const DIMENSION_HELP: Record<string, string> = {
  seo: 'Classic search: keyword placement, headings, intent match, depth.',
  geo: 'Generative-engine citability: extractable answers, named sources, entities, FAQ schema.',
  voice: 'Reads as a person. Capped by the deterministic anti-slop scan.',
  eeat: 'Experience, expertise, authority, trust — methodology, evidence, honest trade-offs.',
  links: 'The /go/ affiliate contract and the placement rules.',
};

/**
 * What the piece is built to win, and why. Shown above the review because it
 * is the thing the review scores against: a low SEO dimension usually means
 * the draft drifted off this plan rather than that the plan was wrong.
 */
function KeywordPlanSection({ plan }: { plan: KeywordPlan }) {
  const [open, setOpen] = useState(false);
  const chips: Array<[string, string]> = [
    ['intent', plan.intent],
    ['difficulty', plan.difficulty],
    ['zero-click', plan.zeroClickRisk],
    ['format', plan.winningFormat],
    ['target', `${plan.wordCountTarget} words`],
  ];
  return (
    <div className="section">
      <h2>
        Keyword plan{' '}
        <button className="btn secondary small" onClick={() => setOpen(!open)}>
          {open ? 'hide' : 'show'} detail
        </button>
      </h2>
      <div className="card">
        <p className="mono" style={{ marginTop: 0, fontSize: 15 }}>
          {plan.primaryKeyword}
        </p>
        <div className="row" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
          {chips
            .filter(([, value]) => value)
            .map(([label, value]) => (
              <span className="badge" key={label}>
                {label}: {value}
              </span>
            ))}
        </div>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          {plan.rationale}
        </p>
        {open && (
          <>
            <PlanList label="Gaps we're exploiting" items={plan.contentGaps} />
            <PlanList label="People Also Ask" items={plan.paaQuestions} />
            <PlanList label="Entities to name (GEO)" items={plan.entities} />
            <PlanList label="Secondary keywords" items={plan.secondaryKeywords} />
            <PlanList label="SERP features" items={plan.serpFeatures} />
            {plan.snippetTarget?.question && (
              <>
                <h4 style={{ marginBottom: 4 }}>
                  Snippet target ({plan.snippetTarget.format})
                </h4>
                <p style={{ marginTop: 0, fontSize: 13 }}>
                  <strong>{plan.snippetTarget.question}</strong>
                  <br />
                  <span className="muted">{plan.snippetTarget.answer}</span>
                </p>
              </>
            )}
            {plan.currentAiAnswer && (
              <>
                <h4 style={{ marginBottom: 4 }}>What AI answers today</h4>
                <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
                  {plan.currentAiAnswer}
                </p>
              </>
            )}
            <PlanList
              label="Top results to beat"
              items={(plan.competitors ?? []).map((c) => `${c.url} — ${c.format}: ${c.angle}`)}
            />
            <PlanList
              label="Candidates rejected"
              items={(plan.rejected ?? []).map((r) => `${r.keyword} — ${r.reason}`)}
            />
          </>
        )}
      </div>
    </div>
  );
}

function PlanList({ label, items }: { label: string; items: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <>
      <h4 style={{ marginBottom: 4 }}>{label}</h4>
      <ul style={{ marginTop: 0, fontSize: 13 }}>
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </>
  );
}

function ArticlePanel({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<ArticleDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showDraft, setShowDraft] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [feedbackSent, setFeedbackSent] = useState(false);

  const load = () => {
    api<ArticleDetail>(`/api/articles/${id}`)
      .then(setDetail)
      .catch((e: Error) => {
        captureError(e, { action: 'article_load', article_id: id, surface: 'pipeline' });
        setErr(e.message);
      });
  };
  useEffect(load, [id]);

  const action = async (path: string) => {
    try {
      await api(`/api/articles/${id}/${path}`, { method: 'POST' });
      track(EVENTS.articleActioned, {
        action: path.replace(/-/g, '_'),
        article_id: id,
        stage: detail?.article.stage,
        status: detail?.article.status,
      });
      load();
      onChanged();
    } catch (e) {
      captureError(e, { action: path.replace(/-/g, '_'), article_id: id, surface: 'pipeline' });
      setErr((e as Error).message);
    }
  };

  const sendFeedback = async () => {
    if (!feedback.trim()) return;
    try {
      await api(`/api/articles/${id}/feedback`, {
        method: 'POST',
        body: JSON.stringify({ feedback: feedback.trim() }),
      });
      track(EVENTS.articleFeedbackSubmitted, {
        article_id: id,
        feedback_length: feedback.trim().length,
        stage: detail?.article.stage,
      });
      setFeedback('');
      setFeedbackSent(true);
      setTimeout(() => setFeedbackSent(false), 4000);
      load();
      onChanged();
    } catch (e) {
      captureError(e, { action: 'article_feedback', article_id: id, surface: 'pipeline' });
      setErr((e as Error).message);
    }
  };

  return (
    <div className="detail-overlay" onClick={onClose}>
      <div className="detail-panel" onClick={(e) => e.stopPropagation()}>
        <button className="close-x" onClick={onClose}>
          ×
        </button>
        {err && <div className="error-banner">{err}</div>}
        {!detail ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <h2>{detail.article.title}</h2>
            <div className="row">
              <Badge value={detail.article.stage} />
              <Badge value={detail.article.status} />
              <span className="muted mono">{detail.article.slug ?? 'no slug yet'}</span>
              <span className="muted">rev {detail.article.revision_round}</span>
            </div>

            <div className="row" style={{ marginTop: 12 }}>
              {detail.article.status === 'waiting_approval' && (
                <button className="btn" onClick={() => action('approve-publish')}>
                  ✅ Approve & publish
                </button>
              )}
              {['failed', 'cancelled'].includes(detail.article.status) && (
                <button className="btn" onClick={() => action('retry')}>
                  Retry stage
                </button>
              )}
              {detail.article.stage === 'done' && detail.article.status === 'done' && (
                <button className="btn secondary" onClick={() => action('republish')}>
                  ♻️ Publish again
                </button>
              )}
              {['queued', 'failed', 'waiting_approval'].includes(detail.article.status) && (
                <button className="btn danger" onClick={() => action('cancel')}>
                  Cancel
                </button>
              )}
            </div>

            {detail.article.error && (
              <div className="error-banner" style={{ marginTop: 12 }}>
                {detail.article.error}
              </div>
            )}

            <HeroImageSection
              key={detail.article.id}
              article={detail.article}
              onSaved={() => {
                load();
                onChanged();
              }}
            />

            {detail.article.draft_md && detail.article.status !== 'running' && (
              <div className="section">
                <h2>Feedback to the writer</h2>
                <div className="card">
                  <textarea
                    rows={3}
                    style={{ width: '100%', resize: 'vertical' }}
                    placeholder='e.g. "Lead with the Dyson, drop the price table, add a section on battery life"'
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                  />
                  <div className="row" style={{ marginTop: 8, alignItems: 'center' }}>
                    <button className="btn" disabled={!feedback.trim()} onClick={sendFeedback}>
                      Send to editor
                    </button>
                    <span className="muted" style={{ fontSize: 12 }}>
                      re-runs edit → SEO review → assemble → publish with your notes applied
                    </span>
                    {feedbackSent && <span style={{ fontSize: 12 }}>✓ queued</span>}
                  </div>
                </div>
              </div>
            )}

            {detail.article.keyword_plan && (
              <KeywordPlanSection plan={detail.article.keyword_plan} />
            )}

            {detail.article.seo_review && (
              <div className="section">
                <h2>SEO review — {detail.article.seo_review.score}/100</h2>
                <div className="card">
                  {detail.article.seo_review.dimensions && (
                    <div className="row" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
                      {Object.entries(detail.article.seo_review.dimensions).map(([name, value]) => (
                        <span
                          key={name}
                          className={`badge${value >= 80 ? ' green' : value >= 60 ? ' amber' : ' red'}`}
                          title={DIMENSION_HELP[name] ?? name}
                        >
                          {name} {value}
                        </span>
                      ))}
                    </div>
                  )}
                  {detail.article.seo_review.slop && (
                    <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
                      Anti-slop scan: {detail.article.seo_review.slop.score}/100 over{' '}
                      {detail.article.seo_review.slop.words} words,{' '}
                      {detail.article.seo_review.slop.findings} finding(s). Run in code before
                      the reviewer saw the draft — banned vocabulary blocks a pass on its own.
                    </p>
                  )}
                  <p style={{ marginTop: 0 }}>{detail.article.seo_review.summary}</p>
                  {(detail.article.seo_review.issues ?? []).map((issue, i) => (
                    <p key={i} style={{ fontSize: 13 }}>
                      <Badge value={issue.severity} /> {issue.issue}
                      <br />
                      <span className="muted">Fix: {issue.fix}</span>
                    </p>
                  ))}
                </div>
              </div>
            )}

            {detail.article.affiliate_links && detail.article.affiliate_links.length > 0 && (
              <div className="section">
                <h2>Affiliate links</h2>
                <div className="card table-scroll" tabIndex={0} role="region" aria-label="Affiliate links">
                  <table>
                    <tbody>
                      {detail.article.affiliate_links.map((l) => (
                        <tr key={l.slug}>
                          <td className="mono">/go/{l.slug}</td>
                          <td className="mono muted" style={{ wordBreak: 'break-all' }}>
                            {l.default_url}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {detail.article.draft_md && (
              <div className="section">
                <h2>
                  Draft{' '}
                  <button className="btn secondary small" onClick={() => setShowDraft(!showDraft)}>
                    {showDraft ? 'hide' : 'show'} ({detail.article.draft_md.split(/\s+/).length} words)
                  </button>
                </h2>
                {showDraft && <pre>{detail.article.draft_md}</pre>}
              </div>
            )}

            <div className="section">
              <h2>Agent sessions</h2>
              <div className="card table-scroll" tabIndex={0} role="region" aria-label="Agent sessions for this article">
                <table>
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th>Status</th>
                      <th>Summary</th>
                      <th>Cost</th>
                      <th>Duration</th>
                      <th>Started</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.sessions.map((s) => (
                      <tr key={s.id}>
                        <td className="mono">{s.agent}</td>
                        <td>
                          <Badge value={s.status} />
                        </td>
                        <td className="muted" style={{ maxWidth: 260 }}>
                          {s.error ?? s.summary ?? '…'}
                        </td>
                        <td className="mono">{fmtCost(s.cost_usd)}</td>
                        <td className="mono">{duration(s.started_at, s.ended_at)}</td>
                        <td className="muted">{fmtTime(s.started_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Hero image for one article. The image agent misses often enough that the
 * operator needs a way in: drop a file here and it becomes the hero, outranking
 * anything the agent found. On a published article the change reaches the site
 * on the next publish - the "Publish again" action above, which is free.
 */
function HeroImageSection({
  article,
  onSaved,
}: {
  article: ArticleDetail['article'];
  onSaved: () => void;
}) {
  const frontmatter = (article.frontmatter ?? {}) as { heroImage?: string; heroAlt?: string };
  const attached = article.hero_image_url ?? frontmatter.heroImage ?? null;
  const storedAlt = article.hero_alt ?? frontmatter.heroAlt ?? '';
  const fromOperator = Boolean(article.hero_image_url);

  const [alt, setAlt] = useState(storedAlt);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Attach a file, or (file omitted) re-label the image already attached. */
  const save = async (file: File | null) => {
    setBusy(true);
    setError(null);
    setStatus(file ? 'uploading…' : 'saving alt text…');
    const action = file ? 'hero_image_attached' : 'hero_alt_saved';
    try {
      await apiUpload(`/api/articles/${article.id}/hero-image`, {
        file,
        fields: { alt: alt.trim() },
      });
      track(EVENTS.articleActioned, {
        action,
        article_id: article.id,
        stage: article.stage,
        status: article.status,
      });
      setStatus(file ? '✓ attached' : '✓ alt text saved');
      onSaved();
    } catch (e) {
      captureError(e, { action, article_id: article.id, surface: 'pipeline' });
      setError((e as Error).message);
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/articles/${article.id}/hero-image`, { method: 'DELETE' });
      track(EVENTS.articleActioned, {
        action: 'hero_image_removed',
        article_id: article.id,
        stage: article.stage,
        status: article.status,
      });
      setAlt('');
      setStatus(null);
      onSaved();
    } catch (e) {
      captureError(e, { action: 'hero_image_removed', article_id: article.id, surface: 'pipeline' });
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="section">
      <h2>
        Hero image{' '}
        {attached && (
          <span className={`badge ${fromOperator ? 'violet' : ''}`}>
            {fromOperator ? 'yours' : 'found by the image agent'}
          </span>
        )}
      </h2>
      <div className="card">
        <HeroImageField
          label={null}
          url={attached}
          alt={alt}
          busy={busy || article.status === 'running'}
          status={status}
          error={error}
          onPick={(file) => void save(file)}
          onRemove={() => void remove()}
          onAltChange={setAlt}
          hint={
            article.published_at
              ? 'Already published — hit “Publish again” above to push the new image to the live site (deterministic, no LLM cost).'
              : 'Used as the hero when the article publishes. With one attached the image agent stands down.'
          }
        />
        {attached && alt.trim() !== storedAlt && (
          <button className="btn secondary small" disabled={busy} onClick={() => void save(null)}>
            Save alt text
          </button>
        )}
      </div>
    </div>
  );
}
