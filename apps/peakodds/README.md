# PeakOdds site

The public PeakOdds website: independent sports previews, guides and articles for adults 18+, in an Australian edition (`/au`) and a Global edition (`/global`).

It is a static Astro site built from PeakOdds' own Supabase database, which the agent publishes PeakOdds posts to.
It shares no code with the SleekDrops site in `apps/web`: no affiliate links, go-links, ads or sponsored links, and `src/lib/architecture.test.ts` fails on any import from another app.

## Build it locally

```sh
cp apps/peakodds/.env.example apps/peakodds/.env   # then fill in the Supabase values
pnpm install
pnpm --filter @sleekdrops/peakodds dev             # http://localhost:4321
```

The root `pnpm build` builds every app, PeakOdds included, so it needs these Supabase values too.
`docs/build-and-deploy.md` covers the environment, the build steps, the checks and the deploy.

## Where things go

- `src/pages/[edition]/` - the edition routes: `/au`, `/global` and `/<edition>/<slug>`.
- `src/layouts/` - `BaseLayout.astro`, the document shell with `head`, `header`, `footer` and `consent` slots.
- `src/lib/` - pure logic with a sibling `*.test.ts`. `posts.ts` is the only reader of posts.
- `src/data/` - static data. `editions.ts` mirrors the agent's PeakOdds editions.
- `scripts/` - build scripts, such as `fetch-content.mjs`.
