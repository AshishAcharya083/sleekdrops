/**
 * The /go/<slug> redirect Function, driven the way Cloudflare drives it: a real
 * `GET` `Request`, a `params.slug` from the route, a `request.cf.country` from
 * the edge, a `context.env` holding the Pages runtime variables, and a
 * `waitUntil` that keeps the background delivery alive.
 *
 * `functions/go/[slug].js` is two lines - it hands the generated link table to
 * `handleRedirect` - and the generated table is gitignored, so the fixture table
 * is passed in here instead. Everything the Function actually decides, and every
 * byte it puts on the wire, is exercised below.
 *
 * The first assertion of every test is the visitor's: the redirect is what this
 * route exists for, and telemetry is only ever allowed to ride along behind it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { handleRedirect, REDIRECT_EVENT } from '../../functions/_lib/redirect.mjs';
import {
  INGEST_TIMEOUT_MS,
  SERVER_DISTINCT_ID,
  SERVICE_NAME,
} from '../../functions/_lib/analytics.mjs';
import { resolve } from '../../functions/_lib/affiliates.mjs';
import {
  CLICK_ID_PARAM,
  PLACEMENT_PARAM,
  POSITION_PARAM,
  TRACE_ID_PARAM,
  decorateGoHref,
} from './outbound.ts';

const CLICK_ID = '3f6b1c22-9b1a-4f0e-8c2a-2b4f7d1e5a90';
const TRACE_ID = 'aa11bb22cc33dd44ee55ff6600112233';

const LINKS = {
  'ninja-blast': { network: 'amazon', search: 'ninja blast blender', asins: { us: 'B08XYZ' }, default: 'https://www.ninjakitchen.com/blast' },
  'legacy-row': { default: 'https://merchant.example/legacy', au: 'https://merchant.example/au' },
  'no-destination': { network: 'amazon' },
  'bad-network': { network: 'constructor', default: 'https://merchant.example/bad-network' },
};

/** Everything the ingest host received, and how it answered. */
function openIngest(answer = () => ({ ok: true, status: 202 })) {
  const requests = [];
  return {
    requests,
    fetch(url, init) {
      requests.push({ url, init, payload: JSON.parse(init.body) });
      return Promise.resolve(answer());
    },
    batchFor(path) {
      return requests.find((request) => request.url.endsWith(path))?.payload;
    },
  };
}

const ENV = {
  DEVTEAM_ANALYTICS_INGEST_KEY: 'dtp_test',
  DEVTEAM_ANALYTICS_HOST: 'https://ingest.test',
};

/**
 * The EventContext a Pages Function is handed. `waitUntil` collects the
 * background promises so a test can await exactly what the platform would keep
 * the Worker alive for.
 */
function contextFor(path, { country = 'US', env = ENV } = {}) {
  const url = new URL(path, 'https://sleekdrops.com');
  const slug = decodeURIComponent(url.pathname.replace(/^\/go\//, ''));
  const request = new Request(url, { method: 'GET' });
  Object.defineProperty(request, 'cf', { value: country ? { country } : undefined });
  const background = [];
  return {
    request,
    params: { slug },
    env,
    waitUntil: (promise) => background.push(promise),
    background,
  };
}

const settle = (context) => Promise.all(context.background);

const eventsSent = (ingest) => ingest.batchFor('/v1/ingest/events')?.events ?? [];
const logsSent = (ingest) => ingest.batchFor('/v1/ingest/logs')?.logs ?? [];

test('a resolved click is redirected and counted server-side', async () => {
  const ingest = openIngest();
  const context = contextFor(
    `/go/ninja-blast?${CLICK_ID_PARAM}=${CLICK_ID}&${TRACE_ID_PARAM}=${TRACE_ID}` +
      `&${PLACEMENT_PARAM}=deal-detail&${POSITION_PARAM}=2`,
  );

  const response = handleRedirect(context, LINKS, { fetch: ingest.fetch });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), `https://www.amazon.com/dp/B08XYZ?tag=sleekdrops-20&ascsubtag=${CLICK_ID}`);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');

  await settle(context);
  const [event] = eventsSent(ingest);
  assert.equal(event.name, REDIRECT_EVENT);
  assert.deepEqual(event.properties, {
    slug: 'ninja-blast',
    network: 'amazon',
    region: 'us',
    placement: 'deal-detail',
    position: 2,
    click_id: CLICK_ID,
    trace_id: TRACE_ID,
  });
});

test('the ingest call carries the runtime key and hits the platform’s endpoints', async () => {
  const ingest = openIngest();
  const context = contextFor('/go/ninja-blast');
  handleRedirect(context, LINKS, { fetch: ingest.fetch });
  await settle(context);

  const events = ingest.requests.find((request) => request.url.endsWith('/v1/ingest/events'));
  assert.equal(events.url, 'https://ingest.test/v1/ingest/events');
  assert.equal(events.init.method, 'POST');
  assert.equal(events.init.headers['X-DevTeam-Key'], 'dtp_test');
  assert.equal(events.init.headers['Content-Type'], 'application/json');
  assert.equal(ingest.batchFor('/v1/ingest/logs').resource.service_name, SERVICE_NAME);
  // Bounded, so an ingest host that accepts the connection and then hangs still
  // cannot hold the Worker open behind an already-served redirect.
  assert.ok(INGEST_TIMEOUT_MS > 0);
  assert.ok(events.init.signal instanceof AbortSignal);
});

test('the server-side row carries no visitor or device identity', async () => {
  const ingest = openIngest();
  const context = contextFor(`/go/ninja-blast?${CLICK_ID_PARAM}=${CLICK_ID}`, { country: 'AU' });
  context.request.headers.set('cookie', 'sd-consent=granted');
  context.request.headers.set('user-agent', 'Mozilla/5.0 (a real browser)');

  handleRedirect(context, LINKS, { fetch: ingest.fetch });
  await settle(context);

  const [event] = eventsSent(ingest);
  assert.equal(event.distinct_id, SERVER_DISTINCT_ID);
  // The click id is random per click, so the session it names is one click.
  assert.equal(event.session_id, CLICK_ID);
  // The storefront region, never the country, the IP, the cookie or the agent.
  assert.equal(event.properties.region, 'au');
  const wire = JSON.stringify(ingest.requests.map((request) => request.payload));
  ['sd-consent', 'Mozilla', 'user-agent', '"AU"'].forEach((leak) => {
    assert.equal(wire.includes(leak), false, `${leak} must not reach the analytics platform`);
  });
});

test('a click id is minted when the browser did not supply one', async () => {
  const ingest = openIngest();
  const context = contextFor('/go/ninja-blast');
  const response = handleRedirect(context, LINKS, { fetch: ingest.fetch, mintClickId: () => CLICK_ID });

  // Minted server-side, and still threaded into the network's sub-id slot - an
  // article link followed without decoration is still joinable to its sale.
  assert.ok(response.headers.get('Location').includes(`ascsubtag=${CLICK_ID}`));
  await settle(context);
  assert.equal(eventsSent(ingest)[0].properties.click_id, CLICK_ID);
});

test('a click with no trace id still logs under one derived from the click id', async () => {
  const ingest = openIngest();
  const context = contextFor(`/go/ninja-blast?${CLICK_ID_PARAM}=${CLICK_ID}`);
  handleRedirect(context, LINKS, { fetch: ingest.fetch });
  await settle(context);
  assert.equal(logsSent(ingest)[0].trace_id, CLICK_ID.replace(/-/g, ''));
});

test('a served redirect is logged at info with the slug and network', async () => {
  const ingest = openIngest();
  const context = contextFor(`/go/ninja-blast?${TRACE_ID_PARAM}=${TRACE_ID}`);
  handleRedirect(context, LINKS, { fetch: ingest.fetch });
  await settle(context);

  const [line] = logsSent(ingest);
  assert.equal(line.severity, 'info');
  assert.match(line.body, /affiliate redirect served/);
  assert.equal(line.attributes.slug, 'ninja-blast');
  assert.equal(line.attributes.network, 'amazon');
  // The same trace id the client error would carry, so the two are one search.
  assert.equal(line.trace_id, TRACE_ID);
});

test('an unknown slug is a 404, an error log, and no click count', async () => {
  const ingest = openIngest();
  const context = contextFor('/go/does-not-exist');
  const response = handleRedirect(context, LINKS, { fetch: ingest.fetch });

  assert.equal(response.status, 404);
  await settle(context);
  const [line] = logsSent(ingest);
  assert.equal(line.severity, 'error');
  assert.match(line.body, /unknown slug/);
  assert.equal(line.attributes.slug, 'does-not-exist');
  assert.equal(line.attributes.network, 'unknown');
  // The primary conversion must never be inflated by a 404.
  assert.deepEqual(eventsSent(ingest), []);
});

test('a slug naming an inherited Object property is an unknown slug', async () => {
  const ingest = openIngest();
  const context = contextFor('/go/constructor');
  const response = handleRedirect(context, LINKS, { fetch: ingest.fetch });

  assert.equal(response.status, 404);
  await settle(context);
  assert.match(logsSent(ingest)[0].body, /unknown slug/);
  assert.deepEqual(eventsSent(ingest), []);
});

test('a row that resolves to nothing is a 404 and an error log', async () => {
  const ingest = openIngest();
  const context = contextFor('/go/no-destination');
  const response = handleRedirect(context, LINKS, { fetch: ingest.fetch });

  assert.equal(response.status, 404);
  await settle(context);
  const [line] = logsSent(ingest);
  assert.equal(line.severity, 'error');
  assert.match(line.body, /no destination/);
  assert.equal(line.attributes.network, 'amazon');
  assert.deepEqual(eventsSent(ingest), []);
});

test('a failure inside the Function is logged with a stack trace', async () => {
  const ingest = openIngest();
  const context = contextFor('/go/ninja-blast');
  const exploding = {
    get 'ninja-blast'() {
      throw new Error('link table unavailable');
    },
  };

  const response = handleRedirect(context, exploding, { fetch: ingest.fetch });
  assert.equal(response.status, 500);

  await settle(context);
  const [line] = logsSent(ingest);
  assert.equal(line.severity, 'error');
  assert.match(line.body, /link table unavailable/);
  assert.match(String(line.attributes.stack), /link table unavailable/);
});

test('a rejected ingest call cannot change the redirect or fail the request', async () => {
  const ingest = openIngest(() => {
    throw new Error('ingest host unreachable');
  });
  const context = contextFor(`/go/ninja-blast?${CLICK_ID_PARAM}=${CLICK_ID}`);

  const response = handleRedirect(context, LINKS, { fetch: ingest.fetch });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), `https://www.amazon.com/dp/B08XYZ?tag=sleekdrops-20&ascsubtag=${CLICK_ID}`);
  // The background work settles rather than rejecting, so waitUntil never sees
  // an unhandled rejection and the Worker is not torn down as failed.
  await assert.doesNotReject(settle(context));
});

test('a rejected batch is not retried into the response either', async () => {
  const ingest = openIngest(() => ({ ok: false, status: 401 }));
  const context = contextFor('/go/ninja-blast');
  const response = handleRedirect(context, LINKS, { fetch: ingest.fetch });
  assert.equal(response.status, 302);
  await assert.doesNotReject(settle(context));
});

test('an empty ingest key disables the sink silently and still serves the 302', async () => {
  const ingest = openIngest();
  const context = contextFor('/go/ninja-blast', {
    env: { DEVTEAM_ANALYTICS_INGEST_KEY: '', DEVTEAM_ANALYTICS_HOST: 'https://ingest.test' },
  });

  const response = handleRedirect(context, LINKS, { fetch: ingest.fetch });
  assert.equal(response.status, 302);
  await settle(context);
  assert.deepEqual(ingest.requests, []);
});

test('a Function with no analytics environment at all still redirects', async () => {
  const ingest = openIngest();
  const context = contextFor('/go/legacy-row', { env: {} });
  const response = handleRedirect(context, LINKS, { fetch: ingest.fetch });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), 'https://merchant.example/legacy');
  await settle(context);
  assert.deepEqual(ingest.requests, []);
});

test('a Function without waitUntil still serves the redirect', async () => {
  const ingest = openIngest();
  const context = contextFor('/go/ninja-blast');
  delete context.waitUntil;
  const response = handleRedirect(context, LINKS, { fetch: ingest.fetch });
  assert.equal(response.status, 302);
});

test('a hostile query string cannot widen a reported dimension', async () => {
  const ingest = openIngest();
  const long = 'x'.repeat(200);
  const context = contextFor(
    `/go/ninja-blast?${PLACEMENT_PARAM}=${long}&${POSITION_PARAM}=99999&${CLICK_ID_PARAM}=${long}`,
  );
  handleRedirect(context, LINKS, { fetch: ingest.fetch, mintClickId: () => CLICK_ID });
  await settle(context);

  const { properties } = eventsSent(ingest)[0];
  assert.equal(properties.placement, undefined);
  assert.equal(properties.position, undefined);
  assert.equal(properties.click_id, CLICK_ID);
});

test('a legacy row with no network resolves exactly as it did before', async () => {
  const ingest = openIngest();
  const context = contextFor(`/go/legacy-row?${CLICK_ID_PARAM}=${CLICK_ID}`, { country: 'AU' });
  const response = handleRedirect(context, LINKS, { fetch: ingest.fetch });

  // No sub-id slot on a direct link: the destination is byte-identical to what
  // `resolve` produced before click ids existed.
  assert.equal(response.headers.get('Location'), resolve(LINKS['legacy-row'], 'AU'));
  assert.equal(response.headers.get('Location'), 'https://merchant.example/au');
  await settle(context);
  assert.equal(eventsSent(ingest)[0].properties.network, 'direct');
});

test('a row with an unusable network still redirects to its literal default', async () => {
  const ingest = openIngest();
  const context = contextFor('/go/bad-network');
  const response = handleRedirect(context, LINKS, { fetch: ingest.fetch });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), 'https://merchant.example/bad-network');
  await settle(context);
});

test('a browser-decorated link joins the client row, the server row and the sale', async () => {
  // The whole chain in one assertion, because each half being right proves
  // nothing about the join: chrome.ts writes the href, the Function reads it
  // back, and the network gets the id in its sub-id slot. One click id has to
  // survive all three, or a commission imported next week matches nothing.
  const ingest = openIngest();
  const href = decorateGoHref('/go/ninja-blast', {
    clickId: CLICK_ID,
    traceId: TRACE_ID,
    placement: 'deal-card',
    position: 3,
  });
  const context = contextFor(href);

  const response = handleRedirect(context, LINKS, { fetch: ingest.fetch });

  // 1. The merchant URL carries the click id in Amazon's sub-id slot.
  assert.equal(
    response.headers.get('Location'),
    `https://www.amazon.com/dp/B08XYZ?tag=sleekdrops-20&ascsubtag=${CLICK_ID}`,
  );

  await settle(context);
  // 2. The server row reports the same id, and the context the browser had.
  const [event] = eventsSent(ingest);
  assert.equal(event.properties.click_id, CLICK_ID);
  assert.equal(event.properties.placement, 'deal-card');
  assert.equal(event.properties.position, 3);
  // 3. The server log is findable under the browser's own trace id.
  assert.equal(logsSent(ingest)[0].trace_id, TRACE_ID);
});

test('the route file is wiring only - the generated table into the handler', () => {
  // The generated link table is gitignored, so `functions/go/[slug].js` itself
  // cannot be imported here. What it must not do is grow logic of its own,
  // which is the one thing about it these tests would not cover.
  const route = readFileSync(
    fileURLToPath(new URL('../../functions/go/[slug].js', import.meta.url)),
    'utf8',
  );
  assert.match(route, /import links from '\.\.\/_data\/affiliate-links\.mjs';/);
  assert.match(route, /import \{ handleRedirect \} from '\.\.\/_lib\/redirect\.mjs';/);
  assert.match(route, /export function onRequest\(context\) \{\s*return handleRedirect\(context, links\);\s*\}/);
});

test('the Function and the site taxonomy name the same server-side event', () => {
  // The Worker cannot import a .ts module, so the name is restated in
  // functions/_lib/redirect.mjs. This is what keeps the two from drifting into
  // two events in the Analytics tab.
  const analytics = readFileSync(fileURLToPath(new URL('./analytics.ts', import.meta.url)), 'utf8');
  const named = /affiliateRedirect: '([^']+)'/.exec(analytics);
  assert.ok(named, 'no `affiliateRedirect` constant in the EVENTS map');
  assert.equal(named[1], REDIRECT_EVENT);
});
