# SleekDrops monorepo

Everything SleekDrops in one repo:

| App | What it is | Stack |
| --- | --- | --- |
| [`apps/web`](apps/web) | The public website — sleekdrops.com | Astro → Cloudflare Pages, content from Cloudflare D1 |
| [`apps/agent`](apps/agent) | The agent platform — a multi-agent pipeline that discovers trending topics and writes SEO-optimized articles | Node/TypeScript, PostgreSQL, OpenRouter |
| [`apps/admin`](apps/admin) | Admin panel for the agent platform — pick topics, watch progress, approve publishes, track AI spend | React + Vite |

The old `sleekdrops-agent` repo is superseded by `apps/agent` and can be archived.

## How the whole thing fits together

```
                 ┌──────────────────────────── apps/admin ───────────────┐
                 │  Topics · Pipeline board · Sessions · Usage · Settings │
                 └────────────────────────┬───────────────────────────────┘
                                          │ REST (/api/*)
┌─ apps/agent ────────────────────────────▼───────────────────────────────┐
│ topic scout → [you approve topics] → research → outline → write         │
│    → SEO review ⇄ edit (bounded loop) → assemble → publish              │
│                                                                          │
│ State: PostgreSQL (topics, articles, agent_sessions, settings)           │
│ LLM:   OpenRouter — any model per agent (Gemini, Claude, GPT, …)         │
└──────────────┬───────────────────────────────────────────┬──────────────┘
               │ posts + affiliate_links                    │ repository_dispatch
               ▼                                            ▼ (content-updated)
        Cloudflare D1  ◄──────────── build-time fetch ── GitHub Actions
        (sleekdrops-content)                                │
                                                            ▼
                                              apps/web → Cloudflare Pages
```

- **PostgreSQL** holds pipeline/operational state (better fit for atomic job
  claims, JSONB dossiers, usage aggregation).
- **Cloudflare D1** stays the publish target — the website's build reads it,
  so the existing deploy flow is untouched (~90s from publish to live).

## Quickstart

```bash
corepack enable pnpm   # or: npm i -g pnpm
pnpm install

# Website
pnpm dev:web           # needs apps/web/.env (D1 read credentials)

# Agent platform
pnpm db:up             # starts dockerized Postgres on :5544
cp apps/agent/.env.example apps/agent/.env   # fill in OPENROUTER_API_KEY etc.
pnpm dev:agent         # API + worker + admin panel on http://localhost:8787
pnpm dev:admin         # (optional) admin panel dev server on :5173
```

Build everything: `pnpm build`. Deploys run from GitHub Actions
(`develop` → sleekdrops.pages.dev, `main`/content-dispatch → sleekdrops.com).

See [`apps/agent/README.md`](apps/agent/README.md) for the pipeline design and
[`apps/web/README.md`](apps/web/README.md) for the editorial rules.
