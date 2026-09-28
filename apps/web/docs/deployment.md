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

### Only production is indexable

Both deploy workflows set `PUBLIC_SITE_ENV` — `production` on production, `preview` on develop. It is a plain workflow value, not a repo variable, because it is a property of the deployment rather than a setting anyone tunes.

| Value | robots meta on every page | `robots.txt` |
| --- | --- | --- |
| `production` | `index, follow` (a page asking for `noindex` still gets `noindex, follow`) | crawl rules **plus** the `Sitemap:` line and the `/llms.txt` pointers, built from `SITE_URL` |
| anything else | `noindex, nofollow` | the same crawl rules, **no** sitemap and no absolute pointers, and a header saying it is a preview |

**Only the exact string `production` is indexable.** Unset, empty, misspelled or `Production` all read as a preview, so a preview environment added later is safe because it did nothing rather than because someone remembered this page.

That direction is deliberate. `develop` is held at the same code level as `main` and renders the same pages from the same live editorial content, so an indexable preview is a complete second copy of the site competing with the real one for its own rankings — and, to an AdSense reviewer, duplicated content on a domain the account does not own.

The failure in the other direction — production's line going missing and silently de-listing the live site — does not break a build and would be invisible for weeks, so [`src/lib/site-env.test.ts`](../src/lib/site-env.test.ts) asserts both halves and fails CI instead.

**The preview `robots.txt` deliberately does not `Disallow: /`.** What keeps a preview out of the index is the `noindex` on every page, and Google is explicit that a page blocked by `robots.txt` cannot be crawled and therefore cannot have its `noindex` seen — a blanket disallow would *preserve* anything already indexed rather than remove it. Blocking discovery and blocking indexing are different jobs; `noindex` is the one that does the second.

The build runs `pnpm prebuild` (which generates `public/_redirects` from `src/data/affiliate-links.json`) → `astro check` → `astro build`. Output goes to `dist/`. `wrangler-action@v3` pushes `dist/` to the matching Cloudflare Pages project.

---

### Canonical URLs, the sitemap and IndexNow

`astro.config.mjs` sets `build.format: 'file'`, so a page is written as
`blog/<slug>.html` and Cloudflare Pages serves it at `/blog/<slug>` - the form the
canonical tag, the sitemap, the RSS feed and the JSON-LD all name.
With Astro's default directory layout Pages 308-redirected every one of those URLs to the
trailing-slash form, and Google indexed the slash form.

**Both forms answer 200; neither redirects.**
`apps/web/functions/_middleware.js` (logic in `functions/_lib/canonical.mjs`) serves a
trailing-slash request the canonical slash-less asset through `env.ASSETS.fetch`, passing
the asset's own status, body and headers - the `public/_headers` policy included - straight
back.
Everything else falls through to `next()` untouched: canonical URLs, the site root, `/go/*`
(which belongs to the affiliate Function) and any non-GET request.
The duplicate URL still consolidates on the canonical tag, so the slash-less form remains the
one indexed.

Why the slash form is not simply redirected back, which is the obvious fix and the wrong one:
**reversing a permanent redirect needs a 200 leg, or it closes a loop.**
A 308 is cached by the browser and by the edge indefinitely, so after the flip above, every
client holding the *old* `/blog/<slug>` → `/blog/<slug>/` redirect met a server insisting on
the reverse, with no 200 anywhere in the chain - Chrome's `ERR_TOO_MANY_REDIRECTS`, on
roughly half of page loads, clearing only when Chrome dropped the poisoned entry.
The stale leg lives in the client, so it cannot be redirected away: a 302 or 307 in place of
the 308 closes exactly the same loop.
One leg answering 200 is the only thing that breaks it without asking every visitor to clear
their cache.
The cost is that a root middleware runs on every request the project serves, so
`public/_routes.json` keeps the hashed build output (`/_astro/*`) and the fonts out of it -
neither can ever be a trailing-slash page, and they are the bulk of the requests.
Everything else, `/go/*` included, stays on `/*` and reaches its Function as before; excluding
a path there would silently take its Function offline, which is what
`src/lib/canonical-url.test.ts` pins.

The edge's own copy of a stale redirect is cleared by the **Purge the Cloudflare edge cache**
step in both deploy workflows, which `POST`s `purge_everything` to the zone after the deploy
and fails the run if the purge does not return 200.
It needs `CLOUDFLARE_ZONE_ID` (Cloudflare → the zone → Overview → Zone ID) and a
`CLOUDFLARE_API_TOKEN` carrying **Zone → Cache Purge → Purge** on top of its Pages scopes;
with no zone id set it warns and skips, which is the state of the develop deploy while it is
served from the bare `*.pages.dev` host - that is Cloudflare's zone, not this account's, and
cannot be purged.

After a deploy, all four forms must answer at most one hop and end in 200:

```
curl -sIL https://sleekdrops.com/blog             # 200
curl -sIL https://sleekdrops.com/blog/            # 200, served by the middleware
curl -sIL https://sleekdrops.com/blog/<slug>      # 200
curl -sIL https://sleekdrops.com/blog/<slug>/     # 200, served by the middleware
```

A 3xx on any of them is the regression this section exists to prevent.

The sitemap carries a `lastmod` per URL, derived from post dates by
`src/lib/sitemap-policy.mjs` (a post's `updatedDate ?? pubDate`; the newest post a
listing holds). The same module leaves out tag pages with fewer than three posts
and empty review or guide hubs. Time-sensitive deal and promo hubs stay out of
the sitemap and are linked from navigation only while they have live inventory.
The empty pages also `noindex` themselves.

`/llms.txt` and `/llms-full.txt` are the crawl surface written for a retrieval
agent rather than a reader: the site description, the categories that have
articles, and the strongest articles with a one-line summary each in the short
file, every live article with a fuller summary in the long one. Both are built
from the content collection on every build by `scripts/generate-llms-txt.mjs`
(rules in `src/lib/llms-txt.mjs`), so neither is ever hand-maintained. A build
with no live articles writes neither, and `generate-robots.mjs` - which runs
after it - only names them in `robots.txt` when they exist.

`robots.txt` names the major AI crawlers and answer engines explicitly
(`src/lib/robots-policy.mjs`), with the same policy the wildcard carries: the
articles are open, `/api/` and `/go/` are not. A named group *replaces* the
wildcard for that agent under RFC 9309, so the group repeats both disallows;
`src/lib/robots-policy.test.ts` parses the emitted file and asserts `/go/` stays
disallowed for every token, which is the assertion that would catch a group
accidentally split in two.

After the production deploy, `scripts/indexnow-submit.mjs` POSTs the URLs whose
lastmod changed in the last 36 hours to IndexNow, which fans out to Bing,
Yandex, Naver, Seznam, Yep and Amazon (Google does not take part). The key it
presents is `public/indexnow-key.txt`, served at the site root; rotate it by
writing a new 32-character value into that file. The step is best-effort and
never fails the deploy. Bing Webmaster Tools shows what was received under
IndexNow.

## Required GitHub repository secrets

Add these in **Settings → Secrets and variables → Actions → Repository secrets**. Production-only values can be scoped via GitHub Environments if you want stricter separation (see the `environment:` block in each workflow).

### Cloudflare Pages (required for any deploy)

| Secret                     | Where to get it                                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`     | Cloudflare → My Profile → API Tokens → Create Token → template **"Edit Cloudflare Workers"** *or* a custom token with **Account → Cloudflare Pages: Edit**. |
| `CLOUDFLARE_ACCOUNT_ID`    | Cloudflare dashboard right sidebar of any zone, or **Workers & Pages → Overview**.                               |
| `CLOUDFLARE_PROJECT_NAME`  | The name of the Pages project you created — e.g. `sleekdrops` (used in the wrangler command).                    |
| `CLOUDFLARE_ZONE_ID`       | Cloudflare → the zone serving this environment → Overview → **Zone ID**. Used by the post-deploy cache purge; unset means the purge warns and skips (see *Canonical URLs* above). |

### DevTeam Analytics (required for the analytics + logging sink)

**DevTeam publishes all four of the settings below itself** — into this repo's Actions secrets and variables on the deployment environment matching the DevTeam environment — whenever analytics is provisioned or an A/B client key is minted.
Nobody copies a key by hand, and nothing here needs setting up manually.
The names are DevTeam's canonical ones, so the platform, this repo's settings, and the workflows below cannot drift apart.

If a value is ever missing, re-run the publish from the DevTeam project's **Config** tab (**Sync to GitHub**) rather than pasting one in — a hand-entered key goes stale the next time the project re-provisions.

Anonymous analytics runs by default on every deployment (see the GA4 section below); the develop workflow additionally passes the DevTeam key and host into its non-production build, so on develop the same events also reach the DevTeam sink. A stored opt-out or a GPC/DNT signal still disables everything.
The production workflow passes literal empty values, and `src/lib/analytics-env.ts` independently discards a key from any build marked `PUBLIC_SITE_ENV=production`. The live `sleekdrops.com` build therefore cannot initialise the DevTeam SDK even if someone later wires a production secret into the workflow by mistake.

| Repo setting                                | Kind         | What it is                                                                          |
| ------------------------------------------- | ------------ | ------------------------------------------------------------------------------------ |
| `DEVTEAM_ANALYTICS_INGEST_KEY`              | **secret**   | The project's ingest key (`dtp_…`). Ingest-only.                                    |
| `DEVTEAM_ANALYTICS_HOST`                    | **variable** | The platform's ingest host, e.g. `https://ingest.analytics.internal.getdevteam.ai`. |

An empty key disables the DevTeam sink. GA4 is unaffected.

The pair is not uploaded to Pages Functions. The deployed `/go` route explicitly supplies no telemetry credentials; affiliate redirects and attribution continue to work without sending click data to this processor.

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

**Analytics is on by default.** gtag.js loads on every page view unless the visitor has switched analytics off under **Privacy preferences** in the footer or their browser sends a Global Privacy Control / Do-Not-Track signal. The site is Australian, where first-party aggregate analytics does not need a prior opt-in, and the default is the site's policy rather than a per-deployment setting (`defaultConsent` in `src/lib/analytics-env.ts`, pinned by a regression test).
The tag declares a Consent Mode v2 default of `analytics_storage: granted` before it loads and nothing about advertising - the ad partner's consent platform owns those signals. A withdrawal pushes `analytics_storage: denied`, sets the tag's own `ga-disable-<id>` flag and deletes its `_ga` cookies in the same page load.

This matters because it was not always so. From 2026-09-12 (PR #55) to 2026-09-28 production resolved the default to `denied`, so GA4 counted only visitors who had opened the footer dialog and switched analytics on: the property read "No data received" for a fortnight while every deploy was green and the measurement id was correctly inlined. The Mediavine application reads its sessions from that property. See [`mediavine-readiness-2026-09.md`](./mediavine-readiness-2026-09.md).

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

### Journey by Mediavine (required for ads to serve)

The site's advertising partner is **Journey by Mediavine**, which requires exclusivity: no other programmatic network's tag, and no other seller's line in `ads.txt`. Everything AdSense-specific was removed on 2026-09-28; the readiness write-up is [`mediavine-readiness-2026-09.md`](./mediavine-readiness-2026-09.md).

The production workflow passes one value into the web build as `PUBLIC_MEDIAVINE_SITE_ID`, and reads one more at build time.

| Repo setting          | Kind         | What it is                                                                                                   |
| --------------------- | ------------ | ------------------------------------------------------------------------------------------------------------ |
| `MEDIAVINE_SITE_ID`   | **variable** | This site's id: the `<id>` in the script wrapper `//scripts.scriptwrapper.com/tags/<id>.js`, from the Journey dashboard → Settings → Ad Setup, issued once the site is approved. |
| `ADS_TXT_URL`         | **variable** | Optional. A URL the build fetches the authorised-sellers file from instead of publishing the committed copy at `apps/web/ads/ads.txt`. Leave unset for Journey, which issues a file to download. |

Set both under **Settings → Environments → `production` → Environment variables**. They are `PUBLIC_`/build values that ship in the markup, not secrets.

**Develop carries no site id, and cannot be given one by a variable.** `deploy-develop.yml` pins `PUBLIC_MEDIAVINE_SITE_ID: ''` outright rather than reading `vars.MEDIAVINE_SITE_ID`, for the reason the AdSense publisher id was pinned: GitHub resolves `vars.X` as environment → repository → organization, so a repo-level value would silently reach develop - and the wrapper is issued for `sleekdrops.com` and, in Mediavine's words, only works on the site it was generated for. `src/lib/ads-env.ts` independently discards the id unless `PUBLIC_SITE_ENV=production`, and `generate-ads-txt.mjs` applies the same gate, so a leaked or inherited value cannot make `sleekdrops.pages.dev` serve ads or publish a seller record. Tests in [`src/lib/ads-env.test.ts`](../src/lib/ads-env.test.ts) hold every half of this.

#### What the integration is

One script tag, on every page, in the head, emitted by [`src/components/ads/MediavineScript.astro`](../src/components/ads/MediavineScript.astro) from `BaseLayout` - the only component in the site that emits ad markup:

```html
<script type="text/javascript" async="async" data-noptimize="1" data-cfasync="false" src="https://scripts.scriptwrapper.com/tags/<id>.js"></script>
```

Mediavine's wrapper does everything else: it places, sizes and refreshes the in-content units, the sticky sidebar unit and the mobile adhesion unit, keeps the density inside Coalition for Better Ads limits, and shows its own consent notice in the EEA, UK and Switzerland. The site has **no ad units, slot ids or placement rules of its own**; there is nothing per-placement to configure. The `data-noptimize` / `data-cfasync` attributes must stay - they stop minifiers and Cloudflare's Rocket Loader from rewriting the tag, which Mediavine's installation check would read as "script not found".

Two landmarks in the markup tell the wrapper where the content is, because a custom-built site has no theme structure it recognises:

| Landmark          | Where                                                          | Requirement it meets                                                                      |
| ----------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `journey-content` | The article body wrapper in [`ArticleBody.astro`](../src/components/article/ArticleBody.astro) - the element whose *immediate* children are the paragraphs and headings. | In-content units are inserted between those children. Must be on the direct parent, and once per page. |
| `journey-sidebar` | The article rail in [`blog/[slug].astro`](../src/pages/blog/[slug].astro).   | Sidebar unit. The rail is 300px wide (the floor, excluding padding), `position: static` (the wrapper drives the unit's stickiness itself) and visible from a 1001px viewport up. |

Article pages are the only pages with both landmarks; listings carry neither, and Mediavine decides for itself whether a listing gets a unit. After approval, Mediavine's **Dashboard Error Form** has to be submitted once to enable the custom-site page-load listeners, and `?test=placeholders` on any article forces placeholder units wherever the wrapper would place them - the check that the landmarks are being found. If they are not, the same selectors go into Journey's Settings → Ad Settings → Ad Placement Selectors (`.journey-content`, `.journey-sidebar`).

#### ads.txt

`public/ads.txt` is generated during `prebuild` by [`scripts/generate-ads-txt.mjs`](../scripts/generate-ads-txt.mjs) and is gitignored like `_redirects` and `robots.txt`. Its source is the file Journey issues in the dashboard, committed at [`apps/web/ads/ads.txt`](../ads/README.md), or `ADS_TXT_URL` fetched at build time when that is set. Production only: any other build removes the generated file, because a seller record on a domain the partner has not approved authorises sellers for a site that does not exist.

The content is validated - at least one `domain, seller id, DIRECT|RESELLER` record - and an invalid source fails the build rather than publishing a 404 page under the name. When the Journey dashboard's ads.txt health check turns yellow or red, download the new file, replace the committed copy, merge to `main`, and press the dashboard's refresh once the deploy is live. **Never add another network's lines**: that is what violates Journey's exclusivity.

#### Privacy policy and consent

Journey requires its "Mediavine Advertising Privacy Notice v. 1.2" verbatim on the privacy policy, linked from the homepage. It is in [`privacy.astro`](../src/pages/privacy.astro) under *Advertising partners*, and the footer links the policy from every page. The consent notice itself, and the "Update Privacy Settings" / "Do Not Sell or Share My Information" footer controls it refers to, are rendered by Mediavine's wrapper where the law requires them; the site's own **Privacy preferences** dialog decides analytics only, so there are never two controls for the same advertising purpose. The Journey dashboard's *Privacy Notice Location* setting should point at the footer.

Leaving `MEDIAVINE_SITE_ID` unset is a supported state, and is how this ships until Journey issues the id: no partner script is requested and no ads.txt is published.

### Response headers

`apps/web/public/_headers` sets the response headers for every route Cloudflare Pages serves - a Content-Security-Policy, plus `X-Content-Type-Options`, `Referrer-Policy` and `Strict-Transport-Security` - and Astro copies the file to the site root like the rest of `public/`.
The policy is hygiene rather than an allowlist: `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'self'`, `form-action 'self'` and `upgrade-insecure-requests`, with script, frame, image and connection sources open to any https origin.
It used to allowlist the ad hosts by name, and that is exactly what Mediavine says not to do: programmatic advertising runs auctions across dozens of exchanges, the winning bidder serves from a domain the last impression did not use, and every host missing from the list is an ad that silently fails to render. Their guidance is a nonce-based `strict-dynamic` policy or `upgrade-insecure-requests`; a static host cannot mint a per-response nonce, so this is the latter. Do not add a domain allowlist back "to be safe" - it goes stale and adds nothing.

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
- **Zone: Cache Purge → Purge**, for the zone in `CLOUDFLARE_ZONE_ID` (the post-deploy purge)
- Account resource scoped to *your* account only

Avoid the "Global API Key" — it has no scope limits.

---

## Branching workflow

```
feature/foo → PR → develop → (deploy to develop.sleekdrops.com, QA)
develop ──────── PR → main ─→ (deploy to sleekdrops.com, live)
```

Direct pushes to `main` are allowed by the workflow but discouraged. If you protect the branch in GitHub settings, use status checks `Build & type-check` (from `pr-checks.yml`) as the required gate.
