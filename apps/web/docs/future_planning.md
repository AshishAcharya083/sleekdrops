# Future planning — v2+ architecture decisions

The v1 architecture is fully static: markdown in the repo, hero images committed alongside posts, a generated `_redirects` file mapping `/go/[slug]` to merchant URLs. This document captures the engineering work that comes after v1.

---

## Image storage at scale → Cloudflare R2

### When to do it

Move when the repo size from images crosses ~2 GB or when commit times start to feel sluggish (typically around 1,000–2,000 posts with one hero image each).

### How it works

The publishing pipeline writes the image to Cloudflare R2 via the S3 API, gets back a URL, and drops the URL into the markdown frontmatter. The build doesn't need to download or transform anything — it just embeds the R2 URL into the HTML, served via Cloudflare's CDN with on-demand transformations through Cloudflare Images. Slightly more complex setup but bulletproof at scale.

### Implementation sketch

```ts
// In the publish pipeline:
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_KEY_ID, secretAccessKey: R2_SECRET },
});

await r2.send(new PutObjectCommand({
  Bucket: "sleekdrops-images",
  Key: `posts/2026/05/${slug}/hero.jpg`,
  Body: imageBuffer,
  ContentType: "image/jpeg",
}));

const heroUrl = `https://images.sleekdrops.com/posts/2026/05/${slug}/hero.jpg`;
// Append heroUrl to the markdown frontmatter.
```

The build references `heroUrl` directly. No `npm run build` step touches the binary.

### Cost
$0.015/GB/month storage, zero egress to Cloudflare. Cloudflare Images is a flat $5/month plus tiny per-image fees for transformations.

---

## Affiliate link management — the `/go/[slug]` pattern

This pattern is already in v1 (via the generated `_redirects` file). Re-documented here so the publishing agent doesn't deviate from it.

### In the markdown

```markdown
The [Sony WH-1000XM6](/go/sony-wh-1000xm6) outperforms…
```

### In `src/data/affiliate-links.json`

The agent appends an entry:

```json
"sony-wh-1000xm6": {
  "amazon": "https://www.amazon.com/dp/B0DXYZ?tag=yourtag-20",
  "fallback": "https://www.sony.com/headphones/wh-1000xm6"
}
```

### Why this matters

- **One source of truth.** Updating an affiliate URL is a one-line JSON edit, not a grep across thousands of markdown files.
- **No raw merchant URLs in posts.** If a tag changes, a program closes, or you migrate to a different aggregator, no post needs touching.
- **Region routing later.** Expand the JSON entry with country keys (`us`, `gb`, `de`) and the Worker reads `CF-IPCountry` to pick the right destination.
- **Click tracking.** The redirect endpoint can log to KV/D1 before the 302.

---

## Move from build-time _redirects to a Cloudflare Worker

### When

Move when any of the following becomes true:

1. Affiliate URLs change often enough that rebuild latency hurts (e.g., daily price refreshes on the deals page).
2. Region-aware routing is needed (Amazon US vs Amazon UK vs Amazon DE).
3. Click-level analytics are wanted independently of merchant reporting.

### How

A small Cloudflare Worker at `go.sleekdrops.com` (or path-prefixed `/go/*`) reads:

1. Slug from path → look up in Cloudflare KV.
2. Country from `CF-IPCountry` request header → pick the region key (`us`, `gb`, `de`, etc.).
3. Optionally log the click to D1 or Logpush.
4. 302 to the destination with `rel="sponsored nofollow"` already set on the source link.

KV updates happen via the Cloudflare API from the publishing pipeline — no rebuild required.

---

## Hybrid monetization layer

When the site crosses 5,000 monthly sessions, layer in Ezoic. At 25,000+, evaluate Raptive vs. Mediavine (both require display ad exclusivity — pick one).

Hybrid ads + affiliate produces the highest overall RPM, but ads compete with affiliate clicks. Start with one rectangle below the fold and measure CTR impact before adding density.

---

## Migration plan — markdown source from repo → R2 content layer

If the repo grows past 50,000 posts (unlikely in year one), Astro 5's content layer can swap the source from local files to a remote loader. The build fetches markdown from R2 at build time. Output is still fully static; only the source location changes.

No code change in components or pages — `getCollection('blog')` keeps the same interface.

---

## Geo-routing for affiliate revenue (v2)

Adding region routing earns roughly 25–40% more on international traffic, depending on niche. Two paths:

1. **Buy Geniuslink** (~$5–15/month). Drop their script, done. Handles Amazon storefront detection and product matching automatically. 43% commission lift vs. Amazon's free OneLink in published case studies.
2. **DIY Worker + KV.** The infrastructure already exists if v2 ships the Worker for the redirect layer. Add per-region keys in the KV map and route on `CF-IPCountry`.

Geniuslink is the right v2 move. DIY is the right v3 move when click volume justifies retaining the full commission.
