// Cloudflare Pages Function: GET /go/<slug>
//
// Replaces the old static `_redirects` rules for affiliate links. A Function is
// required because the destination depends on the visitor's country
// (request.cf.country) — something a static _redirects file cannot do.
// Pages Functions take precedence over _redirects for matching routes, so this
// is the single owner of /go/*.
//
// It is also where the outbound affiliate click — this site's primary
// conversion — is counted server-side, which is the only place the count is
// ad-block-proof. All of that lives in functions/_lib/redirect.mjs so it can be
// driven by a test with a real Request and a fixture link table; this file is
// the wiring that hands it the generated table (functions/_data, built by
// scripts/generate-redirects.mjs from the D1 affiliate_links rows).
//
// The analytics ingest key and host are read from context.env — the Pages
// *runtime* environment, uploaded by the deploy workflows — and never from a
// literal here. An empty or missing key disables the sink silently and the 302
// is served exactly as before.

import links from '../_data/affiliate-links.mjs';
import { handleRedirect } from '../_lib/redirect.mjs';

export function onRequest(context) {
  return handleRedirect(context, links);
}
