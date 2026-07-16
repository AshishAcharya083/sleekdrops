# scheduler-hourly-au.md — hourly auto-publish runbook (D1 + R2)

This file is the **HOW**: the pipeline, the rules, the guardrails each run executes.

The **WHAT** for a given run — which product, what article type, and what to write —
is supplied **separately, per run, via the scheduled task's instruction tab** (see the
template at the bottom). There is no product queue in this file anymore. If a run starts
without a product + type + angle in its instruction, it stops and asks.

> **Architecture (since 2026-06-13):** editorial content lives in **Cloudflare D1**
> (database `sleekdrops-content`), not the decommissioned `sleekdrops-cms` git repo.
> Publishing = INSERT rows into D1 (`posts` + `affiliate_links`) + upload the hero to R2
> + fire a `content-updated` repository dispatch at `AshishAcharya083/sleekdrops`. The web
> build (Cloudflare Pages) reads `status='published'` rows, validates them, and ships
> ~90s later. A bad row fails the build and never goes live.

AU-focused: products are sourced from **amazon.com.au**. Re-verify price + ASIN at publish
time on the live page — never trust a stated price without checking (self-identify as
`SleekDropsBot/1.0` when fetching Amazon).

---

## What the instruction tab provides each run

The scheduled task prompt supplies, for this run only:

- **Product** — name + amazon.com.au ASIN (or enough to identify it).
- **Article type** — `article` | `guide` (Comparison) | `roundup`. **Never `review`.**
- **Category** — one of `Tech · Home · Fashion · Health · Finance · Travel`.
- **Angle / brief** — a sentence or two on what to argue or cover; the rival to compare
  against if it's a guide.

This runbook never picks the product. If the instruction is missing any of the above,
**stop and report** rather than inventing one.

---

## Secrets (read from `sleekdrops-web/keys.md`, git-ignored)

| Name | Purpose | Notes |
|------|---------|-------|
| `CLOUDFLARE_ACCOUNT_ID` | account for D1 + R2 | `2c5e9b7755ce9770bd7bb905ec8db284` (not secret) |
| `D1_DATABASE_ID` | `sleekdrops-content` db | `b98d83ac-a2a5-42cb-a367-0cb71b902670` (not secret) |
| `CLOUDFLARE_D1_TOKEN` | **write** to D1 | token must have **D1 → Edit** (the agent INSERTs, not just reads) |
| `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` | upload hero to R2 | R2 API token (S3 credentials) with **Object Read & Write** on bucket `images` |
| `GITHUB_TOKEN` | fire the rebuild dispatch | repo scope on `AshishAcharya083/sleekdrops` |

Any required secret missing → **STOP and report**. Never echo, commit, or persist a token.
`keys.md` wraps tokens in backticks — extract with `grep -oE`, not a `KEY=value` regex.

---

## Pipeline (each run, top to bottom)

0. **Read the instruction.** Pull the product, article type, category, and angle from the
   scheduled task instruction. If any is missing → STOP and ask (no queue to fall back on).

1. **Coverage check (D1).** Query the live tables:
   `SELECT slug FROM posts;` and `SELECT slug FROM affiliate_links;`
   If a post already covers this product/slug → report "already covered" and stop.
   Choose a unique kebab-case slug — **slugs are immutable once published** (`/go/<slug>`
   and the post URL must never break).

2. **Verify the product live.** Via Chrome (`navigate` + `get_page_text`; the sandbox
   `web_fetch` is provenance-restricted for Amazon) load the amazon.com.au page with UA
   `SleekDropsBot/1.0`: confirm the ASIN, in-stock, and current AUD price. Quick
   supplementary search for fresh reviews/news. If the listing is dead → report and stop.

3. **Route the format.** Usually stated in the instruction. If a credible rival is worth
   cross-shopping → `guide` with `kind: "Comparison"`, ≥1,500 words, ≥3 contenders for a
   roundup. Otherwise → `article` (~900–1,200 tight words). **Never `postType: review`** —
   real reviews need ≥2 weeks of hands-on use and stay human-driven.

4. **Write the post.** Body markdown + complete frontmatter, following the law:
   - **Frontmatter schema** — `sleekdrops-web/src/content/config.ts` (Zod). Fields:
     `title`, `dek`, `category` (enum above), `postType`, `kind?`, `author`, `tags[]`,
     `pubDate`, `updatedDate?`, `readTime` (int), `cover` (`fill-1`…`fill-8`),
     `heroImage?` (R2 URL), `heroAlt?`, `featured` (false), `draft` (**false**).
     `author` must match an entry in `sleekdrops-web/src/data/authors.ts` — Tech → `theo`,
     Home → `mira`.
   - **Conventions** — `CLAUDE.md` + `sleekdrops-web/README.md`. Non-negotiables: open with
     a "The short answer" lede; close with a named winner + buyer profiles; the cons column
     is always full; sentence-case headings; no hype words, no emoji, no exclamation marks;
     every price dated ("verified `<date>`"); closing italic price disclaimer; footnote
     sources.

5. **Affiliate links — store the BASE, never a hand-typed tag.** In the body, every product
   mention links `/go/<slug>` (kebab-case) on first mention per section, in comparison
   tables, and in the verdict — but never the same anchor text more than twice. **Never a
   raw merchant URL or `?tag=` in the body** (the build guardrail rejects it).
   For each `/go/<slug>`, prepare an `affiliate_links` row that carries the product, not the
   tag — the `/go` Pages Function derives the per-marketplace tag at redirect time
   (`functions/_lib/affiliates.mjs` owns `sleekdrops-20` for amazon.com, `sleekdrops-22`
   for amazon.com.au):

   - `default_url` = `https://www.amazon.com.au/dp/{ASIN}?tag=sleekdrops-22` ← **fallback only**
   - `regions_json` = `{"network":"amazon","asin":"{ASIN}"}` ← the source of truth; add an
     `"asins":{"us":"B0…","au":"B0…"}` map only if you know per-marketplace ASINs
   - `note` = `"<product>, used by <post-slug>"`

   Do **not** vary the tag by hand — that's the function's job. Reuse existing slugs; never
   duplicate. Link the rival product too if it's on Amazon AU.

6. **Hero image → R2 via the API key (S3 API).** Generate an ORIGINAL 1600×900 editorial
   graphic with Python/Pillow (dark gradient, abstract product illustration, kicker +
   headline text; **no logos, no trademarks, no watermark, never a copied product photo**).
   Upload it with the R2 **S3 API** using the R2 access key/secret — no Chrome dashboard
   anymore. Key: `posts/{YYYY}/{MM}/{slug}/hero.jpg`, content-type `image/jpeg`:

   ```bash
   pip install boto3 --break-system-packages   # if needed
   ```
   ```python
   import boto3
   s3 = boto3.client(
       "s3",
       endpoint_url=f"https://{ACCOUNT_ID}.r2.cloudflarestorage.com",
       aws_access_key_id=R2_ACCESS_KEY_ID,
       aws_secret_access_key=R2_SECRET_ACCESS_KEY,
       region_name="auto",
   )
   key = f"posts/{yyyy}/{mm}/{slug}/hero.jpg"
   s3.upload_file("hero.jpg", "images", key, ExtraArgs={"ContentType": "image/jpeg"})
   ```
   (Equivalently `aws s3 cp hero.jpg s3://images/<key> --endpoint-url https://$ACCOUNT_ID.r2.cloudflarestorage.com`.)

   Then VERIFY `https://pub-fcb1f09112ed40ba9542a135e3f6618d.r2.dev/posts/{YYYY}/{MM}/{slug}/hero.jpg`
   loads (it can lag a few seconds after PUT — retry the GET once). That URL = `heroImage`;
   set a descriptive `heroAlt`. If upload fails → omit `heroImage`/`heroAlt`, use the `cover`
   gradient, and note it in the report. The Cloudflare MCP connector (`r2_bucket_get`,
   `r2_buckets_list`) is available for bucket-level verification only — it cannot PUT objects.

7. **Publish = write to D1.** Build `frontmatter_json` (the full frontmatter object, with
   `draft:false` consistent with `status='published'`) and run both writes via the D1 query
   API. **Always pass values in the `params` array — never interpolate SQL** (bodies and
   frontmatter contain quotes and markdown):

   `POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/d1/database/{D1_DATABASE_ID}/query`
   with header `Authorization: Bearer ${CLOUDFLARE_D1_TOKEN}` and body `{"sql": "...", "params": [...]}`.

   - **Upsert each affiliate link:**
     ```sql
     INSERT INTO affiliate_links (slug, default_url, regions_json, note, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, datetime('now'), datetime('now'))
     ON CONFLICT(slug) DO UPDATE SET
       default_url=excluded.default_url, regions_json=excluded.regions_json,
       note=excluded.note, updated_at=datetime('now');
     ```
   - **Insert the post (published):**
     ```sql
     INSERT INTO posts (slug, status, title, category, post_type, author, pub_date,
       updated_date, frontmatter_json, body_md, created_at, updated_at)
     VALUES (?1, 'published', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'), datetime('now'));
     ```
     The `post_type`/`category`/`pub_date` columns must mirror the same fields inside
     `frontmatter_json`.

8. **Trigger the rebuild.** Fire the dispatch:
   ```bash
   curl -fsS -X POST \
     -H "Authorization: Bearer $GITHUB_TOKEN" \
     -H "Accept: application/vnd.github+json" \
     https://api.github.com/repos/AshishAcharya083/sleekdrops/dispatches \
     -d '{"event_type":"content-updated"}'
   ```
   The build re-validates (Zod frontmatter + body guardrails: no raw merchant URLs, every
   `/go/<slug>` must exist in `affiliate_links`). A failing check fails the build — fix and
   re-publish.

9. **Verify live (~2 min after dispatch).** Fetch `https://sleekdrops.com/blog/<slug>` →
   200, correct title, `heroImage` URL present in `og:image`. Open
   `https://sleekdrops.com/go/<slug>` in Chrome → confirm it lands on amazon.com.au with
   `tag=` intact (now served by the `/go` Pages Function, geo-aware). If it 404s after 5
   min, check the `AshishAcharya083/sleekdrops` repo's Actions tab and report the failure.

10. **Report.** Title, live URL, category, affiliate slug(s) added, R2 image URL (or
    gradient fallback), price verified + date, and any new gotcha appended below.

---

## Guardrails

- **One post per run.** Quality over volume — Google's March 2026 core update punished
  scaled, identically-structured AI posts.
- Never `postType: review`; never fabricate a price; never commit `keys.md`/`.env`/secrets;
  never put a raw merchant URL or `?tag=` in a post body; never use a watermarked/copied image.
- Slugs are immutable once published.
- If the instruction is missing the product / type / category / angle → **stop and ask**,
  don't invent one.

---

## Known gotchas (append as discovered)

- The sandbox `web_fetch` tool can't open arbitrary URLs (provenance-restricted) — do Amazon
  price/ASIN checks via Chrome (`navigate` + `get_page_text`) instead.
- **D1 writes:** always use the `params` array, never interpolated SQL — post bodies and
  frontmatter JSON contain quotes, apostrophes, and markdown that will break inline SQL.
- **R2 public URL** can lag a few seconds behind a successful PUT — retry the verify GET once
  before falling back to the gradient.
- `keys.md` wraps tokens in backticks (e.g. `` `GITHUB_TOKEN` = `ghp_…` ``) — extract with
  `grep -oE 'gh[pous]_[A-Za-z0-9_]+'` and similar, not a `NAME=value` regex.
- The Amazon Product Advertising API was deprecated 2026-04-30; build affiliate URLs from the
  ASIN by hand (which is exactly what step 5 stores) — the function appends the tag.

---

## The scheduler instruction (paste into the task's instruction tab — fill the WHAT)

```
You are the SleekDrops hourly auto-publisher. The connected folder is the SleekDrops
workspace. Content is published to Cloudflare D1 (NOT git); sleekdrops-web is reference only.

WHAT TO WRITE THIS RUN (fill these in):
- Product:      <name + amazon.com.au ASIN, or enough to identify it>
- Article type: <article | guide (Comparison) | roundup>      # never review
- Category:     <Tech | Home | Fashion | Health | Finance | Travel>
- Angle / brief: <1–2 sentences on what to argue/cover; rival to compare if it's a guide>

HOW (follow exactly, do not deviate):
1. Read scheduler-hourly-au.md at the workspace root and follow its Pipeline top to bottom.
2. Read sleekdrops-web/keys.md for CLOUDFLARE_D1_TOKEN (D1 write), R2_ACCESS_KEY_ID +
   R2_SECRET_ACCESS_KEY (bucket images), and GITHUB_TOKEN (dispatch). Any missing → stop and report.
3. Verify the product live on amazon.com.au via Chrome (UA SleekDropsBot/1.0) before writing.
4. Write the post per sleekdrops-web/src/content/config.ts + CLAUDE.md conventions. Store each
   affiliate link as a BASE row — regions_json {"network":"amazon","asin":"<ASIN>"}, default_url
   as the AU fallback — and NEVER hand-type ?tag= in the body or rows; the /go function derives it.
5. Generate an original 1600x900 hero, upload to R2 via the S3 API key, verify the pub-…r2.dev URL loads.
6. Publish: UPSERT affiliate_links + INSERT the post (status='published') into D1, then fire the
   content-updated repository dispatch at AshishAcharya083/sleekdrops.
7. After ~2 min verify https://sleekdrops.com/blog/<slug> is live and /go/<slug> redirects to
   amazon.com.au with the tag intact.
8. Report: title, live URL, slug(s), R2 image URL, price+date. Append any new gotcha to
   scheduler-hourly-au.md.

Honor every guardrail: one post per run, never a review, never a raw merchant URL or ?tag= in a
body, never a fabricated price, never a watermarked image, never commit secrets. If the WHAT
block above is blank, stop and ask — do not invent a product.
```
