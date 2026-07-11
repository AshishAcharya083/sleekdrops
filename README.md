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
./up.sh          # Postgres + agent platform (API + worker + admin panel on :8787)
./up.sh --web    # ... plus the website dev server on :4321
./down.sh        # stop everything (--wipe also deletes the database)
```

First run creates `apps/agent/.env` from the example — add your
`OPENROUTER_API_KEY` there, or set the provider straight from the admin
panel's Settings tab. Logs live in `.run/`.

Piecemeal alternatives: `pnpm db:up`, `pnpm dev:agent`, `pnpm dev:admin`,
`pnpm dev:web`, `pnpm build`.

## Environments

There is **one** agent platform environment (one Postgres, one admin panel,
one D1 content database). Only the website has develop/production splits:

| What | Where | Trigger |
| --- | --- | --- |
| Website (develop) | sleekdrops.pages.dev | push to `develop` touching `apps/web` |
| Website (production) | sleekdrops.com | push to `main` or `content-updated` dispatch |
| Admin panel | sleekdrops-admin.pages.dev (single env) | push to `develop` touching `apps/admin` |
| Agent platform | wherever you run it (laptop/server) | `./up.sh` |

The Pages-hosted admin panel is a static SPA: set its **API base** field
(header, stored in your browser) to the agent API you want it to talk to —
`http://localhost:8787` while the platform runs on your machine.

See [`apps/agent/README.md`](apps/agent/README.md) for the pipeline design and
[`apps/web/README.md`](apps/web/README.md) for the editorial rules.
