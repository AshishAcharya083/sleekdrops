# Supabase

SleekDrops keeps everything it stores in one Supabase project:

| | |
| --- | --- |
| Project | `SleekDrops`, ref `ofcujovpxfoxvpfkszmf` |
| Organisation | Vitalize (free plan) |
| Region | ap-southeast-2 (Sydney) |
| API URL | https://ofcujovpxfoxvpfkszmf.supabase.co |

## What is in it

- **Postgres, `public` schema.** The agent platform's tables (topics,
  articles, agent sessions, settings, platforms, distribution, ...) and the two
  tables the website builds from, `posts` and `affiliate_links`. All of it is
  created by the agent's own migrations (`apps/agent/src/db/migrations`), which
  run on every boot of the platform and record themselves in
  `schema_migrations`. Migration 019 is the content store and the access
  policy described below.
- **Storage, bucket `images`.** Public hero images, defined in
  [`storage.sql`](storage.sql). Public object URLs look like
  `https://ofcujovpxfoxvpfkszmf.supabase.co/storage/v1/object/public/images/heroes/<file>`.

## Who can read what

| Key | Where it lives | What it can do |
| --- | --- | --- |
| Publishable (`sb_publishable_…`) | GitHub repository variable `SUPABASE_PUBLISHABLE_KEY`, `apps/web/.env.example` | Read published `posts` and every `affiliate_links` row through the Data API; read public images. Nothing else. |
| Service role / secret (`sb_secret_…`) | `apps/agent/.env` only | Upload images. Bypasses row-level security. |
| Database password | `apps/agent/.env` only, inside `DATABASE_URL` | The agent's connection: owner of every table. |

Supabase grants the Data API roles (`anon`, `authenticated`) everything in
`public` by default. Migration 019 revokes that - for existing tables and, via
default privileges, for tables later migrations create - turns row-level
security on for every table, and grants back exactly the two `SELECT` policies
the website needs. A pipeline table therefore never becomes readable with the
publishable key by accident; making one readable is a deliberate migration.

## Connecting

Use the **Session pooler** URI from the dashboard (Connect → Session pooler):
IPv4, and it keeps session features the worker relies on. Add
`?sslmode=no-verify` - node-postgres reads plain `sslmode=require` as
verify-full, which fails against Supabase's own CA unless its certificate is
supplied. `psql` and `pg_dump` take `sslmode=require` as usual.

## Free-plan limits worth knowing

At the time of writing: 500 MB database, 1 GB file storage, 5 GB egress plus
5 GB cached egress a month. Hero images are served straight from Storage, so
image egress grows with traffic; at around 1 MB a hero, that is the first
limit the site would meet (check Usage in the dashboard). Supabase may also
pause a free project that sees no activity for about a week; the site's builds,
its image requests and the agent's connections are all activity, but a paused
project would take the images down with it, so keep an eye on it while traffic
is low.
