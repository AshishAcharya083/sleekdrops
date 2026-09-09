// Thin API client. If the agent server has ADMIN_TOKEN set, the token typed
// into the header bar is stored in localStorage and sent as a bearer.
//
// This is also the panel's single fetch chokepoint, so it is where the client
// trace id goes out as X-Trace-Id and where every request failure is logged and
// reported with a stack trace. The agent's log lines for the same request carry
// that id, so a client error in the Analytics tab leads straight to them.
import { TRACE_HEADER, captureError, getTraceId, log } from './analytics';

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

export interface SeoReviewDetail {
  score: number;
  pass: boolean;
  issues: Array<{ severity: string; issue: string; fix: string }>;
  summary: string;
  /** Per-axis scores. Absent on reviews written before dimensional scoring. */
  dimensions?: { seo: number; geo: number; voice: number; eeat: number; links: number };
  /** Deterministic anti-slop scan that ran before the model saw the draft. */
  slop?: { score: number; words: number; findings: number };
}

export interface ArticleDetail {
  article: ArticleSummary & {
    hero_alt: string | null;
    research: unknown;
    keyword_plan: KeywordPlan | null;
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
    const attributes = { route: path, method, source: 'api', duration_ms: elapsed(started) };
    log('error', `api request unreachable ${method} ${path}`, attributes);
    captureError(e, attributes);
    throw e;
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; traceId?: string };
    const error = new Error(body.error ?? `HTTP ${res.status}`);
    const attributes = {
      route: path,
      method,
      http_status: res.status,
      source: 'api',
      duration_ms: elapsed(started),
      // The agent returns its trace id on uncaught errors and echoes it on every
      // response, so the report points at the exact server-side log lines.
      server_trace_id: body.traceId ?? res.headers.get(TRACE_HEADER) ?? undefined,
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
export const duration = (start: string, end: string | null): string => {
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
