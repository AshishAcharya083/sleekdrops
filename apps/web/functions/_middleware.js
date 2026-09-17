// Cloudflare Pages Function: middleware on every route of this site.
//
// Its one job is the trailing-slash form of a URL: it is served the canonical
// slash-less asset with a 200 rather than being redirected to it, which is what
// stops a client holding the site's previous (and opposite) permanent redirect
// from looping between the two forms. See functions/_lib/canonical.mjs for why
// only a 200 can break that loop, and docs/deployment.md for the deploy step
// that clears the same redirect out of the edge cache.
//
// Everything else - every canonical URL, the site root, /go/*, any non-GET -
// falls through to next() untouched.

import { handleCanonicalRequest } from './_lib/canonical.mjs';

export function onRequest(context) {
  return handleCanonicalRequest(context);
}
