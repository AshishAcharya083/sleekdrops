# Deployment — GitHub Actions → Cloudflare Pages

Two environments, both static builds, both deployed to Cloudflare Pages.

| Branch    | Environment | URL                              | Workflow                                   |
| --------- | ----------- | -------------------------------- | ------------------------------------------ |
| `main`    | production  | https://sleekdrops.com           | `.github/workflows/deploy-production.yml`  |
| `develop` | develop     | https://develop.sleekdrops.pages.dev | `.github/workflows/deploy-develop.yml` |
| any PR    | (checks)    | —                                | `.github/workflows/pr-checks.yml`          |

A push to `main` triggers the production build, type-check, and deploy. A push to `develop` triggers the same against the develop URL. Every PR runs a type-check and a build (no deploy) to keep `main` and `develop` shippable.

**Which `pages.dev` host is which** — Cloudflare Pages serves the project's *production* branch at the bare `sleekdrops.pages.dev` and every other branch at `<branch>.sleekdrops.pages.dev`. So `sleekdrops.pages.dev` is production (the same build as `sleekdrops.com`), and develop is `develop.sleekdrops.pages.dev`. Checking the bare host to see what develop shipped shows you production instead — which is an easy way to conclude that a per-environment setting has leaked when it has not.

Note that develop's build still sets `SITE_URL` to the **production** host on purpose: canonical links, `og:url` and the sitemap are built from it, so pointing it at the preview would make develop a self-canonicalising second copy competing with the real site in the index.

The build runs `pnpm prebuild` (which generates `public/_redirects` from `src/data/affiliate-links.json`) → `astro check` → `astro build`. Output goes to `dist/`. `wrangler-action@v3` pushes `dist/` to the matching Cloudflare Pages project.

---

## Required GitHub repository secrets

Add these in **Settings → Secrets and variables → Actions → Repository secrets**. Production-only values can be scoped via GitHub Environments if you want stricter separation (see the `environment:` block in each workflow).

### Cloudflare Pages (required for any deploy)

| Secret                     | Where to get it                                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`     | Cloudflare → My Profile → API Tokens → Create Token → template **"Edit Cloudflare Workers"** *or* a custom token with **Account → Cloudflare Pages: Edit**. |
| `CLOUDFLARE_ACCOUNT_ID`    | Cloudflare dashboard right sidebar of any zone, or **Workers & Pages → Overview**.                               |
| `CLOUDFLARE_PROJECT_NAME`  | The name of the Pages project you created — e.g. `sleekdrops` (used in the wrangler command).                    |

### DevTeam Analytics (required for the analytics + logging sink)

**DevTeam publishes all four of the settings below itself** — into this repo's Actions secrets and variables on the deployment environment matching the DevTeam environment — whenever analytics is provisioned or an A/B client key is minted.
Nobody copies a key by hand, and nothing here needs setting up manually.
The names are DevTeam's canonical ones, so the platform, this repo's settings, and the workflows below cannot drift apart.

If a value is ever missing, re-run the publish from the DevTeam project's **Config** tab (**Sync to GitHub**) rather than pasting one in — a hand-entered key goes stale the next time the project re-provisions.

Both deploy workflows pass the analytics pair into the web build as `PUBLIC_DEVTEAM_ANALYTICS_INGEST_KEY` / `PUBLIC_DEVTEAM_ANALYTICS_HOST`; the admin panel reads the same two repo settings under its own `VITE_` prefix, so both apps report into one project.

| Repo setting                                | Kind         | What it is                                                                          |
| ------------------------------------------- | ------------ | ------------------------------------------------------------------------------------ |
| `DEVTEAM_ANALYTICS_INGEST_KEY`              | **secret**   | The project's ingest key (`dtp_…`). Ingest-only.                                    |
| `DEVTEAM_ANALYTICS_HOST`                    | **variable** | The platform's ingest host, e.g. `https://ingest.analytics.internal.getdevteam.ai`. |

An empty key disables the DevTeam sink silently after one warning; GA4 is unaffected.

The same pair is also uploaded to the Pages project as **runtime** variables, by a `wrangler pages secret put` step in each deploy workflow (`--env preview` on develop, `--env production` on production).
That step exists because the `PUBLIC_` values above are inlined into the browser bundle by Vite and never reach a Pages Function, and `functions/go/[slug].js` — which counts the outbound affiliate click, the site's primary conversion — reads them from `context.env` at request time.
Both go up as secrets because wrangler has no command for a plain-text Pages variable and a secret reads back through `context.env` identically; nothing is committed to `wrangler.toml` or to the repo, an empty value is skipped, and an empty key leaves the Function's sink off while the 302 is still served.

### Google Analytics 4 (required for GA4 to count anything)

Both deploy workflows pass this into the web build as `PUBLIC_GA4_ID`.

| Repo setting          | Kind         | What it is                                                                                          |
| --------------------- | ------------ | ----------------------------------------------------------------------------------------------------- |
| `GA4_MEASUREMENT_ID`  | **variable** | The measurement id of the property **this environment** reports into, `G-…`, from GA4 → Admin → Data streams → Web. |

**Scope it per GitHub Environment (`develop` / `production`), not as a repo variable** — that is the entire point of the setting.
One property receiving both sites means every figure production is judged on (sessions, conversion rate, the affiliate click-through rate) is inflated by preview traffic, and nothing in GA4 separates the two after the fact beyond a hostname filter nobody remembers to apply.
Set it under **Settings → Environments → `develop` → Environment variables**, and again under `production`; `vars.GA4_MEASUREMENT_ID` then resolves to whichever one the running job is deploying to.

It is a **variable**, not a secret: it is a `PUBLIC_`-prefixed Astro value inlined verbatim into the JS bundle every visitor downloads, and Google treats it as a public identifier.

Leaving it unset is a supported state, and is what a local `pnpm dev` runs in.
The build then disables GA4 after a single `[analytics]` console warning (also forwarded to the DevTeam Logs view): gtag.js is never requested, no `_ga` cookie is written, and nothing else about the site changes.
That is deliberate — a developer's laptop and a preview deploy must not be able to land traffic in the reports the site is actually judged on.

Anything that is not a `G-` measurement id reads as unset and is refused with that same warning rather than tagging the document with it.
A Universal Analytics property (`UA-…`), a Tag Manager container (`GTM-…`) or a lowercase paste names no property gtag.js can report into, so loading the tag for one can only produce a page that looks healthy while Google discards every hit.

GA4 loads only for a visitor who accepted analytics — the tag is not requested before consent, which is stricter than Google Consent Mode (that loads the tag and asks it to restrict itself), so no Consent Mode signal is sent or needed.
A withdrawal sets the tag's own `ga-disable-<id>` flag and deletes its `_ga` cookies in the same page load.

### DevTeam A/B Testing (required for experiments to run)

Both deploy workflows pass these into the web build as `PUBLIC_DEVTEAM_FLAGS_CLIENT_KEY` / `PUBLIC_DEVTEAM_FLAGS_HOST`.

| Repo setting                | Kind         | What it is                                                                                        |
| --------------------------- | ------------ | -------------------------------------------------------------------------------------------------- |
| `DEVTEAM_FLAGS_CLIENT_KEY`  | **secret**   | The environment's client key (`dtfl_…`), minted and published by DevTeam.                        |
| `DEVTEAM_FLAGS_HOST`        | **variable** | The platform's flag-delivery host — always `https://`, e.g. `https://app.internal.getdevteam.ai`. |

The **secret** / **variable** column is not cosmetic: a workflow reads a secret through `secrets.*` and a variable through `vars.*`, so a client key stored as a variable arrives in the build as an empty string and every experiment reports 0 users with nothing anywhere looking broken.

`DEVTEAM_FLAGS_CLIENT_KEY` lives in Actions *secrets* only so it is easy to rotate per environment — it is **not** confidential.
It is a read-only GrowthBook client key, and being a `PUBLIC_`-prefixed Astro variable it is inlined verbatim into the JS bundle every visitor downloads.
Never put a privileged platform API key in that slot: it would be published on the next deploy.

`DEVTEAM_FLAGS_HOST` must be `https://`. The flag payload decides what the page renders and how visitors are bucketed, and it is neither signed nor encrypted, so a plaintext host would let any network intermediary rewrite it.
A `http://` host on the (https) deployed site is refused with a single console warning and every feature falls back to its code-side default — the browser would block it as mixed content anyway. Plain `http` still works for local development, where the page itself is `http`.

Leaving either unset is a supported state: the build ships with experiments disabled and every feature renders its code-side default.

### Google AdSense (required for ads to serve)

Both deploy workflows pass these into the web build as `PUBLIC_ADSENSE_CLIENT` and one `PUBLIC_ADSENSE_SLOT_*` per placement.
All five are **variables**, not secrets: they are `PUBLIC_`-prefixed Astro values that ship in the markup every visitor downloads, and AdSense treats them as public identifiers.

| Repo setting                | Kind         | What it is                                                                              |
| --------------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| `ADSENSE_CLIENT`            | **variable** | The publisher id for this environment, `ca-pub-…`, from AdSense → Account → Settings.   |
| `ADSENSE_SLOT_ARTICLE_MID`  | **variable** | Slot id of the mid-article unit, from AdSense → Ads → By ad unit.                        |
| `ADSENSE_SLOT_ARTICLE_END`  | **variable** | Slot id of the end-of-article unit.                                                      |
| `ADSENSE_SLOT_SIDEBAR`      | **variable** | Slot id of the sticky sidebar unit (desktop only).                                       |
| `ADSENSE_SLOT_FEED`         | **variable** | Slot id of the in-feed card unit.                                                        |

Set them under **Settings → Environments → `production` → Environment variables**.

**Develop carries no publisher id, and cannot be given one by a variable.** `deploy-develop.yml` pins `PUBLIC_ADSENSE_CLIENT: ''` outright rather than reading `vars.ADSENSE_CLIENT`, which is the one place this differs from every other setting in this document.

The reason is inheritance. GitHub resolves `vars.X` as environment → repository → organization, so a repo-level `ADSENSE_CLIENT` would silently apply to develop as well — and adding one is the natural mistake, because the publisher id genuinely *is* the same for the whole account, so scoping it per environment looks redundant until you know why it is not.

Why it is not: `sleekdrops.pages.dev` is a different domain from `sleekdrops.com` and is not in the AdSense account's Sites list. A publisher id there publishes an `/ads.txt` and a `google-adsense-account` tag on an unlisted domain claiming the account, which is the shape of a review failure — and since develop tracks `main` closely, that one line is the entire difference between the two environments. An empty value disables the units, `ads.txt` and the verification tag together, which is what a preview deploy should publish: nothing.

Two tests in [`src/lib/ads-env.test.ts`](../src/lib/ads-env.test.ts) hold both halves — develop pinned empty, production still reading its variable — so this cannot be undone silently, in either direction. Turning ads on for develop means editing that line and knowing why.

#### What each slot renders

Create four ad units in **AdSense → Ads → By ad unit** and paste each one's slot id into the matching variable. Every unit is rendered by [`src/components/ads/AdUnit.astro`](../src/components/ads/AdUnit.astro), which is the only component in the site that emits ad markup — a page asks for a *placement*, never a network or a slot id.

| Placement     | Where it renders                                                                   | Suggested AdSense unit                       |
| ------------- | ------------------------------------------------------------------------------------ | -------------------------------------------- |
| `articleMid`  | Inside a blog post body, on the section break nearest the middle of the article.     | Display, responsive                          |
| `articleEnd`  | Below the article body, after the affiliate disclosure.                              | Display, responsive                          |
| `sidebar`     | The sticky rail on a blog post, beneath the table of contents. **Desktop only** — the rail collapses below 1000px and the unit is neither shown nor requested there. | Display, vertical / half-page (300×600)      |
| `feed`        | One cell of a post grid, opening the second row (after the third card).              | Display, responsive (or an In-feed unit)     |

An empty slot id disables that one placement and leaves the others running, so the units can be switched on one at a time.

Two rules decide whether a slot is used at all, and both live in the pure [`src/lib/ad-placement.ts`](../src/lib/ad-placement.ts): a post shorter than 8 top-level blocks gets no mid-article unit, and a grid of fewer than 4 cards gives no cell away. Thin content beside ads is the shape of an AdSense policy action, and a unit in a three-card grid reads as an ad-first listing.

Nothing is requested until the visitor switches **Advertising** on in the consent dialog — a decline, an unanswered banner and a GPC/DNT signal all load no partner script at all (see [`src/lib/ads.ts`](../src/lib/ads.ts)). Units ship `hidden` and are removed outright for anyone who has not opted in, so no reserved "Advertisement" box is ever shown to a visitor who will not see an ad. Each unit is requested only once it comes within 300px of the viewport, because viewable CPM is what an impression is priced on, and a slot that has no box on the current viewport is dropped rather than filled. A slot the auction cannot fill reports `data-ad-status="unfilled"` and the wrapper collapses, so an unsold slot leaves no hole in the page.

The `Content-Security-Policy` in [`public/_headers`](../public/_headers) already allowlists the partner's script and frame hosts. A **new** ad host would be blocked by it — add it to `script-src` / `frame-src` there, or the units silently stay empty.

#### Site verification, and why one tag is not consent-gated

Setting `ADSENSE_CLIENT` also emits `<meta name="google-adsense-account">` on every page (from [`SEOHead.astro`](../src/components/seo/SEOHead.astro)), alongside the `/ads.txt` the same value generates. Those two are what AdSense verifies the site with.

They exist because **the ad script alone cannot verify a consent-gated site**. `src/lib/ads.ts` requests `adsbygoogle.js` only for a visitor who switched Advertising on, and neither AdSense's verification crawler nor its policy reviewer accepts a consent banner — so the snippet AdSense hands you on onboarding is never what they find here, and the review stalls on "ad code not found". Google publishes the meta tag for exactly this case.

That tag is the one part of the ad integration deliberately outside the consent gate, and it is allowed to be because it costs the visitor nothing: an inert `<meta>` carrying an account id that already ships publicly in `/ads.txt`. No script, no cookie, no device storage, no request — so ePrivacy Art. 5(3), the rule the gate exists to satisfy, does not reach it. Everything that *does* set storage stays behind the opt-in.

Both signals appear only on a build that has a publisher id, so an unconfigured environment still claims nothing.

Leaving `ADSENSE_CLIENT` unset is a supported state, and is how this ships until the ids are issued.
The build then disables ads everywhere after a single `[ads]` console warning: no partner script is requested, and `public/ads.txt` - generated from that same value by `scripts/generate-ads-txt.mjs` during `prebuild` - is not written at all.
An `ads.txt` naming no seller is worse than none, because that is the file a crawler reads as a domain that has revoked every seller it had.

Note that `ads.txt` publishes the publisher id **without** the `ca-` prefix the ad tag carries: `ca-pub-123` in the repo setting becomes `google.com, pub-123, DIRECT, …` in the file. The generator does that conversion; nothing needs entering twice.
It also validates the value first - anything that is not `ca-pub-<digits>` fails the build, because every line of that file authorises somebody to sell this domain's inventory and a stray character would publish a record naming the wrong seller.
The site build applies the same check to the same value (`publisherId()` in `src/lib/ads-env.ts`): a publisher id the generator refuses is one the page will not ask the partner to serve against either, so the two halves of the setting cannot disagree.

Ads are additionally gated on consent at runtime, so a configured publisher id on its own serves nothing.
The partner script is requested only for a visitor who switched **Advertising** on in the consent dialog; a decline, an unanswered banner and a GPC/DNT signal all leave it unrequested.
That is stricter than serving non-personalised ads to a decline, and deliberately so: the ad tag writes cookies and device storage of its own (frequency capping, reporting, fraud) as soon as it runs, which ePrivacy Art. 5(3) conditions on consent whether or not the ads are personalised.

### Response headers

`apps/web/public/_headers` sets the response headers for every route Cloudflare Pages serves - a Content-Security-Policy, plus `X-Content-Type-Options`, `Referrer-Policy` and `Strict-Transport-Security` - and Astro copies the file to the site root like the rest of `public/`.
It exists because the ad tag is the first third-party script this site executes: the `script-src` allowlist is what keeps a hijacked tag from pulling further code in from anywhere it likes.
Adding a third-party script (a new analytics tool, another ad network) or an embed (a video, a map) means adding its origin there in the same change - the browser blocks anything not listed, and the feature then silently does nothing.

### Cloudflare R2 (only if you've enabled R2 for images)

These are read by the publishing pipeline, **not** by the website build. Add them only when you wire R2 into the agent:

| Secret                  | Notes                                                              |
| ----------------------- | ------------------------------------------------------------------ |
| `R2_ACCOUNT_ID`         | Same as `CLOUDFLARE_ACCOUNT_ID`.                                   |
| `R2_ACCESS_KEY_ID`      | Cloudflare → R2 → Manage API Tokens → Create R2 Token.             |
| `R2_SECRET_ACCESS_KEY`  | Shown once at token creation; store immediately.                   |
| `R2_BUCKET`             | The bucket name, e.g. `sleekdrops-images`.                         |
| `R2_PUBLIC_URL`         | Custom domain bound to the bucket, e.g. `https://images.sleekdrops.com`. |

### Optional / future

| Secret                 | When                                                                  |
| ---------------------- | --------------------------------------------------------------------- |
| `PUBLISH_API_URL`      | Backend endpoint the publishing pipeline POSTs to.                    |
| `PUBLISH_API_TOKEN`    | Bearer token for the publish API.                                     |

---

## One-time Cloudflare Pages setup

You said the Cloudflare Pages project already exists. Confirm it's configured for **Direct Upload** (also called "wrangler" mode), not "Connect to Git" — these workflows push the built `dist/` directly. If the project is currently in Git-connected mode, disconnect it in the Pages dashboard so the wrangler deploys don't fight the auto-deploys.

For the develop environment, the simplest setup is to use the **same** Pages project with a different `--branch` flag (already configured in the workflow). Cloudflare Pages treats anything other than the production branch as a preview deploy; you then bind `develop.sleekdrops.com` to the `develop` preview branch in **Pages → Custom domains**.

---

## API token scopes (the minimum)

When creating `CLOUDFLARE_API_TOKEN`, scope it to:

- **Account: Cloudflare Pages → Edit**
- **Account: Account Settings → Read** (required by wrangler-action)
- Account resource scoped to *your* account only

Avoid the "Global API Key" — it has no scope limits.

---

## Branching workflow

```
feature/foo → PR → develop → (deploy to develop.sleekdrops.com, QA)
develop ──────── PR → main ─→ (deploy to sleekdrops.com, live)
```

Direct pushes to `main` are allowed by the workflow but discouraged. If you protect the branch in GitHub settings, use status checks `Build & type-check` (from `pr-checks.yml`) as the required gate.
