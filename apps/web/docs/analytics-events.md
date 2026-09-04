# Analytics event taxonomy

This is the canonical reference for the analytics events SleekDrops emits (to DevTeam Analytics and GA4).
It defines every event name, its properties, and the screen that owns it.

Keep this doc and the code in sync.
Event names live as constants in [`src/lib/analytics.ts`](../src/lib/analytics.ts) (the `EVENTS` map); changing a name means changing it in both places.

The agent-platform admin panel reports into the **same** DevTeam project and extends this vocabulary rather than starting a second one.
Its events, its `X-Trace-Id` correlation contract with the agent API, and its own scrub live in [`apps/admin/docs/analytics-events.md`](../../admin/docs/analytics-events.md).
Names there follow the Title Case convention used here, so the Analytics tab reads as one taxonomy; nothing in this document applies to the panel, which has no consent banner and no GA4.

## How tracking is wired

All tracking goes through the single wrapper in [`src/lib/analytics.ts`](../src/lib/analytics.ts) - no component calls the DevTeam Analytics or GA4 SDKs directly.
Events are declared in the DOM and dispatched by [`src/scripts/chrome.ts`](../src/scripts/chrome.ts), matching the rest of that file's declarative style:

- **Page views** - a page sets `screen` (and optional `pageProps`) on `BaseLayout`, which serialises them onto `<body data-page-view="...">`.
  `chrome.ts` reads that payload on load and fires `Page Viewed` through `trackPageView()`, which stamps the normalized path and holds the one-per-document guard.
- **Funnel clicks** - an element carries `data-track="<Event Name>"` and an optional JSON `data-track-props`.
  `chrome.ts` fires the event synchronously on click, before the browser follows the link.
  The attribute value is the one event name that reaches `track()` as a runtime string, so the dispatcher checks it against the `EVENTS` values first and drops an unknown name with a single `serverLog('warn', ...)` line instead of sending it.
- **List views** - a rendered deal or promo list carries the whole payload as JSON on `data-list-view` (built by [`src/lib/listing.ts`](../src/lib/listing.ts)) and `chrome.ts` fires `Listing Viewed` for it on load.
  The event name stays in code here rather than in the attribute, because nothing about a list view arrives as a runtime string.
  One event per rendered list, never one per card.
- **Outbound clicks** - when the dispatched event is `Affiliate Link Clicked`, `chrome.ts` mints a click id, puts it on the event, and rewrites the anchor's `/go/<slug>` href with it, this session's trace id, the placement and the position before the browser follows the link.
  The rules live in the pure [`src/lib/outbound.ts`](../src/lib/outbound.ts); the Function on the other end reads them back with [`functions/_lib/click.mjs`](../functions/_lib/click.mjs).
- **Server-side redirects** - [`functions/_lib/redirect.mjs`](../functions/_lib/redirect.mjs), behind the `/go/<slug>` Pages Function, posts `Affiliate Redirect Served` straight to the DevTeam ingest endpoints.
  It is the only event on this site that does not go through `src/lib/analytics.ts`, because it is emitted by a Worker rather than by a browser.
- **Read completion** - `ArticleBody.astro` ends with a `[data-read-sentinel]`; `chrome.ts` watches it with an `IntersectionObserver` and an active-time stopwatch, and fires `Article Read` once when both halves of the gate hold ([`src/lib/read-completion.ts`](../src/lib/read-completion.ts)).
- **Newsletter signups** - not currently emitted. There is no mailing list behind the site yet, so the newsletter band and the footer subscribe block carry no form at all; firing a conversion for a submission that stores nothing would report a signup that never happened. The event stays in the taxonomy for the capture that replaces them.
- **Chrome UI interactions** - the dark-mode toggle, share button, copy-link button, copy-code button, image lightbox, and TOC nav links already have dedicated event listeners in `chrome.ts` for their own behaviour; each fires its analytics event directly from that handler rather than through a `data-track` attribute.
- **Experiment copy** - an element carries `data-experiment-copy="<feature key>"`; its default copy renders in the static HTML and `chrome.ts` swaps it in place once the flag payload resolves, rewriting the enclosing `data-track` element's `cta` prop so the funnel event reports the label the visitor actually saw.
- **Experiment nav items** - a primary-nav anchor carries `data-experiment-nav-item="<feature key>"`; the item renders in the static HTML for every visitor and `chrome.ts` removes it from the DOM once a boolean flag resolves true, restoring it in its original slot if the value flips back.
  The decision layer is the pure [`src/lib/nav-experiment.ts`](../src/lib/nav-experiment.ts), which also owns the rule that the flag is read **only** while the primary nav is displayed (wider than the `(max-width: 900px)` breakpoint that hides `.site-nav`) - reading a feature is what buckets a visitor, so a narrow-viewport read would count an exposure for a treatment that visitor can never see.

DevTeam Analytics is initialised with `sendBeacon` transport so a click event still reaches the server when the click immediately navigates the page away.

### The taxonomy is enforced, not just documented

"Keep this doc and the code in sync" is a build failure rather than a convention.
Two mechanisms hold it:

- **Compile time** - `track()` takes the taxonomy union (`EventName` plus the two platform events `$experiment_viewed` and `$client_error`), not `string`, so a call site cannot name an event that has no constant in the `EVENTS` map.
- **Test time** - [`src/lib/taxonomy.test.ts`](../src/lib/taxonomy.test.ts) runs in the normal `npm test` pass and fails on three kinds of drift: an `EVENTS` constant with no `### <Event Name>` section in this document, an event documented here with no constant (the platform events and the two state properties below are exempted by exact name), and any `data-track` / `data={{ track: ... }}` dispatch site in a `.astro` file that hardcodes the event-name string instead of interpolating an `EVENTS.*` reference.

Together with the dispatcher's runtime check they close every path an unnamed event could take to the analytics platform, so an event arriving in production that is absent from this document means a stale deployed bundle or an out-of-repo script - never a source-side omission.

A/B testing follows the same chokepoint discipline: [`src/lib/experiments.ts`](../src/lib/experiments.ts) is the only module that touches the GrowthBook SDK, it is started only from the consent-grant path and stopped from the withdrawal path, and every feature read falls back to the caller's code-side default.
The flag payload is treated as data, never as code: it is read over `https` only (a plaintext host on a secure page is refused with one warning), and GrowthBook's auto-experiments — DOM mutations, JS injection and URL redirects — are disabled, so a flag can change only a value the site itself asked for.

## No identity

`analytics.identify()` and `analytics.reset()` are deliberately **not** called anywhere in this app, and their absence is a decision rather than an omission.
The public website has no accounts, no login and no session restore, so there is no user id to identify a visitor by and nothing for a logout to reset.
The only identifiers on an event are the SDK's own device-scoped distinct id and the two random ids this site mints (`event_id`, `visit_id`), all of which are cleared on a decline or a withdrawal.

The admin panel does hold an operator token and reports into the same DevTeam project; its identity handling is documented in [`apps/admin/docs/analytics-events.md`](../../admin/docs/analytics-events.md) and nothing here applies to it.

## No PII

Properties carry only non-identifying context (screen names, deal slugs, brands, CTA labels).
No email addresses, names, or other personal data are tracked here.
Consent and PII enforcement are handled separately by the consent/PII gate.

## Events

### Page Viewed

Fired **exactly once per document per path**, on every route the site serves.
The deal-detail and promo-detail page views double as the "detail viewed" funnel step (they carry the `slug` and `brand`).

"Exactly once" is a guarantee, not a convention: `chrome.ts` dispatches through `trackPageView()` in [`src/lib/analytics.ts`](../src/lib/analytics.ts), which claims a document-scoped key of `Page Viewed` plus the normalized path and drops any repeat.
So a second script entry point reaching the dispatch, a bfcache restore or a re-run of the dispatch path cannot report a second view, while a same-document navigation to a different path still can.
`path` is stamped by the dispatcher itself, normalized (`trailingSlash: 'never'`, so `/deals/foo/` and `/deals/foo` are one page) and applied last, so no call site can override it with the raw location and a redirected entry URL cannot split the count across two spellings.

| Property | Type | Notes |
|---|---|---|
| `path` | string | The normalized path, stamped by the dispatcher. |
| `referrer` | string | Reduced to path by `scrub()`, and empty on a direct visit. |
| `screen` | string | The screen name. Every route the site serves declares one - see the table below. |
| `category` | string | Category slug. Present on `blog-post`, `deal-detail`, `promo-detail` and `category-listing`. |
| `slug` | string | Post, deal, promo, tag or author slug. Present on `blog-post`, `deal-detail`, `promo-detail`, `tag-listing` and `author`. |
| `brand` | string | Deal or promo brand. Present on `deal-detail` and `promo-detail`. |

Every page under `src/pages` passes a `screen`, so no `Page Viewed` arrives unnamed:

| Screen | Route |
|---|---|
| `home` | `/` |
| `blog-listing` | `/blog`, `/blog/<n>` |
| `blog-post` | `/blog/<slug>` |
| `deals-listing` | `/deals` |
| `deal-detail` | `/deals/<slug>` |
| `promos-listing` | `/promos` |
| `promo-detail` | `/promos/<slug>` |
| `categories` | `/categories` |
| `category-listing` | `/category/<slug>`, `/category/<slug>/<n>` |
| `tag-listing` | `/tag/<tag>`, `/tag/<tag>/<n>` |
| `author` | `/author/<id>` |
| `guides-listing` | `/guides`, `/guides/<n>` |
| `reviews-listing` | `/reviews`, `/reviews/<n>` |
| `about` | `/about` |
| `contact` | `/contact` |
| `privacy` | `/privacy` |
| `disclaimer` | `/disclaimer` |
| `not-found` | the 404 page |

The five names in use before this pass (`home`, `blog-listing`, `blog-post`, `deals-listing`, `deal-detail`) are unchanged, so their history is continuous.

### Hero CTA Clicked

A click on a primary call-to-action in the homepage hero.

| Property | Type | Notes |
|---|---|---|
| `cta` | string | The button label, e.g. `Read the latest`. Always the label as rendered, so a variant of the `hero_cta_copy` experiment reports its own copy. |
| `href` | string | The link target. |

Owning screen: homepage (`Hero` section of `src/pages/index.astro`).

### Listing Viewed

One event per **rendered list** of deal or promo cards - never one per card.

Impressions are the highest-volume signal on a deals site, so the per-list shape is what keeps the event volume proportionate to the pages rendered rather than to the cards on them.
It is the denominator of click-through rate per card and per slot position: divide the `Deal Card Clicked` / `Promo Card Clicked` rows sharing a `list_id` by the `count` this event reports.

Pagination and load-more ride here as properties rather than as an event stream of their own, so "do people go past page 1" is answerable without a second noisy stream.
Neither listing is paginated today, so `page` is `1` and `batch` is `0` on every row.

An empty listing still reports, with `count: 0` - a visitor shown an empty deals page is a fact worth having, and on a site whose deal and promo tables are currently empty it is the only fact these two screens have.
The homepage module is the exception: it is omitted from the page entirely when there is nothing to show, so no list was rendered and none is reported.

| Property | Type | Notes |
|---|---|---|
| `list_id` | string | `home-deals`, `deals-index`, or `promos-index`. Closed set in [`src/lib/listing.ts`](../src/lib/listing.ts). |
| `count` | number | Cards actually rendered in this list. |
| `page` | number | 1-based listing page number. |
| `batch` | number | 0-based index of the lazily-loaded batch. |

Owning screens: `home` (`home-deals`), `deals-listing` (`deals-index`), `promos-listing` (`promos-index`).

### Deal Card Clicked

A click on a deal tile that enters the deal funnel by navigating to a deal-detail page.

| Property | Type | Notes |
|---|---|---|
| `slug` | string | Deal slug. |
| `brand` | string | Deal brand. |
| `placement` | string | `deal-card` for a grid tile, `drop-panel` for the hero drop card. |
| `position` | number | Zero-based slot in the rendered list. Absent for `drop-panel`, which is not a list. |
| `list_id` | string | The `list_id` of the `Listing Viewed` event for the same list. Absent for `drop-panel`. |

Owning components: `DealCard.astro`, `DropPanel.astro` (homepage and deals listing).

### Promo Card Clicked

The promo half of `Deal Card Clicked`: a click on a promo tile that navigates to a promo-detail page.

Kept as its own name rather than folded into `Deal Card Clicked` because the two surfaces convert differently - a promo click carries a code to a checkout, a deal click carries a price - and a blended card-click rate would hide which of them is worth the slot.

| Property | Type | Notes |
|---|---|---|
| `slug` | string | Promo slug. |
| `brand` | string | Promo brand. |
| `placement` | string | Always `promo-card`. |
| `position` | number | Zero-based slot in the rendered list. |
| `list_id` | string | Always `promos-index` today. |

Owning component: `PromoCard.astro` (promos listing).

### Promo Code Copied

The copy-to-clipboard control on the code shown on a promo-detail page.

It is the one step the promo funnel had no signal for at all: between the page view and the click-out, the visitor has to take the code with them, and a code they never copied is a click-out that will not convert.
Fires on click, before the clipboard write - so it captures the intent even where the clipboard API is unavailable and the visitor copies out of the fallback prompt.

| Property | Type | Notes |
|---|---|---|
| `slug` | string | Promo slug. |
| `brand` | string | Promo brand. |

Owning component: `chrome.ts` (`[data-copy-code]` handler), on `promos/[slug].astro`.

### Affiliate Link Clicked

A click on an outbound affiliate "View deal" / "View price" button, as the **browser** saw it.
Fires before the `/go/<slug>` (or direct merchant) navigation, and carries the page context the server never sees.

This is the rich, lossy half of the click. It is dropped by ad blockers and can lose the race with the navigation, so the number reported as the primary conversion is `Affiliate Redirect Served` below; the two join on `click_id`.

| Property | Type | Notes |
|---|---|---|
| `slug` | string | Affiliate slug (post slug or deal slug). |
| `brand` | string | Product / deal brand. |
| `retailer` | string | Merchant name. Present for the in-article product callout. |
| `placement` | string | `deal-detail`, `verdict`, `product-callout`, or `promo-detail`. |
| `position` | number | Zero-based slot, when the link sits in a list. |
| `list_id` | string | The list the link sat in, when it sat in one. |
| `click_id` | string | The per-click join key minted here and appended to the `/go` URL. Present only for a `/go/<slug>` link - a link straight to a merchant is left exactly as the editorial row wrote it. |

Owning components: `deals/[slug].astro`, `promos/[slug].astro`, `Verdict.astro`, `ProductCallout.astro`.

### Affiliate Redirect Served

**The primary conversion**, counted server-side by the `/go/<slug>` Pages Function once a destination has actually been resolved.

Server-side because the publisher owns nothing after the click and every affiliate network defines publisher performance with clicks as the denominator (EPC = commissions / clicks; network conversion rate = orders / clicks).
A count taken on the anchor is lost to ad blockers and to the unload race; a redirect the edge actually served is not.
Emitted for successfully resolved redirects only - an unknown slug or an unresolvable destination produces an error-level log and no event, so the count is never inflated by 404s.

It is a **different name** from `Affiliate Link Clicked` on purpose: one says a visitor clicked, the other says the redirect was served, and emitting one name for both would make the ad-block gap invisible. Join them on `click_id`.

The same `click_id` is threaded into the affiliate network's sub-id slot by [`functions/_lib/affiliates.mjs`](../functions/_lib/affiliates.mjs) - Amazon `ascsubtag`, Awin `clickref`, Commission Factory `UniqueId` - which is what makes a sale reported by the network 24-72 hours later joinable back to the deal, page, placement and position that earned it.
Networks with no sub-id slot, and rows falling back to the direct builder, resolve exactly as they did before.

| Property | Type | Notes |
|---|---|---|
| `slug` | string | Affiliate slug from the route. |
| `network` | string | The builder that produced the destination: `amazon`, `awin`, `commissionfactory`, `direct`. |
| `region` | string | The storefront region the visitor's country resolved to (`us`, `au`, ...). Never the country itself. |
| `placement` | string | From the query string, when the browser supplied one. |
| `position` | number | From the query string, when the browser supplied one. |
| `click_id` | string | The per-click join key. Supplied by the browser, or minted here for a `/go` link followed without one. |
| `trace_id` | string | The client session's trace id when supplied, else derived from the click id. |

Emitting surfaces: every `/go/<slug>` request, wherever the link was rendered - the in-article `Verdict` and `ProductCallout` buttons (which always build `/go/<post slug>`), the deal-detail and promo-detail CTAs whenever the editorial row's `href` is a `/go` link, and any `/go` link written directly into markdown.
A row whose `href` points straight at a merchant bypasses the redirect entirely: it still reports `Affiliate Link Clicked` from the browser, but with no `click_id` and no server-side row, because there is no request of ours to count.

No cookie, IP, user agent, device identifier or visitor identifier is sent with it.
`distinct_id` on the wire is the constant `go-redirect`, naming the surface rather than a person, and `session_id` is the per-click random click id.
The ingest key and host come from `context.env` (Pages *runtime* variables, uploaded by the deploy workflows) and never from a literal in the repo; an empty or missing key disables the sink silently and the 302 is served unchanged.
Delivery is handed to `context.waitUntil` after the Response is built and cannot reject, so a slow or broken ingest host cannot change the redirect's status, its `Location` header or its latency.

### Article Read

One read-completion event per article page view, emitted when the reader crosses the sentinel at the end of the article body **and** has accrued at least 30 seconds of active time.

Active time pauses while the tab is hidden, which is what separates reading from a tab left open.
Both halves are required: a short page is fully scrolled the moment it loads, and time alone counts background tabs.

There is deliberately **no** 25/50/75/90 scroll-depth ladder.
That is four events per page view measuring page length rather than reader interest, and this single event supersedes it.

| Property | Type | Notes |
|---|---|---|
| `screen` | string | Always `blog-post` today - `ArticleBody.astro` is used only there. |
| `slug` | string | Post slug, from the page-view payload. |
| `active_time` | string | Bucketed: `0-15s`, `15-60s`, `60s+`. Never raw milliseconds - a millisecond count is unique per page view and unusable as a dimension. The 30-second gate means only the upper two buckets can appear on this event. |

Owning component: `chrome.ts` (`[data-read-sentinel]` observer), on `blog/[slug].astro`.

### Newsletter Signup

Secondary conversion: a newsletter sign-up attempt (form submit).

**Not emitted today.** No mailing list exists, so no page renders a signup form
and nothing fires this event. Reserved for the notify-me capture that replaces
the placeholder bands.

| Property | Type | Notes |
|---|---|---|
| `screen` | string | The screen the signup happened on, when known. |

Owning components: none yet - `Newsletter.astro` and `Footer.astro` once the capture ships.

### Theme Toggled

The dark/light mode switch in the site chrome.

| Property | Type | Notes |
|---|---|---|
| `theme` | string | The mode switched to: `dark` or `light`. |

Owning component: `chrome.ts` (`[data-theme-toggle]` handler).

This event is the *switch rate* half of theme measurement - who changes mode, and who changes back.
The *population share* half is the [`theme` state property](#theme-state-property) stamped on every event, which is what answers "how many visitors read the site in dark mode"; read the two together.
The handler sets the `data-theme` attribute before it tracks, so this event's own `theme` property and the stamp on it always agree.

### Share Clicked

The share button (Web Share API, with clipboard/prompt fallback).

| Property | Type | Notes |
|---|---|---|
| `screen` | string | The screen the share happened on, when known. |

Fires on click, before the share sheet opens or the fallback runs - so it captures share intent even if the visitor cancels the native share dialog.

Owning component: `chrome.ts` (`[data-share]` handler).

### Copy Link Clicked

The copy-link button (clipboard write, with a `window.prompt` fallback).

| Property | Type | Notes |
|---|---|---|
| `screen` | string | The screen the click happened on, when known. |

Fires on click; the clipboard write itself can still fail (permissions, browser support) without affecting this event.

Owning component: `chrome.ts` (`[data-copy-link]` handler).

### Image Lightbox Opened

The hero-image lightbox overlay.

| Property | Type | Notes |
|---|---|---|
| `screen` | string | The screen the lightbox was opened on, when known. |

Owning component: `chrome.ts` (`[data-lightbox]` handler).

### TOC Link Clicked

A click on an in-article table-of-contents link.

| Property | Type | Notes |
|---|---|---|
| `section` | string | The clicked link's visible text (falls back to its `href`). |

Owning component: `chrome.ts` (`[data-toc] a` handler).

### $experiment_viewed

Platform event: the visitor was bucketed into a running experiment.
It is what the DevTeam **A/B Testing** tab measures a result on, so its name and properties are a contract with the platform rather than part of the Title Case product taxonomy above - like `$client_error`.

Emitted by GrowthBook's `trackingCallback` (see [`src/lib/experiments.ts`](../src/lib/experiments.ts)) through the same consent-gated `track()` pipeline as every other event, so it is buffered before a choice, dropped on a decline, and never fires under GPC/DNT.
Fires once per experiment, at the moment a feature covered by an experiment rule is first evaluated.

| Property | Type | Notes |
|---|---|---|
| `experiment_key` | string | The experiment's key, as minted in the A/B Testing tab. |
| `variant_key` | string | The assigned variation's key (`0`, `1`, ... unless the experiment names them). |

Bucketing uses `attributes.id` = the DevTeam analytics SDK's own distinct id, so exposure and conversion join on the same key.

### $client_error

Platform event: a runtime failure in the browser, with a stack trace.
Its name and its diagnostic properties are a contract with the platform rather than part of the Title Case product taxonomy - like `$experiment_viewed`.

Two sources feed it, both through the same pipeline:

- **Uncaught** - the `window` `error` and `unhandledrejection` listeners registered by `initErrorCapture()`.
- **Handled** - `captureError(error, attributes)` in [`src/lib/analytics.ts`](../src/lib/analytics.ts), called from every catch block that would otherwise swallow a user-visible failure: the Web Share and clipboard fallbacks, the image lightbox and the theme write in `chrome.ts`, the flag payload fetch, refresh and apply in `experiments.ts`, the ad partner loader in `ads.ts`, and the consent storage write in `analytics.ts` itself.

Catches that are *not* wired to it are the ones where nothing was lost: a storage read that already degrades to "no decision on file", a JSON parse with a defined fallback, and the reporter's own guard - which has to stay silent, since it is what keeps a reporting failure from reaching the visitor.

Both route through the consent gate (nothing is sent, stored or logged before the visitor opts in), the dedupe window (an identical signature reports at most once per 10 seconds, so a fault in a tight loop cannot flood the endpoint) and the `scrub()` chokepoint.
Each report also emits an **error-level log** carrying the session's trace id, so the failure is findable in the platform's Logs view beside the lines around it rather than only as an event.
A reporting failure is swallowed: it can never surface to the visitor or break rendering.

| Property | Type | Notes |
|---|---|---|
| `message` | string | URLs reduced to path, emails redacted. |
| `stack` | string | Truncated to 2000 characters. Same scrub as `message`. |
| `source` | string | Script filename, for an uncaught error. |
| `lineno` / `colno` | number | Location, for an uncaught error. |
| `handled` | boolean | `true` for a `captureError()` report, `false` for an unhandled rejection. |
| `feature` | string | The operation that failed, for a handled report: `web-share`, `clipboard`, `lightbox`, `theme-storage`, `ads-loader`, `consent-storage`, `experiments-payload`, `experiments-refresh`, `experiments-init`, `experiments-read`, `experiments-apply`. |

A share sheet the visitor dismisses rejects with `AbortError` and is **not** reported: it is a choice, not a fault, and reporting it would bury the real failures under it.

The `/go` Pages Function has no `captureError` of its own - it is not a browser and has no consent gate to route through - and reports its failures as error-level logs with a `stack` attribute instead. See `Affiliate Redirect Served` above.

### `$exp_<experimentKey>` (sticky property)

Once a variant is assigned, `$exp_<experimentKey>` = `<variantKey>` is stamped onto **every** subsequent event and log at the `send()` / `serverLog()` chokepoint in [`src/lib/analytics.ts`](../src/lib/analytics.ts) - the DevTeam SDK v0.2.0 has no global-properties API.
That is what lets a conversion (`Affiliate Link Clicked`, `Deal Card Clicked`, ...) be attributed to a variant without any call site knowing an experiment exists.

The stamps persist in local storage under `sd-exp`, because this is a multi-page static site: a visitor is bucketed on the page that reads the feature and converts on a later page that never does.
They are written only after consent and deleted on a decline or a withdrawal - and a withdrawal also takes the SDK that writes them down (`stop()`), because clearing the stamps while a live GrowthBook instance is still subscribed to the flag host only means the next feature read buckets the visitor again and writes a new one.

Experiment keys are minted in the A/B Testing tab rather than declared in code, so [`src/lib/pii.ts`](../src/lib/pii.ts) allows them through `scrub()` by **shape** — `$exp_` plus up to 64 characters of `[A-Za-z0-9_-]`, carrying a variant key of at most 64 characters; `experiment_key` and `variant_key` are allowlisted by name.
Without those three rules the strict allowlist would silently drop every experiment dimension and each experiment would read 0% forever.
The shape is deliberately narrow, and at most 32 stamps are retained: both halves come from the flag payload rather than from code, so a bare prefix rule would let anything authored in the A/B Testing tab reach the sink under a name no allowlist review ever saw.

### `theme` (state property)

`theme` = `dark` or `light` is stamped onto **every** outgoing event and log at the `send()` / `serverLog()` chokepoint in [`src/lib/analytics.ts`](../src/lib/analytics.ts), alongside the sticky `$exp_*` stamps and for the same reason - the DevTeam SDK v0.2.0 has no global-properties API.

It is state, not a step: `Theme Toggled` fires only for the minority who touch the switch, so it can report a switch rate but structurally cannot report what share of visitors are in dark mode, and no other metric can be broken down by theme.
The stamp supplies that denominator and lets any funnel step be split by mode.

The value is read at send time from the `data-theme` attribute on `<html>`, which the inline boot script in `SEOHead.astro` restores from `sd-theme` before first paint and `toggleTheme` maintains thereafter; no attribute means the `light` default.
There is deliberately no new storage key, no `identify()` call and no `system` third value - the attribute is the only theme state the site has, and a static marketing site with no accounts has no user record to persist a preference to.

Being merged in at the chokepoint, it inherits the consent gate, the pre-consent buffer and the `scrub()` pass exactly as event properties do: nothing is stamped before the visitor opts in, and `theme` is allowlisted by name in [`src/lib/pii.ts`](../src/lib/pii.ts).
A call site that carries its own `theme` property wins over the stamp, which is what keeps `Theme Toggled` reporting the mode it switched **to** even if a buffered event flushes later.

### `event_id` (state property)

A UUID v4 on **every** outgoing event: the per-event idempotency key the analytics platform can collapse duplicates on.

It is minted in `track()` at the moment the call is made — not at send time — so an event held in the pre-consent buffer keeps the id it was created with.
That is what makes it useful: if the same payload reaches the platform twice, both copies carry one id.
Two paths in the SDK can do that, and neither is visible from this repo's source: it persists its unflushed queue to `localStorage` and restores it into the next page load's client, and a batch whose response is lost (a `keepalive` flush on pagehide) is requeued and re-sent verbatim.

Dedup on `(site, event_id)` with a 24-hour look-back is the platform's half of the contract and is **not** implemented in this repository (the ingest server is the external DevTeam Analytics platform).
The client's half is done: every event carries the key.
The value is 36 bytes of `[A-Za-z0-9-]`, which satisfies the strictest per-event id limit among comparable products (Mixpanel's `$insert_id`).

`crypto.randomUUID` is used where available and falls back to `crypto.getRandomValues`, then to `Math.random`, because `randomUUID` is exposed only in a secure context.
The id is random per call and is never derived from the visitor, the device or any stored identifier.

### `visit_id` (state property)

A random id for the visit, on **every** outgoing event, so page views from one visit are counted as one session.

It exists because of a hard limit in `@getdevteam/analytics-web` 0.2.0: the SDK's own session id lives in a closure, is not persisted, and `ClientConfig` exposes no way to set or restore it.
Every document load therefore opens a fresh SDK session and emits its own `$session_start`, and a visit that spans two loads — a reload, a re-navigation, a redirect chain — reports two of them with nothing in the payload tying them together.
`visit_id` is that tie, and it is why it is **not** called `session_id`: the wire event already carries the SDK's own field under that name, and two disagreeing `session_id`s on one event would be worse than none.

`$session_start` is minted inside the SDK and carries no properties at all, so it has no `visit_id` of its own; it joins to a visit through the `session_id` it shares with the events that do.

Stored under `sd_sid` in **sessionStorage** with a rolling 30-minute inactivity stamp (matching the SDK's own session window), written only once the analytics category is granted, and deleted the moment the visitor declines or withdraws - along with the SDK's device id, its persisted queue, and GA4's `_ga` / `_ga_*` cookies.
Withdrawal detaches the client and shuts it down *before* it clears anything, because the SDK re-persists its queue on every enqueue: leave a client attached and the deny path's own log line writes back the device id and the granted-period events one statement after they were removed.
What the client had already queued under consent is delivered by its final flush rather than left on disk for a later load to restore.
sessionStorage rather than localStorage because a visit is one tab: the browser clearing the item when the tab closes is a shorter retention than any expiry stamp we could implement.
A stored value is shape-checked on the way out of storage, so nothing else on the origin can smuggle a value of its choosing onto the payload.
See the storage inventory in [`src/pages/privacy.astro`](../src/pages/privacy.astro); this addition does **not** bump `POLICY_VERSION` (see the constant for the bump rules).

## Running experiments

Flags are authored in the DevTeam **A/B Testing** tab; the code-side default is what ships whenever no payload applies, so a missing or stopped flag always renders the control experience.

| Flag key | Type | Environment | Variations | Conversion metric | Surface |
|---|---|---|---|---|---|
| `hero_cta_copy` | string | Development | payload copy vs. the code-side `Read the latest` | `Hero CTA Clicked` | `[data-experiment-copy]` on the homepage hero CTA (`src/pages/index.astro`) |
| `remove-about-page` | boolean | Development | `control` = `false` (50%), `b` = `true` (50%) | `Page Viewed` | `[data-experiment-nav-item]` on the About anchor in `Header.astro` |

`remove-about-page` ("Remove about page option from nav bar") asks whether the About entry earns its slot in the six-item primary nav.
Control keeps the nav as rendered; variant B removes the About item from the DOM after the payload resolves.
Both variants ship in the same build - the split happens at runtime in the flag payload, never at merge time.

Its exposure is **desktop-only by design**: `.site-nav` is `display: none` below 900px and there is no mobile drawer, so a narrow-viewport visitor cannot receive the treatment and the flag is never read for them (no bucketing, no `$experiment_viewed`).
Crossing the breakpoint upward re-checks and buckets at that point.
Nothing about `/about` itself changes in either variant: the page, its indexability, its sitemap entry and its footer link are identical, so the experiment measures nav composition alone.

On the first consented page load the buffered `Page Viewed` flushes before bucketing completes, so the `$exp_remove-about-page` stamp appears from the next page load onward - a property of the consent-then-bucket order, not something to work around with a second `Page Viewed`.

## Verification

Last verified: 2026-08-10 (duplicate top-of-funnel events; taxonomy-parity guard).

A production journey recording four events in a zero-second span - `$session_start` -> `Page Viewed` -> `$session_start` -> `Page Viewed` (signature `1707c53280a2635389cbc470003e7016`, 2026-08-08 08:09:18Z) - was reproduced and traced to **two document loads in one visit**, not to a double dispatch and not to two analytics module instances:

- **Two module instances: ruled out.** The production bundle (`astro build` with the ingest key set) emits a single hoisted script for both client entry points - `BaseLayout`'s `import '../scripts/chrome'` and the `ConsentBanner` island - with one copy of `src/lib/analytics.ts` and one copy of the SDK, and one `<script type="module">` tag per page. Two instances also could not produce the observed shape: only the banner calls `boot()`, so the second instance's `Page Viewed` would be stranded in an unflushed buffer rather than duplicated.
- **Two loads: confirmed.** The SDK flushes at 20 events or every 5 seconds, and persists its unflushed queue to `localStorage`, restoring it into the **next** page load's client with `unshift`. So a second load inside the flush window delivers load 1's events in front of its own, in one batch: `$session_start`, `Page Viewed`, `$session_start`, `Page Viewed`, sub-second apart. Each load opens its own session because the SDK's session id lives in a closure and 0.2.0 exposes no way to persist or restore it. `REPRODUCTION` in [`src/lib/analytics.test.ts`](../src/lib/analytics.test.ts) reproduces this against the real SDK and is kept as the regression's premise.
- **A transport double-flush of one batch is not needed to explain it**, but the same persisted queue makes it possible: `takeBatch` removes items before sending, and a batch whose response is lost is requeued verbatim and re-sent on a later load. `event_id` is what collapses that case.

The fix is at the client boundary this repo owns - a document-scoped single client, a page-view dispatch that claims one key per document, `visit_id` for session continuity across loads, and `event_id` on every payload. Server-side dedup on `(site, event_id)` belongs to the DevTeam Analytics platform and is not implemented here.

A production report of a `Theme Toggled` event missing from the code and this document was investigated and found to be a false alarm: the constant, the `chrome.ts` call site, this document's row and the `theme` PII allowlist entry were all already present and correct on `main`, and the event was passing through the consent-gated, scrubbed `track()` chokepoint as designed.

### Automated (run in this environment)

- `npm run check` (`astro check`) - 0 errors, so the full event-wiring graph type-checks (the `EVENTS` map, every `data-track` call site, and the consent banner that boots the gate). `track()` now takes the taxonomy union rather than `string`, so this run is also what proves no code call site names an undeclared event.
- `npm test` - 158/158 pass. This covers the consent decision table end to end: a GPC/DNT signal denies and never sends, an explicit decline denies, a stored grant flushes, and an unknown/stale state keeps buffering (`src/lib/consent.test.ts`); the PII allowlist that scrubs every outgoing payload (`src/lib/pii.test.ts`); the taxonomy parity guard over the `EVENTS` map, this document and the `.astro` dispatch sites (`src/lib/taxonomy.test.ts`); and the duplicate-event guards - one client and one `$session_start` per document across two module copies, one `Page Viewed` per document per path, visit continuity across a slash-suffixed entry URL, `event_id` surviving the consent buffer, and withdrawal leaving no analytics storage behind and both sinks stopped - the GA4 tag opted out and its cookies expired (`src/lib/analytics.test.ts`, `src/lib/visit.test.ts`).
  The consent UI's own state machine is covered separately (`src/lib/consent-surface.test.ts`): the returning visitor whose only way back to their choice is the footer control, the dialog pre-filled from the decision in force, and the focus hand-back that happens exactly once.
  The third sink is covered separately too (`src/lib/experiments-consent.test.ts`), because it takes the real GrowthBook SDK to observe: a granted visitor is bucketed, stamped and streamed to; a withdrawal closes that stream, clears the poll, and leaves a first read of a second experiment-backed feature returning its code-side default with no `sd-exp` written; a withdrawal arriving while the first payload is still in flight leaves nothing running either; and a re-grant buckets the visitor again.
  Those guard tests drive the shipped `src/lib/analytics.ts` itself - imported twice, as the two distinct module instances a per-entry-point bundle would produce - against the real SDK wired to in-test storage and transport, so removing any guard from the module fails a test rather than only a stand-in's copy of it. The modules' build-time configuration is the one thing substituted, through the `src/lib/analytics-env.ts` and `src/lib/flags-env.ts` seams; that is why the test script passes node's `--experimental-test-module-mocks`.
- `npx astro dev` + `GET /privacy` - the updated privacy page renders and serves the new DevTeam Analytics / Google Analytics disclosures.

### Event-flow trace (code path confirmed for each taxonomy event)

Each funnel event was traced from its real call site through the dispatcher (`chrome.ts`), the consent-gated `track()` buffer, the `scrub()` chokepoint, and out via DevTeam Analytics' `sendBeacon` transport.
Every row additionally carries the `event_id` and `visit_id` keys and the `theme` state stamp, plus any sticky `$exp_*` stamps, which are merged in at the chokepoint rather than at the call site:

| Event | Real call site | Properties sent (post-scrub) |
|---|---|---|
| `Page Viewed` | `<body data-page-view>` from `BaseLayout`, dispatched once per document via `trackPageView()` | `path` (normalized), `referrer` (path-reduced), plus `screen`, `category`, `slug`, `brand` as declared per screen |
| `Hero CTA Clicked` | `index.astro` hero buttons | `cta`, `href` (path-reduced) |
| `Deal Card Clicked` | `DealCard.astro`, `DropPanel.astro` | `slug`, `brand`, `placement` (`drop-panel` on the drop card) |
| `Affiliate Link Clicked` | `deals/[slug].astro`, `promos/[slug].astro`, `Verdict.astro`, `ProductCallout.astro` | `slug`, `brand`, `retailer`, `placement` |
| `Newsletter Signup` | _none - no signup form ships while there is no mailing list_ | `screen` (when known) |
| `Theme Toggled` | `chrome.ts` `[data-theme-toggle]` click handler | `theme` |
| `Share Clicked` | `chrome.ts` `[data-share]` click handler | `screen` (when known) |
| `Copy Link Clicked` | `chrome.ts` `[data-copy-link]` click handler | `screen` (when known) |
| `Image Lightbox Opened` | `chrome.ts` `[data-lightbox]` click/keydown handler | `screen` (when known) |
| `TOC Link Clicked` | `chrome.ts` `[data-toc] a` click handler | `section` |

Suppression is enforced in one place (`track()` in `analytics.ts`): events are buffered while consent is unknown, flushed on grant, dropped on deny, and `boot()` denies outright on a GPC/DNT signal - so nothing reaches DevTeam Analytics before consent or after a decline/GPC/DNT.
Withdrawal is reachable from every page: the **Privacy preferences** control in the footer dispatches the `consent:open-preferences` document event owned by [`src/lib/consent-preferences.ts`](../src/lib/consent-preferences.ts), which reopens the consent island's dialog pre-filled from `consentStatus()` - the decision in force - so a visitor can turn analytics back off long after the banner is gone.
Which surface that dialog opens over, and what closing it goes back to, is the state machine in [`src/lib/consent-surface.ts`](../src/lib/consent-surface.ts); the island script is the DOM wiring around it.
Turning it back off stops **everything the grant started**, in the same page load and without a reload: the DevTeam client is detached and shut down; GA4 - which cannot be unloaded once its tag is in the DOM, and which emits `user_engagement` on its own - is switched off through its `window['ga-disable-<MEASUREMENT_ID>']` flag with its `_ga` / `_ga_*` cookies expired; and A/B testing is stopped through `stop()` in [`src/lib/experiments.ts`](../src/lib/experiments.ts), which closes the GrowthBook instance's subscription to the flag host, clears the 60s payload poll, drops the instance and only then clears the `sd-exp` stamps.
Dropping the instance is the part that matters most: it is what makes every later feature read return its code-side default, and the site re-reads every experiment-backed slot on each payload change and each crossing of the nav breakpoint, so a read after a withdrawal is routine rather than hypothetical.
The GA4 flag is cleared and the A/B start guard released again on a re-grant, because the tag is only ever loaded once per document and a visitor who changes their mind must not be left silently out of the sinks they just re-consented to.

### Live View walk-through (operational - run on the preview deploy)

This step needs a deployed/preview build with `PUBLIC_DEVTEAM_ANALYTICS_INGEST_KEY` set and access to the DevTeam Analytics platform's real-time event view; it cannot be exercised in the build sandbox (no deployed build, browser, or DevTeam Analytics access here). To close it out, deploy the preview, open the DevTeam Analytics platform, and:

1. Before accepting consent, browse a few pages - confirm **no** events appear (buffered, not sent).
2. Accept analytics, then walk the funnel: home (hero CTA), deal card click, deal-detail view, affiliate "View deal" click - confirm each event above lands with the listed properties and **no** PII (no emails, names, or query strings). There is no newsletter signup step while no form ships.
3. Reset consent, decline (or enable GPC/DNT), repeat the walk - confirm **no** events appear.
4. Hit the theme toggle once - confirm exactly **one** `Theme Toggled` lands, spelled exactly that, with `theme` = the mode switched to.
5. On a fresh visit that never touches the toggle, confirm `Page Viewed` still carries the `theme` state stamp (`light` by default, `dark` for a visitor with the stored preference).

Record the operator, date, and Live View screenshots here once complete.
