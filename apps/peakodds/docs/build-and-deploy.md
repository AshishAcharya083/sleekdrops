# Building and deploying PeakOdds

## Environment

`apps/peakodds/.env` (copied from `.env.example`) holds three values.
Real environment variables win over the file.

| Variable | What it is |
| --- | --- |
| `PEAKODDS_SUPABASE_URL` | PeakOdds' Supabase project URL, `https://<project-ref>.supabase.co`. |
| `PEAKODDS_SUPABASE_PUBLISHABLE_KEY` | That project's publishable key. It can read published posts and nothing else, so it is not a secret. |
| `PEAKODDS_SITE_URL` | The origin canonical URLs are built from. `http://localhost:4321` locally. |

Both Supabase values are in the Supabase dashboard under Project Settings, API.

## Build

```sh
pnpm --filter @sleekdrops/peakodds build
```

The build runs in three steps:

1. `prebuild` runs `scripts/fetch-content.mjs`.
   It reads every published row of the `posts` table, 1,000 at a time, and writes them to `.content-cache/posts.json`, which git ignores.
   Each request gives up after `FETCH_TIMEOUT_MS` (30 seconds).
2. `astro check` type-checks the site.
3. `astro build` writes the static site to `dist/`.
   Every page reads posts through `src/lib/posts.ts`.

The build stops with a message naming the problem when:

- either Supabase variable is missing or empty;
- a post has no `edition_id`, or one that is not `au` or `global` (the message names the post's slug);
- `PEAKODDS_SITE_URL` is not set.

`pnpm --filter @sleekdrops/peakodds dev` fetches the content the same way, then starts the dev server.
Run `pnpm --filter @sleekdrops/peakodds fetch-content` to refresh the content without restarting.

## Checks

```sh
pnpm --filter @sleekdrops/peakodds check   # astro check
pnpm --filter @sleekdrops/peakodds test    # node:test, src/**/*.test.ts
```

Pull requests that touch the app run both in `.github/workflows/pr-checks-peakodds.yml`.

## Deploy

`.github/workflows/deploy-peakodds.yml` builds the site and uploads `dist/` to Cloudflare Pages by direct upload.
It runs:

- on a push to `main` that changes `apps/peakodds` or the files it is built with;
- on a `peakodds-content-updated` repository dispatch, which the agent sends after a PeakOdds publish;
- by hand, from the Actions tab.

Until every value below is set, the workflow ends with a warning naming what is missing and deploys nothing.

## One-time hosting setup

A person with access to Cloudflare and the GitHub repository does this once.

1. In Cloudflare, create a Pages project for direct upload with `main` as its production branch.
2. In the repository's Actions settings, add these variables:
   - `PEAKODDS_CLOUDFLARE_PROJECT_NAME`: the Pages project's name.
   - `PEAKODDS_SUPABASE_URL` and `PEAKODDS_SUPABASE_PUBLISHABLE_KEY`: as above.
   - `PEAKODDS_SITE_URL`: the site's public origin, such as `https://peakodds.com`.
3. Check the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, which the SleekDrops deploys already use.
   The token needs Cloudflare Pages edit access to the account the new project is in.
4. Add the domain to the Pages project under Custom domains.
