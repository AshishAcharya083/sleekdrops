# Admin panel analytics events

This is the canonical reference for the analytics events the agent-platform admin panel emits to DevTeam Analytics.
It is a sibling of the website's [`apps/web/docs/analytics-events.md`](../../web/docs/analytics-events.md): both apps report into the **same** DevTeam project, so both use the same Title Case naming convention and the same "detail lives in properties" rule.

Keep this doc and the code in sync.
Event names live as constants in [`src/analytics.ts`](../src/analytics.ts) (the `EVENTS` map); changing a name means changing it in both places.

## How tracking is wired

All tracking goes through the single wrapper in [`src/analytics.ts`](../src/analytics.ts) - no component imports the DevTeam SDK directly, mirroring how `apps/web/src/lib/analytics.ts` is the website's sole entry point.
It is a deliberate simplification of the website's wrapper: same chokepoint and same allowlist discipline, minus GA4 and minus the consent banner.

- **No consent banner.** The panel is an internal, token-gated staff tool rather than a public visitor surface, so there is nothing to prompt for.
  It does collect operator telemetry - see [Identity](#identity) - which is a privacy-notice question, not a code question.
- **Pseudonymous identity.** The panel has no user accounts: authentication is one shared `ADMIN_TOKEN`.
  There is therefore no user id to identify with, and the token is a secret that must never be sent.
- **Explicit page views.** The panel is a tabbed SPA with no router, so the SDK runs with `trackPageviews: false` and `App.tsx` emits `Page Viewed` on boot and on every tab change.
- **One scrub chokepoint.** Every event property, log attribute and error attribute passes through `scrubProps()` in [`src/scrub.ts`](../src/scrub.ts) first, and every error message and stack through `sanitizeError()`.

## Configuration

`VITE_DEVTEAM_ANALYTICS_INGEST_KEY` and `VITE_DEVTEAM_ANALYTICS_HOST` (see [`.env.example`](../.env.example)) configure the sink at build time.
Either value being empty disables analytics silently after one `console.warn` - the panel keeps working and never throws.
No key, host or fallback value is hardcoded in source.

## No secrets, no operator prose

`scrubProps()` is allowlist-based, not blocklist-based: only known-structural dimensions survive, so anything a caller forgets about is dropped by default.
That is what keeps the admin bearer token, the Gemini API key, the Claude OAuth token and every piece of operator-authored text - topic titles, agent instructions, editor feedback, reference-material bodies - out of every payload.
Credential fields are reported as set/not-set booleans and prose as a length or a count, never as a value.
Surviving strings still have emails redacted and query strings stripped, so an id or token smuggled onto a URL cannot escape either.
`scrub.test.ts` asserts exactly this.

## Identity

On boot the panel resolves a pseudonymous, device-bound operator id - a random UUID persisted in `localStorage` under `sleekdrops_operator_id` - and calls `identify()` with it.
Clearing the admin token calls `reset()` and drops the stored id, so the next session starts a fresh pseudonym.
The shared `ADMIN_TOKEN`, and any hash, prefix or derivative of it, is never used as the identity and never sent.

## Events

Every event also carries `tab` (the tab the operator was on) unless the property is explicitly overridden.

### Page Viewed

Fired on boot and on every tab change.

| Property | Type | Notes |
|---|---|---|
| `tab` | string | `Overview`, `Topics`, `Pipeline`, `Published`, `Sessions` or `Settings`. |
| `path` | string | The SPA's path - constant in practice, kept for parity with the website. |

Owning screen: `App.tsx`.

### Topic Approved

A topic became an article and a generation run was queued.
One name for every surface, because the approval means the same thing wherever it was pressed.

| Property | Type | Notes |
|---|---|---|
| `count` | number | Topics approved in this action (the Topics list approves a selection). |
| `source` | string | `scout` for suggested topics, `manual` for operator-authored ones. |
| `surface` | string | `topics` (list bulk action), `draft-row` (draft confirm modal), `manual-drawer`. |
| `topic_id` | string | Present for single-topic approvals. |

Owning screens: `pages/Topics.tsx`, `pages/ManualTopicDrawer.tsx`.

### Topic Rejected

| Property | Type | Notes |
|---|---|---|
| `count` | number | Topics rejected in this action. |
| `surface` | string | `topics`. |

Owning screen: `pages/Topics.tsx`.

### Scout Run Started

The operator started a topic-scout sweep by hand.

| Property | Type | Notes |
|---|---|---|
| `surface` | string | `topics`. |

Owning screen: `pages/Topics.tsx`.

### Manual Topic Saved

The manual-topic drawer submitted a brief - as a draft, or on the way to an immediate approval.
`Topic Approved` fires alongside it in the approve case, so approvals stay countable in one place.

| Property | Type | Notes |
|---|---|---|
| `action` | string | `draft` (Save as draft) or `approve` (Approve & start now). |
| `mode` | string | `create` or `edit`. |
| `category` | string | Chosen category. |
| `post_type` | string | `article`, `guide` or `roundup`. |
| `reference_count` | number | Reference materials attached. Never their contents. |
| `instructions_provided` | boolean | Whether the operator wrote instructions. Never the text. |
| `hero_image_provided` | boolean | Whether a hero image is attached to the brief. Never the file or its URL. |
| `topic_id` | string | Present on the approve path. |

Owning screen: `pages/ManualTopicDrawer.tsx`.

### Article Actioned

A pipeline-board action on one article: one name, with the action in a property.

| Property | Type | Notes |
|---|---|---|
| `action` | string | `retry`, `approve_publish`, `cancel`, `republish`, `hero_image_attached`, `hero_alt_saved` or `hero_image_removed`. |
| `article_id` | string | The article acted on. |
| `stage` | string | The stage it was in. |
| `status` | string | The status it was in. |

Owning screen: `pages/Pipeline.tsx` (article detail panel).
The hero-image actions report only that an image was attached, re-labelled or removed - never the file, its name or its URL.

### Article Feedback Submitted

Operator feedback queued an editor pass.

| Property | Type | Notes |
|---|---|---|
| `article_id` | string | The article the feedback is for. |
| `feedback_length` | number | Characters of feedback. Never the feedback text. |
| `stage` | string | The stage the article was in. |

Owning screen: `pages/Pipeline.tsx`.

### Published Post Deleted

A live post was removed from Cloudflare D1.

| Property | Type | Notes |
|---|---|---|
| `slug` | string | The deleted post's slug. |
| `category` | string | Its category. |
| `post_type` | string | Its post type. |
| `removed_links` | number | Orphaned affiliate links cleaned up with it. |
| `status` | string | `rebuild_dispatched` or `rebuild_failed`. |

Owning screen: `pages/Published.tsx`.

### Settings Saved

Platform settings were written. Shape only - which engines are configured and which enums are chosen.

| Property | Type | Notes |
|---|---|---|
| `publish_mode` | string | `approval`, `auto` or `draft`. |
| `worker_enabled` | boolean | Whether the pipeline worker runs. |
| `scout_interval_hours` | number | Autonomous scout interval, `0` = off. |
| `max_revision_rounds` | number | |
| `prose_engine` | string | `claude` or `gemini`. |
| `models_configured` | number | Per-agent model overrides set. |
| `gemini_key_set` | boolean | Whether a Gemini key is present. **Never the key.** |
| `claude_token_set` | boolean | Whether a Claude token is present. **Never the token.** |

Owning screen: `pages/Settings.tsx`.

### Connection Setting Changed

The header-bar API base or admin token gained or lost a value.
It fires on the transition only, not per keystroke, and **never carries the entered value** - only whether one is now present.

| Property | Type | Notes |
|---|---|---|
| `field` | string | `api_base` or `admin_token`. |
| `value_present` | boolean | Whether the field now holds a value. |

Owning screen: `App.tsx`.

### `$error` (SDK)

Every failure the panel sees is reported with `captureError`, so it ships a stack trace: the React error boundary, every catch site, the central failure path of `api()`, and the `window.onerror` / `unhandledrejection` listeners.
Message and stack are redacted; attributes are scrubbed like any other payload.

| Property | Type | Notes |
|---|---|---|
| `source` | string | `api`, `error_boundary`, `window_error` or `unhandled_rejection`. |
| `route` | string | The API path that failed, path-reduced. |
| `method` | string | HTTP verb. |
| `http_status` | number | Response status. |
| `duration_ms` | number | Time to the failure. |
| `server_trace_id` | string | The agent's trace id for that request - see below. |
| `action` | string | The operator action the call site was performing. |
| `component_stack` | string | React component stack, redacted and truncated. Error boundary only. |
| `handled` | boolean | `false` for the global window listeners. |

An error object is reported at most once, and identical signatures are dropped inside a 10s window, so the 4s `usePoll` loop against an unreachable API reports once rather than fifteen times a minute.

## Logs

`analytics.log.info/warn/error` lines are emitted around panel boot, every API request, every API failure and the settings save.
Each line carries the session's trace id plus the distinct and session ids, so the logs around an error are findable by the same id.
Log attributes go through the same scrub, and bodies - which interpolate the request path - are redacted the same way error messages are, so nothing reaches the Logs view that the event pipeline would have dropped.

## The `X-Trace-Id` contract

This is how a client error found in the Analytics tab leads to the server-side logs of the same request.

1. `apps/admin/src/api.ts` - the panel's single fetch chokepoint - sends `X-Trace-Id: <analytics.getTraceId()>` on **every** call to the agent API.
   When analytics is disabled the trace id is empty and the header is omitted entirely.
2. `apps/agent/src/api/trace.ts` runs as Hono middleware on `/api/*`.
   It adopts the caller's id when it matches `^[A-Za-z0-9-]{8,64}$`, and mints a fresh 32-hex-character id otherwise - an unvalidated id would land in log lines.
3. The id is held in `AsyncLocalStorage` for the duration of the request, so every line `apps/agent/src/lib/log.ts` writes carries it as `trace_id`.
   One `request` line per call records method, path, status and duration.
4. The id is echoed back on the response as `X-Trace-Id`, and CORS exposes that header so the browser can read it.
5. `app.onError` logs any uncaught route error with its stack under the same id and returns `{ error, traceId }` - the existing `{ error }` shape the panel already reads, with the id added.
   `api()` attaches it to its own error report as `server_trace_id`.

The trace id deliberately stops at the HTTP boundary.
An API request and a pipeline stage run are decoupled by a database poll, so an `AsyncLocalStorage` id cannot flow into stage execution.
Where a request enqueues asynchronous work (topic approve, manual-topic approve, article retry, publish approval, feedback), the log line records the trace id **together with** the topic or article id - that entity id is what joins the worker's later `[pipeline]` lines back to the originating request.

There is no server-side analytics SDK and no server ingest key: stdout is the agent's sink (Cloud Run collects it) and the shared trace id is what correlates the two halves.

## Verification

Last verified: 2026-08-04.

### Automated

- `pnpm --filter @sleekdrops/admin test` - the property scrub (secrets and prose dropped, allowlisted dimensions kept, URLs path-reduced, errors redacted but always carrying a stack) and the error de-duplication.
- `pnpm --filter @sleekdrops/agent test` - the log-line formatter, the trace-id resolution (including hostile headers), and `src/api/server.test.ts`, which drives the real Hono app with the panel's own verbs and headers to assert the header echo, the traced request line, the traced 401, the `{ error, traceId }` shape and the CORS preflight.
- `pnpm --filter @sleekdrops/admin build` (`tsc --noEmit && vite build`) and `pnpm --filter @sleekdrops/agent check`.

### End to end

Run `./up.sh`, open the panel, and confirm in the browser console (`[analytics]` prefix) that each instrumented action emits exactly one event.
Then force a failure (wrong admin token, or stop the API) and confirm a single `[analytics] error captured` line with a stack, and that `.run/agent.log` holds a line with the identical `trace_id`.
Finally, rebuild with an empty `VITE_DEVTEAM_ANALYTICS_INGEST_KEY` and confirm the panel still works, warns once, and sends no `X-Trace-Id`.
