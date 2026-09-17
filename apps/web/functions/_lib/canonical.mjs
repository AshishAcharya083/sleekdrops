// The trailing-slash request handler - the request logic behind
// functions/_middleware.js, kept here so it is drivable in a test with a real
// Request and a stub ASSETS binding, the way functions/_lib/redirect.mjs is.
//
// Why a Function serves these at all, rather than Pages redirecting them:
// `build.format: 'file'` (astro.config.mjs) writes blog/<slug>.html, so the
// canonical URL this site names everywhere is the slash-less one and Cloudflare
// Pages answers the slash form with a 308 to it. The site previously served the
// exact opposite 308, and a 308 is *permanent*: every browser and edge node that
// cached the old direction still believes /blog/<slug> goes to /blog/<slug>/,
// while the server now insists the reverse. That is a closed redirect loop with
// no 200 anywhere in it, which is what ERR_TOO_MANY_REDIRECTS is.
//
// A stale leg that lives in the client cannot be redirected away, so the only
// thing that breaks the loop for a visitor who already holds it - without asking
// them to clear their cache - is one leg answering 200. That is what this does:
// the slash form is served the canonical asset's own bytes, status and headers
// instead of a redirect. The canonical tag, sitemap, RSS and JSON-LD keep naming
// the slash-less form, so the duplicate URL still consolidates to one.
//
// Everything else is handed straight back to the platform, /go/* included: that
// route is a Function of its own whose redirect timing and click telemetry this
// must not touch.

/** The methods a static asset may be served for. Anything else is not ours. */
const SERVABLE_METHODS = new Set(['GET', 'HEAD']);

/** Routes owned by another Function, which must reach it untouched. */
const RESERVED_PREFIXES = ['/go/'];

/**
 * The slash-less form of a pathname, or null when there is nothing to serve.
 *
 * Null for a path that already is canonical, for the site root (which is the one
 * trailing slash that is not a duplicate), and for a path that is only slashes.
 *
 * @param {string} pathname
 * @returns {string | null}
 */
export function canonicalPathFor(pathname) {
  if (!pathname.endsWith('/')) return null;
  const canonical = pathname.replace(/\/+$/, '');
  return canonical === '' ? null : canonical;
}

/**
 * Serve the canonical asset for a trailing-slash request; pass everything else
 * through to the platform.
 *
 * @param {object} context  the Pages Function EventContext (request, env, next)
 * @returns {Promise<Response> | Response}
 */
export function handleCanonicalRequest(context) {
  const { request, env, next } = context;

  if (!SERVABLE_METHODS.has(request.method)) return next();

  const url = new URL(request.url);
  if (RESERVED_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return next();

  const canonical = canonicalPathFor(url.pathname);
  if (canonical === null) return next();

  const assetUrl = new URL(url);
  assetUrl.pathname = canonical;

  try {
    // The asset server answers with the file, the _headers policy applied to it,
    // and a 404 page when there is no such file - all of which are what the
    // slash-less URL would have served, so all of it is passed straight on. A new
    // Response because the one ASSETS hands back has immutable headers.
    return env.ASSETS.fetch(new Request(assetUrl, request)).then(
      (asset) =>
        new Response(asset.body, {
          status: asset.status,
          statusText: asset.statusText,
          headers: asset.headers,
        }),
      () => next(),
    );
  } catch {
    // A binding that is missing or broken. This middleware runs on every route
    // of the site, so its failure mode is the whole site: hand the request back
    // and let the platform redirect it as it did before, rather than 500 every
    // page.
    return next();
  }
}
