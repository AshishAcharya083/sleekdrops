import 'dotenv/config';

function env(key: string, fallback = ''): string {
  // `||` not `??`: empty strings in .env must fall back too.
  return process.env[key] || fallback;
}

export const config = {
  databaseUrl: env(
    'DATABASE_URL',
    'postgres://sleekdrops:sleekdrops@localhost:5544/sleekdrops_agent',
  ),

  openrouter: {
    apiKey: env('OPENROUTER_API_KEY'),
    baseUrl: env('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'),
    // Shown on openrouter.ai activity dashboards.
    siteUrl: env('OPENROUTER_SITE_URL', 'https://sleekdrops.com'),
    appName: env('OPENROUTER_APP_NAME', 'sleekdrops-agent'),
  },
  // Google AI Studio key — bills the GCP project it belongs to, so Google
  // Cloud credits apply. Used when the admin selects the "gemini" provider.
  geminiApiKey: env('GEMINI_API_KEY'),
  modelDefault: env('MODEL_DEFAULT', 'google/gemini-2.5-flash'),

  tavilyApiKey: env('TAVILY_API_KEY'),

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
};
