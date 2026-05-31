# Automation — the agentic publishing pipeline

How SleekDrops goes from "what's trending right now" to a published, affiliate-monetized article with zero manual writing. This document is the engineering spec for the pipeline; implement it in the Google Agent Development Kit (GEAP/ADK).

**The agent never touches this Astro repo.** Content lives in a separate repository — **[sleekdrops-cms](https://github.com/DevMahisaur/sleekdrops-cms)** — whose `AGENTS.md` is the operating manual the writer agents read. Posts and affiliate-link JSON are committed there; the main site clones that repo at build time.

The site is fully static (Astro → Cloudflare Pages). **Publishing = writing a schema-valid markdown file in sleekdrops-cms + appending an affiliate-link entry + a `git push` to sleekdrops-cms.** A push to sleekdrops-cms's `main` dispatches a `content-updated` event to this main repo, which rebuilds and redeploys in ~90s. No backend, no database. The final agent's job is a commit to sleekdrops-cms, not this repo.

---

## Guiding principles (read before building)

1. **People-first, not scaled-content-abuse.** Google's March 2026 core update wiped 50–80% of traffic from sites publishing high-volume, thin, identically-structured AI pages with no original angle. The pipeline must produce *fewer, deeper* articles with a genuine point of view — not a content farm. One excellent post a day beats ten generic ones.
2. **E-E-A-T, especially the first E (Experience).** Google now treats first-hand experience as a deciding ranking factor. The agent cannot physically test products, so it must lean on *aggregated real-world signals* (owner reviews, expert consensus, spec comparison) and be honest about what it is — an editorial synthesis, not a hands-on lab test.
3. **Honor the README's editorial rules.** No fabricated prices. Decimal ratings. The cons column is always full. No paid-placement language. These are non-negotiable and must be encoded in every writer agent's system prompt.
4. **Reviews need real testing — so don't fully automate them.** A `review` post type (per the README) requires ≥2 weeks of hands-on use. An agent can't do that. **The automated pipeline produces `article`, `comparison` (an `article`/`guide` with `kind: "Comparison"`), `guide`, and `roundup` types only.** True single-product `review` posts stay human-driven. This is a hard guardrail, not a preference.
5. **Human-in-the-loop by default.** The pipeline publishes to the `develop` branch (staging) and opens a PR. A human approves the merge to `main`. Flip to direct-to-`main` only once you trust the output.

---

## Affiliate links — how the agent attaches them

This is the mechanic that confuses everyone, so it's spelled out here.

**For Amazon, you have ONE affiliate tag** (your store ID, e.g. `sleekdrops-22`). You do not get a unique link per product. The agent takes any product's Amazon page and appends your single tag:

```
https://www.amazon.com/dp/{ASIN}?tag=sleekdrops-22
```

`{ASIN}` is the 10-character product ID in every Amazon URL. The link differs per product *only because the ASIN differs* — the tag is constant across every link on the site. (Amazon's old Product Advertising API was deprecated April 30, 2026; its replacement needs 10 sales in 30 days, so until then the agent builds these URLs manually by scraping/looking up the ASIN.)

**The agent never writes a raw merchant URL into a post.** It uses the `/go/<slug>` indirection:

- In the markdown body: `[Sony WH-1000XM6](/go/sony-wh-1000xm6)`
- In sleekdrops-cms's `data/affiliate-links.json` it appends the real destination:

```json
"sony-wh-1000xm6": {
  "default": "https://www.amazon.com/dp/B0DGHMNQRS?tag=sleekdrops-22",
  "note": "WH-1000XM6, Amazon Associates, tag sleekdrops-22"
}
```

On build, `scripts/generate-redirects.mjs` reads that JSON and writes `public/_redirects`, so `/go/sony-wh-1000xm6` 302s to the tagged URL at Cloudflare's edge, with `rel="sponsored nofollow"` already on the link. **`affiliate-links.json` is the single source of truth for every destination** — change your tag once there and every link on the site updates. `products.ts`, `deals.ts`, and `promos.ts` all reference `/go/<slug>` too, never raw URLs.

> When you swap programs (e.g. add Awin/CJ/Impact later), only the `default` value in the JSON changes — the post, the slug, and the redirect stay put.

---

## Pipeline overview

```
                         ┌─────────────────────────────────────────┐
                         │  ORCHESTRATOR (sequential workflow)       │
                         └─────────────────────────────────────────┘
                                          │
   ┌──────────────┐   trend + niche   ┌───┴────────┐  has rival in uptrend?  ┌──────────────────┐
   │ 1. TREND     │ ────────────────▶ │ 2. ROUTER  │ ──── yes ─────────────▶ │ 3a. COMPARISON   │
   │    SCOUT      │                   │ (decision) │                         │     WRITER        │
   └──────────────┘                   └───┬────────┘                         └────────┬─────────┘
                                          │ no                                         │
                                          ▼                                            │
                                   ┌──────────────────┐                                │
                                   │ 3b. RESEARCH/     │                                │
                                   │     ARTICLE WRITER│                                │
                                   └────────┬─────────┘                                │
                                            └──────────────┬─────────────────────────┘
                                                           ▼
                              ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
                              │ 4. AFFILIATE     │──▶│ 5. ASSEMBLER &   │──▶│ 6. EDITOR / QA   │
                              │    RESOLVER       │   │    FILE WRITER    │   │    (gate)         │
                              └──────────────────┘   └──────────────────┘   └────────┬─────────┘
                                                                                       ▼
                                                                              ┌──────────────────┐
                                                                              │ 7. PUBLISHER     │
                                                                              │ (git → develop)  │
                                                                              └──────────────────┘
```

Each agent has a narrow job, a defined input, and a defined output. Narrow instructions = higher precision. Agents hand off via a shared JSON "brief" object (the working memory) that grows as it passes down the chain.

---

## The shared brief (working memory)

Every agent reads and writes one evolving JSON object. This is the contract between stages.

```jsonc
{
  "runId": "2026-05-30-tech",          // date + category, also the idempotency key
  "category": "Tech",                   // one of: Tech Home Fashion Health Finance Travel
  "trend": {
    "product": "Anker Prime 27,650mAh Power Bank",
    "why": "Search interest +180% MoM; trending on r/gadgets; new GaN model just launched",
    "signals": { "googleTrends": "rising", "redditMentions": 42, "amazonBSR": 3 }
  },
  "route": "comparison",                // "comparison" | "article"
  "rival": "UGREEN Nexode 25,000mAh",   // present only when route == comparison
  "postType": "guide",                  // article | guide | roundup  (never "review")
  "kind": "Comparison",                 // human label badge
  "draft": { "title": "...", "dek": "...", "bodyMarkdown": "...", "tags": [] },
  "affiliate": [                         // filled by agent 4
    { "slug": "anker-prime-27650", "asin": "B0CX1W2Y3Z", "url": "https://www.amazon.com/dp/B0CX1W2Y3Z?tag=sleekdrops-22" }
  ],
  "file": { "slug": "anker-vs-ugreen-power-bank", "path": "sleekdrops-cms/posts/anker-vs-ugreen-power-bank.md" }
}
```

---

## Agent 1 — Trend Scout

**Job:** find ONE genuinely trending product worth writing about today, in the day's assigned category.

**Category rotation:** the orchestrator passes the category. Rotate across the six on a schedule so coverage stays balanced, e.g. Mon=Tech, Tue=Home, Wed=Fashion, Thu=Health, Fri=Finance, Sat=Travel, Sun=whatever's hottest across all.

**Data sources (intersection of three signals = the sweet spot):**

- **Search momentum:** Google Trends (rising queries in the category), or a keyword tool. Rising > declining.
- **Social/community heat:** relevant subreddits (r/gadgets, r/BuyItForLife, r/financialindependence, etc.), TikTok Shop trending, YouTube "vs / review" upload spikes.
- **Commercial intent + availability:** Amazon Best Sellers / "Movers & Shakers" in the category, current price, in-stock status, and whether an affiliate program covers it.

**Selection rule:** pick the product at the intersection of *high demand + mid (not crushing) competition + buyable via your affiliate programs*. Reject anything with no clear purchase intent or no affiliate path.

**Output:** populates `brief.trend` and `brief.category`.

**Guardrail:** must return a *real, currently-purchasable* product with a verifiable price. If it can't verify a price, it flags the product and the orchestrator skips to the next candidate (never fabricate prices).

---

## Agent 2 — Router (decision step)

**Job:** decide the content format. One question: *does this product have a comparable rival that is also in an upswing (a credible head-to-head)?*

- **Yes** → `route = "comparison"`, set `brief.rival`, hand to **Agent 3a**.
- **No** → `route = "article"`, hand to **Agent 3b**.

A "credible rival" means same category, similar price band, and something buyers actually cross-shop (Sonos Era 300 vs Era 100; Anker vs UGREEN). If the only "rival" is irrelevant, treat it as no rival and go to 3b.

The Router also sets `postType`:
- comparison of 2 products → `guide` with `kind: "Comparison"`
- "best N" list → `roundup`
- single trend explainer / buying advice → `article` or `guide`

---

## Agent 3a — Comparison Writer

**Job:** write a side-by-side comparison that helps a buyer who's already decided to purchase choose between two (or a few) options. Comparison content targets high-commercial-intent keywords and converts well.

**Structure that ranks (bake into the prompt):**
- A **short-answer / verdict box up top** ("If X, buy A; if Y, buy B").
- Clear, scannable **comparison criteria** as `## H2` sections (the first H2 becomes the first TOC entry).
- A **named winner** — don't hedge to a tie.
- Honest **trade-offs on both sides** (cons column always full).
- Long-tail variations covered ("best under $100", "best for travel").
- Inline affiliate links to each product as `/go/<slug>` placeholders (Agent 4 fills the destinations).

**Length:** comparison/guide ≥ 1,500 words of genuine substance (per README), no padding.

**Voice:** editorial, plain, direct. No "leverage/unleash/revolutionize". No emoji. Decimal framing, not hype.

**Output:** `brief.draft` (title, dek, body markdown with `/go/<slug>` links, tags) and the list of product slugs it linked.

---

## Agent 3b — Research / Article Writer

**Job:** when there's no head-to-head, gather everything relevant on the single trending product and write the appropriate article.

**Research first (it is the source of truth):** scour expert reviews, owner reviews, spec sheets, manufacturer claims vs. real-world reports, common complaints, and price history. Identify the audience's actual pain points. Synthesize — don't paraphrase one source.

**Then write** one of:
- `article` — a trend explainer / "is it worth it" piece (no strict length minimum, but make it deep).
- `guide` — "best X for Y" buying guide, ≥ 1,500 words, tests ≥ 3 contenders on a stated rubric.
- `roundup` — "Top N" list scored against a published rubric.

**Same structural + voice + honesty rules as 3a.** Inline affiliate links as `/go/<slug>`.

**Output:** `brief.draft` + linked product slugs.

---

## Agent 4 — Affiliate Resolver

**Job:** turn every `/go/<slug>` the writer used into a real, tagged destination.

For each linked product:
1. Resolve the **ASIN** (Amazon product ID) — from the trend data or a lookup.
2. Build the destination URL: `https://www.amazon.com/dp/{ASIN}?tag=sleekdrops-22` (substitute the live tag from config/secret — never hard-code; keep the tag in one place).
3. Choose a stable, human-readable **slug** (kebab-case, product-identifying, e.g. `anker-prime-27650`). Reuse an existing slug if the product is already in `affiliate-links.json` (don't duplicate).
4. Stage an append to sleekdrops-cms's `data/affiliate-links.json`:

```json
"anker-prime-27650": {
  "default": "https://www.amazon.com/dp/B0CX1W2Y3Z?tag=sleekdrops-22",
  "note": "Anker Prime 27,650mAh, Amazon Associates"
}
```

**Validation:** the destination must be a valid absolute URL with the tag present, and the JSON must still pass sleekdrops-cms's `data/affiliate-links.schema.json` (each entry requires `default`). Slugs in the body must exactly match keys in the JSON, or the link 404s. sleekdrops-cms's `scripts/validate.ts` (run in its CI) catches mismatches before merge.

**Multi-program future:** when you add CJ/Awin/Impact, this agent picks the right program per merchant and may write region keys (`us`, `gb`, `de`) instead of just `default`.

**Output:** `brief.affiliate[]`, and the staged JSON diff.

---

## Agent 5 — Assembler & File Writer

**Job:** produce the actual `.md` file with valid frontmatter, and apply the `affiliate-links.json` append.

**Frontmatter contract** (validated by `src/content/config.ts` at build — a typo fails the build, which is the safety net):

```yaml
---
title: "..."                 # required
dek: "..."                   # required, one-sentence subhead
category: "Tech"             # required, one of the 6 exactly
postType: "guide"            # article | guide | roundup  (NOT review)
kind: "Comparison"           # optional human label badge
author: "theo"               # required, MUST be an id from the fixed roster (main repo authors.ts)
tags: ["anker", "power bank"]
pubDate: "2026-05-30"        # required
readTime: 9                  # required, integer minutes
cover: "fill-3"              # required, fill-1 … fill-8
featured: false              # optional; at most one featured post site-wide
draft: false                 # optional
---
```

**Rules the assembler enforces:**
- `author` must be an existing id in the main repo's `src/data/authors.ts` (the roster is fixed: `mira`, `theo`, `aiko`, `lina`, `sam`, `beatriz`). Pick the author whose beat matches the category. Do **not** invent authors — unknown id fails the build.
- `cover` is one of `fill-1`…`fill-8` (placeholder gradient; v1 has no per-post hero image — see `docs/future_planning.md` for the R2 image plan when you add real images).
- `slug` = filename (kebab-case, unique). If a file with that slug exists, append a disambiguator or skip (idempotency via `runId`).
- Body `/go/<slug>` links must all have matching keys in `affiliate-links.json`.

**Writes:** sleekdrops-cms's `posts/<slug>.md` and the updated `data/affiliate-links.json`.

**Output:** `brief.file`.

---

## Agent 6 — Editor / QA gate

**Job:** the quality bar that keeps you out of scaled-content-abuse territory. Runs before anything is committed.

**Automated checks:**
- sleekdrops-cms `pnpm validate` passes (mirror of the main repo's content schema + raw-URL ban + slug presence in affiliate JSON).
- Main repo CI (after the content-updated dispatch fires) runs `pnpm build` cleanly — `astro check` + redirects generation + astro build.
- Word-count minimums met for the post type.
- Cons/trade-offs section is non-empty; a winner is named; price claims have a source.
- No banned hype words; no emoji; no paid-placement phrasing; affiliate disclosure present (the layout injects `AffiliateDisclosure` automatically, so this is just a sanity check).
- Duplicate-content check against existing posts (don't republish the same angle).

**Human gate (default):** the run stops here and surfaces the draft for approval. Approve → Agent 7. Reject → discard or send back to the writer with notes.

---

## Agent 7 — Publisher

**Job:** ship it the only way a static site can — via git. All writes go to the **sleekdrops-cms** repo, not the main Astro repo.

```bash
cd sleekdrops-cms
git checkout -b post/<slug>
git add posts/<slug>.md data/affiliate-links.json
git commit -m "Add <postType>: <title>"
git push -u origin post/<slug>
# open PR against main         → sleekdrops-cms CI runs `pnpm validate`
# human reviewer / autonomous gate approves → merge to main
# notify-main.yml fires        → repository_dispatch to DevMahisaur/sleekdrops
# main repo CI runs `pnpm build` → Cloudflare Pages deploys
```

- The main repo's CI runs `pnpm prebuild` (clones sleekdrops-cms via `fetch-content.mjs` → regenerates `_redirects` from the JSON) → `astro check` → `astro build`. If the assembler did its job, this is green.
- For full autonomy later: agent merges PRs directly in sleekdrops-cms after CI passes. Keep the Editor gate either way.

**Amazon agent compliance:** Amazon's Nov 2025 Agent Terms require automated systems that hit Amazon to self-identify in their user-agent (e.g. `SleekDropsBot/1.0`). Set this on any agent that scrapes Amazon for ASIN/price.

---

## Mapping to the Gemini Agent Development Kit (ADK)

ADK (Python/TypeScript, 2.0 GA) natively supports multi-agent systems and gives you two orchestration styles — use both:

- **Workflow (sequential) agent** for the deterministic spine: Trend Scout → Router → Writer → Affiliate Resolver → Assembler → Editor → Publisher. This guarantees a predictable pipeline.
- **Agent-coordinated routing** for the one branch point: the Router dynamically delegates to either the Comparison Writer or the Research Writer (ADK's dynamic routing / sub-agent delegation, or the `adk_a2a` agent-to-agent template).

Practical setup:
- Each agent = one ADK agent with a **narrow system prompt** (the role sections above are your prompts) and only the tools it needs (Trend Scout gets web/Trends/Reddit/Amazon tools; Publisher gets a git/shell tool).
- The **shared brief** is ADK shared session state / memory passed through the workflow.
- Give writer agents grounding/RAG over the research the researcher gathered, so they cite real signals rather than hallucinate.
- Schedule the workflow once daily (cron / Cloud Scheduler) with the category rotation as input.

Docs: ADK — https://google.github.io/adk-docs/ ; Gemini API agents — https://ai.google.dev/gemini-api/docs/agents

---

## Daily run, end to end

1. **06:00** scheduler triggers the workflow with today's category.
2. Trend Scout finds the product + signals.
3. Router picks comparison vs article, sets post type.
4. Writer drafts (≥ length minimum, structured, honest, `/go/` links).
5. Affiliate Resolver builds tagged URLs + slugs, stages the JSON append.
6. Assembler writes the `.md` + updates `affiliate-links.json`; runs schema check.
7. Editor/QA runs automated checks, then surfaces for human approval.
8. Publisher pushes a branch → PR → `develop` (staging) → on approval, `main` (live).

One post per category per day, deep and people-first — not a farm.

---

## Guardrails checklist (encode in prompts + CI)

- [ ] Never fabricate a price; verify against the live merchant page.
- [ ] Never write a raw merchant URL in a post/data file — always `/go/<slug>`.
- [ ] Never invent an author id — use the existing `authors.ts` roster.
- [ ] Never auto-publish a single-product `review` (needs real hands-on testing).
- [ ] Cons column always full; name a winner; cite real signals (E-E-A-T).
- [ ] One excellent post/day over volume (avoid scaled-content-abuse penalties).
- [ ] sleekdrops-cms `pnpm validate` must pass before merge.
- [ ] Human approves PRs in sleekdrops-cms until output is proven.
- [ ] Self-identify the bot's user-agent when accessing Amazon.
