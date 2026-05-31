# SleekDrops — developer reference

The technical handbook for the **sleekdrops** Astro site. Read this before editing the codebase. For business context and editorial rules, see [README](./README.md). For content authoring (posts + affiliate links), the agent operates on the separate [sleekdrops-cms](https://github.com/DevMahisaur/sleekdrops-cms) repo — this codebase has no editorial content committed to it.

---

## Architecture overview

```
┌──────────────────────────────────────────────┐
│  sleekdrops-cms (separate GitHub repo)       │
│  ├── posts/*.md                              │
│  ├── data/affiliate-links.json               │
│  └── schema/  (rules the agent must follow)  │
└──────────────────────┬───────────────────────┘
                       │ git clone (prebuild)
                       ▼
┌──────────────────────────────────────────────┐
│  sleekdrops (this repo) — Astro 4 site       │
│  ├── src/content/blog/   (gitignored,        │
│  │                        populated at build │
│  │                        by fetch-content)  │
│  ├── .cms-cache/         (gitignored)        │
│  ├── src/                (everything else)   │
│  └── scripts/                                │
│      ├── fetch-content.mjs                   │
│      └── generate-redirects.mjs              │
└──────────────────────────────────────────────┘
```

**Build flow:** `pnpm build` → `prebuild` runs `fetch-content.mjs` (clones sleekdrops-cms into `.cms-cache/`, copies `posts/` to `src/content/blog/`) → `generate-redirects.mjs` (reads `.cms-cache/data/affiliate-links.json`, writes `public/_redirects`) → `astro check && astro build`.

**Trigger flow:** push to `sleekdrops-cms/main` → `.github/workflows/notify-main.yml` dispatches a `content-updated` event → main repo's CI rebuilds → Cloudflare Pages deploys. Live in ~90s.

---

## Stack

- **Framework:** Astro 4 (static output, Cloudflare Pages adapter).
- **Styling:** Plain CSS with design tokens (no Tailwind). Tokens in [src/styles/tokens.css](src/styles/tokens.css); resets/utilities in [src/styles/global.css](src/styles/global.css). Components own their styles via `<style>` blocks.
- **Content:** Astro [content collections](https://docs.astro.build/en/guides/content-collections/). Markdown files are fetched from sleekdrops-cms at build time into `src/content/blog/` and validated against the Zod schema in [src/content/config.ts](src/content/config.ts).
- **Data:** Static TypeScript modules under [src/data/](src/data/) for authors, categories, deals, and promos. Posts, products, and affiliate destinations live in sleekdrops-cms.
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
│   │   └── seo/                    # SEOHead, JsonLd, Breadcrumbs
│   ├── content/
│   │   ├── config.ts               # Blog + embedded product Zod schema
│   │   └── blog/                   # GITIGNORED — fetched from sleekdrops-cms
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
│   ├── fetch-content.mjs           # Clones sleekdrops-cms at build time
│   └── generate-redirects.mjs      # Writes public/_redirects from cms cache
├── .cms-cache/                     # GITIGNORED — clone target
├── docs/                           # Engineering notes
├── .github/workflows/              # CI/CD: main → production, develop → staging
└── ...
```

### What goes where

| If you're… | Edit… |
|---|---|
| Adding/editing a blog post | sleekdrops-cms repo — `posts/<slug>.md` |
| Adding an affiliate redirect | sleekdrops-cms repo — `data/affiliate-links.json` |
| Adding an author | `src/data/authors.ts` (here) |
| Adding a deal or promo | `src/data/deals.ts` or `src/data/promos.ts` (here) |
| Adjusting brand colour, font, spacing | `src/styles/tokens.css` |
| Adding a new page | `src/pages/<route>.astro` |
| Adding a new component | `src/components/<namespace>/<Name>.astro` |
| Adding a new SEO schema | `src/lib/seo.ts` |

---

## Common commands

```bash
pnpm install            # install deps
pnpm fetch-content      # clone sleekdrops-cms into .cms-cache + src/content/blog
pnpm dev                # fetch-content + http://localhost:4321
pnpm build              # fetch-content + redirects + astro check + production build
pnpm preview            # serve the production build
pnpm check              # type-check only
```

For local dev against a private sleekdrops-cms, set `CMS_REPO_URL` in `.env` with a PAT, or rely on your existing `git` credentials.

---

## Environment variables

| Variable        | Where    | Purpose |
|-----------------|----------|---------|
| `SITE_URL`      | build    | Canonical site URL (defaults to `https://sleekdrops.com`). |
| `CMS_REPO_URL`  | build    | sleekdrops-cms clone URL. Defaults to `https://github.com/DevMahisaur/sleekdrops-cms.git` (public clone) — for a private repo, pass `https://x-access-token:${PAT}@github.com/...`. |
| `CMS_REPO_REF`  | build    | Branch/tag to clone (default `main`). |

---

## Embedded product data (review posts)

Review posts (`postType: review`) embed structured product data directly in their frontmatter — the old `src/data/products.ts` module was removed.

The post's filename slug doubles as the affiliate slug: a review at `posts/sony-wh-1000xm6.md` builds CTAs that link to `/go/sony-wh-1000xm6`, which must have a matching entry in sleekdrops-cms's `data/affiliate-links.json`.

The `ProductData` type is derived from the Zod schema in `src/content/config.ts` and consumed by `Verdict.astro`, `ProductCallout.astro`, and `buildReviewSchema()` in `src/lib/seo.ts`.

---

## Deployment

Cloudflare Pages, plain static output. Build command: `pnpm build`. Output: `dist/`.

Two environments via GitHub Actions in `.github/workflows/`:
- **Production:** push to `main` → `sleekdrops.com`.
- **Develop:** push to `develop` → `develop.sleekdrops.com`.

Secrets in GitHub: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_PROJECT_NAME`. For private sleekdrops-cms access, also `CMS_REPO_URL` containing a PAT.

A `repository_dispatch: content-updated` event from sleekdrops-cms triggers a production rebuild — wire this into a workflow that runs `pnpm build` and deploys.

### Affiliate redirects

`/go/[slug]` URLs are resolved at the Cloudflare edge via `public/_redirects`, regenerated from sleekdrops-cms's `data/affiliate-links.json` on every build. Local `astro dev` does not honor `_redirects` — test in production preview if you need to confirm an outbound URL.
