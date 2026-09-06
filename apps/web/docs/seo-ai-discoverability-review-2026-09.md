# Search and AI discoverability review — 6 September 2026

Status: **research, for review**. Nothing here is implemented. Each item is
marked Do / Later / Ignore so the list can be turned into tickets.

Scope: validate the suggestions a Gemini session made about SleekDrops
("shopping" structured data, robots.txt for AI bots, sitemap, canonicals,
schema, internal links, IndexNow), check each against what the site actually
ships today, and work out whether a "Buy" button that fires the affiliate link
is allowed and worth doing. SleekDrops sells nothing; it earns Amazon Associates
commission (AU tag `-22`, US tag `-20`) through the `/go/<slug>` redirect.

Everything below was checked against the live site on 6 Sept 2026 and against
the code at `origin/develop` (`5b44d3e`). Sources are listed at the end.

---

## 1. The short version

Three things matter more than anything Gemini listed:

1. **Every canonical URL on the site redirects.** Astro's default
   `build.format: 'directory'` emits `blog/<slug>/index.html`, so Cloudflare
   Pages serves `/blog/<slug>/` and 308-redirects `/blog/<slug>` to it. The
   canonical tag, the sitemap and the JSON-LD all name the slash-less URL, so
   Google is being told "the real page is the one that redirects to me". Google
   has indexed the trailing-slash version. One config line fixes it.
2. **Affiliate links in the article body carry no `rel` attribute at all**, and
   the site displays Amazon prices in prose ("DJI Mic 3 at $479") without an
   API source or timestamp. Both are policy problems: Google wants
   `rel="sponsored"`, and Amazon's Program Policies §2(b) only allow prices that
   come from the Creators API or an Amazon-served link.
3. **The site claims testing it does not do.** "We test the product before
   linking it", "Two-week test minimum", "side-by-side testing across at least
   three contenders", "Independent, ad-free" (while running AdSense). The
   pipeline is explicitly editorial synthesis. This is the biggest E-E-A-T and
   consumer-law exposure on the site and no schema fixes it.

Gemini's Shopping / Merchant Center idea is wrong for us (Merchant Center bans
affiliate-link promotion outside the EEA/UK/Swiss CSS programme). Its robots.txt
idea is unnecessary and slightly harmful. Its sitemap, canonical, Article
schema, internal-link and IndexNow points are right, and half of them are
already done.

A Buy button is fine, with constraints: label it "Check price on Amazon" or
"View at Amazon AU", never a bare "Buy now"; show no price unless it comes from
the Creators API with an "as of" stamp; `rel="sponsored noopener"`; disclosure
next to it, not only in the footer.

---

## 2. Gemini's suggestions, one by one

| # | Gemini said | Verdict | Why |
|---|---|---|---|
| 1 | Add `Product` + `Review` schema so shopping engines pull ratings into an "Editorial Reviews" section | **Partly right, wrong mechanism** | Google's *product snippets* (not merchant listings) are exactly for "editorial product review pages" and support pros/cons. But they only apply to single-product pages, never to "best X" roundups, and there is no "editorial reviews" feed into Google Shopping. Our review-schema builder already exists (`src/lib/seo.ts` `buildReviewSchema`) but is dead code: the agent never emits `postType: review` or a `product` block. It also hard-codes USD, fakes an `AggregateRating` of one review, and points `Offer.url` at the robots-blocked `/go/` path. |
| 2 | Optimise for Google's product reviews system (measurements, hands-on evidence, comparisons, multiple sellers) | **Right, and it is the real lever** | The reviews system is still a named ranking system, updated continuously since Nov 2023. Its guidance is the checklist for our content: first-hand evidence, quantitative measurements, comparisons, links to multiple sellers. Today we can honestly offer AU price/availability checks with dates, comparisons and pros/cons. We cannot honestly claim lab testing, and the site currently does. |
| 3 | Google Merchant Center / Manufacturer Center for publishers and affiliates | **Ignore** | Merchant Center: "You're not allowed to use Shopping to promote affiliate or pay-per-click links to products, except when participating as a Comparison Shopping Service (CSS) in a CSS program country." CSS is EEA + UK + Switzerland; Australia is not included. Product Ratings feeds need a merchant account and reviews "honestly solicited from customers who made a purchase". Manufacturer Center is for brands. Editorial content reaches Shopping only via normal organic crawling. |
| 4 | Explicitly `Allow: /` for `OAI-SearchBot`; distinguish it from `GPTBot` | **Ignore the Allow group; the distinction is correct** | Our `User-agent: *` already allows every bot; verified live: GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot, bingbot and Googlebot user agents all get 200. A specific `User-agent: OAI-SearchBot` group would *replace* the `*` group for that bot (RFC 9309 §2.2.1, Google robots docs), silently dropping `Disallow: /api/` and `/go/` unless re-listed. The real risk is not robots.txt, it is Cloudflare's bot toggles (see §3.8). |
| 5 | Clean XML sitemap with accurate `lastmod` | **Do** | Sitemap exists (`sitemap-index.xml` → `sitemap-0.xml`, 124 URLs) but has zero `lastmod` tags, and 84 of the 124 URLs are tag pages, 11 of 12 sampled holding a single post. Google and Bing both say they use `lastmod` when it is accurate and ignore `changefreq`/`priority`. |
| 6 | Submit to Google Search Console and Bing Webmaster Tools | **Do (manual)** | Not a code change. Bing matters more than it looks: its index feeds Copilot, DuckDuckGo and is a named provider for ChatGPT search. Bing Webmaster Tools can import the GSC verification in one click. |
| 7 | Proper self-referencing canonicals | **Do, urgently** | Canonicals exist and self-reference, but they name a URL that 308-redirects (§3.1). |
| 8 | Keep title, `<title>`, H1 and topic aligned | **Already done** | `<title>` and H1 are the same field; `<title>` adds " \| SleekDrops". Minor: the pipeline spends its 60-char budget before the 13-char suffix, so titles can hit ~73 chars. |
| 9 | Add `Article` JSON-LD with headline, author, dates, image, publisher | **Already done; polish** | Shipped on every post. Gaps: `author` has no `url` to `/author/<id>`; `publisher.logo` is the 1200×630 social card, not a logo; `dateModified` always equals `datePublished`; no `inLanguage`. |
| 10 | Put the answer near the top | **Already done** | The pipeline's GEO rules mandate a 40–60-word answer block under every H2 and a "short answer" section. |
| 11 | Strong internal links (hub → article, related articles, new → old) | **Do** | Real gap. The pipeline's link rules cover affiliate links only; no article links to another SleekDrops article. `RelatedPosts` falls back to "newest 3" so every page shows the same three. `/reviews` is permanently empty; roundups have no hub. |
| 12 | Backlinks / citations from relevant Australian sites | **Right, non-technical** | Out of scope for the codebase. |
| 13 | Keep the article body in plain HTML | **Already true** | Fully static build; body is server HTML; the only client JS is progressive enhancement. |
| 14 | IndexNow on publish | **Do** | Cheap. Participants: Bing, Yandex, Naver, Seznam, Yep, Amazon. Google does not participate. Publishing already triggers a rebuild via `repository_dispatch`; nothing pings anyone afterwards. |
| 15 | The real problem is domain authority and time | **Right** | 16 posts, no external links in articles, no backlinks. Structured data does not change ranking (Mueller, April 2025: "Structured data won't make your site rank better"). |

Also from Gemini: "shopping search engines look for structured, mathematical
e-commerce data". True for Google Shopping, which ingests merchant feeds. It is
not something a publisher can plug into.

---

## 3. What the audit found that Gemini did not

Ranked by impact.

### 3.1 Every canonical URL 308-redirects (P0)

Observed live:

```
https://sleekdrops.com/blog/harman-kardon-luna-2    → 308 → …/harman-kardon-luna-2/
https://sleekdrops.com/blog/harman-kardon-luna-2/   → 200
<link rel="canonical" href="https://sleekdrops.com/blog/harman-kardon-luna-2">
sitemap-0.xml: <loc>https://sleekdrops.com/blog/harman-kardon-luna-2</loc>
```

Google has indexed `…/harman-kardon-luna-2/`, the opposite of what the canonical
says. Astro's docs are explicit that `trailingSlash` "only affects the dev
server and on-demand rendered pages"; static output is decided by
`build.format`, whose default `'directory'` writes `slug/index.html`. Cloudflare
Pages then redirects `/slug` to `/slug/` because that is where the file is.

Fix (`apps/web/astro.config.mjs`):

```js
build: { format: 'file' },   // emits blog/<slug>.html → served at /blog/<slug>
trailingSlash: 'never',      // already set
```

Cloudflare then serves `/blog/<slug>` directly and 308s `/blog/<slug>/` back to
it, which matches the canonical, sitemap and JSON-LD. `absoluteUrl()` builds
URLs from pathnames, not `Astro.url`, so canonicals will not gain `.html`. Also
set `trailingSlash: false` in the `rss()` call in `src/pages/rss.xml.ts`; the
feed currently emits `/blog/<slug>/` links because `@astrojs/rss` adds a slash
regardless of config. Verify after deploy with the curl above, then request
re-indexing in Search Console.

### 3.2 Body affiliate links have no `rel`; CTA labels hide the destination (P0)

Article-body links are markdown `[text](/go/<slug>)` and render as
`<a href="/go/…">` with no `rel`, no `target`. Only the `Verdict` and
`ProductCallout` components add `rel="sponsored nofollow noopener noreferrer"`,
and those components never render on pipeline posts. Live count on the Luna 2
review: 2 `/go/` anchors, 0 `sponsored`, 0 `nofollow`.

Google: "Mark links that are advertisements or paid placements … with the
sponsored value." Because `/go/` is robots-blocked, the `rel` on the anchor is
the only signal Google sees.

Amazon Program Policies §6(w): "You will not use a link shortening service,
button, hyperlink or other ad placement in a manner that makes it unclear that
you are linking to an Amazon Site." Live roundup anchor texts include "Find out
more" and "Check the current price" with no mention of Amazon.

Fix: a rehype plugin in `astro.config.mjs` that adds `rel="sponsored noopener"`
to any `a[href^="/go/"]`; a pipeline rule that CTA anchor text names Amazon
("See today's price on Amazon" already appears and is fine).

### 3.3 Prices in prose breach Amazon's pricing rule (P0, compliance)

Live: "priced in AUD and checked 6 September 2026: DJI Mic 3 at $479, Mic Mini 2
at $149, RØDE from $139", and AUD figures throughout roundups.

Amazon Program Policies, Participation Requirements §2(b): "your Site may only
show prices and availability if: (a) we serve the link in which that price and
availability data are displayed, or (b) you obtain Product pricing and
availability data via Creators API or PA API". Even with the API, prices
refreshed less than hourly need an adjacent date/time stamp and the disclaimer
"Product prices and availability are accurate as of the date/time indicated and
are subject to change."

PA-API 5 is retired (calls return 403); the successor Creators API requires "at
least 10 qualifying sales within the past 30 days". Until then the only
compliant option is **no numeric Amazon prices**. Price *bands* not attributed
to Amazon ("under $200") are a grey area; RRP from the manufacturer with a
source is safer. This is a pipeline prompt change in `apps/agent`.

### 3.4 The site claims hands-on testing it does not do (P0, trust)

Live copy:

- Every article footer: "Our reviews are independent. **We test the product
  before linking it.**"
- `/reviews`: "Independent · **Two-week test minimum**"
- `/guides`: "**Tested across at least three contenders**"
- `/about`: "Independent, **ad-free**" (AdSense units ship)

The pipeline's own writer instruction is to "include the honesty disclaimer
(editorial synthesis, not lab-tested)". Google's reviews guidance asks for
"evidence such as visuals, audio, or other links of your own experience"; the
FTC Endorsement Guides and the ACCC both treat misleading review claims as
actionable (ACL s18/s29; ACCC: reviews "should be independent and reflect the
genuine opinion of the person who experienced the product"). The six bylines
are fictional personas on fully AI-generated content, which Google's helpful
content guidance addresses directly: "Is the use of automation, including
AI-generation, self-evident to visitors through disclosures or in other ways?"

Recommendation: rewrite the four claims to what is true (independent, not paid
by brands, prices and availability checked on the stated date, sources cited),
add a "How we research" page, and state that articles are researched and
drafted with AI assistance and editor-reviewed. Whether to keep persona bylines
is a business decision; the risk is Google's "scaled content abuse" policy,
which applies "no matter whether content is produced through automation, human
efforts, or some combination".

### 3.5 Disclosure wording and placement (P1, compliance)

The Amazon Operating Agreement §5 requires "As an Amazon Associate I earn from
qualifying purchases" displayed clearly and prominently. It is absent. The
current disclosure is an 11px `<aside>` at the *bottom* of the article. The FTC
says a reader must "see both the review containing that disclosure and the link
at the same time"; the ACCC's 2023 sweep named "at the very end", "small or hard
to read font" and bio-only disclosures as failing patterns.

Fix: one-line disclosure under the byline on every post ("SleekDrops earns a
commission from Amazon links on this page. As an Amazon Associate we earn from
qualifying purchases."), keep the footer version, add "(paid link)" or an
equivalent inside any product box.

### 3.6 FAQPage schema is dead on Google (P2, remove a false assumption)

Google's changelog, 8 May 2026: "This feature will no longer appear in Google
Search starting May 7, 2026"; 15 June 2026: documentation removed. Our pipeline
mandates a FAQ section "because apps/web turns it into FAQPage" and `seo.ts`
calls the markup "the strongest single signal we can ship" for AI engines.
Google's May 2026 AI guide says the opposite: "Structured data isn't required
for generative AI search, and there's no special schema.org markup."

Keep the visible FAQ section: question-shaped headings with 40–60-word answers
are what answer engines quote. Keep the markup if you like (it is valid and
harmless), but stop treating it as a lever.

### 3.7 Index bloat and empty hubs (P1)

Sitemap: 124 URLs, of which 84 are `/tag/*` pages for 16 posts. Sampled 12 tag
pages: 11 have one post, all `index, follow`. `/reviews` (31 words, empty),
`/deals` and `/promos` (empty) are indexed. Thin, near-duplicate listing pages
dilute a 16-post site.

Fix: `noindex` tag pages with fewer than 3 posts and drop them from the sitemap
via the sitemap `filter`; `noindex` `/reviews`, `/deals`, `/promos` until they
have content; add `lastmod` via `serialize()` from `updatedDate ?? pubDate`.

### 3.8 Cloudflare bot controls, not robots.txt, decide AI access (P0, check by 15 Sept)

Cloudflare has blocked AI crawlers by default for zones onboarded since July
2025 and, from 15 September 2026, blocks its "Training" and "Agent" categories
by default on pages that display ads for newly onboarded domains. The changelog
says new domains; sleekdrops.com is an existing zone, so the legacy toggle is
what counts. My user-agent test passing does not prove anything, because
Cloudflare matches verified-bot IP ranges, not the UA string.

Check: Cloudflare dashboard → zone → Security → Settings → "Block AI bots" must
be **Allow** (or at least not "Block on all pages"); then AI Crawl Control →
Crawlers for blocked counts on OAI-SearchBot, PerplexityBot, Claude-SearchBot,
ChatGPT-User. Do not use Cloudflare's "block Training" category toggle: it also
blocks multi-purpose crawlers such as Googlebot and Bingbot. If you want to
refuse training use, do it in robots.txt with a block-only group for GPTBot,
ClaudeBot, Google-Extended, Applebot-Extended, meta-externalagent, CCBot,
Bytespider; the search and user-fetch agents stay allowed and are the ones that
produce citations.

### 3.9 Rich data is thrown away at publish (P1, enabler)

The agent's `research` dossier already holds `products[{name, brand,
approxPrice, amazonUrl, goSlug}]`, `facts[{fact, sourceUrl}]`, `entities`,
`paaQuestions` and a `snippetTarget`. `publisher.ts` writes only
`frontmatter_json` + `body_md` to D1. Everything commerce-shaped that Product
schema, a product box, pros/cons markup or cited sources would need is
discarded. The web content schema already has the `product` shape; the agent
contract has no `product` field and excludes `review` from `POST_TYPES`.

### 3.10 Smaller items

- Region routing sends every non-US/AU/NZ visitor to amazon.com with the US
  tag. Correct as far as it goes. Note Amazon's new US "Global Earning"
  redirect does not cover Australia, so our own AU routing is load-bearing.
- No external citations in articles (0 non-Amazon outbound links on the Luna 2
  review) despite the pipeline's "claim + evidence with named source" rule. The
  GEO paper found citations, quotations and statistics raised generative-engine
  visibility 30–40%.
- RSS declares `en-us` for an Australian site; use `en-AU`.
- `www.sleekdrops.com` has no DNS record; add a CNAME and redirect to the apex.
- Article JSON-LD: `author.url`, `publisher.logo` as an `ImageObject` with a
  square logo, real `dateModified`, `inLanguage: "en-AU"`.
- `CollectionPage.url` on `/blog/2` etc. is hard-coded to page 1 and disagrees
  with the canonical.
- Standalone `Offer` schema on deal pages is not a valid rich-result entity
  (needs a parent `Product`); moot while `dailyDeals` is empty.

---

## 4. The "Buy" button

**Verdict: build it, as a product box, with the constraints below. Do not
label it "Buy".**

What Amazon allows and requires (Program Policies and Operating Agreement,
verified 6 Sept 2026):

- **Label**: "Check price on Amazon", "View at Amazon AU", "See it on Amazon".
  A bare "Buy now" on a `/go/` link risks §6(w) (unclear it links to Amazon).
  No Amazon logo or smile mark for publishers; the only sanctioned asset is the
  "Available at Amazon" badge, with a trademark statement on the site.
- **Price**: none, until the Creators API is available (10 qualifying sales in
  30 days), then hourly refresh or an adjacent "as of <time AEST>" stamp plus
  the exact disclaimer.
- **Images**: do not download and host Amazon product images; you may link an
  Amazon image URL for up to 24 hours. Own photos or brand press assets are
  fine. Check that the manual hero-image workflow never saves Amazon photos.
- **Redirect**: a click-initiated single 302 through `/go/` with the referrer
  preserved is fine; §6(v) is about obscuring the *referring page URL*, and the
  "Redirecting Link" disqualifier is about auto-forwarding pages. Never
  auto-open Amazon. `target="_blank"` on a user click is industry-universal but
  not explicitly blessed by Amazon.
- **Attribution**: the tag must belong to the destination store (`-22` on
  amazon.com.au, `-20` on amazon.com). Our geo-routing already does this.
- **Disclosure**: §5 sentence site-wide plus "(paid link)"-style text next to
  the box; FTC requires the disclosure be visible with the link.

What Google wants: `rel="sponsored"`; "consider including links to multiple
sellers"; product boxes are fine inside genuinely useful review content; the
thin-affiliation policy is the ceiling ("product descriptions and reviews are
copied directly from the original merchant without any original content").

What converts (practitioner evidence, no controlled studies found): a summary
or verdict box near the top, a comparison table with a per-product button on
roundups, a verdict box at the end, in-content text links, and "Check price"
wording. Tom's Guide AU uses "View at Amazon" / "Check Amazon" with
`rel="sponsored noopener" target="_blank"`; RTINGS offers a country selector.
Too many boxes reads as a thin affiliate page; 5–8 products per roundup is the
common ceiling.

Suggested anatomy for SleekDrops: product name, brand, one-line why, 2–3 pros,
1–2 cons, a "Check price on Amazon AU" button (region-aware via `/go/`), a
small "Amazon AU · Amazon US" switch, "(paid link)" text. Data source:
`research.products` passed through the publisher into frontmatter. Same data
later feeds `Product` + `Review` + pros/cons JSON-LD on single-product reviews.

---

## 5. Prioritised plan

### Do now (P0)

| Item | Where | Effort |
|---|---|---|
| `build.format: 'file'`; `trailingSlash: false` in `rss()`; verify canonicals, sitemap and 308s after deploy; request re-crawl | `apps/web/astro.config.mjs`, `src/pages/rss.xml.ts` | Small |
| Rehype plugin: `rel="sponsored noopener"` on `a[href^="/go/"]` | `astro.config.mjs` | Small |
| Stop emitting numeric Amazon prices; CTA anchor text names Amazon | `apps/agent` writer/link rules | Small |
| Disclosure: add Amazon §5 sentence; one-line disclosure under the byline | `AffiliateDisclosure.astro`, `blog/[slug].astro` | Small |
| Rewrite untrue testing / ad-free claims; add "How we research" page | `about.astro`, `reviews/[...page].astro`, `guides/[...page].astro`, `AffiliateDisclosure.astro`, new page | Small, needs copy sign-off |
| Cloudflare: confirm "Block AI bots" = Allow; review AI Crawl Control | Dashboard | Manual, before 15 Sept |
| Google Search Console + Bing Webmaster Tools: verify, submit `sitemap-index.xml` | Dashboards | Manual |

### Next (P1)

| Item | Where | Effort |
|---|---|---|
| IndexNow: key file in `public/`, POST changed URLs after `pages deploy` | `.github/workflows/deploy-production.yml` (+ small script) | Small |
| Sitemap `lastmod` via `serialize()`; filter thin tag pages and empty hubs; `noindex` them | `astro.config.mjs`, tag/hub pages | Small |
| Article JSON-LD polish: `author.url`, `publisher.logo` ImageObject, real `dateModified`, `inLanguage` | `src/lib/seo.ts`, `authors.ts` | Small |
| Internal links: writer gets the live-post list and must link 2–3 relevant SleekDrops articles; `RelatedPosts` by tag overlap; roundups hub; hide `/reviews` until populated | `apps/agent` context, `posts.ts`, pages | Medium |
| Publisher passes `research.products` (and facts with sources) into frontmatter; product box + comparison table components read it | `publisher.ts`, `contract.ts`, `content/config.ts`, components | Medium |
| RSS `en-AU`; `www` CNAME + redirect | `rss.xml.ts`, DNS | Trivial |

### Later (P2)

| Item | Note |
|---|---|
| `Product` + `Review` + `positiveNotes`/`negativeNotes` JSON-LD on single-product reviews | Fix the existing builder: drop `AggregateRating`, AUD, no `offers` without API price, nest `review` inside `Product` once, add `image`. Only valid on `postType: review`, which the pipeline must start producing. |
| Creators API price with timestamp | After 10 qualifying sales in 30 days. |
| Region chooser in the product box | Satisfies Google's "multiple sellers" advice and VPN/expat readers. |
| Optional robots.txt training-bot block | Only if the business decides against training use; search/fetch bots stay allowed. |

### Ignore

- Google Merchant Center, Manufacturer Center, Product Ratings feeds, CSS
  programme: not available to an Australian non-merchant.
- An explicit `User-agent: OAI-SearchBot / Allow: /` group.
- `llms.txt`: no vendor reads it; Google: it "neither harm[s] nor help[s]".
- FAQPage as a Google rich-result strategy; HowTo; sitelinks search box;
  standalone `Offer` markup.
- Buying ads for discovery.

---

## 6. Sources

Google Search Central: product structured data (snippets vs merchant listings)
<https://developers.google.com/search/docs/appearance/structured-data/product>;
product snippets and pros/cons
<https://developers.google.com/search/docs/appearance/structured-data/product-snippet>;
merchant listing eligibility
<https://developers.google.com/search/docs/appearance/structured-data/merchant-listing>;
review snippets
<https://developers.google.com/search/docs/appearance/structured-data/review-snippet>;
Article <https://developers.google.com/search/docs/appearance/structured-data/article>;
updates log (FAQ removal 7 May / 15 June 2026)
<https://developers.google.com/search/updates>;
reviews system <https://developers.google.com/search/docs/appearance/reviews-system>;
write high quality reviews
<https://developers.google.com/search/docs/specialty/ecommerce/write-high-quality-reviews>;
ranking systems guide
<https://developers.google.com/search/docs/appearance/ranking-systems-guide>;
qualify outbound links (`rel="sponsored"`)
<https://developers.google.com/search/docs/crawling-indexing/qualify-outbound-links>;
spam policies (thin affiliation, scaled content abuse)
<https://developers.google.com/search/docs/essentials/spam-policies>;
AI features <https://developers.google.com/search/docs/appearance/ai-features>;
AI optimisation guide
<https://developers.google.com/search/docs/fundamentals/ai-optimization-guide>;
robots.txt semantics
<https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt>;
sitemaps <https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap>;
crawlers <https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers>.

Google Merchant Center: Shopping ads policies
<https://support.google.com/merchants/answer/6363310>; CSS countries
<https://support.google.com/css-center/answer/7524491>; product ratings
<https://support.google.com/merchants/answer/14549080>.

Amazon Associates: Program Policies (AU)
<https://affiliate-program.amazon.com.au/help/operating/policies>; Operating
Agreement (AU) <https://affiliate-program.amazon.com.au/help/operating/agreement>;
trademark guidelines
<https://affiliate-program.amazon.com/help/operating/amazonmarks/>; Creators API
introduction
<https://affiliate-program.amazon.com/creatorsapi/docs/en-us/introduction>;
PA-API 5 deprecation
<https://affiliate-program.amazon.com/creatorsapi/docs/en-us/paapiv5-deprecation>;
OneLink <https://affiliate-program.amazon.com.au/help/node/topic/G8JHEWQ9GTDUN7EH>.

Regulators: FTC Endorsement Guides 16 CFR 255
<https://www.law.cornell.edu/cfr/text/16/255.5>; FTC FAQ
<https://www.ftc.gov/business-guidance/resources/ftcs-endorsement-guides-what-people-are-asking>;
ACCC managing online reviews
<https://www.accc.gov.au/business/advertising-and-promotions/managing-online-reviews>;
ACCC influencer sweep
<https://www.accc.gov.au/system/files/social-media-influencer-testimonials.pdf>.

AI crawlers: OpenAI <https://developers.openai.com/api/docs/bots>; Anthropic
<https://support.claude.com/en/articles/8896518>; Perplexity
<https://docs.perplexity.ai/guides/bots>; Apple
<https://support.apple.com/en-us/119829>; RFC 9309
<https://www.rfc-editor.org/rfc/rfc9309.html>.

Cloudflare: AI traffic options changelog (15 Sept 2026 defaults)
<https://developers.cloudflare.com/changelog/post/2026-07-01-ai-traffic-options/>;
Block AI bots
<https://developers.cloudflare.com/bots/additional-configurations/block-ai-bots/>;
AI Crawl Control <https://developers.cloudflare.com/ai-crawl-control/get-started/>;
managed robots.txt
<https://developers.cloudflare.com/bots/additional-configurations/managed-robots-txt/>;
Pages serving behaviour
<https://developers.cloudflare.com/pages/configuration/serving-pages/>.

IndexNow and Bing: <https://www.indexnow.org/faq>;
<https://www.bing.com/indexnow/getstarted>; Bing on `lastmod`
<https://blogs.bing.com/webmaster/february-2023/The-Importance-of-Setting-the-lastmod-Tag-in-Your-Sitemap>;
Bing sitemaps and AI answers
<https://blogs.bing.com/webmaster/July-2025/Keeping-Content-Discoverable-with-Sitemaps-in-AI-Powered-Search>.

Astro / trailing slash: configuration reference
<https://docs.astro.build/en/reference/configuration-reference/>; RSS recipe
<https://docs.astro.build/en/recipes/rss/>; the same fix written up
<https://realmorrisliu.com/thoughts/fixing-astro-seo-cloudflare-trailing-slash/>.

Evidence on AI citations: GEO paper (Aggarwal et al. 2023)
<https://huggingface.co/papers/2311.09735>; Ahrefs on AI/organic overlap
<https://ahrefs.com/blog/ai-search-overlap/>; Ahrefs `llms.txt` study
<https://ahrefs.com/blog/llmstxt-study/>; Profound citation patterns
<https://www.tryprofound.com/blog/ai-platform-citation-patterns>; Mueller on
structured data and ranking
<https://www.seroundtable.com/google-structured-data-ranking-39232.html>;
Mueller on `llms.txt`
<https://www.seroundtable.com/google-ai-llms-txt-39607.html>.

Unverified in this review: whether Cloudflare's 15 Sept defaults touch existing
free zones (Cloudflare says new domains; press says also existing free
customers); the exact PA-API retirement dates (third-party); the community
reports of Cloudflare Pages custom domains 403-ing AI bots; Wirecutter's button
wording (site blocked).
