# SleekDrops agent platform

A multi-agent content pipeline that finds trending topics and writes very SEO,
genuinely helpful articles/guides/roundups for sleekdrops.com — a light version
of the devteam-platform orchestration pattern (DB-claimed work units, one
agent session per stage, verdict-driven routing, token/cost ledger).

## The agents

| # | Agent | Stage | What it does |
| - | ----- | ----- | ------------ |
| 1 | `topic_scout` | (out of band) | Sweeps the live web (Tavily) for trending products/topics **not covered before** (checks D1 posts + every prior suggestion), **verifies each candidate is still current** with its own search, writes suggestions for the admin |
| 2 | `researcher` | research | Plans and runs its searches in five strata (primary/manufacturer, independent expert, owner reviews and long-term complaints, price and availability, competing coverage) and fills each dossier field from its own stratum: tiered and dated facts, failure modes, who should not buy, attributed owner complaints, dated price observations, tested claims, products (non-Amazon "amazonUrl"s are dropped deterministically), keywords, competitor gap. **Every price and spec is checked against a primary source** before it is filed, and a **deterministic evidence gate** fails the article here rather than letting a spec-sheet dossier reach the writer |
| 3 | `keyword_strategist` | keyword | **Reads the live SERP** for 4 candidate queries and picks the one we can win: intent, difficulty, zero-click risk, SERP features, the top 3 to beat, the gaps they leave, PAA questions, entities, snippet target, word-count target |
| 4 | `angle_editor` | angle | **Decides what the piece argues** before it is outlined: the thesis, the specific reader, the contrarian or non-obvious take, what this piece says that the top-3 results do not, the structural shape and which beat's voice writes it. Grounded in the dossier and the plan's competitor reads only — a topic with no defensible take is **recorded as having none** rather than given a fabricated one |
| 5 | `outliner` | outline | SEO content brief executing that plan: ≤60-char title, dek, slug, H2/H3 outline, mandatory FAQ |
| 6 | `writer` | write | Full markdown draft in the site voice; answer-first sections, sourced claims, products linked only as `/go/<slug>` with mandated placements (tables, per-product CTAs, conclusion) |
| 7 | `seo_reviewer` | seo_review | Deterministic anti-slop scan **first**, then a scored review across five dimensions (search / generative-engine / voice / E-E-A-T / links) → pass/fail verdict. **Fact-checks the riskiest claims** against live sources as part of E-E-A-T |
| 8 | `editor` | edit | Surgical revision resolving the reviewer's issues, the voice-scan findings and any admin feedback (loops with the reviewer, bounded by `max_revision_rounds`) |
| 9 | `assembler` | assemble | Exact D1 payload: frontmatter (validated against the site's Zod schema) + affiliate link rows built deterministically — liveness-verified per-marketplace ASINs with an Amazon-search fallback that can't 404; Amazon is the only approved merchant |
| 10 | `image_agent` | image | Hero image: Tavily image search → Gemini vision check (related, watermark-free) → else generate with the Gemini image model; uploads to the public GCS bucket and stores the URL in frontmatter. Stands down entirely when the operator attached their own image, and skips itself when `GCS_IMAGES_BUCKET` is unset |
| 11 | `publisher` | publish | Upserts D1 `posts` + `affiliate_links`, fires the `content-updated` dispatch → site rebuilds |

Flow: `research → keyword → angle → outline → write → seo_review ⇄ edit → assemble → image → publish`.

An article that fails the evidence gate stops at `research` with `status =
'failed'` and a message naming each thin stratum, what it found against what
the post type needs, and where that evidence is actually gathered. The bar is
per post type (a guide carries the full owner set, a trend article is held to
sourcing depth) and eases for categories with no Australian owner corpus.
Widen the topic brief or re-run research; there is nothing to fix in the draft,
because there is no draft.
With `publish_mode = approval` (default) the article parks at
`waiting_approval` until you hit **Approve & publish** in the admin panel.

Every stage runs under a wall-clock budget - `AGENT_RUN_TIMEOUT_SECONDS`
(default 3600s), capped by a hard ceiling in code that no configuration can
raise, with an optional per-stage override in `STAGE_TIMEOUT_SECONDS`
(`pipeline/budgets.ts`, read beside the stage map in `pipeline/runner.ts`). It
is deliberately not an admin setting: a timeout is a safety guard, and what an
operator acts on is the outcome. A
stage that outlives its budget stops at `status = 'timed_out'` - a distinct
terminal state from `failed`, because nothing reported an error - keeping
whatever it had already written as a draft, with a message naming the agent,
the stage, the limit, how long it ran and the last LLM call it was waiting on
(scrubbed of any credential the process holds). A claim also carries a lease
the worker renews while it works, and the worker reaps lapsed leases on its own
poll (`REAPER_EVERY_TICKS`), so a run whose process died is stopped while the
platform is up rather than at the next restart. A run that discovers its lease
is gone - reaped, or cancelled from the panel - abandons the stage and writes
nothing, leaving the outcome whoever took the article away recorded.
Every agent prompt is grounded with today's date (Australia/Sydney) so years
in titles/copy come from the calendar, not stale training data.

Admin extras: the **Published** tab lists everything in D1 and can delete a
post (plus its orphaned pipeline-authored affiliate links) with an automatic
site rebuild; the article panel has a **feedback box** that requeues the piece
through `edit → seo_review → assemble → image → publish` with your notes
applied (original pubDate is kept, `updatedDate` is stamped).

**Hero images by hand.** The image agent's automatic pick is often not good
enough, so three admin surfaces take a dropped image file (JPEG/PNG/WebP,
≤ 10 MB), vetted by magic bytes — not by the content type the browser claims —
and uploaded to the same public bucket:

| Surface | Attaches to | Reaches the site |
| --- | --- | --- |
| Manual-topic drawer | the draft topic; copied onto the article on approval | with the article's first publish |
| Pipeline article panel | `articles.hero_image_url` / `hero_alt` + frontmatter | at publish, or **Publish again** for one already live |
| **Published** tab | the D1 `posts` row itself | immediately, with a site rebuild |

The dedicated `articles` columns are what make an operator image stick: the
assembler stamps them into frontmatter on every pass, so an image attached
while briefing a topic survives assembly and the feedback loop, and the image
stage skips its search instead of paying for one. Removing it hands the piece
back to the agent (or to the generated cover fill).

The **Published** tab is the one that reaches *older* posts. Most of what is
live was written before this platform and has no article row at all, so that
surface edits the published D1 row directly — and when a pipeline article does
exist for the slug, its copy is updated too, so a later re-publish can't push
the old image back over the new one. `updatedDate` is deliberately not stamped:
swapping a photo is not an editorial revision.

## What the pipeline optimises for

Two audiences read every article, and they reward different things.

**Google.** The `keyword` stage is what changed here. Picking a target query
used to be a side effect of writing the brief — the researcher named whatever
phrase it had read most, and nobody had looked at a results page. So a piece
could be built for a query owned by Amazon's own product listings, or for a
head term whose answer never leaves the AI Overview. The keyword strategist
runs a real SERP read over several candidates first (the superseo
`keyword-deep-dive` method), and commits to one on winnability rather than
prettiness: what format ranks, who holds the top three, what they miss, how
long they are, and how much of the traffic clicks through at all. Everything
downstream is built against that plan.

**Generative engines.** Being cited by ChatGPT, Claude, Perplexity and AI
Overviews is a different game from ranking, and the overlap is mostly about
being *extractable*. Every major H2 now opens with a self-contained 40–60 word
answer; claims are paired with a named source and a year; entities are named
instead of gestured at ("Ninja AF160", not "several models"); and every article
ends with a real FAQ section. That FAQ is load-bearing — `apps/web` reads it
back out of the published markdown and emits **FAQPage** structured data, which
is the strongest single citation signal available to us. It costs no extra
frontmatter field: `extractFaq()` parses the body the writer already produced.

**Neither, if it reads like a machine.** See below.

## The anti-slop gate

Telling a model "don't write like an AI" does not work. It agrees, and then
writes *"In today's fast-paced landscape, it's worth noting that this robust
solution seamlessly delves into..."* anyway.

So `src/content/slop.ts` measures the draft instead — plain string matching, no
LLM. Banned vocabulary (delve, leverage, robust, seamless, pivotal, showcase,
"landscape" used metaphorically…), banned phrases ("it's worth noting", "let's
dive in", "plays a crucial role"), the structural tells (binary contrasts,
additive hedges, negative listing, copula avoidance, participial tack-ons,
false agency), and two density rules that scale with length: hedge adverbs and
em-dashes per thousand words. It also flags metronomic rhythm — four
consecutive sentences within three words of each other.

On top of that vocabulary layer it measures the qualities a blocklist cannot
see, still deterministic and offline, each with its own threshold in
`SCAN_THRESHOLDS` and its own line-anchored finding:

- **shape** - sentence-length variance, paragraph-length uniformity and the
  opening move repeated across every H2. This is what "every article on the
  site reads the same" actually measures as;
- **specificity** - prices, model designations, dates and named sources per 100
  words of body copy, with a stricter floor on the passages that pick or rank,
  and a requirement that some of those specifics be Australian and comparative
  (a local RRP, an AU retailer, a warranty term, a stated gap against the
  runner-up) rather than a restated global spec sheet;
- **house text** - `HOUSE_BLOCKS` registers the exact blocks a publisher may
  repeat verbatim, split three ways: what the body owes the reader on every
  endorsement, what it may repeat inside a word budget, and what the article
  layout renders and an author must therefore never retype;
- **cross-corpus repetition** - n-gram and opening-line overlap against the
  last published bodies, loaded by `src/content/corpus.ts`. `detectSlop` never
  fetches anything itself: the corpus is passed in, and with no corpus those
  metrics are skipped entirely and the score is unchanged.

The scan runs **before** the SEO reviewer prompts anything, and its hits are
handed to the model as established fact rather than left to its judgement. Then:

- every finding becomes an issue with a line number, an example and a fix;
- a banned word or phrase is **high severity whatever the score**, and a
  high-severity issue blocks the pass — one "delve" in an otherwise strong
  draft still forces a revision round;
- the shape, specificity, house-text and repetition metrics are **never** high
  severity and each is capped, so no single measurement can force a revision
  round or drag an otherwise clean draft below the pass mark on its own;
- the scan's score caps the review's `voice` dimension and the overall score,
  so a model that liked the draft cannot out-vote the scanner;
- the editor re-runs the scan on the draft in front of it, so it never works
  from a stale line number.

Rules from the [`stop-slop`](https://hvpandya.com) skill and the
[superseo](https://github.com/inhouseseo/superseo-skills) `write-content`
anti-slop ruleset, narrowed to what a regex can judge honestly. Anything
needing taste — does this take a position, are the specifics real — stays with
the reviewing model.

## Two engines, routed by model id

Every LLM call goes through `src/llm/`, which routes on the model id:

| Engine | Models | Runs | Auth |
| --- | --- | --- | --- |
| **Gemini** (Google ADK) | everything not `claude-*` (default `gemini-2.5-flash`) | image agent, plus every other stage when the toggle says so | admin-set AI Studio key → Vertex ADC (`GOOGLE_GENAI_USE_VERTEXAI=true`, keyless on Cloud Run) → `GEMINI_API_KEY` |
| **Claude subscription** (Claude Agent SDK) | `claude-*` (default **`claude-opus-5`**) | every stage that runs a prompt: topic scout, researcher, keyword strategist, angle editor, outliner, writer, SEO reviewer, editor — switchable in Settings | `claude setup-token` → paste in admin Settings, or `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` in `.env` |

The subscription token only works through the Agent SDK/CLI — it is not an API
key, which is why the Claude engine is a separate execution path.

Every stage whose judgement lands in the published piece runs on Opus 5, not
just the two that write prose. The old split (writer + editor on Claude,
research and review on the cheap model) had the economics backwards: a draft is
capped by the quality of the brief behind it and the honesty of the review in
front of it, so a weaker researcher or reviewer costs more than a weaker writer
does. On a subscription the marginal cost of the better model is zero. The
topic scout joined them for the same reason: it decides what everything
downstream then spends its budget on.

The **image agent is the one exception** and always runs on Gemini. It
vision-checks candidate photos and generates a hero when none is usable — a
capability boundary, not a preference — so it is not offered as an override
either.

Stages follow the admin **Settings → Every article stage uses** toggle (Claude
by default). Per-agent model overrides sit on top and can put any agent on
either engine. Usage (tokens; USD only where a provider bills per call) is
recorded per agent session and aggregated in the admin panel.

### A missing credential fails loudly

A Claude stage with no token used to fall back to Gemini and log a warning
nobody reads. The panel said Opus 5, every session row said `gemini-2.5-flash`,
and articles came out of the cheap model unnoticed — for as long as it took
somebody to compare the two screens. There is no automatic downgrade now:
`modelFor` refuses, the article fails with the missing-credential message on
it, and `GET /api/settings` reports which engines actually hold a credential so
the Settings page can warn before anything is queued.

## Verification: the stages that may open the web

Three stages get live web access, and they are the three whose job is to be
right rather than to be readable:

| Stage | What it checks |
| --- | --- |
| `topic_scout` | that a trend is current and the product is still sold here, before the pipeline spends a run on it |
| `researcher` | every price, model number, headline spec and availability claim, against a primary source, before it enters the dossier |
| `seo_reviewer` | the three or four claims in the draft that would do the most damage if wrong — a contradiction is a high-severity issue with the right figure in the fix |

On Claude that is two in-process MCP tools (`src/llm/searchTools.ts`):
`web_search` over the pipeline's own Tavily index, and `read_page` to read a
source rather than a snippet. On Gemini it is Google Search grounding, which
costs the forced-JSON response type — those stages ask for JSON in the prompt
and lean on `extractJson`, which already handles a fenced reply.

**The angle editor, the outliner, the writer and the editor have no web access, deliberately.**
They work from the dossier the research and review stages verified. A writer
that could search would pull in sources nobody reviewed and reach for the
competing articles sitting at the top of every result page — the pages the
piece has to beat, not echo. Every agent also carries `SOURCE_DISCIPLINE`:
competing articles are competitive intelligence, never source material, and
never get named, quoted, linked or paraphrased in the body.

`searchPolicy.test.ts` asserts that split against the agent sources, in both
directions — no prose stage searches, and no verifying stage has quietly
stopped.

## Autonomy: what runs by itself

- **Topic scout**: runs on a schedule (Settings → *Autonomous topic scout*,
  default daily; in-process scheduler, no external cron needed). Manual and
  scheduled searches are inserted into the same durable queue and processed
  in order. It skips an automatic request while 30+ suggestions sit untriaged
  or another search is queued/running. A search abandoned by a recycled
  process is put back on the queue automatically.
- **Article pipeline**: fully autonomous once you approve topics — the worker
  polls Postgres (the light pub/sub) and drives every stage to completion.
- **Publishing**: gated on your approval by default (`publish_mode=approval`);
  flip to `auto` for hands-off publishing or `draft` to stage in D1 only.

## State model (PostgreSQL)

- `topics` — scout suggestions; `suggested → approved/rejected` (unique on
  normalized title = the "never repeat a topic" guard, alongside the D1 check)
- `articles` — the work unit ("card"): stage, status, dossier/keyword plan/
  brief/draft/review/frontmatter JSONB, revision round, error
- `agent_sessions` — one row per agent run: model, tokens in/out, cost USD,
  duration, summary/error
- `settings` — publish_mode, per-agent models, revision cap, worker toggle
- `scout_runs` — durable topic-search jobs (`queued → running → done/failed`);
  heartbeat recovery re-queues work abandoned by a recycled instance

The workers claim queued articles and topic searches atomically, run the
corresponding agent, record the session, and route the work onward. Stranded
`running` rows are re-queued automatically.

## Run it

```bash
pnpm db:up                                  # repo root — Postgres on :5544
cp apps/agent/.env.example apps/agent/.env  # fill in keys
pnpm dev:agent                              # migrate + API + worker + admin UI on :8787
```

Required env: `GEMINI_API_KEY` (or Vertex on GCP) and `TAVILY_API_KEY`; add
`CLAUDE_CODE_OAUTH_TOKEN` to write prose on your Claude plan. For publishing:
`CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, `CLOUDFLARE_D1_TOKEN` (D1 Edit),
`GITHUB_TOKEN` (repo dispatch). Optional: `ADMIN_TOKEN` to protect the API —
required in practice when the API is deployed on Cloud Run.

`DATABASE_URL` has no built-in default. Left unset, the `pg` driver resolves
the connection from `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` and
falls back to `localhost:5432` - the standard port a sidecar or service-container
Postgres listens on. Port 5544 is only the host-side mapping `pnpm db:up`
publishes on a laptop, so it is never right inside a container. Boot - and
`pnpm db:migrate` - waits up to 30s for the database to answer before giving up,
so the agent may start before Postgres does.

## Tests

```bash
pnpm --filter @sleekdrops/agent test
```

Most suites are pure logic and need nothing running.
The API suites are contract tests over the real Hono app:
`server.test.ts` points at an unreachable database on purpose (tracing, auth,
the upload guards and the overview's degraded answer all resolve without a
working query), while `usage.db.test.ts` and `overview.db.test.ts` need a live
one - SQL that reads fine in review still only fails on a server, and a
partially failing overview only exists there - and skip themselves when no
`DATABASE_URL` answers.
The boot suites are the slow ones - about a minute of wall clock, most of it
one deliberate 30s wait - and the only ones that start real processes:
`index.db.test.ts` spawns the agent entrypoint and the `pnpm migrate` CLI the
way the container does, and `db/boot.db.test.ts` puts a TCP proxy in front of
Postgres to make it arrive late.
The cases that only need an unreachable database run anywhere; the ones that
have to reach a real one - late-arriving database, booting on `PG*` with no
`DATABASE_URL`, a rejected connection - skip themselves when no `DATABASE_URL`
answers, and each gives its spawned agent a throwaway database of its own,
because that child boots the whole pipeline and would otherwise recover and
claim the rows other suites are asserting on.
`db/pool.noDatabaseUrl.test.ts` covers what an unset `DATABASE_URL` resolves to
without connecting at all, so it runs everywhere.
Give it a live database with `pnpm db:up` (then
`DATABASE_URL=postgres://sleekdrops:sleekdrops@localhost:5544/sleekdrops_agent`);
CI runs it against a Postgres service container.

## Typical day

1. Topics tab → **Find new trending topics** (or curl `POST /api/scout` from cron).
2. Tick the topics worth writing → **Approve → write articles**.
3. Watch the Pipeline board; drafts + SEO scores are inspectable per article.
4. When an article reaches *waiting approval*, review the draft → **Approve & publish**.
5. ~90 seconds later it's live on sleekdrops.com.
