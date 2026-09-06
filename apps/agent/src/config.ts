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
};
