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
