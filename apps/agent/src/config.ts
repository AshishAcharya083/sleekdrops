import 'dotenv/config';

function env(key: string, fallback = ''): string {
  // `||` not `??`: empty strings in .env must fall back too.
  return process.env[key] || fallback;
}

/**
 * A positive number from the environment, or the fallback. Anything else -
 * blank, a typo, a negative - falls back rather than propagating: these values
 * bound a safety guard, and a guard configured to zero is worse than no guard.
 */
function positiveNumber(key: string, fallback: number): number {
  const value = Number(env(key, String(fallback)));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Wall-clock budget for one pipeline stage, as a deployment asks for it.
 *
 * Deliberately not an operator setting. Comparable tooling treats an execution
 * timeout as a build/config-time value with a fixed platform ceiling (Zapier's
 * 30s is unchangeable, Make's 40min is a guardrail, GitHub Actions caps at
 * 360min, n8n's author-facing field is bounded by an admin-set maximum) - a
 * free-form number in the admin panel turns a guard into a support surface
 * ("someone set it to 5 seconds and everything fails") for no operator
 * benefit. What the operator sees is the outcome: a 'timed_out' run whose
 * error names the limit. A stage that genuinely needs longer gets a per-stage
 * override in the stage definition map; the ceiling this cannot raise lives
 * with it, in pipeline/budgets.ts.
 */
export const DEFAULT_STAGE_TIMEOUT_SECONDS = 3600;

export const config = {
  // No fallback on purpose: the docker-compose URL (port 5544 is a host-side
  // mapping that exists only on a laptop running `pnpm db:up`) is documentation
  // in .env.example, not a universal default. Empty means "let the `pg` driver
  // resolve PGHOST/PGPORT/... itself" - see db/pool.ts.
  databaseUrl: env('DATABASE_URL'),

  // Google AI Studio key — bills the GCP project it belongs to, so Google
  // Cloud credits apply. On Cloud Run, Vertex ADC replaces the key entirely.
  geminiApiKey: env('GEMINI_API_KEY'),
  geminiModelDefault: env('MODEL_DEFAULT', 'gemini-2.5-flash').replace(/^google\//, ''),
  vertex: {
    enabled: env('GOOGLE_GENAI_USE_VERTEXAI').toLowerCase() === 'true',
    project: env('GOOGLE_CLOUD_PROJECT'),
    location: env('GOOGLE_CLOUD_LOCATION', 'us-central1'),
  },

  // Claude subscription (the article-writing engine). The OAuth token comes
  // from `claude setup-token` and only works through the Claude Agent SDK/CLI.
  // Opus 5 is the default: every stage whose judgement reaches the published
  // piece runs on it, and on a subscription the marginal cost is zero.
  claude: {
    oauthToken: env('CLAUDE_CODE_OAUTH_TOKEN'),
    apiKey: env('ANTHROPIC_API_KEY'),
    modelDefault: env('CLAUDE_MODEL', 'claude-opus-5'),
  },

  tavilyApiKey: env('TAVILY_API_KEY'),

  // Hero-image storage. The bucket must allow public reads (allUsers →
  // Storage Object Viewer); uploaded objects are served from
  // https://storage.googleapis.com/<bucket>/<object>. Empty = image stage
  // skips itself and articles keep the generated cover fills.
  gcs: {
    imagesBucket: env('GCS_IMAGES_BUCKET'),
    // Override when serving through a CDN / custom domain instead.
    publicBase: env('GCS_PUBLIC_BASE', 'https://storage.googleapis.com'),
  },

  d1: {
    accountId: env('CLOUDFLARE_ACCOUNT_ID'),
    databaseId: env('D1_DATABASE_ID'),
    token: env('CLOUDFLARE_D1_TOKEN') || env('CLOUDFLARE_API_TOKEN'),
  },

  github: {
    token: env('GITHUB_TOKEN'),
    repo: env('GITHUB_REPO', 'AshishAcharya083/sleekdrops'),
  },

  adminToken: env('ADMIN_TOKEN'),
  port: Number(env('PORT', '8787')),
  workerConcurrency: Number(env('WORKER_CONCURRENCY', '2')),
  pollMs: Number(env('POLL_MS', '5000')),

  /**
   * Wall-clock budget for one stage run. Clamped to MAX_STAGE_TIMEOUT_SECONDS
   * where it is read (pipeline/budgets.ts) - this value is what the deployment
   * asked for, not necessarily what it gets.
   */
  agentRunTimeoutSeconds: positiveNumber(
    'AGENT_RUN_TIMEOUT_SECONDS',
    DEFAULT_STAGE_TIMEOUT_SECONDS,
  ),

  /**
   * How many worker polls between reaper sweeps. At the default poll of 5s
   * that is a sweep a minute: often enough that a wedged run is noticed while
   * the process is alive, rare enough that the sweep is not most of what the
   * worker does.
   */
  reaperEveryTicks: positiveNumber('REAPER_EVERY_TICKS', 12),
};
