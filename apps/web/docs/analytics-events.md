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
- **Newsletter signups** - not currently emitted. There is no mailing list behind the site yet, so the newsletter band and the footer subscribe block carry no form at all; firing a conversion for a submission that stores nothing would report a signup that never happened. The event stays in the taxonomy for the capture that replaces them.
- **Chrome UI interactions** - the dark-mode toggle, share button, copy-link button, image lightbox, and TOC nav links already have dedicated event listeners in `chrome.ts` for their own behaviour; each fires its analytics event directly from that handler rather than through a `data-track` attribute.
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

A/B testing follows the same chokepoint discipline: [`src/lib/experiments.ts`](../src/lib/experiments.ts) is the only module that touches the GrowthBook SDK, it is started only from the consent-grant path, and every feature read falls back to the caller's code-side default.
The flag payload is treated as data, never as code: it is read over `https` only (a plaintext host on a secure page is refused with one warning), and GrowthBook's auto-experiments — DOM mutations, JS injection and URL redirects — are disabled, so a flag can change only a value the site itself asked for.

## No PII

Properties carry only non-identifying context (screen names, deal slugs, brands, CTA labels).
No email addresses, names, or other personal data are tracked here.
Consent and PII enforcement are handled separately by the consent/PII gate.

## Events

### Page Viewed

Fired **exactly once per document per path**, on the key screens.
The deal-detail page view doubles as the "deal detail viewed" funnel step (it carries the deal `slug` and `brand`).

"Exactly once" is a guarantee, not a convention: `chrome.ts` dispatches through `trackPageView()` in [`src/lib/analytics.ts`](../src/lib/analytics.ts), which claims a document-scoped key of `Page Viewed` plus the normalized path and drops any repeat.
So a second script entry point reaching the dispatch, a bfcache restore or a re-run of the dispatch path cannot report a second view, while a same-document navigation to a different path still can.
`path` is stamped by the dispatcher itself, normalized (`trailingSlash: 'never'`, so `/deals/foo/` and `/deals/foo` are one page) and applied last, so no call site can override it with the raw location and a redirected entry URL cannot split the count across two spellings.

| Property | Type | Notes |
|---|---|---|
| `path` | string | The normalized path, stamped by the dispatcher. |
| `referrer` | string | Reduced to path by `scrub()`, and empty on a direct visit. |
| `screen` | string | One of `home`, `blog-listing`, `blog-post`, `deals-listing`, `deal-detail`. |
| `category` | string | Category slug. Present on `blog-post` and `deal-detail`. |
| `slug` | string | Post or deal slug. Present on `blog-post` and `deal-detail`. |
| `brand` | string | Deal brand. Present on `deal-detail`. |

Owning screens: homepage, blog listing, blog post, deals listing, deal detail.

### Hero CTA Clicked

A click on a primary call-to-action in the homepage hero.

| Property | Type | Notes |
|---|---|---|
| `cta` | string | The button label, e.g. `Read the latest`. Always the label as rendered, so a variant of the `hero_cta_copy` experiment reports its own copy. |
| `href` | string | The link target. |

Owning screen: homepage (`Hero` section of `src/pages/index.astro`).

### Deal Card Clicked

A click on a deal tile that enters the deal funnel by navigating to a deal-detail page.

| Property | Type | Notes |
|---|---|---|
| `slug` | string | Deal slug. |
| `brand` | string | Deal brand. |
| `placement` | string | `drop-panel` for the hero drop card; absent for the standard `DealCard` grid tile. |

Owning components: `DealCard.astro`, `DropPanel.astro` (homepage and deals listing).

### Affiliate Link Clicked

The primary conversion: a click on an outbound affiliate "View deal" / "View price" button.
Fires before the `/go/<slug>` (or direct merchant) navigation.

| Property | Type | Notes |
|---|---|---|
| `slug` | string | Affiliate slug (post slug or deal slug). |
| `brand` | string | Product / deal brand. |
| `retailer` | string | Merchant name. Present for the in-article product callout. |
| `placement` | string | `deal-detail`, `verdict`, `product-callout`, or `promo-detail`. |

Owning components: `deals/[slug].astro`, `promos/[slug].astro`, `Verdict.astro`, `ProductCallout.astro`.

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

### `$exp_<experimentKey>` (sticky property)

Once a variant is assigned, `$exp_<experimentKey>` = `<variantKey>` is stamped onto **every** subsequent event and log at the `send()` / `serverLog()` chokepoint in [`src/lib/analytics.ts`](../src/lib/analytics.ts) - the DevTeam SDK v0.2.0 has no global-properties API.
That is what lets a conversion (`Affiliate Link Clicked`, `Deal Card Clicked`, ...) be attributed to a variant without any call site knowing an experiment exists.

The stamps persist in local storage under `sd-exp`, because this is a multi-page static site: a visitor is bucketed on the page that reads the feature and converts on a later page that never does.
They are written only after consent and deleted on a decline.

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

Stored under `sd_sid` in **sessionStorage** with a rolling 30-minute inactivity stamp (matching the SDK's own session window), written only once the analytics category is granted, and deleted the moment the visitor declines or withdraws — along with the SDK's device id and any batch it had not yet delivered.
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
- **Two loads: confirmed.** The SDK flushes at 20 events or every 5 seconds, and persists its unflushed queue to `localStorage`, restoring it into the **next** page load's client with `unshift`. So a second load inside the flush window delivers load 1's events in front of its own, in one batch: `$session_start`, `Page Viewed`, `$session_start`, `Page Viewed`, sub-second apart. Each load opens its own session because the SDK's session id lives in a closure and 0.2.0 exposes no way to persist or restore it. `REPRODUCTION` in [`src/lib/analytics-scope.test.ts`](../src/lib/analytics-scope.test.ts) reproduces this against the real SDK and is kept as the regression's premise.
- **A transport double-flush of one batch is not needed to explain it**, but the same persisted queue makes it possible: `takeBatch` removes items before sending, and a batch whose response is lost is requeued verbatim and re-sent on a later load. `event_id` is what collapses that case.

The fix is at the client boundary this repo owns - a document-scoped single client, a page-view dispatch that claims one key per document, `visit_id` for session continuity across loads, and `event_id` on every payload. Server-side dedup on `(site, event_id)` belongs to the DevTeam Analytics platform and is not implemented here.

A production report of a `Theme Toggled` event missing from the code and this document was investigated and found to be a false alarm: the constant, the `chrome.ts` call site, this document's row and the `theme` PII allowlist entry were all already present and correct on `main`, and the event was passing through the consent-gated, scrubbed `track()` chokepoint as designed.

### Automated (run in this environment)

- `npm run check` (`astro check`) - 0 errors, so the full event-wiring graph type-checks (the `EVENTS` map, every `data-track` call site, and the consent banner that boots the gate). `track()` now takes the taxonomy union rather than `string`, so this run is also what proves no code call site names an undeclared event.
- `npm test` - 123/123 pass. This covers the consent decision table end to end: a GPC/DNT signal denies and never sends, an explicit decline denies, a stored grant flushes, and an unknown/stale state keeps buffering (`src/lib/consent.test.ts`); the PII allowlist that scrubs every outgoing payload (`src/lib/pii.test.ts`); the taxonomy parity guard over the `EVENTS` map, this document and the `.astro` dispatch sites (`src/lib/taxonomy.test.ts`); and the duplicate-event guards against the real SDK - one client and one `$session_start` per document across two module copies, one `Page Viewed` per document per path, visit continuity across a slash-suffixed entry URL, and `event_id` surviving the consent buffer (`src/lib/analytics-scope.test.ts`, `src/lib/visit.test.ts`).
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

### Live View walk-through (operational - run on the preview deploy)

This step needs a deployed/preview build with `PUBLIC_DEVTEAM_ANALYTICS_INGEST_KEY` set and access to the DevTeam Analytics platform's real-time event view; it cannot be exercised in the build sandbox (no deployed build, browser, or DevTeam Analytics access here). To close it out, deploy the preview, open the DevTeam Analytics platform, and:

1. Before accepting consent, browse a few pages - confirm **no** events appear (buffered, not sent).
2. Accept analytics, then walk the funnel: home (hero CTA), deal card click, deal-detail view, affiliate "View deal" click - confirm each event above lands with the listed properties and **no** PII (no emails, names, or query strings). There is no newsletter signup step while no form ships.
3. Reset consent, decline (or enable GPC/DNT), repeat the walk - confirm **no** events appear.
4. Hit the theme toggle once - confirm exactly **one** `Theme Toggled` lands, spelled exactly that, with `theme` = the mode switched to.
5. On a fresh visit that never touches the toggle, confirm `Page Viewed` still carries the `theme` state stamp (`light` by default, `dark` for a visitor with the stored preference).

Record the operator, date, and Live View screenshots here once complete.
