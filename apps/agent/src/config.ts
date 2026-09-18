import 'dotenv/config';

function env(key: string, fallback = ''): string {
  // `||` not `??`: empty strings in .env must fall back too.
  return process.env[key] || fallback;
}

/**
 * The host-side half of the docker-compose mapping in docker-compose.yml
 * (container 5432 published as host 5544). It exists on a developer laptop and
 * nowhere else, so it is only ever a development default - see
 * `resolveDatabase`.
 */
const LOCAL_COMPOSE_URL = 'postgres://sleekdrops:sleekdrops@localhost:5544/sleekdrops_agent';

/** What the entrypoint reports when no environment named a database. */
export const MISSING_DATABASE_URL =
  "DATABASE_URL is not set - point it at this environment's Postgres, " +
  'or inject PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE';

export interface DatabaseTarget {
  /** Connection string for the pool. Empty when the environment names none. */
  url: string;
  /** `host:port/database`, credentials stripped - safe to log. */
  label: string;
}

/**
 * Where the pool dials, in the order an environment supplies it:
 *
 * 1. `DATABASE_URL` - what deploys, previews and CI set explicitly.
 * 2. `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` - what container
 *    platforms inject when they attach a managed Postgres.
 * 3. The docker-compose URL, and only outside production.
 *
 * Production never guesses: with nothing to resolve the url is empty so the
 * entrypoint can fail with a config error. Shipping the compose URL as the
 * unconditional default is what killed the v0.14.0 agent at boot - every
 * deployed instance dialled a port that only listens on a laptop.
 */
export function resolveDatabase(source: NodeJS.ProcessEnv = process.env): DatabaseTarget {
  const explicit = source.DATABASE_URL;
  if (explicit) return { url: explicit, label: describeUrl(explicit) };
  const injected = fromPgVars(source);
  if (injected) return injected;
  if (source.NODE_ENV === 'production') return { url: '', label: '(unset)' };
  return { url: LOCAL_COMPOSE_URL, label: describeUrl(LOCAL_COMPOSE_URL) };
}

/** A DSN from the libpq vars, but only when they name a complete target. */
function fromPgVars(source: NodeJS.ProcessEnv): DatabaseTarget | undefined {
  const { PGHOST: host, PGUSER: user, PGDATABASE: database, PGPASSWORD: password } = source;
  if (!host || !user || !database) return undefined;
  const port = source.PGPORT || '5432';
  const credentials = password
    ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}`
    : encodeURIComponent(user);
  // A socket directory - Cloud SQL injects PGHOST=/cloudsql/<instance> - cannot
  // sit in a URL authority, so it travels as the `host` parameter instead.
  const target = host.startsWith('/')
    ? `@/${encodeURIComponent(database)}?host=${encodeURIComponent(host)}&port=${port}`
    : `@${host}:${port}/${encodeURIComponent(database)}`;
  return { url: `postgres://${credentials}${target}`, label: `${host}:${port}/${database}` };
}

/**
 * `host:port/database` for logs. Never includes the user or the password, and
 * degrades to a placeholder rather than throwing: this string exists to make a
 * misrouted DSN legible, so it must never be the thing that fails.
 */
function describeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.searchParams.get('host') || parsed.hostname || '(local socket)';
    const port = parsed.port || parsed.searchParams.get('port') || '5432';
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, '')) || '(default)';
    return `${host}:${port}/${database}`;
  } catch {
    return '(unparsable connection string)';
  }
}

const database = resolveDatabase();

export const config = {
  databaseUrl: database.url,
  /** Log this instead of the URL: a misrouted DSN is then one legible line. */
  databaseLabel: database.label,

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
