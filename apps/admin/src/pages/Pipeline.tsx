import { useEffect, useState } from 'react';
import { EVENTS, captureError, track } from '../analytics';
import type {
  ArticleDetail,
  ArticleList,
  EditorialAngle,
  KeywordPlan,
  ResearchDetail,
  Session,
  StructureShape,
  TestStageResult,
} from '../api';
import {
  api,
  apiUpload,
  duration,
  elapsedSeconds,
  fmtCost,
  fmtSeconds,
  fmtTime,
  groupAttempts,
  isLeaseLapsed,
  isRetryableRun,
  isTestableStage,
  outOfDateStages,
  OUT_OF_DATE_LABEL,
  readTestStageResult,
  retryBlockedReason,
  REVIEW_STALE_BANNER,
  REVIEW_STALE_REASON,
  sessionBudgetSeconds,
  sessionStage,
  stageBudgetLine,
  stageBudgetSeconds,
  STAGE_LABELS,
  STAGE_ORDER,
  stagesKeptBy,
  stagesRegeneratedBy,
  stoppedSession,
  timedOutSentence,
  untestableStageHint,
} from '../api';
import { toApiError, type ApiError } from '../api-error';
import { ApiErrorBanner, Badge, Elapsed, OutOfDateBadge } from '../components';
import { HeroImageField } from '../HeroImageField';
import { usePoll } from '../hooks';

const LANES: Array<{ title: string; stages: string[] }> = [
  { title: 'Research & Brief', stages: ['research', 'keyword', 'angle', 'outline'] },
  { title: 'Write & Optimize', stages: ['write', 'seo_review', 'edit'] },
  { title: 'Assemble & Publish', stages: ['assemble', 'image', 'publish'] },
  { title: 'Done', stages: ['done'] },
];

export function Pipeline({
  openArticleId,
  onOpened,
}: {
  /** A run the operator picked on another tab - the stuck surface links here. */
  openArticleId?: string | null;
  onOpened?: () => void;
} = {}) {
  const { data, error, refresh } = usePoll<ArticleList>('/api/articles');
  const [openId, setOpenId] = useState<string | null>(openArticleId ?? null);
  const articles = data?.articles ?? [];

  useEffect(() => {
    if (!openArticleId) return;
    setOpenId(openArticleId);
    onOpened?.();
    // Consumed once: the request is a navigation, not a piece of panel state.
  }, [openArticleId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <ApiErrorBanner error={error} />
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

/**
 * The axes a review can carry. The first five are what the reviewer grades
 * today; the rest are the pre-rebuild axes, kept so an article reviewed before
 * the change still explains its own badges.
 */
const DIMENSION_HELP: Record<string, string> = {
  evidence: 'Specifics traceable to the dossier, sourced by name and dated where recency matters.',
  position: 'Does the piece argue something and pay for it - a named loser, cons that cost the buyer.',
  structure: 'Fit to the structure shape it was commissioned in, rather than the house skeleton.',
  citability: 'What a generative engine can lift: extractable answers, named entities, FAQ, recency.',
  links: 'The /go/ affiliate contract and the placement rules.',
  seo: 'Retired axis: keyword placement, headings, intent match, depth.',
  geo: 'Retired axis: extractable answers, named sources, entities, FAQ schema.',
  voice: 'Retired axis: reads as a person. Now measured by the anti-slop scan alone.',
  eeat: 'Retired axis: methodology, evidence, honest trade-offs.',
};

/**
 * The axes in DIMENSION_HELP order, current set first. JSONB does not preserve
 * key order, so a review read back out of the column arrives sorted by key
 * length; the reading order is restored here.
 */
function orderedDimensions(dimensions: Record<string, number>): Array<[string, number]> {
  const rank = (name: string): number => {
    const at = Object.keys(DIMENSION_HELP).indexOf(name);
    return at === -1 ? Object.keys(DIMENSION_HELP).length : at;
  };
  return Object.entries(dimensions).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}

/** The counts worth showing, in the order an operator reads them. */
const EVIDENCE_COUNTS: Array<[string, string]> = [
  ['primaryFacts', 'primary facts'],
  ['expertFacts', 'expert facts'],
  ['ownerFacts', 'owner facts'],
  ['aggregatorFacts', 'aggregator facts'],
  ['untieredFacts', 'untiered facts'],
  ['testedClaims', 'tested claims'],
  ['attributedOwnerComplaints', 'attributed owner complaints'],
  ['aggregateFaultRates', 'aggregate fault rates'],
  ['failureModes', 'failure modes'],
  ['groundedExclusions', 'sourced buyer exclusions'],
  ['datedPriceObservations', 'dated prices'],
  ['products', 'products'],
];

/**
 * The evidence density this piece was written from, as the deterministic gate
 * measured it. A dossier that does not clear the bar never reaches the writer
 * - the research stage stops the article and the shortfall is on the error
 * banner above - so what this panel answers is the other question: an article
 * that reads thin, and what its evidence actually looked like.
 *
 * The shortfall table renders whatever verdict the stored dossier carries; it
 * is the panel's job to show the document, not to assume it passed.
 */
function EvidenceSection({ research }: { research: ResearchDetail }) {
  const gate = research.sufficiency;
  if (!gate) return null;
  return (
    <div className="section">
      <h2>
        Evidence <span className={`badge ${gate.pass ? 'green' : 'red'}`}>{gate.pass ? 'sufficient' : 'too thin'}</span>
      </h2>
      <div className="card">
        <div className="row" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
          {EVIDENCE_COUNTS.filter(([key]) => gate.counts[key] !== undefined).map(([key, label]) => (
            <span className="badge" key={key}>
              {label}: {gate.counts[key]}
            </span>
          ))}
        </div>
        <p className="muted" style={{ marginBottom: 0, fontSize: 12 }}>
          Deterministic gate, run in code at the end of research. Checked {fmtTime(gate.checkedAt)}.
          A {gate.postType} clears it by carrying attributed owner complaints, failure modes and
          dated prices - the material a spec sheet cannot supply. A piece that came up short failed
          at research instead, with the thin strata named on its error.
        </p>
      </div>
      {gate.shortfalls.length > 0 && (
        <div className="card table-scroll" tabIndex={0} role="region" aria-label="Evidence strata that came up short" style={{ marginTop: 8 }}>
          <table>
            <thead>
              <tr>
                <th>Stratum</th>
                <th>Missing</th>
                <th>Where it comes from</th>
              </tr>
            </thead>
            <tbody>
              {gate.shortfalls.map((s) => (
                <tr key={s.label}>
                  <td className="mono">{s.stratum}</td>
                  <td>
                    {s.label}{' '}
                    <span style={{ color: 'var(--red)' }}>
                      {s.have}/{s.need}
                    </span>
                  </td>
                  <td className="muted">{s.fix}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

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

/**
 * What the piece argues, decided before it was outlined. This sits between the
 * keyword plan and the review because it is the record both are judged
 * against: a draft that covers the topic and takes no position is the defect
 * this stage exists to catch, and the thesis here is what an operator reads
 * the draft back against.
 *
 * "No defensible take" is shown as loudly as a thesis, not hidden. It is a
 * real outcome - the evidence supported no position - and an operator seeing
 * it knows the piece is competing on completeness rather than on a claim.
 */
function EditorialAngleSection({ angle }: { angle: EditorialAngle }) {
  const gain = angle.informationGain ?? [];
  return (
    <div className="section">
      <h2>
        Editorial angle{' '}
        <span className={`badge ${angle.defensible ? 'green' : 'amber'}`}>
          {angle.defensible ? 'has a take' : 'no defensible take'}
        </span>
      </h2>
      <div className="card">
        <p style={{ marginTop: 0, fontSize: 15 }}>{angle.thesis || '(no thesis recorded)'}</p>
        <div className="row" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
          <span className="badge">shape: {angle.shape}</span>
          <span className="badge">beat: {angle.byline}</span>
          <span className="badge">
            {gain.length} claim{gain.length === 1 ? '' : 's'} the top results miss
          </span>
        </div>
        {angle.reader && (
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            <strong>Written for:</strong> {angle.reader}
          </p>
        )}
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          {angle.defensible ? (
            <>
              <strong>The take:</strong> {angle.contrarianTake}
            </>
          ) : (
            <>
              <strong>Why there is no take:</strong> {angle.weakness}. The writer was told not
              to invent one and to compete on evidence instead.
            </>
          )}
        </p>
        {gain.length > 0 && (
          <>
            <h4 style={{ marginBottom: 4 }}>What this piece says that the top results don't</h4>
            <ul style={{ marginTop: 0, fontSize: 13 }}>
              {gain.map((g, i) => (
                <li key={i}>
                  {g.claim}
                  {g.absentFrom && <span className="muted"> - absent from {g.absentFrom}</span>}
                  {g.evidence && (
                    <>
                      <br />
                      <span className="muted">Evidence: {g.evidence}</span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        {angle.shapeRationale && (
          <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
            Shape: {angle.shapeRationale}
          </p>
        )}
        {angle.bylineRationale && (
          <p className="muted" style={{ marginTop: 0, marginBottom: 0, fontSize: 12 }}>
            Beat: {angle.bylineRationale}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Which silhouette the piece was built to. Small on purpose: the operator
 * question this answers is "why does this one not look like the last one", and
 * the running order plus where the shape came from answers it.
 */
function StructureShapeSection({ shape }: { shape: StructureShape }) {
  const { passages, words } = shape.passageBudget;
  return (
    <div className="section">
      <h2>Structure</h2>
      <div className="card">
        <div className="row" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
          <span className="badge">{shape.name}</span>
          <span className="badge">
            {passages} extractable answer{passages === 1 ? '' : 's'} · {words.min}-{words.max} words
          </span>
          <span className="badge">FAQ: {shape.faq}</span>
          {shape.selectedBy && <span className="badge">from the {shape.selectedBy}</span>}
        </div>
        <p className="muted" style={{ marginTop: 0, fontSize: 13, whiteSpace: 'pre-wrap' }}>
          <strong>Opening:</strong> {shape.openingStyle}
        </p>
        <ul style={{ marginTop: 0, fontSize: 13 }}>
          {shape.sections.map((section) => (
            <li key={section.kind}>
              {section.label}
              <span className="muted">
                {' '}
                - {section.slot}
                {section.required ? '' : ', optional'}
                {section.repeats ? ', repeats' : ''}
                {section.carriesAnswer ? ', extractable answer' : ''}
              </span>
            </li>
          ))}
        </ul>
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
  // Classified, so a refused action names its own cause: the agent's sentence
  // on a 409, the token field on a 401, the server logs on a 5xx.
  const [err, setErr] = useState<ApiError | null>(null);
  const [showDraft, setShowDraft] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [feedbackSent, setFeedbackSent] = useState(false);
  /** The action currently in flight, so its own control can say so. */
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirmation | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestStageResult | null>(null);

  const load = () => {
    api<ArticleDetail>(`/api/articles/${id}`)
      .then(setDetail)
      .catch((e: unknown) => {
        captureError(e, { action: 'article_load', article_id: id, surface: 'pipeline' });
        setErr(toApiError(e));
      });
  };
  // The panel polls as well as the board behind it: a cancel lands on the row
  // asynchronously (the stage is stopped by the reaper, not by the request),
  // and a retry moves the article through stages while the panel is open.
  useEffect(() => {
    load();
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const article = detail?.article;

  const action = async (
    path: string,
    body?: Record<string, unknown>,
    props?: Record<string, unknown>,
  ) => {
    const name = path.replace(/-/g, '_');
    setBusy(name);
    setErr(null);
    try {
      await api(`/api/articles/${id}/${path}`, {
        method: 'POST',
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      track(EVENTS.articleActioned, {
        action: name,
        article_id: id,
        stage: article?.stage,
        status: article?.status,
        attempt: article?.attempt,
        ...props,
      });
      load();
      onChanged();
    } catch (e) {
      captureError(e, { action: name, article_id: id, surface: 'pipeline' });
      setErr(toApiError(e));
    } finally {
      setBusy(null);
    }
  };

  /**
   * One stage, in isolation. Synchronous and slow - the agent runs the model
   * call before it answers - so the control stays disabled and named while it
   * is out, and the result lands in its own panel rather than in the article.
   */
  const testStage = async (stage: string) => {
    setTesting(stage);
    setErr(null);
    setTestResult(null);
    try {
      const res = await api<unknown>(`/api/articles/${id}/test-stage`, {
        method: 'POST',
        body: JSON.stringify({ stage }),
      });
      // A body this panel cannot read is still the output of a call that was
      // billed, so it is shown raw rather than swallowed.
      setTestResult(readTestStageResult(res) ?? { stage, output: res });
      track(EVENTS.articleActioned, {
        action: 'test_stage',
        article_id: id,
        stage,
        status: article?.status,
      });
    } catch (e) {
      captureError(e, { action: 'test_stage', article_id: id, stage, surface: 'pipeline' });
      setErr(toApiError(e));
    } finally {
      setTesting(null);
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
      setErr(toApiError(e));
    }
  };

  const sessions = detail?.sessions ?? [];
  /**
   * The agent answers this itself, and its answer is the one its retry guards
   * and its publisher are written against, so a stage it has re-passed stops
   * being labelled here at the same moment it stops being blocked there. The
   * local derivation stands in for an agent that does not send it.
   */
  const outOfDate = detail?.outOfDateStages
    ? new Set(detail.outOfDateStages)
    : article
      ? outOfDateStages(article, sessions)
      : new Set<string>();
  /**
   * The session the budget stopped, which is what the detail block quotes.
   * Pipeline runs only: an isolated test can hit the same budget, and a run
   * that wrote nothing must never be what the stop card, the stage it names
   * or the scrubbed detail below it describe.
   */
  const timedOutSession = stoppedSession(sessions);
  const stoppedStage = (timedOutSession && sessionStage(timedOutSession)) ?? article?.stage ?? null;
  const budgetSeconds = stageBudgetSeconds(stoppedStage, detail?.budgets);
  /**
   * Whether the retry engine would take this run at all. A live claim is the
   * one thing it refuses outright; a claim nothing is renewing is the stalled
   * run this panel exists to recover, and it is accepted.
   */
  const leaseLapsed = isLeaseLapsed(article?.lease_expires_at);
  const retryable = article ? isRetryableRun(article.status, leaseLapsed) : false;
  /** Blocked publishing, and the agent's own sentence for it when it sends one. */
  const reviewStale = Boolean(article?.review_stale ?? detail?.reviewStale);
  const reviewStaleReason = detail?.reviewStaleReason ?? REVIEW_STALE_REASON;

  return (
    <div className="detail-overlay" onClick={onClose}>
      <div className="detail-panel" onClick={(e) => e.stopPropagation()}>
        <button className="close-x" onClick={onClose}>
          ×
        </button>
        <ApiErrorBanner error={err} />
        {!detail || !article ? (
          // An error has already said what went wrong above; a skeleton under
          // it would claim the run is still arriving.
          err ? null : <RunDetailSkeleton />
        ) : (
          <>
            <h2>{article.title}</h2>
            <div className="row">
              <Badge value={article.stage} />
              <Badge value={article.status} />
              <span className="muted mono">{article.slug ?? 'no slug yet'}</span>
              <span className="muted">rev {article.revision_round}</span>
              {(article.attempt ?? 1) > 1 && (
                <span className="badge gray">attempt {article.attempt}</span>
              )}
            </div>

            {reviewStale && (
              <div className="warn-banner" role="status" style={{ marginTop: 12 }}>
                {REVIEW_STALE_BANNER}
              </div>
            )}

            {article.status === 'timed_out' ? (
              <div className="stop-card">
                <div className="stop-h">
                  <strong>⏱ Timed out</strong>
                  <span className="muted mono">{stoppedStage ?? '—'}</span>
                </div>
                <p className="oneline">{timedOutSentence(budgetSeconds)}</p>
                <BudgetLine budgetSeconds={budgetSeconds} />
                {/* Already scrubbed by the agent, and rendered exactly as it
                    arrived: it names the stage and the last call it made. */}
                {(timedOutSession?.error ?? article.error) && (
                  <pre>{timedOutSession?.error ?? article.error}</pre>
                )}
              </div>
            ) : (
              // The budget is on the run detail whatever state it is in - the
              // stop card carries it when the budget is what ended the run.
              article.error && (
                // pre-wrap because the evidence gate's message is a list: which
                // stratum came up short, and where that evidence is gathered.
                // Collapsed to one line it is unreadable at exactly the moment
                // an operator needs to read it.
                <div className="error-banner" style={{ marginTop: 12, whiteSpace: 'pre-wrap' }}>
                  {article.error}
                </div>
              )
            )}

            {article.status !== 'timed_out' && <BudgetLine budgetSeconds={budgetSeconds} />}

            <RunActions
              article={article}
              retryable={retryable}
              leaseLapsed={leaseLapsed}
              reviewStale={reviewStale}
              reviewStaleReason={reviewStaleReason}
              busy={busy}
              testing={testing}
              onRetry={(stage) => setConfirming({ kind: 'retry', stage })}
              onRerunAll={() => setConfirming({ kind: 'rerun' })}
              onTest={(stage) => void testStage(stage)}
              onCancel={() => void action('cancel')}
              onApprove={() => void action('approve-publish')}
              onRepublish={() => void action('republish')}
            />

            {testResult && (
              <TestResultPanel result={testResult} onClose={() => setTestResult(null)} />
            )}

            <StageTimeline
              article={article}
              sessions={sessions}
              budgets={detail.budgets}
              outOfDate={outOfDate}
            />

            <AttemptHistory
              sessions={sessions}
              budgets={detail.budgets}
              outOfDate={outOfDate}
              testing={testing}
              busy={busy}
              running={article.status === 'running'}
              retryable={retryable}
              onRetry={(stage) => setConfirming({ kind: 'retry', stage })}
              onTest={(stage) => void testStage(stage)}
            />

            <HeroImageSection
              key={article.id}
              article={article}
              onSaved={() => {
                load();
                onChanged();
              }}
            />

            {article.draft_md && article.status !== 'running' && (
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

            {article.research && <EvidenceSection research={article.research} />}

            {article.keyword_plan && <KeywordPlanSection plan={article.keyword_plan} />}

            {article.editorial_angle && <EditorialAngleSection angle={article.editorial_angle} />}

            {article.structure_shape && <StructureShapeSection shape={article.structure_shape} />}

            {article.seo_review && (
              <div className="section">
                <h2>
                  SEO review — {article.seo_review.score}/100{' '}
                  {outOfDate.has('seo_review') && <OutOfDateBadge />}
                </h2>
                <div className="card">
                  {article.seo_review.dimensions && (
                    <div className="row" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
                      {orderedDimensions(article.seo_review.dimensions).map(([name, value]) => (
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
                  {article.seo_review.competitorDelta && (
                    <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
                      Versus the top {article.seo_review.competitorDelta.comparedWith.length}{' '}
                      captured result(s):{' '}
                      <strong>{article.seo_review.competitorDelta.verdict}</strong>.{' '}
                      {article.seo_review.competitorDelta.additions.length === 0
                        ? 'Nothing this piece carries that they do not.'
                        : article.seo_review.competitorDelta.additions
                            .map((a) => a.claim)
                            .join(' · ')}
                    </p>
                  )}
                  {article.seo_review.claimAudit && (
                    <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
                      Claim audit: {article.seo_review.claimAudit.unsupported} of{' '}
                      {article.seo_review.claimAudit.checked} specific(s) are not carried by the
                      dossier.{' '}
                      {article.seo_review.claimAudit.unsupported > 0
                        ? 'Each one blocks a pass on its own.'
                        : 'Every figure in the draft traces back to the research.'}
                    </p>
                  )}
                  {article.seo_review.slop && (
                    <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
                      Anti-slop scan: {article.seo_review.slop.score}/100 over{' '}
                      {article.seo_review.slop.words} words, {article.seo_review.slop.findings}{' '}
                      finding(s). Run in code before the reviewer saw the draft — banned vocabulary
                      blocks a pass on its own.
                    </p>
                  )}
                  <p style={{ marginTop: 0 }}>{article.seo_review.summary}</p>
                  {(article.seo_review.issues ?? []).map((issue, i) => (
                    <p key={i} style={{ fontSize: 13 }}>
                      <Badge value={issue.severity} /> {issue.issue}
                      <br />
                      <span className="muted">Fix: {issue.fix}</span>
                    </p>
                  ))}
                </div>
              </div>
            )}

            {article.affiliate_links && article.affiliate_links.length > 0 && (
              <div className="section">
                <h2>Affiliate links</h2>
                <div className="card table-scroll" tabIndex={0} role="region" aria-label="Affiliate links">
                  <table>
                    <tbody>
                      {article.affiliate_links.map((l) => (
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

            {article.draft_md && (
              <div className="section">
                <h2>
                  Draft{' '}
                  <button className="btn secondary small" onClick={() => setShowDraft(!showDraft)}>
                    {showDraft ? 'hide' : 'show'} ({article.draft_md.split(/\s+/).length} words)
                  </button>
                </h2>
                {showDraft && <pre>{article.draft_md}</pre>}
              </div>
            )}

            {confirming?.kind === 'retry' && (
              <RetryConfirm
                title={article.title}
                stage={confirming.stage}
                onCancel={() => setConfirming(null)}
                onConfirm={() => {
                  setConfirming(null);
                  void action('retry-stage', { stage: confirming.stage }, { stage: confirming.stage });
                }}
              />
            )}
            {confirming?.kind === 'rerun' && (
              <RerunAllConfirm
                title={article.title}
                onCancel={() => setConfirming(null)}
                onConfirm={() => {
                  setConfirming(null);
                  void action('rerun-all');
                }}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * First load of one run. Sized to the real panel - 44px action buttons, ~20px
 * badges - so the status card and the action bar do not shove the stage
 * timeline down the page as they arrive.
 */
function RunDetailSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading the run">
      <span className="skel" style={{ width: '70%', height: 20 }} />
      <div className="row" style={{ marginTop: 12 }}>
        <span className="skel" style={{ width: 84, height: 20 }} />
        <span className="skel" style={{ width: 84, height: 20 }} />
        <span className="skel" style={{ width: 160, height: 20 }} />
      </div>
      <div className="stop-card" style={{ borderStyle: 'dashed' }}>
        <span className="skel" style={{ width: 150, height: 18 }} />
        <span className="skel" style={{ width: '90%', height: 14, marginTop: 12 }} />
        <span className="skel" style={{ width: '60%', height: 14, marginTop: 8 }} />
      </div>
      <div className="actions">
        {[0, 1].map((i) => (
          <div className="agroup" key={i}>
            <span className="skel" style={{ width: 120, height: 11 }} />
            <span className="skel" style={{ width: 200, height: 44 }} />
            <span className="skel" style={{ width: 160, height: 44 }} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Which confirmation is open, and what it is about to do. */
type Confirmation = { kind: 'retry'; stage: string } | { kind: 'rerun' };

/**
 * The stage budget, as text. It is server configuration with a hard ceiling in
 * the agent's code, so the panel prints it and says who owns it rather than
 * offering a field that would turn a safety guard into a support surface.
 */
function BudgetLine({ budgetSeconds }: { budgetSeconds: number }) {
  return (
    <div className="budget">
      <span>{stageBudgetLine(budgetSeconds)}</span>
      <span className="lock">🔒 read-only</span>
    </div>
  );
}

/**
 * Every recovery the API supports, one click from the run that needs it and
 * grouped by what it costs you: repair this run, check a stage without
 * changing anything, start over, stop.
 */
function RunActions({
  article,
  retryable,
  leaseLapsed,
  reviewStale,
  reviewStaleReason,
  busy,
  testing,
  onRetry,
  onRerunAll,
  onTest,
  onCancel,
  onApprove,
  onRepublish,
}: {
  article: ArticleDetail['article'];
  /** Whether the agent's retry engine would accept this run at all. */
  retryable: boolean;
  /** Nothing is renewing the claim, so no worker is writing to this run. */
  leaseLapsed: boolean;
  reviewStale: boolean;
  reviewStaleReason: string;
  busy: string | null;
  testing: string | null;
  onRetry: (stage: string) => void;
  onRerunAll: () => void;
  onTest: (stage: string) => void;
  onCancel: () => void;
  onApprove: () => void;
  onRepublish: () => void;
}) {
  const stage = article.stage === 'done' ? 'publish' : article.stage;
  /**
   * The stage the primary retry actually re-runs. It is the run's own stage,
   * except on an article held at publish by a stale review: the agent refuses
   * a retry of `publish` for exactly that reason, so offering it would be a
   * button whose only outcome is a 409. The review is what has to run again,
   * and re-running it carries the article forward through publish anyway.
   */
  const retryStage = reviewStale && stage === 'publish' ? 'seo_review' : stage;
  const label = STAGE_LABELS[stage] ?? stage;
  const retryLabel = STAGE_LABELS[retryStage] ?? retryStage;
  const running = article.status === 'running';
  const testable = isTestableStage(stage);
  /** A cancel that has been accepted but whose row has not moved yet. */
  const cancelling = busy === 'cancel';
  const queueingRetry = busy === 'retry_stage';
  const cancellable = ['running', 'queued', 'failed', 'timed_out', 'waiting_approval'].includes(
    article.status,
  );

  return (
    <div className="actions">
      <div className="agroup">
        <span className="alabel">Recover this run</span>
        <button
          className="btn"
          disabled={!retryable || queueingRetry}
          onClick={() => onRetry(retryStage)}
        >
          {queueingRetry
            ? 'Queuing retry…'
            : retryStage === stage
              ? `Retry from this stage (${stage})`
              : `Retry from ${retryStage}`}
        </button>
        <span className="ahint">
          {retryable ? (
            <>
              Re-runs {retryLabel} against the output already stored for the stage before it, then
              carries on forward.{' '}
              {retryStage !== stage &&
                `${label} itself cannot re-run while its review is out of date. `}
              Everything after {retryLabel} is regenerated.
            </>
          ) : (
            retryBlockedReason(article.status)
          )}
        </span>
      </div>

      <div className="agroup">
        <span className="alabel">Check without changing anything</span>
        <button
          className="btn secondary"
          disabled={running || testing !== null || !testable}
          onClick={() => onTest(stage)}
        >
          {testing ? `Testing ${testing}…` : 'Test this step only'}
        </button>
        <span className="ahint">
          {testable
            ? `Runs ${label} on its own and shows you what came back. Writes nothing to the article - the model call is still billed, and shows up in the attempt history as a test run.`
            : `${untestableStageHint(stage)} Test an earlier stage from the attempt history below.`}
        </span>
      </div>

      {article.status === 'waiting_approval' && (
        <div className="agroup">
          <span className="alabel">Publish</span>
          <button
            className="btn"
            disabled={reviewStale || busy === 'approve_publish'}
            aria-disabled={reviewStale ? 'true' : undefined}
            aria-describedby={reviewStale ? 'approve-blocked-reason' : undefined}
            onClick={onApprove}
          >
            ✅ Approve &amp; publish
          </button>
          <span className="ahint" id={reviewStale ? 'approve-blocked-reason' : undefined}>
            {reviewStale
              ? // Led in rather than opened with: the reason is the agent's own
                // sentence and starts on a stage name, not a capital.
                `Publishing is blocked: ${reviewStaleReason}. Retry from ${STAGE_LABELS.seo_review} above, and this unlocks once the review passes on the current draft.`
              : 'Pushes the assembled article to the live site.'}
          </span>
        </div>
      )}

      <div className="agroup">
        <span className="alabel">Start over, or stop</span>
        {/* Refused only under a live claim - a stalled run is rebuilt from the
            top the same as a stopped one. */}
        <button className="btn secondary" disabled={running && !leaseLapsed} onClick={onRerunAll}>
          Run whole pipeline again
        </button>
        {article.stage === 'done' && article.status === 'done' && (
          <button className="btn ghost" onClick={onRepublish}>
            ♻️ Publish again
          </button>
        )}
        {cancellable && (
          // Kept live while a retry is being queued: a run that has just been
          // committed to spend must never be the one thing nothing can stop.
          <button className="btn danger" disabled={cancelling} onClick={onCancel}>
            {cancelling ? 'Cancelling…' : 'Cancel run'}
          </button>
        )}
        <span className="ahint">
          {queueingRetry
            ? 'Cancel stops the queued retry before it starts, or the running stage once it begins.'
            : cancelling
              ? 'The stage is being stopped; the run lands on cancelled once it lets go.'
              : `Re-running the whole pipeline re-bills every stage from ${STAGE_LABELS.research} onward, including the ones that already succeeded.`}
        </span>
      </div>
    </div>
  );
}

/** What an isolated test run returned. Nothing here reached the article. */
function TestResultPanel({ result, onClose }: { result: TestStageResult; onClose: () => void }) {
  return (
    <div className="section">
      <h2>Test run - {result.stage}</h2>
      <div className="test-result">
        <div className="trh">
          <span className="badge violet">wrote nothing</span>
          {result.agent && <span className="mono muted">{result.agent}</span>}
          {result.model && <span className="mono muted">{result.model}</span>}
          {result.cost_usd !== undefined && (
            <span className="mono">{fmtCost(result.cost_usd)}</span>
          )}
          {result.started_at ? (
            <span className="mono muted">{duration(result.started_at, result.ended_at ?? null)}</span>
          ) : result.duration_ms !== undefined ? (
            <span className="mono muted">{fmtSeconds(result.duration_ms / 1000)}</span>
          ) : null}
          <span className="spacer" />
          <button className="btn ghost small" onClick={onClose}>
            Dismiss
          </button>
        </div>
        <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
          This ran {result.stage} in isolation. The article, its stages and its stored output are
          untouched - only the spend is recorded.
        </p>
        {result.summary && <p style={{ marginTop: 0 }}>{result.summary}</p>}
        {result.output !== undefined && <pre>{formatOutput(result.output)}</pre>}
      </div>
    </div>
  );
}

/** The agent's raw stage output, as readable JSON (it can be any shape). */
function formatOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

/**
 * The run, stage by stage. Out-of-date stages carry the marker and the amber
 * edge: their stored output was superseded by a retry upstream and has not
 * been regenerated yet, which is the state that gets published on a false
 * assumption if nobody labels it.
 */
function StageTimeline({
  article,
  sessions,
  budgets,
  outOfDate,
}: {
  article: ArticleDetail['article'];
  sessions: Session[];
  budgets?: ArticleDetail['budgets'];
  outOfDate: Set<string>;
}) {
  const { groups } = groupAttempts(sessions);
  const byStage = new Map(groups.map((g) => [g.stage, g.sessions]));
  const currentAt = STAGE_ORDER.indexOf(article.stage as (typeof STAGE_ORDER)[number]);

  return (
    <div className="section">
      <h2>Stages</h2>
      <div className="stages">
        {STAGE_ORDER.filter((stage) => stage !== 'done').map((stage) => {
          const attempts = byStage.get(stage) ?? [];
          // A test run writes nothing, so it never speaks for the stage's
          // state - only for its spend.
          const runs = attempts.filter((s) => s.kind !== 'test');
          const last = runs[runs.length - 1];
          const stale = outOfDate.has(stage);
          const current = stage === article.stage;
          const stopped = current && ['timed_out', 'failed'].includes(article.status);
          const cls = stale ? 'stale' : stopped ? 'stopped' : last?.status === 'done' ? 'ok' : '';
          const cost = attempts.reduce((sum, s) => sum + Number(s.cost_usd ?? 0), 0);
          const at = STAGE_ORDER.indexOf(stage);
          return (
            <div className={`stage-row ${cls}`} key={stage}>
              <span className="dot" aria-hidden="true" />
              <div className="sname">
                {stage}
                <small>
                  {STAGE_LABELS[stage] ?? stage}
                  {last?.agent ? ` · ${last.agent}` : ''}
                </small>
              </div>
              <div className="row" style={{ gap: 6 }}>
                {stale && <OutOfDateBadge />}
                {last ? (
                  <Badge value={last.status} />
                ) : stale ? null : currentAt > at ? (
                  <span className="badge gray">no record</span>
                ) : (
                  <span className="muted" style={{ fontSize: 12 }}>
                    not run yet
                  </span>
                )}
                {current && <span className="badge blue">current</span>}
              </div>
              <div className="num">
                {last ? (
                  <Elapsed
                    seconds={elapsedSeconds(last.started_at, last.ended_at)}
                    budgetSeconds={stageBudgetSeconds(stage, budgets)}
                    status={last.status}
                  />
                ) : (
                  '—'
                )}
              </div>
              <div className="cost">
                {attempts.length > 0 && (
                  <>
                    {runs.length} attempt{runs.length === 1 ? '' : 's'}
                    <div>{fmtCost(cost)}</div>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Attempt history, grouped per stage on the one article. A flat session list
 * cannot answer "how many times has the reviewer tried this, and what did it
 * cost"; three rows under `seo_review` can.
 */
function AttemptHistory({
  sessions,
  budgets,
  outOfDate,
  testing,
  busy,
  running,
  retryable,
  onRetry,
  onTest,
}: {
  sessions: Session[];
  budgets?: ArticleDetail['budgets'];
  outOfDate: Set<string>;
  testing: string | null;
  busy: string | null;
  running: boolean;
  retryable: boolean;
  onRetry: (stage: string) => void;
  onTest: (stage: string) => void;
}) {
  const { groups, ungrouped } = groupAttempts(sessions);
  if (groups.length === 0 && ungrouped.length === 0) return null;

  return (
    <div className="section">
      <h2>Attempt history</h2>
      {groups.map((group) => {
        const budget = stageBudgetSeconds(group.stage, budgets);
        const runs = group.sessions.filter((s) => s.kind !== 'test');
        const last = runs[runs.length - 1];
        const cost = group.sessions.reduce((sum, s) => sum + Number(s.cost_usd ?? 0), 0);
        const tests = group.sessions.length - runs.length;
        return (
          <details className="attempt" key={group.stage} open={outOfDate.has(group.stage)}>
            <summary>
              <span className="chev" aria-hidden="true">
                ▶
              </span>
              <span className="sum-name">{group.stage}</span>
              {outOfDate.has(group.stage) && <OutOfDateBadge />}
              {last && <Badge value={last.status} />}
              <span className="sum-meta">
                {runs.length} attempt{runs.length === 1 ? '' : 's'}
                {tests > 0 ? ` · ${tests} test run${tests === 1 ? '' : 's'}` : ''} · {fmtCost(cost)}
              </span>
            </summary>
            <div className="abody" tabIndex={0} role="region" aria-label={`Attempt history table for ${group.stage}`}>
              <table>
                <thead>
                  <tr>
                    <th>Attempt</th>
                    <th>Status</th>
                    <th>Model</th>
                    <th>Started</th>
                    <th>Elapsed</th>
                    <th>Cost</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {group.sessions.map((s) => (
                    <tr key={s.id}>
                      <td className="mono">
                        #{s.attempt ?? 1}
                        {s.kind === 'test' && <span className="badge violet">test</span>}
                      </td>
                      <td>
                        <Badge value={s.status} />
                      </td>
                      <td className="mono muted">{s.model ?? '—'}</td>
                      <td className="muted">{fmtTime(s.started_at)}</td>
                      <td>
                        <Elapsed
                          seconds={elapsedSeconds(s.started_at, s.ended_at)}
                          budgetSeconds={budget}
                          status={s.status}
                        />
                      </td>
                      <td className="mono">{fmtCost(s.cost_usd)}</td>
                      <td className="muted" style={{ maxWidth: 260, whiteSpace: 'pre-wrap' }}>
                        {s.error ?? s.summary ?? '…'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="attempt-actions">
              <button
                className="btn small"
                disabled={!retryable || busy === 'retry_stage'}
                onClick={() => onRetry(group.stage)}
              >
                Retry from this stage
              </button>
              <button
                className="btn secondary small"
                disabled={running || testing !== null || !isTestableStage(group.stage)}
                onClick={() => onTest(group.stage)}
              >
                {testing === group.stage ? 'Testing…' : 'Test this step only'}
              </button>
              <span className="ahint">
                {isTestableStage(group.stage)
                  ? `Retry re-runs ${group.stage} and everything after it. Test runs it on its own and writes nothing.`
                  : `Retry re-runs ${group.stage} and everything after it. ${untestableStageHint(group.stage)}`}
              </span>
            </div>
          </details>
        );
      })}
      {groups.length > 0 && (
        <p className="attempt-hint">
          Each attempt table scrolls sideways for model, started and result - drag it, or focus it
          and use the arrow keys.
        </p>
      )}

      {ungrouped.length > 0 && (
        <>
          <h2 style={{ marginTop: 16 }}>Sessions without a stage</h2>
          <div className="card table-scroll" tabIndex={0} role="region" aria-label="Agent sessions with no recorded stage">
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Status</th>
                  <th>Summary</th>
                  <th>Cost</th>
                  <th>Elapsed</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                {ungrouped.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">{s.agent}</td>
                    <td>
                      <Badge value={s.status} />
                    </td>
                    <td className="muted" style={{ maxWidth: 260 }}>
                      {s.error ?? s.summary ?? '…'}
                    </td>
                    <td className="mono">{fmtCost(s.cost_usd)}</td>
                    <td>
                      <Elapsed
                        seconds={elapsedSeconds(s.started_at, s.ended_at)}
                        budgetSeconds={sessionBudgetSeconds(s, budgets)}
                        status={s.status}
                      />
                    </td>
                    <td className="muted">{fmtTime(s.started_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            Topic searches, and runs recorded before attempts were tracked per stage. The panel does
            not guess which stage they belonged to.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * The retry confirmation. It names the article and splits the pipeline in two:
 * what is kept and read from storage, and what is thrown away and regenerated.
 * That second list is the whole point - retrying `write` silently invalidates
 * the SEO review of a draft that no longer exists.
 */
function RetryConfirm({
  title,
  stage,
  onCancel,
  onConfirm,
}: {
  title: string;
  stage: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const kept = stagesKeptBy(stage);
  const regenerated = stagesRegeneratedBy(stage);
  return (
    <div
      className="confirm-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="confirm-modal wide" role="alertdialog" aria-modal="true" aria-label={`Retry from ${stage}`}>
        <h3>Retry from {stage}?</h3>
        <p className="confirm-topic">{title}</p>
        <div className="stage-split">
          <div>
            <h4>Kept, read from storage</h4>
            <ul className="kept">
              {kept.length === 0 ? <li>nothing - this is the first stage</li> : null}
              {kept.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
          <div>
            <h4>Regenerated, and re-billed</h4>
            <ul className="regen">
              {regenerated.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
        </div>
        <p className="muted" style={{ fontSize: 12.5 }}>
          Until each regenerated stage has run again it is marked “{OUT_OF_DATE_LABEL}”, and an
          article whose review is out of date cannot be approved for publishing.
        </p>
        <div className="confirm-actions">
          <button className="btn secondary" onClick={onCancel}>
            Keep it as it is
          </button>
          <button className="btn" onClick={onConfirm}>
            Retry from {stage}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The expensive one: it re-bills every stage, so it gates on an acknowledgement. */
function RerunAllConfirm({
  title,
  onCancel,
  onConfirm,
}: {
  title: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <div
      className="confirm-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div
        className="confirm-modal wide"
        role="alertdialog"
        aria-modal="true"
        aria-label="Run the whole pipeline again"
      >
        <h3>Run the whole pipeline again?</h3>
        <p className="confirm-topic">{title}</p>
        <div className="stage-split">
          <div>
            <h4>Kept, read from storage</h4>
            <ul className="kept">
              <li>nothing - the run starts at research</li>
            </ul>
          </div>
          <div>
            <h4>Regenerated, and re-billed</h4>
            <ul className="regen">
              {stagesRegeneratedBy('research').map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
        </div>
        <label className="ack">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span>
            I understand every stage re-runs from scratch and every model call is billed again. To
            fix one stage, retry from that stage instead.
          </span>
        </label>
        <div className="confirm-actions">
          <button className="btn secondary" onClick={onCancel}>
            Keep it as it is
          </button>
          <button className="btn danger" disabled={!acknowledged} onClick={onConfirm}>
            Run everything again
          </button>
        </div>
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
