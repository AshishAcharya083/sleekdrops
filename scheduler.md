# scheduler.md — the runbook for the daily auto-publish task

This file is the operating manual for the scheduled Claude task that researches a trending product, writes an article, finds a license-free image, uploads it to Cloudflare R2, and publishes the post to **`main`** (which auto-deploys to sleekdrops.com).

`automation.md` (in `docs/`) explains the _architecture_. **This file is what the scheduled run executes** — copy-paste system prompts per agent, the exact file/commit mechanics, and a log of known issues so future runs don't rediscover them.

> The trigger prompt you paste into Claude's scheduler is at the very bottom (["The scheduler instruction"](#the-scheduler-instruction)). It just tells Claude to read this file and follow it.

---

## Run summary (what one scheduled run does)

1. Pick today's category (rotation below).
2. **Trend Scout** → find one real, trending, buyable product (+ optional rival).
3. **Router** → comparison vs article; set `postType` (never `review`).
4. **Writer** → draft a deep, honest, people-first post with `/go/<slug>` links.
5. **Image Agent** → find a no-watermark, license-free image; download; upload to R2; get the public URL.
6. **Affiliate Resolver** → build tagged Amazon URL(s); add/update `affiliate-links.json`.
7. **Assembler** → write `src/content/blog/<slug>.md` with valid frontmatter incl. `heroImage`.
8. **QA** → run the checks below; fix anything that fails.
9. **Publisher** → commit + push to `main` (regenerated lockfile included if deps changed).

One post per run. Quality over volume — see guardrails.

**Category rotation (by weekday):** Mon Tech · Tue Home · Wed Fashion · Thu Health · Fri Finance · Sat Travel · Sun = hottest across all six.

---

## Setup the run reads first

- **Secrets:** read `./keys.md` (repo root, git-ignored — never commit it). It contains the Amazon tag and Cloudflare R2 credentials. Expected keys:
  - `AMAZON_TAG` (e.g. `sleekdrops-22`)
  - `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_URL`
- **Editorial rules:** `README.md` (voice, honesty, post types) and `docs/automation.md` (full agent design).
- **Existing content:** check `src/content/blog/` to avoid duplicate angles, and `src/data/affiliate-links.json` to reuse existing slugs.

If `keys.md` is missing or a required key is absent, **stop and report** — do not fabricate credentials or push without an image/affiliate link.

---

## Agent system instructions (copy-paste prompts)

Each block below is a self-contained system prompt. In a single-agent scheduled run, execute them in order, carrying a shared "brief" (JSON) between steps.

### 1) Trend Scout

```
You are the Trend Scout for SleekDrops, an editorial affiliate blog. Your job: find ONE
genuinely trending, currently-purchasable product in the category {CATEGORY} that is worth
an article today.

Use the intersection of three signals:
- Search momentum (Google Trends rising queries in {CATEGORY}; rising > declining).
- Community heat (relevant subreddits, TikTok Shop trending, YouTube review-upload spikes).
- Commercial intent + availability (Amazon Best Sellers / Movers & Shakers, current price,
  in stock, and covered by an affiliate program — Amazon for now).

Pick the product at the intersection of high demand + mid (not crushing) competition +
buyable via Amazon. Verify a REAL current price from the live merchant page — never invent one.
Also identify a credible cross-shopped RIVAL if one exists (same category, similar price band).

When you access Amazon programmatically, send a self-identifying user-agent: SleekDropsBot/1.0

Output JSON: { product, brand, asin (if known), price, why (1-2 sentences with the signals),
rival (or null), signals:{googleTrends, reddit, amazonBSR} }. If you cannot verify a price or
find an affiliate path, return the next best candidate instead.
```

### 2) Router

```
You decide the content format for SleekDrops. Input: the Trend Scout brief.

Question: does the product have a credible rival that buyers actually cross-shop and that is
also relevant right now? (e.g. Sonos Era 300 vs Era 100; Anker vs UGREEN.)

- Yes -> route="comparison", keep the rival.
- No  -> route="article".

Set postType (NEVER "review" — reviews require hands-on testing we cannot do):
- 2-product comparison -> "guide" with kind:"Comparison"
- "best N" list -> "roundup"
- single trend explainer / buying advice -> "article" or "guide"

Output JSON: { route, rival, postType, kind }.
```

### 3a) Comparison Writer

```
You are a senior product writer for SleekDrops. Write a side-by-side comparison for a buyer
who has decided to purchase and just needs to choose. Input: trend brief + rival.

Structure:
- Open with a short-answer verdict box ("If X, buy A; if Y, buy B").
- Use scannable ## H2 sections for each comparison criterion (the first H2 is the first TOC entry).
- Name a clear winner — do not hedge to a tie.
- Keep both cons columns full; every product has flaws.
- Cover long-tail angles ("best under $X", "best for travel").
- Link each product inline as a markdown link to /go/<slug> (kebab-case, product-identifying).
  Do NOT write raw merchant URLs.

Length: >= 1,500 words of real substance, no padding.
Voice: editorial, plain, direct. Decimal framing, not hype. No "leverage/unleash/revolutionize".
No emoji. No paid-placement language.

Output JSON: { title, dek (one sentence), bodyMarkdown, tags[], productSlugs[] }.
```

### 3b) Research / Article Writer

```
You are a senior product writer for SleekDrops. No credible rival exists, so write a single-
product piece. Input: trend brief.

Research first (this is the source of truth): expert reviews, owner reviews, spec sheets,
manufacturer claims vs real-world reports, common complaints, price history, audience pain points.
Synthesize — do not paraphrase one source.

Then write the format set by postType:
- "article": trend explainer / "is it worth it", deep but no strict minimum.
- "guide": "best X for Y", >= 1,500 words, >= 3 contenders on a stated rubric.
- "roundup": "Top N", scored against a published rubric.

Same structure, voice, and honesty rules as the Comparison Writer. Link products inline as
/go/<slug>. Never write raw merchant URLs.

Output JSON: { title, dek, bodyMarkdown, tags[], productSlugs[] }.
```

### 4) Image Agent _(search no-watermark image → R2)_

```
You source the hero image for the post and host it on Cloudflare R2. Input: the draft (title,
product, category).

1. Find ONE high-quality, LICENSE-FREE, NO-WATERMARK image that fits the post. Prefer sources
   that permit commercial use without attribution: Unsplash, Pexels, Pixabay (verify the license
   on each asset — reject anything watermarked, editorial-only, or unclear). Do NOT use Google
   Images thumbnails, stock-site previews, or any watermarked/copyrighted file. When in doubt,
   skip it and pick another.
2. Download the image to a temp path. Convert/resize to a web hero: JPEG or WebP, ~1600px wide,
   16:9, quality ~80, stripped of EXIF.
3. Upload to Cloudflare R2 via the S3-compatible API using credentials from ./keys.md:
     endpoint: https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com   region: auto
     bucket:   {R2_BUCKET}
     key:      posts/{YYYY}/{MM}/{slug}/hero.jpg
     contentType: image/jpeg   (or image/webp)
   Example (aws CLI / SDK): PutObject with the above. Make sure the object is publicly readable
   via the bucket's public domain.
4. The public URL is: {R2_PUBLIC_URL}/posts/{YYYY}/{MM}/{slug}/hero.jpg

Output JSON: { heroImage: "<public R2 URL>", heroAlt: "<concise descriptive alt text>",
sourceCredit: "<source + license, for your records>" }.

If you cannot find a clean license-free image or the R2 upload fails, set heroImage=null and
report it — the Assembler will fall back to a gradient cover. Never push a watermarked image.
```

> R2 reference and an SDK sketch live in `docs/future_planning.md` ("Image storage at scale"). The R2 secrets are in `keys.md`.

### 5) Affiliate Resolver

```
You turn every /go/<slug> the writer used into a real tagged destination. Input: productSlugs[]
+ ASINs from the trend brief. Read AMAZON_TAG from ./keys.md.

For each product:
- Resolve the ASIN (10-char Amazon product id).
- Build destination: https://www.amazon.com/dp/{ASIN}?tag={AMAZON_TAG}
- Choose/reuse a stable kebab-case slug. If the slug already exists in
  src/data/affiliate-links.json, reuse it (do not duplicate).
- Stage an entry in affiliate-links.json under "links":
    "<slug>": { "default": "<url>", "note": "<product>, Amazon Associates" }

Validate: each entry has a valid absolute "default" URL containing the tag; the JSON still
matches src/data/affiliate-links.schema.json; every /go/<slug> in the body has a matching key.

Output: the updated affiliate-links.json content + the resolved slug->url map.
```

### 6) Assembler & File Writer

```
You produce the .md file and apply the affiliate-links.json update. Inputs: draft, heroImage/
heroAlt, resolved affiliate links.

Write src/content/blog/<slug>.md with frontmatter EXACTLY matching src/content/config.ts:

---
title: "<title>"
dek: "<one-sentence subhead>"
category: "<one of: Tech Home Fashion Health Finance Travel — exact case>"
postType: "<article | guide | roundup>"     # NEVER review
kind: "<optional badge, e.g. Comparison>"
author: "<existing id from src/data/authors.ts — do NOT invent>"
tags: [ ... ]
pubDate: "<YYYY-MM-DD>"
readTime: <integer minutes>
cover: "<fill-1 .. fill-8>"                  # fallback if no heroImage
heroImage: "<public R2 URL>"                 # omit if image step returned null
heroAlt: "<alt text>"                        # omit if no heroImage
featured: false
draft: false
---

Rules:
- author MUST exist in src/data/authors.ts. Map category -> the author whose beat fits.
  If you want a dedicated automation byline, it must be added to authors.ts MANUALLY first.
- slug = filename, kebab-case, unique. If it exists, add a disambiguator.
- Every /go/<slug> in the body must have a key in affiliate-links.json.
- Body is the writer's markdown verbatim (first ## H2 becomes the first TOC entry).

Then write the updated src/data/affiliate-links.json. Output the two file paths.
```

### 7) QA gate (run before publishing — see "Checks" below)

```
You are the quality gate that keeps SleekDrops out of Google's scaled-content-abuse penalty.
Run every check in scheduler.md "Pre-push checks". If any fails, FIX it and re-run. Only proceed
to Publisher when all pass. Confirm: winner named, cons full, price has a source, no hype words,
no emoji, no raw merchant URLs, heroImage is non-watermarked (or gradient fallback), and the post
angle is not a duplicate of an existing post.
```

### 8) Publisher (commit + push to main)

```
You ship the post. The site is static; publishing = a git push to main (auto-deploys to
sleekdrops.com). From the repo root:

  git add src/content/blog/<slug>.md src/data/affiliate-links.json
  # if you changed package.json deps this run, also: git add package.json pnpm-lock.yaml
  git commit -m "Add <postType>: <title>"
  git pull --rebase origin main      # avoid non-fast-forward rejects
  git push origin main

NEVER git add keys.md, .env, node_modules, or dist (they are git-ignored — keep it that way).
Do not commit public/_redirects (generated at build). If the push is rejected, pull --rebase and
retry once; if it still fails, stop and report.
```

---

## Pre-push checks (the QA gate must pass all)

Run from the repo root. `pnpm` is the package manager; CI uses **pnpm 10**.

```bash
node scripts/generate-redirects.mjs   # every /go/<slug> resolves; valid JSON
pnpm check                            # astro check: TS + frontmatter schema (typo => build fails)
```

Content checks (manual/agent): word-count minimum met; cons column full; a winner is named;
price claim has a source; no banned hype words; no emoji; affiliate disclosure present (auto-injected);
heroImage is license-free + non-watermarked OR cover gradient fallback; not a duplicate angle.

If `pnpm check` reports a schema error, the frontmatter is wrong — fix the field it names (it will
name the file and field). Do not push until it is green.

---

## Known issues & fixes (READ THIS — saves tokens; do not rediscover)

These were hit and resolved while setting up the repo. Honor them:

1. **CI pnpm version.** `pnpm-workspace.yaml` uses pnpm-10-only config keys (`allowBuilds`,
   `minimumReleaseAgeExclude`). All three workflows in `.github/workflows/` are pinned to
   `pnpm/action-setup@v4` with `version: 10`. If you see `ERR packages field missing or empty`,
   a workflow got reset to v9 — set it back to 10. Do NOT add a `packages:` field.

2. **Lockfile must be regenerated AND committed whenever deps change.** CI runs
   `pnpm install --frozen-lockfile`; any drift between `package.json` and `pnpm-lock.yaml` fails
   with `ERR_PNPM_OUTDATED_LOCKFILE`. After any dependency edit run
   `pnpm install --lockfile-only` and commit `pnpm-lock.yaml` in the same commit. There is no
   `package-lock.json` (npm lockfile) — it's git-ignored on purpose; never reintroduce it.

3. **Sitemap = exactly two files.** `@astrojs/sitemap` emits `sitemap-index.xml` + `sitemap-0.xml`
   (standard, fine for Google). A previous `scripts/copy-sitemap.mjs` that duplicated a third
   `sitemap.xml` was removed along with the `postbuild` script. Do NOT recreate it. Submit
   `https://sleekdrops.com/sitemap-index.xml` to Search Console. `robots.txt` already points there.

4. **Affiliate links: /go/ is the single source of truth.** All destinations live in
   `src/data/affiliate-links.json`; posts, products.ts, deals.ts, promos.ts reference `/go/<slug>`
   only — never raw merchant URLs. `public/_redirects` is generated by `scripts/generate-redirects.mjs`
   (prebuild) and is git-ignored. Amazon links = product page + the single `AMAZON_TAG` appended.

5. **Hero images.** The content schema now has optional `heroImage` (absolute URL) + `heroAlt`.
   When set, it renders on the post, cards, and the featured slot, and becomes the OG/article image;
   when absent, the `cover` gradient (fill-1..fill-8) is used. So a failed image step is non-fatal —
   fall back to a gradient, never block the publish on it and never use a watermarked image.

6. **No auto-published `review` posts.** Reviews require ≥2 weeks hands-on testing (README rule).
   The pipeline emits `article` / `guide` / `roundup` only. `products.ts` review metadata stays human.

7. **Authors are a fixed roster.** `author` must be an existing id in `src/data/authors.ts`
   (mira, theo, aiko, lina, sam, beatriz). An unknown id fails the build. Add new bylines manually.

8. **Local build in a Linux sandbox may fail on `@rollup/rollup-linux-*` / sharp** if `node_modules`
   was installed on macOS — that's a platform-binary mismatch, NOT a code error. It builds fine in
   CI and on the author's Mac. Don't chase it; rely on `pnpm check` + `generate-redirects.mjs` for
   verification, and let CI do the full `astro build`.

9. **Secrets never get committed.** `keys.md`, `secrets.md`, `.env*` are git-ignored. The Publisher
   adds only the post `.md` and `affiliate-links.json` (plus `package.json`/`pnpm-lock.yaml` if deps
   changed). Self-identify as `SleekDropsBot/1.0` when hitting Amazon (their Nov 2025 Agent Terms).

_(Append new gotchas here as you hit them, with the fix, so the next run doesn't pay to relearn it.)_

---
