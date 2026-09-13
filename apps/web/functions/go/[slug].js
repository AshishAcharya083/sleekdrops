// Cloudflare Pages Function: GET /go/<slug>
//
// Replaces the old static `_redirects` rules for affiliate links. A Function is
// required because the destination depends on the visitor's country
// (request.cf.country) — something a static _redirects file cannot do.
// Pages Functions take precedence over _redirects for matching routes, so this
// is the single owner of /go/*.
//
// Server-side click telemetry is deliberately disabled until its processor has
// public privacy, jurisdiction and retention terms. The redirect still carries
// the anonymous click reference used for affiliate attribution.

import links from '../_data/affiliate-links.mjs';
import { handleRedirect } from '../_lib/redirect.mjs';

export function onRequest(context) {
  return handleRedirect({ ...context, env: {} }, links);
}
