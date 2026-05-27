# SleekDrops

> **Exclusive deals dropping daily.**
> An editorial affiliate blog covering honest product reviews, side-by-side comparisons, daily deals, and promo codes — for tech, home, fashion, health, finance, and travel.

SleekDrops.com is a quietly opinionated publication. Picture a senior product reviewer who's been doing this for ten years and refuses to pretend a $40 gadget is life-changing.

---

## What this project is

The Astro frontend that renders SleekDrops.com. It pairs a small, editorial design system with a content pipeline so the writing — not the chrome — does the work.

Two audiences read this repo:

- **Editorial and operations.** People who add posts, deals, promo codes, and authors. Most of that work happens in `src/content/blog/` and `src/data/`. See "Business rules" below.
- **Engineering.** People who change layouts, add components, or wire new data sources. See **[AGENTS.md](./AGENTS.md)** for the full technical handbook — stack, folder structure, tokens, schemas, commands, and the post-publishing checklist.

---

## Business rules & context

These are the rules behind the product. They predate the code and survive any rewrite of it.

### What we publish

| Type | Use for | Rules |
|---|---|---|
| **Article** | News, trends, educational pieces | No length minimum. |
| **Review** | Single product, in-depth | ≥ 1,200 words. Honest decimal rating (1.0–5.0). 3–5 genuine pros, 2–4 genuine cons. Quick Verdict block at the top. |
| **Guide** | "Best X for Y" buying guides | ≥ 1,500 words. Side-by-side test across ≥ 3 contenders. |
| **Roundup** | Top-N listicles | Scored against a published rubric. |

Categories: **Tech · Home · Fashion · Health · Finance · Travel.**

### Editorial principles (the three we don't break)

1. **No paid placements. Ever.** No sponsorships, no "promoted" posts. Every product is either bought with our own money or borrowed for testing.
2. **If we couldn't test it, we don't review it.** Reviews require at least two weeks of real-world use against the nearest competitor.
3. **The cons column is always full.** Every product has flaws. If we can't think of any, we haven't tested long enough.

### Voice

- **Editorial, not promotional.** Even though every post drives an affiliate click, copy never reads like a sales pitch.
- **Honest by rule.** Decimal ratings (4.3, not 4.5★). Genuine pros and cons.
- **Plain and direct.** Short clauses. Concrete nouns. No "leverage," "unleash," or "revolutionize."
- **Calm urgency for deals.** Deals have real `expiresAt` timestamps — copy says "Ends Friday" not "HURRY!!"
- **No emoji** in editorial copy. The unicode `★` in star ratings is the single exception.

### Deals & affiliate rules

- **Always disclose.** Every page with an affiliate link shows the calm `AffiliateDisclosure` block. Outbound product CTAs carry `rel="sponsored nofollow"`.
- **Never fabricate prices.** Deal data must reflect the merchant's current price; refresh `updatedAt` when prices change.
- **Always set `expiresAt`.** Stale deals fall out of the live list automatically.
- **Code in plain text.** When a promo requires a code, show it as a copyable string — not a hidden reveal.

### Content publishing flow

Content is published daily by a LangGraph multi-agent pipeline. The pipeline POSTs to the shared Python backend API (header `x-site-id: sleekdrops`); the backend stores the content; a Cloudflare Pages deploy webhook rebuilds the site. The current frontend renders from local content collections — when the API is wired in, `src/lib/posts.ts` is the single switch.

---

## For developers

All technical detail — stack, folder structure, token system, content schema, commands, and the "how do I add a post / component / page" checklists — lives in **[AGENTS.md](./AGENTS.md)**. Start there.

Quickstart:

```bash
pnpm install
pnpm dev          # http://localhost:4321
pnpm build        # astro check + production build
```
