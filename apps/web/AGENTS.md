# SleekDrops — developer reference

The technical handbook for the **sleekdrops** Astro site. Read this before editing the codebase. For business context and editorial rules, see [README](./README.md). For content authoring (posts + affiliate links), the agent writes to the Cloudflare D1 database `sleekdrops-content` — this codebase has no editorial content committed to it.

---

## Architecture overview

```
┌──────────────────────────────────────────────┐
│  Cloudflare D1: sleekdrops-content           │
│  ├── posts            (status='published')   │
│  └── affiliate_links  (/go/<slug> map)       │
└──────────────────────┬───────────────────────┘
                       │ REST query (prebuild)
                       ▼
┌──────────────────────────────────────────────┐
│  sleekdrops (this repo) — Astro 4 site       │
│  ├── src/content/blog/   (gitignored,        │
│  │                        populated at build │
│  │                        by fetch-content)  │
│  ├── .d1-cache/          (gitignored)        │
│  ├── src/                (everything else)   │
│  └── scripts/                                │
│      ├── fetch-content.mjs                   │
│      ├── generate-redirects.mjs              │
│      └── check-anchors.mjs                   │
└──────────────────────────────────────────────┘
```

**Build flow:** `pnpm build` → `prebuild` runs `fetch-content.mjs` (queries D1 for published posts → `src/content/blog/`, affiliate links → `.d1-cache/affiliate-links.json`, and enforces body guardrails: no raw merchant URLs, every `/go/<slug>` must exist in `affiliate_links`) → `generate-redirects.mjs` (writes `public/_redirects`) → `generate-ads-txt.mjs` (writes `public/ads.txt` from `PUBLIC_ADSENSE_CLIENT`) → `generate-robots.mjs` (writes `public/robots.txt`; only a `PUBLIC_SITE_ENV=production` build gets the sitemap line, every other build noindexes itself) → `astro check && astro build` → `check-anchors.mjs` (fails the build on any in-page anchor in `dist/` with no matching element).

All three generated files live in `public/` and are gitignored — they are per-environment build output, not source.

**Trigger flow:** after writing to D1, fire `repository_dispatch` type `content-updated` at this repo (POST /repos/AshishAcharya083/sleekdrops/dispatches) → CI rebuilds → Cloudflare Pages deploys. Live in ~90s.

---

## Stack

- **Framework:** Astro 4 (static output, Cloudflare Pages adapter).
- **Styling:** Plain CSS with design tokens (no Tailwind). Tokens in [src/styles/tokens.css](src/styles/tokens.css); resets/utilities in [src/styles/global.css](src/styles/global.css). Components own their styles via `<style>` blocks.
- **Content:** Astro [content collections](https://docs.astro.build/en/guides/content-collections/). Markdown files are reconstructed from D1 rows at build time into `src/content/blog/` and validated against the Zod schema in [src/content/config.ts](src/content/config.ts).
- **Data:** Static TypeScript modules under [src/data/](src/data/) for authors, categories, deals, and promos. Posts, products, and affiliate destinations live in D1 (`sleekdrops-content`).
- **TypeScript:** Strict mode. Path aliases: `@components/*`, `@layouts/*`, `@data/*`, `@lib/*`, `@styles/*`.

---

## Folder structure

```
sleekdrops/
├── public/                         # Static assets served as-is
├── src/
│   ├── components/
│   │   ├── ui/                     # Atoms: Badge, Button, Eyebrow, BrandMark, IconButton
│   │   ├── layout/                 # Header, Footer, CategoryStrip, Newsletter
│   │   ├── blog/                   # PostCard, PostGrid, FeaturedPost, ListingHero, ...
│   │   ├── article/                # ArticleBody, Verdict, TableOfContents, LegalLayout
│   │   ├── affiliate/              # DealCard, PromoCard, ProductCallout, ProsConsList, ...
│   │   ├── ads/                    # AdUnit — the only component that emits ad markup
│   │   └── seo/                    # SEOHead, JsonLd, Breadcrumbs
│   ├── content/
│   │   ├── config.ts               # Blog + embedded product Zod schema
│   │   └── blog/                   # GITIGNORED — fetched from D1
│   ├── data/
│   │   ├── authors.ts              # Byline registry — posts reference by id
│   │   ├── categories.ts           # Six categories with blurbs + intros
│   │   ├── categories-types.ts     # Shared CategorySlug / CategoryName unions
│   │   ├── deals.ts                # Daily affiliate deals (the "drops")
│   │   └── promos.ts               # Promo codes
│   ├── layouts/
│   ├── lib/
│   │   ├── posts.ts                # Content-collection helpers
│   │   ├── format.ts
│   │   └── seo.ts                  # Meta payload + JSON-LD builders
│   ├── pages/                      # Astro page routes
│   ├── scripts/                    # Client-side bootstrap (theme, TOC, progress)
│   └── styles/
├── scripts/
│   ├── fetch-content.mjs           # Queries D1 at build time
│   ├── generate-redirects.mjs      # Writes public/_redirects from .d1-cache
│   └── check-anchors.mjs           # Fails the build on dead in-page anchors
├── .d1-cache/                      # GITIGNORED — D1 fetch target
├── docs/                           # Engineering notes
├── .github/workflows/              # CI/CD: main → production, develop → staging
└── ...
```

### What goes where

| If you're… | Edit… |
|---|---|
| Adding/editing a blog post | D1 `posts` table — INSERT/UPDATE row, then dispatch `content-updated` |
| Adding an affiliate redirect | D1 `affiliate_links` table |
| Adding an author | `src/data/authors.ts` (here) |
| Adding a deal or promo | `src/data/deals.ts` or `src/data/promos.ts` (here) |
| Adjusting brand colour, font, spacing | `src/styles/tokens.css` |
| Adding a new page | `src/pages/<route>.astro` |
| Adding a new component | `src/components/<namespace>/<Name>.astro` |
| Adding a new SEO schema | `src/lib/seo.ts` |

---

## Conventions

**No UI element may report success for an operation that did not happen.**
A control that accepts input and answers "✓ Subscribed" / "✓ Message sent" while nothing is stored or sent is a false claim to the visitor, not an unfinished feature.
Ship the honest placeholder (no input, no submit, copy that says what is and isn't there) until the real path exists.

**A control that cannot act must not look like it can.**
The homepage hero used to render `href="#today"` whether or not `DropPanel` emitted that id, so with no live drop the button did nothing at all.
In-page anchor CTAs are therefore derived from the state that renders their target - see [`src/lib/hero-cta.ts`](src/lib/hero-cta.ts) - and `scripts/check-anchors.mjs` fails the build on any `href="#..."` in `dist/` with no matching element.
The rule that script enforces lives in [`src/lib/anchor-integrity.ts`](src/lib/anchor-integrity.ts), unit-tested by its sibling `.test.ts`.

**Every surface degrades to a designed empty state.**
A heading over an empty row, or a blank hero column, is a broken page rather than a neutral one.
Sections whose only content is data either render an empty state or are omitted entirely.

---

## Common commands

```bash
pnpm install            # install deps
pnpm fetch-content      # query D1 → src/content/blog + .d1-cache
pnpm dev                # fetch-content + http://localhost:4321
pnpm build              # fetch-content + redirects + astro check + production build + anchor check
pnpm preview            # serve the production build
pnpm check              # type-check only
pnpm test               # node --test over src/**/*.test.ts
pnpm check:anchors      # in-page anchors resolve in dist/ (also runs as part of build)
```

For local dev, copy `.env.example` to `.env` and fill in `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, `CLOUDFLARE_D1_TOKEN`.

---

## Environment variables

| Variable        | Where    | Purpose |
|-----------------|----------|---------|
| `SITE_URL`      | build    | Canonical site URL (defaults to `https://sleekdrops.com`). |
| `CLOUDFLARE_ACCOUNT_ID` | build | Cloudflare account id. |
| `D1_DATABASE_ID` | build | `sleekdrops-content` database id (not secret). |
| `CLOUDFLARE_D1_TOKEN` | build | API token with "Account → D1 → Read". Falls back to `CLOUDFLARE_API_TOKEN`. |

---

## Embedded product data (review posts)

Review posts (`postType: review`) embed structured product data directly in their frontmatter — the old `src/data/products.ts` module was removed.

The post's filename slug doubles as the affiliate slug: a review at `posts/sony-wh-1000xm6.md` builds CTAs that link to `/go/sony-wh-1000xm6`, which must have a matching row in the D1 `affiliate_links` table.

The `ProductData` type is derived from the Zod schema in `src/content/config.ts` and consumed by `Verdict.astro`, `ProductCallout.astro`, and `buildReviewSchema()` in `src/lib/seo.ts`.

---

## Deployment

Cloudflare Pages, plain static output. Build command: `pnpm build`. Output: `dist/`.

Two environments via GitHub Actions in `.github/workflows/`:
- **Production:** push to `main` → `sleekdrops.com`.
- **Develop:** push to `develop` → `develop.sleekdrops.com`.

Secrets in GitHub: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_PROJECT_NAME`, `CLOUDFLARE_D1_TOKEN` (D1 read access for the build).

A `repository_dispatch: content-updated` event (fired by whatever wrote to D1) triggers a production rebuild.

### Affiliate redirects

`/go/[slug]` URLs are resolved at the Cloudflare edge via `public/_redirects`, regenerated from the D1 `affiliate_links` table on every build. Local `astro dev` does not honor `_redirects` — test in production preview if you need to confirm an outbound URL.
