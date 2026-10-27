# SleekDrops monorepo

Everything SleekDrops in one repo:

| App                        | What it is                                                                                                   | Stack                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| [`apps/web`](apps/web)     | The public website — sleekdrops.com                                                                          | Astro → Cloudflare Pages, content and images from Supabase                                                             |
| [`apps/agent`](apps/agent) | The agent platform — a multi-agent pipeline that discovers trending topics and writes SEO-optimized articles | Node/TypeScript, PostgreSQL (Supabase), Gemini via Google ADK + Claude subscription via the Claude Agent SDK           |
| [`apps/admin`](apps/admin) | Admin panel for the agent platform — pick topics, watch progress, approve publishes, track AI spend          | React + Vite → Cloudflare Pages                                                                                        |

The old `sleekdrops-agent` repo is superseded by `apps/agent` and can be archived.

## How the whole thing fits together

```
        ┌───────────────── apps/admin (Cloudflare Pages) ─────────────────┐
        │      Topics · Pipeline board · Sessions · Usage · Settings      │
        └───────────────────────────┬─────────────────────────────────────┘
                                    │ REST (/api/*, ADMIN_TOKEN bearer)
┌─ apps/agent (./up.sh on the operator's machine) ▼───────────────────────┐
│ topic scout → [you approve topics] → research → outline → write         │
│    → SEO review ⇄ edit (bounded loop) → assemble → image → publish      │
│                                                                          │
│ LLM:    two engines, routed by model id —                                │
│           gemini-*  → Google ADK → AI Studio key (or Vertex ADC)         │
│           claude-*  → Claude Agent SDK → your Claude subscription        │
│                        (CLAUDE_CODE_OAUTH_TOKEN, pasted in Settings)     │
│           verifying stages also get live web search + a page reader      │
└──────┬──────────────────────────────┬────────────────────┬──────────────┘
       │ pipeline state,              │ hero images        │ repository_dispatch
       │ posts + affiliate_links      │ (service role)     ▼ (content-updated)
       ▼                              ▼              GitHub Actions
┌─ Supabase: SleekDrops ──────────────────────────┐        │ build-time fetch
│ Postgres  topics · articles · sessions · ...    │◄───────┤ (Data API,
│           posts · affiliate_links (RLS: public  │        │  publishable key)
│           read of published content only)       │        ▼
│ Storage   images (public bucket)  ◄─────────────┼── <img> apps/web → Cloudflare Pages
└─────────────────────────────────────────────────┘
```

- **Two LLM engines.** Every stage that runs a prompt — scout, researcher,
  keyword strategist, angle editor, outliner, writer, SEO reviewer, editor — runs on your
  Claude plan through the Claude Agent SDK at $0 marginal cost, Opus 5 by
  default, with an admin toggle to put them on Gemini instead. Only the image
  agent is pinned to Gemini, for its vision and image generation. Without a
  Claude credential those stages fail with that message rather than silently
  downgrading. See [`apps/agent/README.md`](apps/agent/README.md).
- **The fact-checking stages can search.** The scout, the researcher and the
  SEO reviewer get live web search and a page reader so specifics get verified
  against primary sources. The writer and editor deliberately do not: they work
  from what those stages confirmed, and no competing article is ever cited,
  quoted or mirrored.
- **PostgreSQL** holds pipeline/operational state (atomic job claims, JSONB
  dossiers, usage aggregation) — the Supabase project in production, Docker
  for a throwaway local copy.
- **The same database is the publish target.** The posts and affiliate links
  the website builds from are two tables beside the pipeline's, and a publish
  is an upsert into them plus a rebuild dispatch (~90s from publish to live).
  They were in Cloudflare D1 until October 2026; the columns are unchanged.
- **Images are in Supabase Storage** (public bucket `images`), served straight
  from their public URLs.
- **Launch-window offers are attached by hand.** A SKU announced today is in no
  affiliate feed and cannot be read through Amazon's Product Advertising API, so
  the admin panel's offer screens let an editor attach the commissionable link
  and the price they can see, with the day they saw it. The assembler resolves
  that record ahead of a verified ASIN and ahead of the healed search link, the
  page quotes the figure as a dated RRP with a "check current price" link rather
  than as a live price, and a pre-order says when it ships and that the reader is
  charged on dispatch. A feed overwrites the record once the SKU appears; every
  version is kept.

## Quickstart (local)

```bash
./up.sh          # Postgres + agent platform (API + worker + admin panel on :8787)
./up.sh --web    # ... plus the website dev server on :4321
./down.sh        # stop everything (--wipe also deletes the database)
```

First run creates `apps/agent/.env` from the example — add `GEMINI_API_KEY`
(aistudio.google.com) and `TAVILY_API_KEY`, plus `CLAUDE_CODE_OAUTH_TOKEN`
(from `claude setup-token`), which every article stage needs unless you switch
the engine toggle to Gemini in admin Settings. With the example's
`DATABASE_URL` everything runs against a local Docker Postgres; set it to the
Supabase Session pooler URI (and `SUPABASE_SERVICE_ROLE_KEY` for images) to run
against production - `./up.sh` then skips the container.
All three can also be pasted straight into admin **Settings**, no restart.
Logs live in `.run/`.

Piecemeal alternatives: `pnpm db:up`, `pnpm dev:agent`, `pnpm dev:admin`,
`pnpm dev:web`, `pnpm build`.

## Where everything runs

Everything SleekDrops stores lives in one **Supabase** project, `SleekDrops`
(ref `ofcujovpxfoxvpfkszmf`, Sydney, in the Vitalize organisation). The GCP
project is gone, and with it Cloud Run, Cloud SQL, Secret Manager and the
image bucket.

| What                                              | Where                                                         | Trigger / how it changes                         |
| ------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| Published posts + affiliate links                 | Supabase `posts`, `affiliate_links` (public schema)           | the agent's publisher, or the Supabase table editor |
| Hero images                                       | Supabase Storage, public bucket `images`                      | the image stage and the admin hero-image drops   |
| Pipeline state                                    | the same Supabase database (topics, articles, sessions, ...)  | the agent's migrations, applied on boot          |
| Agent platform (API + worker + scheduler + admin) | the operator's machine (`./up.sh`), against Supabase          | —                                                |
| Admin panel (hosted copy)                         | sleekdrops-admin.pages.dev                                    | push to `develop` touching `apps/admin`          |
| Website (develop)                                 | sleekdrops.pages.dev                                          | push to `develop` touching `apps/web`            |
| Website (production)                              | sleekdrops.com                                                | push to `main` or `content-updated` dispatch     |

The website build reads the posts and affiliate links through Supabase's Data
API with the project's **publishable key** (`SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY` repository variables). Row-level security lets that
key read published posts and the affiliate links and nothing else; every other
table - settings with a pasted Claude token, drafts, channel credentials - has
RLS on and no grant to the Data API roles at all (migration 019 sets this up,
including for tables later migrations create). Hero images are plain public
object URLs, `https://ofcujovpxfoxvpfkszmf.supabase.co/storage/v1/object/public/images/<path>`.

The agent needs two Supabase credentials, both kept in `apps/agent/.env` and
nowhere else: `DATABASE_URL` (the **Session pooler** URI with the database
password, plus `?sslmode=no-verify` - see `apps/agent/.env.example`) and
`SUPABASE_SERVICE_ROLE_KEY` for uploading images. Supabase cannot host the
worker itself - it is a long-running Node process that drives the Claude Agent
SDK - so until it gets a host it runs where `./up.sh` runs it; the
[`Dockerfile`](Dockerfile) still builds it for any container host, and the
hosted admin panel takes that host's URL from the `AGENT_API_BASE` repository
variable (or the **API base** field in its header).

Gemini calls go to the AI Studio key (`GEMINI_API_KEY`, or pasted in admin
Settings); Vertex AI is still supported where a GCP service account exists.

When an instance stops mid-stage (a restart, a memory kill, Ctrl-C), nothing is
lost: on SIGTERM the agent hands the articles it holds back to the queue before
its 10-second grace period ends (the image runs `node` as PID 1 rather than
`pnpm start`, because pnpm does not pass the signal on), and a claim whose
worker died without that is re-queued once its lease lapses. The same article
is re-queued at most twice per attempt; the third lapse fails the card with a
plain message, draft kept, and **Retry from this stage** starts the count
again. Stages stopped by their own time budget still end as timed out.

### Connecting the Facebook Page

The Page adapter runs on **Standard Access**: a token for a Page the operator
already administers, so no App Review and no Business Verification. Mint it in
Graph API Explorer (or, better, for a Business Manager System User, whose Page
token does not expire) with all three of:

| Permission                 | What it is for                                   |
| -------------------------- | ------------------------------------------------ |
| `pages_manage_posts`       | creating the photo post and the link post         |
| `pages_read_engagement`    | reading the Page and its post insights            |
| `pages_manage_engagement`  | writing the first comment that carries the link   |

The token is never an env var this repo names. Keep it as the secret
`facebook-page-token` and point the channel's `token_ref` at that name. The
adapter resolves the name at post time, from the `channel_credentials` settings
row first and then from the `FACEBOOK_PAGE_TOKEN` env var that name maps to.
The admin **Channels** tab connects the Page from either: paste the token (it
is checked with Meta, then stored by reference and never shown again), or leave
the token empty and name `facebook-page-token` to read `FACEBOOK_PAGE_TOKEN`
from the agent's environment (`apps/agent/.env`).

Two optional deployment knobs, both with working defaults:
`FACEBOOK_BODY_LINK_CAP` (organic link posts Meta allows the Page per calendar
month, default 2) and `FACEBOOK_APP_ID`/`FACEBOOK_APP_SECRET`, which only let
the adapter read a token's real expiry and exchange a short-lived token for a
long-lived one. Posting is identical without them.

**Two things to check with the first real posts**, neither of which changes the
design and both of which only move the default: whether the monthly link cap is
live for Australian Pages at all, and whether a deals/reviews Page counts as an
exempt publisher Page. Until they are answered the default placement is
`first_comment` (admin Channels tab or Settings → `facebook_link_placement`), which never
depends on the cap.

The agent serves the admin panel itself on http://localhost:8787. The hosted
copy (sleekdrops-admin.pages.dev) defaults to that same local platform, baked in
at build time via `VITE_API_BASE` from the `AGENT_API_BASE` repository
variable; paste the platform's `ADMIN_TOKEN` into its header field once, and
point the **API base** field elsewhere when the agent has a host.

See [`apps/agent/README.md`](apps/agent/README.md) for the pipeline design and
[`apps/web/README.md`](apps/web/README.md) for the editorial rules.
