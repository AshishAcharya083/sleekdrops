# SleekDrops agent platform

A multi-agent content pipeline that finds trending topics and writes very SEO,
genuinely helpful articles/guides/roundups for sleekdrops.com — a light version
of the devteam-platform orchestration pattern (DB-claimed work units, one
agent session per stage, verdict-driven routing, token/cost ledger).

## The agents

| # | Agent | Stage | What it does |
| - | ----- | ----- | ------------ |
| 1 | `topic_scout` | (out of band) | Sweeps the live web (Tavily) for trending products/topics **not covered before** (checks D1 posts + every prior suggestion), writes suggestions for the admin |
| 2 | `researcher` | research | Plans targeted searches, builds an evidence dossier: facts + source URLs, real Amazon links (non-Amazon "amazonUrl"s are dropped deterministically), keywords, competitor gap |
| 3 | `outliner` | outline | SEO content brief: ≤60-char title, dek, slug, keyword plan, H2/H3 outline, FAQ |
| 4 | `writer` | write | Full markdown draft in the site voice; products linked only as `/go/<slug>`, with mandated placements (tables, per-product CTAs, conclusion) |
| 5 | `seo_reviewer` | seo_review | Strict scored review (0–100) against the brief + SEO checklist → pass/fail verdict |
| 6 | `editor` | edit | Surgical revision resolving the reviewer's issues and any admin feedback (loops with #5, bounded by `max_revision_rounds`) |
| 7 | `assembler` | assemble | Exact D1 payload: frontmatter (validated against the site's Zod schema) + affiliate link rows built deterministically — liveness-verified per-marketplace ASINs with an Amazon-search fallback that can't 404; Amazon is the only approved merchant |
| 8 | `image_agent` | image | Hero image: Tavily image search → Gemini vision check (related, watermark-free) → else generate with the Gemini image model; uploads to the public GCS bucket and stores the URL in frontmatter. Stands down entirely when the operator attached their own image, and skips itself when `GCS_IMAGES_BUCKET` is unset |
| 9 | `publisher` | publish | Upserts D1 `posts` + `affiliate_links`, fires the `content-updated` dispatch → site rebuilds |

Flow: `research → outline → write → seo_review ⇄ edit → assemble → image → publish`.
With `publish_mode = approval` (default) the article parks at
`waiting_approval` until you hit **Approve & publish** in the admin panel.
Every agent prompt is grounded with today's date (Australia/Sydney) so years
in titles/copy come from the calendar, not stale training data.

Admin extras: the **Published** tab lists everything in D1 and can delete a
post (plus its orphaned pipeline-authored affiliate links) with an automatic
site rebuild; the article panel has a **feedback box** that requeues the piece
through `edit → seo_review → assemble → image → publish` with your notes
applied (original pubDate is kept, `updatedDate` is stamped).

**Hero images by hand.** The image agent's automatic pick is often not good
enough, so both the manual-topic drawer and the article panel take a dropped
image file (JPEG/PNG/WebP, ≤ 10 MB). It is vetted by magic bytes — not by the
content type the browser claims — uploaded to the same public bucket, and
stored in `articles.hero_image_url` / `hero_alt` as well as in frontmatter.
The dedicated column is what makes it stick: the assembler stamps it in on
every pass, so an image attached while briefing a topic survives assembly and
the feedback loop, and the image stage skips its search. Removing it hands the
piece back to the agent (or to the generated cover fill). For an article that
is already live, **Publish again** re-runs the deterministic publish stage —
no LLM cost — and the new hero reaches the site with the next build.

## Two engines, routed by model id

Every LLM call goes through `src/llm/`, which routes on the model id:

| Engine | Models | Runs | Auth |
| --- | --- | --- | --- |
| **Gemini** (Google ADK) | everything not `claude-*` (default `gemini-2.5-flash`) | topic scout, researcher, outliner, SEO reviewer | admin-set AI Studio key → Vertex ADC (`GOOGLE_GENAI_USE_VERTEXAI=true`, keyless on Cloud Run) → `GEMINI_API_KEY` |
| **Claude subscription** (Claude Agent SDK) | `claude-*` (default `claude-sonnet-4-5`) | writer + editor, switchable in Settings | `claude setup-token` → paste in admin Settings, or `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` in `.env` |

The subscription token only works through the Agent SDK/CLI — it is not an API
key, which is why the Claude engine is a separate execution path. Writer and
editor follow the admin **Settings → Writer & editor use** toggle (Claude by
default, graceful fallback to Gemini when no token is configured). Per-agent
model overrides sit on top and can put any agent on either engine. Usage
(tokens; USD only where a provider bills per call) is recorded per agent
session and aggregated in the admin panel.

## Autonomy: what runs by itself

- **Topic scout**: runs on a schedule (Settings → *Autonomous topic scout*,
  default daily; in-process scheduler, no external cron needed). It skips a
  sweep while 30+ suggestions sit untriaged.
- **Article pipeline**: fully autonomous once you approve topics — the worker
  polls Postgres (the light pub/sub) and drives every stage to completion.
- **Publishing**: gated on your approval by default (`publish_mode=approval`);
  flip to `auto` for hands-off publishing or `draft` to stage in D1 only.

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

Required env: `GEMINI_API_KEY` (or Vertex on GCP) and `TAVILY_API_KEY`; add
`CLAUDE_CODE_OAUTH_TOKEN` to write prose on your Claude plan. For publishing:
`CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, `CLOUDFLARE_D1_TOKEN` (D1 Edit),
`GITHUB_TOKEN` (repo dispatch). Optional: `ADMIN_TOKEN` to protect the API —
required in practice when the API is deployed on Cloud Run.

## Typical day

1. Topics tab → **Find new trending topics** (or curl `POST /api/scout` from cron).
2. Tick the topics worth writing → **Approve → write articles**.
3. Watch the Pipeline board; drafts + SEO scores are inspectable per article.
4. When an article reaches *waiting approval*, review the draft → **Approve & publish**.
5. ~90 seconds later it's live on sleekdrops.com.
