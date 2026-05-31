# SleekDrops

> **Exclusive deals dropping daily.**
> An editorial affiliate blog covering honest product reviews, side-by-side comparisons, daily deals, and promo codes — for tech, home, fashion, health, finance, and travel.

SleekDrops.com is a quietly opinionated publication. Picture a senior product reviewer who's been doing this for ten years and refuses to pretend a $40 gadget is life-changing.

---

## What this project is

The Astro frontend that renders SleekDrops.com. Editorial content lives in a separate repo, [sleekdrops-cms](https://github.com/DevMahisaur/sleekdrops-cms), which is cloned at build time. This repo holds the framework, components, layouts, and structural data (authors, categories, deals, promos).

Two audiences read this codebase:

- **Editorial / content agents.** You don't work here — you work in [sleekdrops-cms](https://github.com/DevMahisaur/sleekdrops-cms). Start with its `AGENTS.md`.
- **Engineering.** Layouts, components, build pipeline, design tokens. Start with **[AGENTS.md](./AGENTS.md)**.

---

## Business rules & context

These rules survive any rewrite of the code.

### What we publish

| Type | Use for | Rules |
|---|---|---|
| **Article** | News, trends, educational pieces | No length minimum. |
| **Review** | Single product, in-depth | ≥ 1,200 words. Honest decimal rating (1.0–5.0). 3–5 pros, 2–4 cons. Quick Verdict block at the top. Structured product data embedded in frontmatter. |
| **Guide** | "Best X for Y" buying guides | ≥ 1,500 words. Side-by-side test across ≥ 3 contenders. |
| **Roundup** | Top-N listicles | Scored against a published rubric. |

Categories: **Tech · Home · Fashion · Health · Finance · Travel.**

### Editorial principles (the three we don't break)

1. **No paid placements. Ever.** No sponsorships, no "promoted" posts.
2. **If we couldn't test it, we don't review it.** Reviews require ≥2 weeks of real-world use. The autonomous pipeline writes articles, guides, and roundups only — true reviews stay human-driven.
3. **The cons column is always full.** Every product has flaws. If we can't think of any, we haven't tested long enough.

### Voice

- **Editorial, not promotional.** Copy never reads like a sales pitch.
- **Honest by rule.** Decimal ratings (4.3, not 4.5★).
- **Plain and direct.** Short clauses. Concrete nouns.
- **Calm urgency for deals.** "Ends Friday," not "HURRY!!"
- **No emoji** in editorial copy (★ in star ratings is the single exception).

### Deals & affiliate rules

- **Always disclose.** Every page with an affiliate link shows `AffiliateDisclosure`. Outbound CTAs carry `rel="sponsored nofollow"`.
- **Never fabricate prices.** Refresh `updatedAt` when prices change.
- **Always set `expiresAt`.** Stale deals fall out of the live list automatically.
- **All affiliate destinations** go through `/go/<slug>` — the slug-to-URL map lives in [sleekdrops-cms/data/affiliate-links.json](https://github.com/DevMahisaur/sleekdrops-cms/blob/main/data/affiliate-links.json).

### Content publishing flow

Editorial content lives in **sleekdrops-cms**. A push to its `main` branch dispatches a `content-updated` event to this repo, which triggers a Cloudflare Pages rebuild. The build clones sleekdrops-cms, copies posts into `src/content/blog/`, regenerates `public/_redirects` from the affiliate JSON, and ships. End-to-end: ~90 seconds.

---

## For developers

All technical detail — stack, folder structure, content fetch pipeline, token system, schemas, commands — lives in **[AGENTS.md](./AGENTS.md)**.

Quickstart:

```bash
pnpm install
pnpm dev          # fetches content from sleekdrops-cms, then http://localhost:4321
pnpm build        # full production build
```
