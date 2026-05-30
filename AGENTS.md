# SleekDrops — agent & developer reference

The technical handbook for SleekDrops.com. Read this before editing the codebase. For the business context and content rules, start with the [README](./README.md).

---

## Stack

- **Framework:** Astro 4 (static output, Cloudflare Pages adapter).
- **Styling:** Plain CSS with design tokens (no Tailwind). All tokens live in [src/styles/tokens.css](src/styles/tokens.css); element resets and utilities in [src/styles/global.css](src/styles/global.css). Components own their styles via `<style>` blocks.
- **Content:** Astro [content collections](https://docs.astro.build/en/guides/content-collections/). One markdown file per post in [src/content/blog/](src/content/blog/), validated against the Zod schema in [src/content/config.ts](src/content/config.ts).
- **Data:** Static TypeScript modules under [src/data/](src/data/) for authors, categories, deals, promos, and products. These are the single source of truth — no backend fetch at build time.
- **TypeScript:** Strict mode. Path aliases: `@components/*`, `@layouts/*`, `@data/*`, `@lib/*`, `@styles/*`.

The `PUBLISH_API_URL` placeholder in [.env.example](.env.example) is reserved for the publishing pipeline; the frontend doesn't read it yet — wire it into `src/lib/posts.ts` when the API is ready.

---

## Folder structure

```
sleekdrops/
├── public/                         # Static assets served as-is
│   ├── favicon.svg                 # SleekDrops mark (dark droplet)
│   ├── mark.svg / wordmark.svg     # Brand assets for embed
│   ├── og-default.png              # Fallback Open Graph image
│   └── robots.txt
├── src/
│   ├── components/
│   │   ├── ui/                     # Atoms: Badge, Button, Eyebrow, BrandMark, IconButton
│   │   ├── layout/                 # Header, Footer, CategoryStrip, Newsletter
│   │   ├── blog/                   # PostCard, PostGrid, FeaturedPost, ListingHero, Pagination, AuthorChip, AuthorCard, RelatedPosts
│   │   ├── article/                # ArticleBody, Verdict, TableOfContents, LegalLayout
│   │   ├── affiliate/              # DealCard, PromoCard, DropPanel, ProductCallout, ProsConsList, ComparisonTable, StarRating, AffiliateDisclosure
│   │   └── seo/                    # SEOHead, JsonLd, Breadcrumbs
│   ├── content/
│   │   ├── config.ts               # Blog frontmatter schema (Zod)
│   │   └── blog/*.md               # One file = one post
│   ├── data/
│   │   ├── authors.ts              # Byline registry — posts reference by id
│   │   ├── categories.ts           # Six categories with blurbs + intros
│   │   ├── categories-types.ts     # Shared CategorySlug / CategoryName unions
│   │   ├── deals.ts                # Daily affiliate deals (the "drops")
│   │   ├── promos.ts               # Promo codes
│   │   ├── products.ts             # Products linked from review posts
│   │   ├── affiliate-links.json    # /go/[slug] → merchant URL map (drives public/_redirects)
│   │   └── affiliate-links.schema.json
│   ├── layouts/
│   │   └── BaseLayout.astro        # Head + sticky header + footer + chrome script
│   ├── lib/
│   │   ├── posts.ts                # Content-collection helpers (list / filter / related)
│   │   ├── format.ts               # Date + headline helpers
│   │   └── seo.ts                  # Meta payload + JSON-LD builders
│   ├── pages/
│   │   ├── index.astro             # Home
│   │   ├── 404.astro
│   │   ├── about.astro             # About + principles + team
│   │   ├── contact.astro
│   │   ├── privacy.astro / disclaimer.astro
│   │   ├── categories.astro        # All categories index
│   │   ├── rss.xml.ts              # RSS feed
│   │   ├── blog/
│   │   │   ├── [...page].astro     # Paginated blog index (/blog, /blog/2…)
│   │   │   └── [slug].astro        # Post detail (with optional Verdict for reviews)
│   │   ├── category/[slug]/[...page].astro
│   │   ├── tag/[tag]/[...page].astro
│   │   ├── author/[author].astro
│   │   ├── reviews/[...page].astro # postType=review filter
│   │   ├── guides/[...page].astro  # postType=guide filter
│   │   ├── deals/index.astro
│   │   ├── deals/[slug].astro
│   │   ├── promos/index.astro
│   │   └── promos/[slug].astro
│   ├── scripts/
│   │   └── chrome.ts               # Dark mode + reading progress + TOC active + smooth anchors
│   └── styles/
│       ├── tokens.css              # Design tokens — single source of truth
│       └── global.css              # Element resets + layout utilities + `.fill-*` cover gradients
├── scripts/
│   └── generate-redirects.mjs      # Generates public/_redirects from affiliate-links.json
├── docs/                           # Engineering notes (associate networks, future planning)
├── .github/workflows/              # CI/CD: main → production, develop → staging
├── astro.config.mjs                # Astro + sitemap config
├── package.json
├── tsconfig.json
├── AGENTS.md                       # You are here
└── README.md                       # Project purpose + business rules
```

### What goes where

| If you're… | Edit… |
|---|---|
| Adding a blog post | `src/content/blog/<slug>.md` |
| Adding an author | `src/data/authors.ts` |
| Adding a deal or promo | `src/data/deals.ts` or `src/data/promos.ts` |
| Adding a product (for a review) | `src/data/products.ts`, then set `product: <id>` in the post frontmatter |
| Adding an affiliate redirect | Append an entry to `src/data/affiliate-links.json`. Reference it in markdown as `/go/<slug>`. |
| Adjusting brand colour, font, spacing | `src/styles/tokens.css` |
| Adding a new page | `src/pages/<route>.astro` — wrap with `<BaseLayout>` and call `buildMeta()` |
| Adding a new reusable component | `src/components/<namespace>/<Name>.astro` — colocate styles in a `<style>` block |
| Adding a new SEO schema | `src/lib/seo.ts` |

---

## Design system

Visual decisions ship from a separate design-system folder, ported into this repo. The canonical source of truth for any colour, type, spacing, or radius decision is **[src/styles/tokens.css](src/styles/tokens.css)** — never inline a hex value; always use a `var(--*)`.

- **Type:** Instrument Serif for display, Manrope for body, JetBrains Mono for code. Loaded via Google Fonts at the top of `tokens.css`.
- **Colour:** Warm paper (`--paper`) background, deep ink (`--ink`) text, single ember (`--accent`) used sparingly — for CTAs, active states, and ratings only.
- **Borders before shadows:** most cards are `1px solid var(--hairline)` with no shadow. Shadows are reserved for hover lift and floating chrome.
- **Headlines:** one serif headline per screen. Italicise one word with `<em>` for editorial accent.
- **Dark mode:** toggled by `data-theme="dark"` on `<html>`. The bootstrap script in `SEOHead.astro` sets it pre-paint so the theme never flashes.

If you change a token, run `pnpm build` and skim the affected pages — colour and type are referenced everywhere.

---

## Content rules

The frontmatter schema in `src/content/config.ts` enforces what it can; the rest is editorial discipline.

### Categories
`Tech` · `Home` · `Fashion` · `Health` · `Finance` · `Travel`. Defined as both an enum in the content schema and a registry in `src/data/categories.ts` — keep them in sync.

### Post types

| `postType` | Use for | Layout extras |
|---|---|---|
| `article` | News, trends, educational | Plain post body |
| `review` | Single product, ≥ 1,200 words | Quick Verdict + ProsCons + ProductCallout (needs `product: <id>`) |
| `guide` | Buying guides, ≥ 1,500 words | Plain post body (or add a `ComparisonTable` inline) |
| `roundup` | "Top N" lists | Plain post body |

### Review quality rules
- `rating`: honest decimal 1.0–5.0.
- `pros`: 3–5 genuine advantages.
- `cons`: 2–4 honest disadvantages.
- A "Quick verdict" block opens every review — rendered automatically when the post has a `product` frontmatter and the matching product exists in `src/data/products.ts`.

### Deal rules
- Always set `expiresAt` (ISO date).
- Update `updatedAt` when refreshing prices.
- Never fabricate prices.

---

## Common commands

```bash
pnpm install            # install deps
pnpm dev                # http://localhost:4321
pnpm build              # astro check + production build
pnpm preview            # serve the production build
pnpm check              # type-check only
```

The build runs `astro check` first — type errors and frontmatter-schema violations fail the build, so the CI pipeline doesn't need to repeat them.

---

## Adding a new blog post (checklist)

1. Create `src/content/blog/<slug>.md`.
2. Fill the frontmatter — see [src/content/config.ts](src/content/config.ts) for the full schema. Required: `title`, `dek`, `category`, `author`, `pubDate`, `readTime`, `cover`.
3. If it's a review, also set `postType: review` and `product: <product-id>` (and add the product to `src/data/products.ts` if it isn't there yet).
4. Write the body in markdown. The first `## H2` becomes the first TOC entry.
5. Run `pnpm dev` and skim `/blog/<slug>` — verify Verdict, TOC, and Related Posts render as expected.

If the author is new, add them to `src/data/authors.ts` first — otherwise the build fails with `Unknown author id: "…"`.

---

## Deployment

Cloudflare Pages, plain static output (no SSR adapter). The build command is `pnpm build`; the output directory is `dist/`. `SITE_URL` is read from the environment and falls back to `https://sleekdrops.com`.

Two environments, driven by GitHub Actions in `.github/workflows/`:

- **Production:** push to `main` → deploys to `sleekdrops.com`.
- **Develop:** push to `develop` → deploys to `develop.sleekdrops.com` (or the Cloudflare Pages preview URL).

Secrets are stored in GitHub: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_PROJECT_NAME`.

### Affiliate redirects

`/go/[slug]` URLs are resolved at the Cloudflare edge via `public/_redirects`, which is regenerated from [src/data/affiliate-links.json](src/data/affiliate-links.json) by `scripts/generate-redirects.mjs` on every build (wired as the `prebuild` npm script). Local `astro dev` does not honor `_redirects` — test in production preview if you need to confirm an outbound URL.
