// Thin API client. If the agent server has ADMIN_TOKEN set, the token typed
// into the header bar is stored in localStorage and sent as a bearer.
//
// This is also the panel's single fetch chokepoint, so it is where the client
// trace id goes out as X-Trace-Id, where every request failure is logged and
// reported with a stack trace, and where that failure is classified (see
// api-error.ts) so a tab can tell a rejected token from a stopped server. The
// agent's log lines for the same request carry that id, so a client error in
// the Analytics tab leads straight to them.
import { TRACE_HEADER, captureError, getTraceId, log } from './analytics';
import { ApiError, apiErrorFromResponse } from './api-error';

/** A markdown reference the operator supplied (uploaded file or pasted block). */
export interface ReferenceMaterial {
  name: string;
  content: string;
}

export interface Topic {
  id: string;
  title: string;
  category: string;
  post_type: string;
  angle: string | null;
  keywords: string[];
  why_trending: string | null;
  sources: string[];
  status: string;
  /** 'scout' (Topic Scout) | 'manual' (operator-authored). */
  source: string;
  instructions: string | null;
  research_notes: ReferenceMaterial[];
  /** Operator-dropped hero image, attached while briefing the piece. */
  hero_image_url: string | null;
  hero_alt: string | null;
  created_at: string;
}

/** Payload for POST /api/topics/manual (create when `id` absent, else edit). */
export interface ManualTopicPayload {
  id?: string;
  title: string;
  instructions: string;
  category: string;
  post_type: string;
  /** The image file itself is uploaded separately; only its alt text is here. */
  hero_alt: string;
  references: ReferenceMaterial[];
}

/**
 * The scout run holding the sweep lock, as GET /api/scout/lock reports it.
 * A sweep is a background task, so its 'running' row is the only thing keeping
 * two of them apart - and a run whose instance died used to hold that row
 * forever. The agent now leases it, and this is what the Topics tab reads to
 * show the operator who holds the lock and to offer to release it.
 */
export interface ScoutLock {
  id: string;
  started_at: string;
  heartbeat_at: string;
  /** Seconds since the run started - how long the lock has been held. */
  age_seconds: number;
  /** Seconds since the run last reported it was alive. */
  heartbeat_age_seconds: number;
}

export const TOPIC_CATEGORIES = ['Tech', 'Home', 'Fashion', 'Health', 'Finance', 'Travel'] as const;
export const TOPIC_POST_TYPES = ['article', 'guide', 'roundup'] as const;

export interface ArticleSummary {
  id: string;
  title: string;
  slug: string | null;
  category: string;
  post_type: string;
  stage: string;
  status: string;
  revision_round: number;
  seo_score: string | null;
  hero_image_url: string | null;
  error: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: string;
  article_id: string | null;
  scout_run_id: string | null;
  agent: string;
  model: string | null;
  status: string;
  summary: string | null;
  error: string | null;
  tokens_input: number;
  tokens_output: number;
  cost_usd: string;
  llm_calls: number;
  started_at: string;
  ended_at: string | null;
  article_title?: string | null;
}

export interface Overview {
  topics: Array<{ status: string; n: string }>;
  articles: Array<{ stage: string; status: string; n: string }>;
  runningSessions: number;
  usage30d: { costUsd: number; tokensInput: number; tokensOutput: number; runs: number };
  recentSessions: Session[];
  publishMode: string;
  workerEnabled: boolean;
  /**
   * Sections whose query failed: the agent answers with the ones that worked
   * and names the rest here instead of collapsing the whole page to a 500.
   * Absent on an agent older than that change.
   */
  failedSections?: string[];
}

/** Keyword strategist output — mirrors KeywordPlan in the agent app. */
export interface KeywordPlan {
  primaryKeyword: string;
  rationale: string;
  intent: string;
  difficulty: string;
  zeroClickRisk: string;
  serpFeatures: string[];
  winningFormat: string;
  wordCountTarget: number;
  secondaryKeywords: string[];
  paaQuestions: string[];
  entities: string[];
  competitors: Array<{ url: string; format: string; angle: string; strength: string }>;
  contentGaps: string[];
  snippetTarget: { question: string; format: string; answer: string };
  currentAiAnswer: string;
  titleOptions: string[];
  metaDescription: string;
  rejected: Array<{ keyword: string; reason: string }>;
}

/**
 * The angle stage's record - what the piece argues, decided before it was
 * outlined. Mirrors EditorialAngle in the agent app.
 */
export interface EditorialAngle {
  thesis: string;
  reader: string;
  defensible: boolean;
  contrarianTake: string;
  weakness: string;
  informationGain: Array<{ claim: string; absentFrom: string; evidence: string }>;
  shape: string;
  shapeRationale: string;
  /** The beat voice the piece is written in - the byline itself is the team. */
  byline: string;
  bylineRationale: string;
}

/**
 * The structure library shape a piece was outlined to - which sections it
 * carries, in what order, under what names, and how many extractable passages
 * it spends. Mirrors ArticleShape in the agent app. Null on articles outlined
 * before the library existed.
 */
export interface StructureShape {
  id: string;
  name: string;
  openingStyle: string;
  passageBudget: { passages: number; words: { min: number; max: number } };
  faq: 'required' | 'optional' | 'omit';
  sections: Array<{
    kind: string;
    label: string;
    required: boolean;
    slot: string;
    purpose: string;
    carriesAnswer: boolean;
    repeats?: boolean;
  }>;
  /** Which record decided it: the angle, the SERP read, or the fallback. */
  selectedBy?: string;
}

export interface SeoReviewDetail {
  score: number;
  pass: boolean;
  issues: Array<{ severity: string; issue: string; fix: string }>;
  summary: string;
  /**
   * Per-axis scores. Absent on reviews written before dimensional scoring, and
   * carrying the pre-rebuild axes (seo, geo, voice, eeat, links) on reviews
   * written before the reviewer graded against competitors. Kept as an open
   * record so the panel renders whichever axes a review actually has.
   */
  dimensions?: Record<string, number>;
  /** Deterministic anti-slop scan that ran before the model saw the draft. */
  slop?: { score: number; words: number; findings: number };
  /** What the piece adds over the top results the keyword stage captured. */
  competitorDelta?: {
    comparedWith: string[];
    additions: Array<{ claim: string; absentFrom: string; evidence: string }>;
    duplicated: string[];
    verdict: string;
    notes: string;
  };
  /** Specifics checked against the dossier, and how many it did not carry. */
  claimAudit?: { checked: number; unsupported: number };
}

/**
 * The research stage's deterministic verdict, as the pipeline stamped it onto
 * the dossier. The panel shows this because "research failed" on its own sends
 * an operator back to re-run the same stage; the shortfall says which stratum
 * was thin and where that evidence is actually gathered.
 */
export interface EvidenceSufficiency {
  pass: boolean;
  postType: string;
  counts: Record<string, number>;
  shortfalls: Array<{ stratum: string; label: string; have: number; need: number; fix: string }>;
  message: string;
  checkedAt: string;
}

/** Only the part of the dossier the panel renders. */
export interface ResearchDetail {
  /** Absent on dossiers written before the evidence gate existed. */
  sufficiency?: EvidenceSufficiency;
}

/**
 * The live page a requalification started from, as the agent captured it.
 * Present only while (and after) an article is a rebuild of a published page.
 */
export interface RequalificationSource {
  slug: string;
  title: string;
  angle: string;
  pubDate: string | null;
  goSlugs: string[];
  requestedAt: string;
  /** The published body. Carried by the API; the panel shows the length, not the text. */
  body: string;
}

export interface ArticleDetail {
  article: ArticleSummary & {
    hero_alt: string | null;
    requalification: RequalificationSource | null;
    research: ResearchDetail | null;
    keyword_plan: KeywordPlan | null;
    editorial_angle: EditorialAngle | null;
    structure_shape: StructureShape | null;
    outline: unknown;
    draft_md: string | null;
    seo_review: SeoReviewDetail | null;
    frontmatter: Record<string, unknown> | null;
    affiliate_links: Array<{ slug: string; default_url: string; note?: string }> | null;
  };
  sessions: Session[];
}

export interface PublishedPost {
  slug: string;
  status: string;
  title: string;
  category: string;
  post_type: string;
  author: string;
  pub_date: string;
  updated_at: string;
  /** Read out of the live post's frontmatter — null when it has no hero. */
  hero_image: string | null;
  hero_alt: string | null;
}

/** One published page's place in the corpus audit's ranking. */
export interface AuditedArticle {
  slug: string;
  title: string;
  publishedAt: string | null;
  words: number;
  scanScore: number;
  scanFindings: number;
  worstRules: Array<{ category: string; rule: string; count: number; severity: string }>;
  review: {
    dimensions: Record<string, number>;
    score: number;
    summary: string;
    issues: Array<{ severity: string; issue: string; fix: string }>;
  } | null;
  reviewError: string | null;
  score: number;
  band: 'requalify' | 'review' | 'ok';
  verdict: string;
}

/** The ranked report one audit sweep wrote - worst page first. */
export interface CorpusAuditReport {
  generatedAt: string;
  scanned: number;
  articles: AuditedArticle[];
  bands: Record<string, number>;
  requalify: string[];
  summary: string;
}

/** The audit sweep itself. `report` is null until it finishes. */
export interface CorpusAudit {
  id: string;
  status: string;
  articles_scanned: number;
  report: CorpusAuditReport | null;
  error: string | null;
  started_at: string;
  ended_at: string | null;
}

/**
 * The run holding the audit lock. Same lease contract the scout lock uses: a
 * sweep is a detached background task, and a run whose instance died stops
 * holding the lock once its heartbeat goes stale.
 */
export interface CorpusAuditLock {
  id: string;
  started_at: string;
  heartbeat_at: string;
  age_seconds: number;
  heartbeat_age_seconds: number;
}

/** What the requalify routes answer with. */
export interface RequalifyResult {
  ok: boolean;
  article_id: string;
  slug: string;
  /** True when the live page had no pipeline article behind it until now. */
  created: boolean;
  go_slugs: string[];
}

/** What the hero routes report back about the site rebuild they asked for. */
export interface RebuildResult {
  dispatched: boolean;
  dispatchError?: string | null;
}

/** Whether an engine can actually run, and where its credential came from. */
export interface EngineReadiness {
  configured: boolean;
  source: 'admin-settings' | 'env-oauth-token' | 'env-api-key' | 'vertex-adc' | null;
}

export interface Settings {
  models: Record<string, string>;
  publish_mode: string;
  max_revision_rounds: number;
  worker_enabled: boolean;
  llm: {
    gemini_api_key?: string;
    gemini_model?: string;
    claude_token?: string;
    claude_model?: string;
    prose_engine?: 'claude' | 'gemini';
  };
  scout_interval_hours: number;
  /** Derived server-side, read-only — the API ignores it on save. */
  engines?: { claude: EngineReadiness; gemini: EngineReadiness };
}

export function getToken(): string {
  return localStorage.getItem('sleekdrops_admin_token') ?? '';
}

export function setToken(token: string): void {
  localStorage.setItem('sleekdrops_admin_token', token);
}

/**
 * Where the agent API lives. Empty = same origin (the agent server serves
 * this SPA locally). The Cloudflare Pages build bakes in the Cloud Run URL
 * via VITE_API_BASE as the default; the header field (localStorage) can
 * still override it, e.g. with http://localhost:8787 for a local platform.
 */
export function getApiBase(): string {
  const stored = localStorage.getItem('sleekdrops_api_base');
  const base = stored ?? (import.meta.env.VITE_API_BASE as string | undefined) ?? '';
  return base.replace(/\/+$/, '');
}

export function setApiBase(base: string): void {
  localStorage.setItem('sleekdrops_api_base', base.trim());
}

const elapsed = (startedAt: number): number => Math.round(performance.now() - startedAt);

/**
 * The one place a request leaves the panel: auth, trace header, failure logging
 * and error reporting all live here, whether the body is JSON or a file.
 */
async function request<T>(path: string, init: RequestInit, headers: Record<string, string>): Promise<T> {
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const traceId = getTraceId();
  if (traceId) headers[TRACE_HEADER] = traceId;

  const method = init.method ?? 'GET';
  const started = performance.now();
  log('info', `api request ${method} ${path}`, { route: path, method });

  let res: Response;
  try {
    res = await fetch(`${getApiBase()}${path}`, { ...init, headers });
  } catch (e) {
    // Reported as an ApiError so the banner can say "unreachable" rather than
    // guess, but it keeps the thrown value's message and stack: the message is
    // what the error-report dedupe keys on, and the stack is where it happened.
    const error = new ApiError(e instanceof Error ? e.message : String(e), { kind: 'unreachable' });
    if (e instanceof Error && e.stack) error.stack = e.stack;
    const attributes = { route: path, method, source: 'api', duration_ms: elapsed(started) };
    log('error', `api request unreachable ${method} ${path}`, attributes);
    captureError(error, attributes);
    throw error;
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; traceId?: string };
    const error = apiErrorFromResponse(res, body, TRACE_HEADER);
    const attributes = {
      route: path,
      method,
      http_status: res.status,
      source: 'api',
      duration_ms: elapsed(started),
      // The agent returns its trace id on uncaught errors and echoes it on every
      // response, so the report points at the exact server-side log lines.
      server_trace_id: error.traceId ?? undefined,
    };
    log('error', `api request failed ${method} ${path}`, attributes);
    captureError(error, attributes);
    throw error;
  }
  return (await res.json()) as T;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  return request<T>(path, init ?? {}, { 'Content-Type': 'application/json' });
}

/**
 * Multipart POST for the hero-image drop. The Content-Type header is
 * deliberately left unset: the browser has to add it itself, together with the
 * multipart boundary it generated.
 */
export async function apiUpload<T>(
  path: string,
  { file, fields }: { file?: File | null; fields?: Record<string, string> } = {},
): Promise<T> {
  const body = new FormData();
  if (file) body.set('file', file, file.name);
  for (const [key, value] of Object.entries(fields ?? {})) body.set(key, value);
  return request<T>(path, { method: 'POST', body }, {});
}

export const fmtCost = (v: number | string): string => `$${Number(v).toFixed(4)}`;
export const fmtTokens = (v: number | string): string => {
  const n = Number(v);
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
};
export const fmtTime = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
/** An age in seconds, the way the agent words it in the scout-lock message. */
export const fmtAge = (seconds: number): string => {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};
export const duration = (start: string, end: string | null): string => {
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
