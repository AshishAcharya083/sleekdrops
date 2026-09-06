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
└──────────────┬───────────────────────────────────────────┬──────────────┘
               │ posts + affiliate_links                    │ repository_dispatch
               ▼                                            ▼ (content-updated)
        Cloudflare D1  ◄──────────── build-time fetch ── GitHub Actions
        (sleekdrops-content)                                │
                                                            ▼
                                              apps/web → Cloudflare Pages
```

- **Two LLM engines.** Gemini (through Google ADK) runs the high-volume
  structured stages; the writer and editor run on your Claude plan through the
  Claude Agent SDK — $0 marginal cost — with an admin toggle to put them on
  Gemini instead. See [`apps/agent/README.md`](apps/agent/README.md).
- **PostgreSQL** holds pipeline/operational state (atomic job claims, JSONB
  dossiers, usage aggregation) — Cloud SQL in the cloud, Docker locally.
- **Cloudflare D1** stays the publish target — the website's build reads it,
  so the existing deploy flow is untouched (~90s from publish to live).

## Quickstart (local)

```bash
./up.sh          # Postgres + agent platform (API + worker + admin panel on :8787)
./up.sh --web    # ... plus the website dev server on :4321
./down.sh        # stop everything (--wipe also deletes the database)
```

First run creates `apps/agent/.env` from the example — add `GEMINI_API_KEY`
(aistudio.google.com) and `TAVILY_API_KEY`, plus `CLAUDE_CODE_OAUTH_TOKEN`
(from `claude setup-token`) if the writer/editor should use your Claude plan.
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
