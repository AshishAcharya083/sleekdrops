# SleekDrops monorepo

Everything SleekDrops in one repo:

| App                        | What it is                                                                                                   | Stack                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| [`apps/web`](apps/web)     | The public website — sleekdrops.com                                                                          | Astro → Cloudflare Pages, content from Cloudflare D1                                                                   |
| [`apps/agent`](apps/agent) | The agent platform — a multi-agent pipeline that discovers trending topics and writes SEO-optimized articles | Node/TypeScript, PostgreSQL, Gemini via Google ADK + Claude subscription via the Claude Agent SDK, hosted on Cloud Run |
| [`apps/admin`](apps/admin) | Admin panel for the agent platform — pick topics, watch progress, approve publishes, track AI spend          | React + Vite → Cloudflare Pages                                                                                        |

The old `sleekdrops-agent` repo is superseded by `apps/agent` and can be archived.

## How the whole thing fits together

```
        ┌───────────────── apps/admin (Cloudflare Pages) ─────────────────┐
        │      Topics · Pipeline board · Sessions · Usage · Settings      │
        └───────────────────────────┬─────────────────────────────────────┘
                                    │ REST (/api/*, ADMIN_TOKEN bearer)
┌─ apps/agent (Cloud Run, min-instances 1) ─▼─────────────────────────────┐
│ topic scout → [you approve topics] → research → outline → write         │
│    → SEO review ⇄ edit (bounded loop) → assemble → image → publish      │
│                                                                          │
│ State:  Cloud SQL PostgreSQL (topics, articles, agent_sessions, settings)│
│ LLM:    two engines, routed by model id —                                │
│           gemini-*  → Google ADK → Vertex AI (service-account ADC)       │
│           claude-*  → Claude Agent SDK → your Claude subscription        │
│                        (CLAUDE_CODE_OAUTH_TOKEN, pasted in Settings)     │
│           verifying stages also get live web search + a page reader      │
└──────────────┬───────────────────────────────────────────┬──────────────┘
               │ posts + affiliate_links                    │ repository_dispatch
               ▼                                            ▼ (content-updated)
        Cloudflare D1  ◄──────────── build-time fetch ── GitHub Actions
        (sleekdrops-content)                                │
                                                            ▼
                                              apps/web → Cloudflare Pages
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
  dossiers, usage aggregation) — Cloud SQL in the cloud, Docker locally.
- **Cloudflare D1** stays the publish target — the website's build reads it,
  so the existing deploy flow is untouched (~90s from publish to live).
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
the engine toggle to Gemini in admin Settings.
All three can also be pasted straight into admin **Settings**, no restart.
Logs live in `.run/`.

Piecemeal alternatives: `pnpm db:up`, `pnpm dev:agent`, `pnpm dev:admin`,
`pnpm dev:web`, `pnpm build`.

## Cloud deployment (single environment)

The agent platform runs as **one Cloud Run service** in the `sleekdrops` GCP
project; there are no develop/production splits anywhere except the website.

| What                                              | Where                                            | Trigger                                      |
| ------------------------------------------------- | ------------------------------------------------ | -------------------------------------------- |
| Agent platform (API + worker + scheduler + admin) | Cloud Run `sleekdrops-agent`, us-central1        | push to `develop` touching `apps/agent`, `apps/admin` or the Dockerfile |
| Pipeline state                                    | Cloud SQL Postgres `sleekdrops-pg` (db-f1-micro) | —                                            |
| Secrets (Tavily, D1 token, admin token)           | GCP Secret Manager                               | —                                            |
| Admin panel                                       | sleekdrops-admin.pages.dev                       | push to `develop` touching `apps/admin`      |
| Website (develop)                                 | sleekdrops.pages.dev                             | push to `develop` touching `apps/web`        |
| Website (production)                              | sleekdrops.com                                   | push to `main` or `content-updated` dispatch |

Gemini calls on Cloud Run go through **Vertex AI with the service account's
ADC** — no API key anywhere. The Claude subscription token is pasted in admin
Settings (stored in Postgres) or set as the `CLAUDE_CODE_OAUTH_TOKEN` env var.

Redeploying is automatic: a push to `develop` that touches `apps/agent`,
`apps/admin`, the Dockerfile or the lockfile runs
[`deploy-agent.yml`](.github/workflows/deploy-agent.yml), which type-checks and
tests the platform, builds the admin panel into the image, pushes it to
Artifact Registry and rolls out a new Cloud Run revision — then health-checks
it. The container migrates the database on boot, so a green check also means
migrations applied.

GitHub authenticates to GCP with **Workload Identity Federation** — its OIDC
token is exchanged for short-lived credentials, so there is no service-account
key in the repo. The provider is pinned to this repository, and
`github-deployer@sleekdrops.iam.gserviceaccount.com` may only push to Artifact
Registry, deploy Cloud Run, and act as the agent's runtime service account.

Deploying by image alone leaves the rest of the service untouched — runtime
service account, min-instances, and the Secret Manager wiring for
`DATABASE_URL`, `ADMIN_TOKEN`, `TAVILY_API_KEY`, `CLOUDFLARE_D1_TOKEN` and
`GITHUB_TOKEN`. Change those with `gcloud run services update`, never with
`--set-env-vars` in the workflow (that flag replaces the whole set).

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

The token is never an env var this repo names. Store it as the Secret Manager
secret `facebook-page-token` and point the channel's `token_ref` at that name.
The adapter resolves the name at post time, from the `channel_credentials`
settings row first and then from the `FACEBOOK_PAGE_TOKEN` env var that name
maps to. The admin **Channels** tab connects the Page from either: paste the
token (it is checked with Meta, then stored by reference and never shown
again), or leave the token empty and name `facebook-page-token` to use the
mounted secret. Adding the secret to the service is a `gcloud run services update
--update-secrets` call, for the same reason as above: `--set-env-vars` in the
workflow would replace the whole set.

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

The hosted admin panel is pre-pointed at the Cloud Run URL (baked in at build
time via `VITE_API_BASE`); paste the admin token (Secret Manager `admin-token`)
into its header field once. The **API base** field still accepts
`http://localhost:8787` to steer a locally-running platform instead.

See [`apps/agent/README.md`](apps/agent/README.md) for the pipeline design and
[`apps/web/README.md`](apps/web/README.md) for the editorial rules.

### Manual deploy (fallback)

Two constraints shaped this, and they are why `gcloud run deploy --source`
isn't used: the default compute service account lacks
`roles/cloudbuild.builds.builder` on the run-sources bucket, and esbuild's Go
runtime crashes under the QEMU amd64 emulation a cross-build from Apple
Silicon needs — so the admin panel is built natively first and the image is
built with buildx.

```bash
# from the repo root, with N one past the highest existing tag
pnpm --filter @sleekdrops/admin build

docker buildx build --platform linux/amd64 \
  -t us-central1-docker.pkg.dev/sleekdrops/cloud-run-source-deploy/sleekdrops-agent:vN \
  --push .

gcloud run deploy sleekdrops-agent \
  --image us-central1-docker.pkg.dev/sleekdrops/cloud-run-source-deploy/sleekdrops-agent:vN \
  --region us-central1 --project sleekdrops
```

The admin token for the hosted panel:

```bash
gcloud secrets versions access latest --secret=admin-token --project sleekdrops | pbcopy
```
