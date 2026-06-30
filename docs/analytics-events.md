# Analytics event taxonomy

This is the canonical reference for the Mixpanel events SleekDrops emits.
It defines every event name, its properties, and the screen that owns it.

Keep this doc and the code in sync.
Event names live as constants in [`src/lib/analytics.ts`](../src/lib/analytics.ts) (the `EVENTS` map); changing a name means changing it in both places.

## How tracking is wired

All tracking goes through the single wrapper in [`src/lib/analytics.ts`](../src/lib/analytics.ts) - no component calls the Mixpanel SDK directly.
Events are declared in the DOM and dispatched by [`src/scripts/chrome.ts`](../src/scripts/chrome.ts), matching the rest of that file's declarative style:

- **Page views** - a page sets `screen` (and optional `pageProps`) on `BaseLayout`, which serialises them onto `<body data-page-view="...">`.
  `chrome.ts` reads that payload on load and fires `Page Viewed`.
- **Funnel clicks** - an element carries `data-track="<Event Name>"` and an optional JSON `data-track-props`.
  `chrome.ts` fires the event synchronously on click, before the browser follows the link.
- **Newsletter signups** - a newsletter form carries `data-signup`; the mock-form submit handler fires `Newsletter Signup`.

Mixpanel is initialised with batching off and `sendBeacon` transport so a click event still reaches the server when the click immediately navigates the page away.

## No PII

Properties carry only non-identifying context (screen names, deal slugs, brands, CTA labels).
No email addresses, names, or other personal data are tracked here.
Consent and PII enforcement are handled separately by the consent/PII gate.

## Events

### Page Viewed

Fired once per page load on the key screens.
The deal-detail page view doubles as the "deal detail viewed" funnel step (it carries the deal `slug` and `brand`).

| Property | Type | Notes |
|---|---|---|
| `screen` | string | One of `home`, `blog-listing`, `blog-post`, `deals-listing`, `deal-detail`. |
| `category` | string | Category slug. Present on `blog-post` and `deal-detail`. |
| `slug` | string | Post or deal slug. Present on `blog-post` and `deal-detail`. |
| `brand` | string | Deal brand. Present on `deal-detail`. |

Owning screens: homepage, blog listing, blog post, deals listing, deal detail.

### Hero CTA Clicked

A click on a primary call-to-action in the homepage hero.

| Property | Type | Notes |
|---|---|---|
| `cta` | string | The button label, e.g. `Read the latest`. |
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

| Property | Type | Notes |
|---|---|---|
| `screen` | string | The screen the signup happened on, when known. |

Owning components: `Newsletter.astro`, `Footer.astro` subscribe form.

## Verification

Last verified: 2026-06-30 (epic close-out).

### Automated (run in this environment)

- `npm run check` (`astro check`) - 0 errors across 72 files, so the full event-wiring graph type-checks (the `EVENTS` map, every `data-track` call site, and the consent banner that boots the gate).
- `npm test` - 30/30 pass. This covers the consent decision table end to end: a GPC/DNT signal denies and never sends, an explicit decline denies, a stored grant flushes, and an unknown/stale state keeps buffering (`src/lib/consent.test.ts`); plus the PII allowlist that scrubs every outgoing payload (`src/lib/pii.test.ts`).
- `npx astro dev` + `GET /privacy` - the updated privacy page renders and serves the new Mixpanel / Google Analytics disclosures.

### Event-flow trace (code path confirmed for each taxonomy event)

Each funnel event was traced from its real call site through the dispatcher (`chrome.ts`), the consent-gated `track()` buffer, the `scrub()` chokepoint, and out via Mixpanel's `sendBeacon` transport:

| Event | Real call site | Properties sent (post-scrub) |
|---|---|---|
| `Page Viewed` | `<body data-page-view>` from `BaseLayout` | `path`, `referrer` (both path-reduced), plus `screen`, `category`, `slug`, `brand` as declared per screen |
| `Hero CTA Clicked` | `index.astro` hero buttons | `cta`, `href` (path-reduced) |
| `Deal Card Clicked` | `DealCard.astro`, `DropPanel.astro` | `slug`, `brand`, `placement` (`drop-panel` on the drop card) |
| `Affiliate Link Clicked` | `deals/[slug].astro`, `promos/[slug].astro`, `Verdict.astro`, `ProductCallout.astro` | `slug`, `brand`, `retailer`, `placement` |
| `Newsletter Signup` | `Newsletter.astro`, `Footer.astro` (`data-signup`) | `screen` (when known) |

Suppression is enforced in one place (`track()` in `analytics.ts`): events are buffered while consent is unknown, flushed on grant, dropped on deny, and `boot()` denies outright on a GPC/DNT signal - so nothing reaches Mixpanel before consent or after a decline/GPC/DNT.

### Live View walk-through (operational - run on the preview deploy)

This step needs a deployed/preview build with `PUBLIC_Mixpanel__ProjectToken` set and access to the Mixpanel project's Live View; it cannot be exercised in the build sandbox (no deployed build, browser, or Mixpanel project access here). To close it out, deploy the preview, open Mixpanel Live View, and:

1. Before accepting consent, browse a few pages - confirm **no** events appear (buffered, not sent).
2. Accept analytics, then walk the funnel: home (hero CTA), deal card click, deal-detail view, affiliate "View deal" click, newsletter signup - confirm each event above lands with the listed properties and **no** PII (no emails, names, or query strings).
3. Reset consent, decline (or enable GPC/DNT), repeat the walk - confirm **no** events appear.

Record the operator, date, and Live View screenshots here once complete.
