# Deployment — GitHub Actions → Cloudflare Pages

Two environments, both static builds, both deployed to Cloudflare Pages.

| Branch    | Environment | URL                              | Workflow                                   |
| --------- | ----------- | -------------------------------- | ------------------------------------------ |
| `main`    | production  | https://sleekdrops.com           | `.github/workflows/deploy-production.yml`  |
| `develop` | develop     | https://develop.sleekdrops.com   | `.github/workflows/deploy-develop.yml`     |
| any PR    | (checks)    | —                                | `.github/workflows/pr-checks.yml`          |

A push to `main` triggers the production build, type-check, and deploy. A push to `develop` triggers the same against the develop URL. Every PR runs a type-check and a build (no deploy) to keep `main` and `develop` shippable.

The build runs `pnpm prebuild` (which generates `public/_redirects` from `src/data/affiliate-links.json`) → `astro check` → `astro build`. Output goes to `dist/`. `wrangler-action@v3` pushes `dist/` to the matching Cloudflare Pages project.

---

## Required GitHub repository secrets

Add these in **Settings → Secrets and variables → Actions → Repository secrets**. Production-only values can be scoped via GitHub Environments if you want stricter separation (see the `environment:` block in each workflow).

### Cloudflare Pages (required for any deploy)

| Secret                     | Where to get it                                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`     | Cloudflare → My Profile → API Tokens → Create Token → template **"Edit Cloudflare Workers"** *or* a custom token with **Account → Cloudflare Pages: Edit**. |
| `CLOUDFLARE_ACCOUNT_ID`    | Cloudflare dashboard right sidebar of any zone, or **Workers & Pages → Overview**.                               |
| `CLOUDFLARE_PROJECT_NAME`  | The name of the Pages project you created — e.g. `sleekdrops` (used in the wrangler command).                    |

### DevTeam Analytics (required for the analytics + logging sink)

Both deploy workflows pass these into the web build as `PUBLIC_Devteam__IngestKey` / `PUBLIC_Devteam__Host`; the admin panel reads the same two settings, so both apps report into one project.

| Setting                                    | Where to get it                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| `VITE_DEVTEAM_INGEST_KEY` (**secret**)     | DevTeam platform → the project's ingest key (`dtp_…`). Ingest-only, but rotate it per project. |
| `VITE_DEVTEAM_HOST` (**variable**)         | The platform's ingest host, e.g. `https://ingest.analytics.internal.getdevteam.ai`.     |

An empty key disables the DevTeam sink silently after one warning; GA4 is unaffected.

### DevTeam A/B Testing (required for experiments to run)

Both deploy workflows pass these into the web build as `PUBLIC_AbTesting__ClientKey` / `PUBLIC_AbTesting__Host`.
Nothing is inlined in the workflow files: the client key is minted per environment in the platform's **A/B Testing** tab, and a stale one serves an empty payload, so every experiment would read 0% while the site still looks healthy.

| Setting                               | Where to get it                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| `AB_TESTING_CLIENT_KEY` (**secret**)  | DevTeam platform → **A/B Testing** → mint a client key, one per environment. |
| `AB_TESTING_HOST` (**variable**)      | The platform's flag-delivery host — must be `https://`, e.g. `https://app.internal.getdevteam.ai`. |

`AB_TESTING_CLIENT_KEY` lives in Actions *secrets* only so it is easy to rotate per environment — it is **not** confidential.
It is a read-only GrowthBook client key, and being a `PUBLIC_`-prefixed Astro variable it is inlined verbatim into the JS bundle every visitor downloads.
Never put a privileged platform API key in that slot: it would be published on the next deploy.

`AB_TESTING_HOST` must be `https://`. The flag payload decides what the page renders and how visitors are bucketed, and it is neither signed nor encrypted, so a plaintext host would let any network intermediary rewrite it.
A `http://` host on the (https) deployed site is refused with a single console warning and every feature falls back to its code-side default — the browser would block it as mixed content anyway. Plain `http` still works for local development, where the page itself is `http`.

Leaving either unset is a supported state: the build ships with experiments disabled and every feature renders its code-side default.

### Cloudflare R2 (only if you've enabled R2 for images)

These are read by the publishing pipeline, **not** by the website build. Add them only when you wire R2 into the agent:

| Secret                  | Notes                                                              |
| ----------------------- | ------------------------------------------------------------------ |
| `R2_ACCOUNT_ID`         | Same as `CLOUDFLARE_ACCOUNT_ID`.                                   |
| `R2_ACCESS_KEY_ID`      | Cloudflare → R2 → Manage API Tokens → Create R2 Token.             |
| `R2_SECRET_ACCESS_KEY`  | Shown once at token creation; store immediately.                   |
| `R2_BUCKET`             | The bucket name, e.g. `sleekdrops-images`.                         |
| `R2_PUBLIC_URL`         | Custom domain bound to the bucket, e.g. `https://images.sleekdrops.com`. |

### Optional / future

| Secret                 | When                                                                  |
| ---------------------- | --------------------------------------------------------------------- |
| `PUBLISH_API_URL`      | Backend endpoint the publishing pipeline POSTs to.                    |
| `PUBLISH_API_TOKEN`    | Bearer token for the publish API.                                     |

---

## One-time Cloudflare Pages setup

You said the Cloudflare Pages project already exists. Confirm it's configured for **Direct Upload** (also called "wrangler" mode), not "Connect to Git" — these workflows push the built `dist/` directly. If the project is currently in Git-connected mode, disconnect it in the Pages dashboard so the wrangler deploys don't fight the auto-deploys.

For the develop environment, the simplest setup is to use the **same** Pages project with a different `--branch` flag (already configured in the workflow). Cloudflare Pages treats anything other than the production branch as a preview deploy; you then bind `develop.sleekdrops.com` to the `develop` preview branch in **Pages → Custom domains**.

---

## API token scopes (the minimum)

When creating `CLOUDFLARE_API_TOKEN`, scope it to:

- **Account: Cloudflare Pages → Edit**
- **Account: Account Settings → Read** (required by wrangler-action)
- Account resource scoped to *your* account only

Avoid the "Global API Key" — it has no scope limits.

---

## Branching workflow

```
feature/foo → PR → develop → (deploy to develop.sleekdrops.com, QA)
develop ──────── PR → main ─→ (deploy to sleekdrops.com, live)
```

Direct pushes to `main` are allowed by the workflow but discouraged. If you protect the branch in GitHub settings, use status checks `Build & type-check` (from `pr-checks.yml`) as the required gate.
