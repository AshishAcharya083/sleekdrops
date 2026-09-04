// The /go/<slug> redirect handler — the request logic behind
// functions/go/[slug].js, with the generated link table passed in rather than
// imported, so it is drivable in a test with a real Request and a fixture table.
//
// This is where the site's PRIMARY CONVERSION is counted. The outbound
// affiliate click is what every network defines publisher performance on
// (EPC = commissions / clicks; network conversion rate = orders / clicks), and
// counting it here rather than on the anchor is what makes the number
// trustworthy: a client-side beacon is lost to ad blockers and to the unload
// race with the navigation, while a redirect the server actually served cannot
// be. The browser's own `Affiliate Link Clicked` is kept as the rich-context,
// lossy companion; the two join on the click id.
//
// The redirect owns the visitor's next 300 milliseconds, so telemetry is
// strictly subordinate to it: every event and log line is collected in memory,
// the Response is built from the resolved destination alone, and delivery is
// handed to context.waitUntil afterwards. Nothing on this path awaits the
// ingest host, and `deliver()` cannot reject, so a slow or broken analytics
// platform cannot change the status, the Location header or the latency.

import { networkFor, regionFor, resolve } from './affiliates.mjs';
import { mintClickId, readClickContext } from './click.mjs';
import { createTelemetry, traceIdFrom } from './analytics.mjs';

/**
 * The server-side click. Named separately from the browser's
 * `Affiliate Link Clicked` on purpose: they are two different facts - one says
 * a visitor clicked, the other says the redirect was actually served - and
 * emitting one name twice would make the ad-block gap invisible. It is a
 * constant of the site's taxonomy, declared in `src/lib/analytics.ts` and
 * restated here because a Worker cannot import a `.ts` module;
 * src/lib/go-redirect.test.ts asserts the two agree.
 */
export const REDIRECT_EVENT = 'Affiliate Redirect Served';

const TEXT_HEADERS = { 'content-type': 'text/plain; charset=utf-8' };

function textResponse(body, status) {
  return new Response(body, { status, headers: TEXT_HEADERS });
}

/**
 * Resolve a /go click to its destination and report it.
 *
 * @param {object} context   the Pages Function EventContext (request, params, env, waitUntil)
 * @param {object} links     the generated affiliate link table, slug -> row
 * @param {object} [options] injection seams for tests (fetch, now, mintClickId)
 * @returns {Response} 302 to the merchant, or 404 when nothing resolves
 */
export function handleRedirect(context, links, options = {}) {
  const mint = options.mintClickId ?? mintClickId;
  const telemetry = createTelemetry(context.env, options);
  // Minted before anything that can throw, so the catch-all below still has a
  // click id to key its log line on.
  let click = { clickId: mint() };
  let response;

  try {
    const { request, params } = context;
    const slug = String(params?.slug ?? '');
    click = readClickContext(new URL(request.url), mint);
    const country = request.cf && request.cf.country; // ISO alpha-2, may be undefined locally
    const region = regionFor(country);
    // Own-property lookup: `links['constructor']` would otherwise hand back a
    // function off Object.prototype, and `/go/__proto__` an object, both of
    // which read as a slug this site knows about.
    const entry = links && Object.hasOwn(links, slug) ? links[slug] : undefined;

    // Every event and log line from this request is grouped by the same
    // dimensions: what was clicked, how the destination was built, where the
    // visitor resolved to, and the two ids that join this row to the browser's.
    const attributes = {
      slug,
      network: entry ? networkFor(entry) : 'unknown',
      region,
      placement: click.placement,
      position: click.position,
      click_id: click.clickId,
      trace_id: traceIdFrom(click.traceId, click.clickId),
    };
    const dest = entry ? resolve(entry, country, click.clickId) : null;

    if (!entry) {
      telemetry.log('error', `affiliate redirect failed: unknown slug "${slug}"`, attributes, click);
      response = textResponse(`Unknown affiliate slug: ${slug}`, 404);
    } else if (!dest) {
      telemetry.log(
        'error',
        `affiliate redirect failed: no destination for "${slug}" in region ${region}`,
        attributes,
        click,
      );
      response = textResponse(`No destination for affiliate slug: ${slug}`, 404);
    } else {
      telemetry.event(REDIRECT_EVENT, attributes, click);
      telemetry.log(
        'info',
        `affiliate redirect served: "${slug}" via ${attributes.network}`,
        attributes,
        click,
      );
      // 302 (temporary) so search engines don't index the merchant target; the
      // on-page <a rel="sponsored nofollow"> already tells crawlers not to follow.
      response = new Response(null, {
        status: 302,
        headers: {
          Location: dest,
          // Geo-dependent: don't let a CDN cache one country's answer for another.
          'cache-control': 'private, no-store',
        },
      });
    }
  } catch (error) {
    // The redirect itself broke. It is the only path here that answers 5xx, and
    // it is invisible in the Analytics tab without a stack trace, so the log
    // line carries one.
    telemetry.log(
      'error',
      `affiliate redirect failed: ${error instanceof Error ? error.message : String(error)}`,
      {
        slug: String(context?.params?.slug ?? ''),
        network: 'unknown',
        click_id: click.clickId,
        stack: error instanceof Error ? error.stack : undefined,
      },
      click,
    );
    response = textResponse('Affiliate redirect failed', 500);
  }

  // Delivery is started here and handed to the platform's background queue:
  // without waitUntil the Worker may be torn down the moment the Response is
  // returned and the batch never leaves, and with it the visitor is already at
  // the merchant while the batch is still in flight.
  const delivery = telemetry.deliver();
  try {
    context.waitUntil?.(delivery);
  } catch {
    /* no waitUntil (local dev, a test) - the delivery promise still settles */
  }

  return response;
}
