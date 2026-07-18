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

  // Claude subscription (writer/editor engine). The OAuth token comes from
  // `claude setup-token` and only works through the Claude Agent SDK/CLI.
  claude: {
    oauthToken: env('CLAUDE_CODE_OAUTH_TOKEN'),
    apiKey: env('ANTHROPIC_API_KEY'),
    modelDefault: env('CLAUDE_MODEL', 'claude-sonnet-4-5'),
  },

  tavilyApiKey: env('TAVILY_API_KEY'),

  // Hero-image storage on Cloudflare R2 (S3-compatible). The image stage
  // uploads the vetted product photo here under posts/{YYYY}/{MM}/{slug}/hero.jpg
  // and stores the public URL in the post frontmatter. Any value missing =
  // stage skips itself and articles fall back to the gradient cover art.
  r2: {
    accountId: env('R2_ACCOUNT_ID'),
    accessKeyId: env('R2_ACCESS_KEY_ID'),
    secretAccessKey: env('R2_SECRET_ACCESS_KEY'),
    bucket: env('R2_BUCKET'),
    // Public domain that serves the bucket (an R2 custom domain or the managed
    // r2.dev subdomain). Hero URL = `${publicBase}/posts/{YYYY}/{MM}/{slug}/hero.jpg`.
    publicBase: env('R2_PUBLIC_URL').replace(/\/+$/, ''),
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
