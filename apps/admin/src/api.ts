// Thin API client. If the agent server has ADMIN_TOKEN set, the token typed
// into the header bar is stored in localStorage and sent as a bearer.

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
  created_at: string;
}

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

export interface ArticleDetail {
  article: ArticleSummary & {
    research: unknown;
    outline: unknown;
    draft_md: string | null;
    seo_review: { score: number; pass: boolean; issues: Array<{ severity: string; issue: string; fix: string }>; summary: string } | null;
    frontmatter: Record<string, unknown> | null;
    affiliate_links: Array<{ slug: string; default_url: string; note?: string }> | null;
  };
  sessions: Session[];
}

export interface Settings {
  models: Record<string, string>;
  publish_mode: string;
  max_revision_rounds: number;
  worker_enabled: boolean;
  llm: { base_url?: string; api_key?: string; default_model?: string };
  scout_interval_hours: number;
}

export function getToken(): string {
  return localStorage.getItem('sleekdrops_admin_token') ?? '';
}

export function setToken(token: string): void {
  localStorage.setItem('sleekdrops_admin_token', token);
}

/**
 * Where the agent API lives. Empty = same origin (the agent server serves
 * this SPA locally). The Cloudflare Pages deployment of this panel sets it
 * to wherever the agent platform runs, e.g. http://localhost:8787.
 */
export function getApiBase(): string {
  return (localStorage.getItem('sleekdrops_api_base') ?? '').replace(/\/+$/, '');
}

export function setApiBase(base: string): void {
  localStorage.setItem('sleekdrops_api_base', base.trim());
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${getApiBase()}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
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
