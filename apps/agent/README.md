# SleekDrops agent platform

A multi-agent content pipeline that finds trending topics and writes very SEO,
genuinely helpful articles/guides/roundups for sleekdrops.com — a light version
of the devteam-platform orchestration pattern (DB-claimed work units, one
agent session per stage, verdict-driven routing, token/cost ledger).

## The agents

| # | Agent | Stage | What it does |
| - | ----- | ----- | ------------ |
| 1 | `topic_scout` | (out of band) | Sweeps the live web (Tavily) for trending products/topics **not covered before** (checks D1 posts + every prior suggestion), writes suggestions for the admin |
| 2 | `researcher` | research | Plans targeted searches, builds an evidence dossier: facts + source URLs, real Amazon links, keywords, competitor gap |
| 3 | `outliner` | outline | SEO content brief: ≤60-char title, dek, slug, keyword plan, H2/H3 outline, FAQ |
| 4 | `writer` | write | Full markdown draft in the site voice; products linked only as `/go/<slug>` |
| 5 | `seo_reviewer` | seo_review | Strict scored review (0–100) against the brief + SEO checklist → pass/fail verdict |
| 6 | `editor` | edit | Surgical revision resolving the reviewer's issues (loops with #5, bounded by `max_revision_rounds`) |
| 7 | `assembler` | assemble | Exact D1 payload: frontmatter (validated against the site's Zod schema) + affiliate link rows; deterministic guardrail checks |
| 8 | `publisher` | publish | Upserts D1 `posts` + `affiliate_links`, fires the `content-updated` dispatch → site rebuilds |

Flow: `research → outline → write → seo_review ⇄ edit → assemble → publish`.
With `publish_mode = approval` (default) the article parks at
`waiting_approval` until you hit **Approve & publish** in the admin panel.

## Any AI provider via OpenRouter

Every LLM call goes through OpenRouter's OpenAI-compatible API:

- `MODEL_DEFAULT` in `.env` sets the default (e.g. `google/gemini-2.5-flash`).
- Per-agent overrides in the admin **Settings** tab — e.g. run the writer on
  `anthropic/claude-sonnet-4.5` and the reviewer on `openai/gpt-4o`.
- `OPENROUTER_BASE_URL` can point at any OpenAI-compatible endpoint, so you're
  not locked to OpenRouter either.

Usage (tokens + billed USD) is recorded per agent session and aggregated in
the admin panel.

## State model (PostgreSQL)

- `topics` — scout suggestions; `suggested → approved/rejected` (unique on
  normalized title = the "never repeat a topic" guard, alongside the D1 check)
- `articles` — the work unit ("card"): stage, status, dossier/brief/draft/
  review/frontmatter JSONB, revision round, error
- `agent_sessions` — one row per agent run: model, tokens in/out, cost USD,
  duration, summary/error
- `settings` — publish_mode, per-agent models, revision cap, worker toggle
- `scout_runs` — one row per topic sweep

The worker claims queued articles with `FOR UPDATE SKIP LOCKED` (atomic,
multi-process safe), runs the stage's agent, records the session, and routes
the article onward. Stranded `running` rows are re-queued on startup.

## Run it

```bash
pnpm db:up                                  # repo root — Postgres on :5544
cp apps/agent/.env.example apps/agent/.env  # fill in keys
pnpm dev:agent                              # migrate + API + worker + admin UI on :8787
```

Required env: `OPENROUTER_API_KEY`, `TAVILY_API_KEY`. For publishing:
`CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, `CLOUDFLARE_D1_TOKEN` (D1 Edit),
`GITHUB_TOKEN` (repo dispatch). Optional: `ADMIN_TOKEN` to protect the API.

## Typical day

1. Topics tab → **Find new trending topics** (or curl `POST /api/scout` from cron).
2. Tick the topics worth writing → **Approve → write articles**.
3. Watch the Pipeline board; drafts + SEO scores are inspectable per article.
4. When an article reaches *waiting approval*, review the draft → **Approve & publish**.
5. ~90 seconds later it's live on sleekdrops.com.
