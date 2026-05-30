# Affiliate networks — application requirements & where to apply

A tiered guide to which affiliate networks accept new publishers, what they want to see, and the realistic order to apply in.

---

## Tier 1 — Day-one accessible (zero traffic needed)

Apply to these the day your first 5–10 posts go live.

### Amazon Associates
- **Requirements:** A live website with a privacy policy and a handful of real articles. Approved in minutes.
- **Catch:** You must make **3 qualified sales within your first 180 days** or the account is revoked.
- **Apply at:** [affiliate-program.amazon.com](https://affiliate-program.amazon.com)

### Google AdSense
- **Requirements:** Live site with original content, privacy policy, and a few weeks of activity. No traffic minimum.
- **Apply at:** [google.com/adsense](https://www.google.com/adsense)

---

## Tier 2 — Need a working site with content (1–2 weeks of activity)

### Awin
- **Requirements:** Active site and a stated traffic strategy. Manual site verification by their team.
- **Cost:** $5 deposit at application, refunded with the first commission payout.
- **Apply at:** [awin.com](https://www.awin.com) → "Become a publisher"

### CJ Affiliate
- **Requirements:** Real, original content in a clearly defined niche. Easier than Skimlinks, harder than Amazon.
- **Apply at:** [cj.com](https://www.cj.com)

### Impact.com
- **Requirements:** Quality content in a defined niche. Especially good for premium DTC brands.
- **Apply at:** [impact.com](https://www.impact.com) → "Become a partner"

---

## Tier 3 — Want demonstrated traffic (need 3+ months of growth first)

Apply once you have **5,000+ monthly sessions**. Applying too early gets you rejected, and rejections often have cool-down periods.

### Sovrn Commerce
- **Requirements:** Site that generates real clicks. Brand-new sites face a hurdle.
- **Apply at:** [sovrn.com](https://www.sovrn.com)

### Skimlinks
- **Requirements:** Highly selective — they receive ~1,600 applications a month and approve about 3%. They look for content quality, niche fit, and early traffic signals.
- **Apply at:** [skimlinks.com](https://www.skimlinks.com) → publisher application

---

## Pragmatic application ladder

| Phase                | When                | Apply to                                  |
| -------------------- | ------------------- | ----------------------------------------- |
| Launch (day 1)       | First 5–10 posts live | Amazon Associates, Google AdSense       |
| Week 2–4             | Site is filled out  | Awin, CJ Affiliate, Impact                |
| Month 3+ (5k+ sessions)  | Traffic visible    | Sovrn Commerce, Skimlinks                 |

---

## Key mechanics worth remembering

### Links are tied to platforms, not products
The URL points at a specific product, but the tracking cookie is scoped to the entire merchant. A reader clicks a link to a $20 phone case, browses Amazon for 18 hours, then buys a $1,400 TV — you earn commission on the TV.

### Cookie windows
- **Amazon Associates:** 24 hours, platform-wide. Cart-adds get extended to 90 days for that cart item only. Last-click wins.
- **Awin:** 30-day default, varies per merchant.
- **CJ Affiliate:** typically 30+ days, set per program.
- **Impact:** variable, often multi-touch attribution rather than last-click.
- **Skimlinks:** passes through the underlying merchant's cookie.

### Amazon Product API
The **Product Advertising API (PA-API) was deprecated on April 30, 2026**. Its replacement is the **Creators API**, which requires **10 qualifying sales in the trailing 30 days** to maintain access — a bootstrap problem for new publishers. Until that threshold is hit, build Amazon affiliate URLs manually:

```
https://www.amazon.com/dp/{ASIN}?tag={YOUR_TAG}-20
```

The ASIN is the 10-character product ID visible in any Amazon product URL.

### Amazon AI compliance flags
- The March 2024 Operating Agreement clause restricts use of "Special Links" with generative AI applications (interpreted as real-time AI recommenders rather than AI-written articles).
- The November 2025 Agent Terms require automated systems accessing Amazon to self-identify in their user-agent string (e.g., `SleekDropsBot/1.0`).
