# Mediavine readiness and the GA4 outage — September 2026

**Status, 2026-09-28.** AdSense rejected sleekdrops.com for "low-value content". The site is being taken to
**Journey by Mediavine** instead (publishers.mediavine.com/join routes any site under Mediavine's own threshold to
Journey). Journey's minimum is **1,000 sessions from premium countries — the US, Canada, the UK and Australia — in
30 days**, read from a connected GA4 property. GA4 had been reporting nothing since 12 September, so the
application could not qualify on data the site was actually generating. This document records what was wrong,
what this change does about it, what Journey requires that the code now provides, and what is still manual.

The two sources for everything Journey-specific below are Journey's own help centre (journeymv.zendesk.com,
articles last updated August–September 2026) and mediavine.com/mediavine-requirements. Quotes are theirs.

---

## 1. Why GA4 read "No data received"

### What the dashboard showed

- **Last 7 days:** 0 users, 0 sessions, "No data received from your website or app yet".
- **This month:** 38 users / 83 sessions, all before ~12 September, then a flat line.
- **Last 90 days:** 67 users / 175 sessions, with a visible cliff around 12–13 September.
- **Realtime:** one `page_view` and one `session_start` — the owner's own visit, after switching analytics on in
  the footer dialog.

So the property, the data stream and the measurement id were all fine, and the 7-day view was not a filter
artefact. The tag simply stopped firing for ordinary visitors on 12 September.

### Root cause

PR #55, `fix(web): enable develop analytics behind production gate` (commit `c0e2a5f`, merged to `main`
2026-09-12), introduced a per-deployment analytics default in `src/lib/analytics-env.ts`:

```ts
const enabled = deployment === 'preview' && configuredKey !== '';
return { ..., defaultConsent: enabled ? 'granted' : 'denied' };
```

On production `enabled` is always false, so the no-decision default became **denied**. The site's own
`boot()` then applied a denial on every page load, and gtag.js was requested only for a visitor who opened
**Privacy preferences** in the footer and switched analytics on. Nothing warned: the build was green, the
measurement id `G-8B65NZ3BD4` was correctly inlined (verified in the live bundle, `PUBLIC_GA4_ID:"G-8B65NZ3BD4"`,
alongside `defaultConsent: ... "denied"`), and a visit by the owner after opting in produced exactly the one
Realtime hit the screenshot shows.

This reversed the decision PR #37 had made on 6 September ("drop the consent banner; anonymous analytics on by
default, opt-out from the footer"), as a side effect of wiring the DevTeam sink for develop. The AdSense
preparation on 11 and 18 September then documented the denied default as intended ("analytics remains denied
everywhere until the separate SleekDrops analytics opt-in"), which is why nobody caught it.

### The fix

- `defaultConsent` is `granted` on every deployment. Anonymous, aggregate analytics is opt-out again: the site
  is Australian, and the footer dialog and a GPC/DNT signal remain the ways to switch it off. Which sinks a
  build has stays separate (`PUBLIC_GA4_ID`, and the DevTeam key that production still refuses).
- gtag.js declares a Consent Mode v2 default of `analytics_storage: granted` before it loads, and nothing about
  advertising — those signals belong to the ad partner's consent platform (see §3).
- A regression test pins the production default; the preferences dialog and the privacy policy say "on by
  default" again.

### How to confirm it is working after the deploy

1. Open sleekdrops.com in a private window (no stored opt-out), then GA4 → **Reports → Realtime**: the visit
   should appear within a minute, as `session_start` + `page_view`, with the country.
2. **Admin → Data streams → sleekdrops.com** should read "Receiving traffic in past 48 hours" within a day.
3. The **Last 7 days** card on Home stops saying "No data received" once a day of data exists.

If Realtime still shows nothing: check the page source of the deployed site for `googletagmanager.com/gtag/js`
in the hoisted bundle, and check the console for `[analytics] GA4 initialized -> G-8B65NZ3BD4`. A
`[analytics] analytics disabled` line on a fresh profile means the default regressed again.

### Timeline

| Date       | Event                                                                                   |
| ---------- | --------------------------------------------------------------------------------------- |
| 2026-09-06 | PR #37: consent banner removed, analytics on by default with a footer opt-out.          |
| 2026-09-09 | `googleadsready`: editorial trust signals for the AdSense review.                       |
| 2026-09-11 | `fix/google-ads-readiness`: AdSense bootstrap, Google CMP, Consent Mode defaults.        |
| 2026-09-12 | PR #55: production analytics default flips to denied. **GA4 goes dark.**                |
| 2026-09-13 | SLE-64: methodology page, sources block, review stamps, AI-assistance disclosure.       |
| 2026-09-18 | `fix/adsense-regional-consent`: region-scoped CMP defaults; the denied analytics default documented as intended. |
| 2026-09-28 | AdSense rejection ("low-value content"); this change.                                    |

---

## 2. What was removed, and why

Journey **requires exclusivity**: "Anything that requires additional lines added to your ads.txt file violates
exclusivity", and "'Testing' other programmatic ads while running Journey — this includes A/B testing" is listed
as a violation. AdSense cannot coexist with it, so everything AdSense-specific is gone:

| Removed                                                                 | Replaced by                                                   |
| ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| `src/lib/ads.ts` consent-gated loader, `AdUnit.astro`, `ad-placement.ts` and the four placements | Nothing site-side: Mediavine's wrapper places its own units. |
| `GoogleConsent.astro` (publisher tag + Google CMP + region defaults), `google-consent.ts` | `MediavineScript.astro`: one script wrapper in the head.      |
| `google-adsense-account` meta in `SEOHead.astro`                        | —                                                             |
| `generate-ads-txt.mjs` writing a `google.com` seller record             | The same script publishing the file Journey issues (§3).      |
| CSP `script-src` / `frame-src` allowlist of Google ad hosts             | Hygiene-only CSP with `upgrade-insecure-requests` (§3).       |
| AdSense wording in the privacy policy and the ad-free privacy route     | Mediavine's required notice; the wrapper runs on every page.  |
| `ADSENSE_*` GitHub Environment variables                                | `MEDIAVINE_SITE_ID`, optional `ADS_TXT_URL` (production only). |
| The AI-assistance disclosure page, header chip, byline note, author-card line, author-page panel, footer and rail links, llms.txt sentence, how-we-research section (all from the AdSense review, SLE-64) | Removed at the owner's decision; `/ai-disclosure` 301s to `/how-we-research`. See the risk in §5. |

Kept, because they are what makes the content checkable rather than anything AdSense asked for: the numbered
sources block with tiers and dates, the review stamp and re-check cadence, the evidence rail, the claim trail,
the methodology page, the single accountable byline, the honest "no paid placements / not sent products"
statements and the affiliate disclosure beside the links.

The remaining AdSense-era work — the `ADSENSE_CLIENT` and `GA4_MEASUREMENT_ID` variables on the production
GitHub Environment — needs one manual step: **delete the four `ADSENSE_*` variables** (they are now unread) and
leave `GA4_MEASUREMENT_ID=G-8B65NZ3BD4` exactly as it is.

---

## 3. Journey's requirements, and where each one stands

From "Journey Minimum Requirements" and "Journey: From Application to Launch" (both updated August 2026),
"Installing the Journey Script Wrapper on a Custom-Built Site" (27 Aug 2026), "Why Your Content Security Policy
Shouldn't Allowlist Ad Domains" (16 Sep 2026), "Privacy Policy" (20 Aug 2026) and "Why Journey requires
exclusivity".

| Requirement                                                                                     | Status |
| ----------------------------------------------------------------------------------------------- | ------ |
| **≥ 1,000 premium sessions in 30 days** (US, CA, UK, AU)                                        | **Not met.** ~175 sessions in the last 90 days *while GA4 was counting*, and nothing since 12 Sep. GA4 is counting again from this deploy; the 30-day window restarts from there. See §5. |
| **A connected GA4 account** — Journey reads sessions from it                                    | Done: property 272549330 is connected (screenshot). Journey notes its ad server runs on US Eastern time and that a property in another timezone "can skew traffic-dependent data such as RPM"; connecting it as-is is allowed, and a separate Eastern-time property is optional. |
| **Original, brand-safe content; an engaged audience; frequently updated**                       | Editorial. Journey's automatic disqualifiers are "Incompatible CMS (e.g., Wix, Blogspot)", "Extreme brand safety concerns or **excessive use of AI**", and "Under 1,000 premium sessions". |
| **Compatible platform** — custom-built sites are explicitly supported                            | Done. Journey documents custom frameworks; the wrapper goes in the head of every page. |
| **Script wrapper in `<head>` on every page, as issued, not minified**                           | Ready: `MediavineScript.astro` renders it from `MEDIAVINE_SITE_ID` on production only. Attributes `async` / `data-noptimize="1"` / `data-cfasync="false"` preserved. |
| **Ad landmarks for a custom site** — `journey-content` on the direct parent of the article's blocks, `journey-sidebar` on a static sidebar ≥ 300px wide, visible from 1100px up, each once per page | Done on article pages. The rail is now 300px, `position: static`, single-column below 1001px. Listings carry no landmarks; Mediavine decides whether they get units. |
| **Submit the Dashboard Error Form to enable custom-site page-load listeners**                    | Manual, after approval. Then verify with `?test=placeholders` on an article. |
| **ads.txt at the site root, the file Journey issues, kept current**                              | Ready: commit Journey's file at `apps/web/ads/ads.txt` (or set `ADS_TXT_URL`), production-only, validated. Manual: the file itself, once issued. |
| **No other programmatic seller** in ads.txt, no other ad tag                                     | Done: AdSense removed entirely. |
| **Privacy policy linked from the homepage, carrying the "Mediavine Advertising Privacy Notice v. 1.2" verbatim** | Done: `/privacy`, linked in the footer of every page. Manual: enter the policy URL and the "Privacy Notice Location" (footer) in the Journey dashboard. |
| **Consent management** — Journey's CMP shows in the EEA/UK/CH, once per visitor, and links the privacy policy | Provided by the wrapper; nothing site-side. The site's own dialog decides analytics only. |
| **No CSP domain allowlist** — "adding 'just one more domain' every time they do isn't a fix, it's a treadmill" | Done: `public/_headers` keeps the hygiene directives and adds `upgrade-insecure-requests`; script/frame/img/connect sources are any https origin. |
| **HTTPS site-wide, an About page in the navigation, a clear content niche, easy navigation**     | In place. |
| **Identity verification (Stripe) and Terms of Service** at onboarding                            | Manual, in the dashboard. |
| **Google Analytics Consent Mode** — Journey encourages, for EU-based publishers, a denied default with `wait_for_update` that its CMP then grants | Not applied: the publisher is Australian and analytics is opt-out by policy. The tag declares `analytics_storage: granted` and leaves the advertising signals to the CMP. Switch to Journey's snippet only if the site's policy changes. |

### Post-approval runbook

1. Journey dashboard → **Settings → Ad Setup**: copy the `<id>` out of the wrapper URL. Set
   `MEDIAVINE_SITE_ID` on the **production** GitHub Environment (Settings → Environments → production →
   Environment variables). Never as a repository variable.
2. Download the ads.txt file from the same page. Commit it at `apps/web/ads/ads.txt`, merge to `main`, wait for
   the deploy, confirm `https://sleekdrops.com/ads.txt` serves it, then press **I've added the ads.txt file**.
3. Enter `https://sleekdrops.com/privacy` as the privacy policy URL and choose the footer as the Privacy Notice
   Location.
4. Submit the **Dashboard Error Form** asking for custom-site listeners. Open any article with
   `?test=placeholders` in a private window: placeholder units should appear inside the body and in the rail.
   If not, enter `.journey-content` / `.journey-sidebar` under Settings → Ad Settings → Ad Placement Selectors.
5. Complete identity verification and the Terms of Service, then **Launch My Site**.
6. Delete the four `ADSENSE_*` variables from the production environment if not already done.

---

## 4. What Journey says it evaluates, against this site

Journey's own words, from "What are best practices for a website monetized by Journey" (Feb 2026), "Why was my
site rejected?" (Aug 2026) and the Publisher Policies (Jul 2026):

- **Traffic composition.** "An unusually high bounce rate, traffic that's heavily concentrated in a single
  source, a low share of organic traffic, or a weak mix of countries can all affect your approval." Search
  Console shows 2.05k impressions / 16 clicks in 28 days: organic exists but is small. Diversifying sources
  (email, Pinterest, Facebook — all named by Journey as monetising well) is the lever they point at.
- **Original content, not aggregated.** "Steer clear of creating a website that is entirely focused on
  'round-up' posts or aggregated content." Under *Templated, Made For Advertising, or Low-Value Content* they
  give the example: "A website where most of the content is structured as a list, even if extra text is added
  relating to each item (Listicle)." Roundups are this site's dominant format; the structure-library work
  (SLE-59) and the reviewer (SLE-61) push against templating, but a corpus that is mostly "best X for
  Australia" lists is the shape they name.
- **Posting cadence.** "Posting too often can be an indication of overuse of AI or content that is not
  original." The pipeline's publish rate is a signal they read.
- **Content length and shape.** 500–800 words minimum as a rule of thumb, short paragraphs, 18–21px body
  text with ~1.6 line height, content column 728–1024px wide, images that are original or licensed (they say
  they check attribution). The site's 18px / 1.75 body and the reading measure already fit.
- **About page.** Journey wants a photo and introduction of the author(s), why the site started, why the reader
  should trust it, a location and contact routes. The current page names one accountable editorial byline and
  the contact addresses; it has no person, no photo and no origin story, and nothing here invents one.
- **Session duration and pages per session** are read as engagement.

---

## 5. Risks the owner should weigh before merging to `main`

1. **The AI policy, stated plainly.** Journey lists "excessive use of AI" as an *automatic* disqualifier, says
   "content that raises significant AI concerns" can be rejected "without the option to reapply", and Mediavine's
   creator-first statement reads: "We do not monetize low-quality, mass-produced, unedited or **undisclosed** AI
   content", with "faster, automated tools to help us identify low-quality, mass-produced AI content" and
   third-party detection already used to terminate accounts. Every SleekDrops article is produced by an AI
   pipeline. Removing the disclosure (§2, last row) does not change how the content reads to a detector; it
   changes which of Mediavine's categories the site would fall into if it is detected. That is the owner's
   call and it was made knowingly; it is recorded here so the trade-off is visible later. The removal is one
   commit and reverts cleanly on its own.
2. **Sessions.** The last 90 days of counted data are ~175 sessions total. Even with GA4 counting every visit
   again, 1,000 premium sessions in 30 days is roughly a five-fold increase on what the site has ever recorded.
   Journey's reapply countdown after a rejection is 60 days.
3. **The listicle shape** of the corpus, and the posting cadence, are both named by Journey as signals they
   read against a site.
4. **Sidebar change.** The article rail no longer sticks; the jump list scrolls with the page. This is what the
   partner's sticky sidebar unit requires (a static container) and is the standard shape of an ad-supported
   article page, but it is a visible change to the reading experience.
5. **CSP is now permissive for scripts.** By the partner's design. `object-src 'none'`, `base-uri` and
   `frame-ancestors` still hold; `script-src` no longer limits where code can be loaded from.

---

## 6. What this change was verified against

- `pnpm --filter @sleekdrops/web test`: 468 pass (ads, ad-placement and Google-consent suites removed; a
  Consent Mode ordering test and a production-default regression test added).
- `astro check`: 0 errors.
- A full `astro build` from the 30 live posts with `PUBLIC_SITE_ENV=production`, `PUBLIC_GA4_ID` and a test
  `PUBLIC_MEDIAVINE_SITE_ID`: 203 pages; the wrapper tag present as issued in every head; `journey-content`
  and `journey-sidebar` once each on article pages and absent elsewhere; no `adsbygoogle`, `adsense` or
  `ai-disclosure` anywhere in the output except the `_redirects` line; `ads.txt` published from a test source
  and removed again on a preview build; `G-8B65NZ3BD4`-shaped id and `consent default analytics_storage
  granted` in the hoisted bundle; the Mediavine notice on `/privacy`.
