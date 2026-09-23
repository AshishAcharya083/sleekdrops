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
 * A non-negative whole number from the environment, or the fallback. Unlike
 * `positiveNumber`, zero is a value a deployment may legitimately mean.
 */
function wholeNumber(key: string, fallback: number): number {
  const value = Number(env(key, String(fallback)));
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * Wall-clock budget for one pipeline stage, as a deployment asks for it
 * (AGENT_RUN_TIMEOUT_SECONDS). Deliberately a deployment value rather than an
 * operator setting, and never the last word: the ceiling it cannot raise, the
 * per-stage overrides and the reasoning behind all three live together in
 * pipeline/budgets.ts.
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

  /**
   * Social distribution. The site URL is where the readiness gate looks for a
   * published slug before an item is handed to a provider, so it must be the
   * origin the rebuild actually deploys to - the same default apps/web's
   * astro.config.mjs carries, overridable with SITE_URL for a preview.
   */
  distribution: {
    siteUrl: env('SITE_URL', 'https://sleekdrops.com').replace(/\/+$/, ''),
    pollMs: positiveNumber('DISTRIBUTION_POLL_MS', 15_000),
    /**
     * How often posted items are checked for a due insights reading. Coarse on
     * purpose: the checkpoints themselves are hours apart, so this only bounds
     * how late a reading is taken, and every poll that finds nothing due is a
     * single indexed query.
     */
    insightsPollMs: positiveNumber('DISTRIBUTION_INSIGHTS_POLL_MS', 300_000),
  },

  /**
   * The Facebook Page adapter. No token here on purpose: the Page access token
   * is resolved by reference at post time (channel_connections.token_ref), so
   * it is a Secret Manager secret or a value pasted in admin Settings, never an
   * env var this file names.
   *
   * App credentials are optional and only sharpen two things: with them a
   * token's real expiry can be read (debug_token wants an app access token) and
   * a short-lived token can be exchanged for a long-lived one. Without them the
   * adapter posts identically - a Business Manager System User Page token, the
   * credential this is designed around, does not expire at all.
   */
  facebook: {
    graphVersion: env('FACEBOOK_GRAPH_VERSION', 'v21.0'),
    appId: env('FACEBOOK_APP_ID'),
    appSecret: env('FACEBOOK_APP_SECRET'),
    /**
     * Organic link posts Meta allows a non-subscribing Page per calendar month.
     * Roughly two at the time of writing, and a live test rather than a settled
     * policy - hence a knob. Zero is meaningful (never place a link in the
     * body), which is why this is not `positiveNumber`.
     */
    bodyLinkCap: wholeNumber('FACEBOOK_BODY_LINK_CAP', 2),
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
