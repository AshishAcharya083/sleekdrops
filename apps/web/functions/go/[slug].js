// Cloudflare Pages Function: GET /go/<slug>
//
// Replaces the old static `_redirects` rules for affiliate links. A Function is
// required because the destination depends on the visitor's country
// (request.cf.country) — something a static _redirects file cannot do.
// Pages Functions take precedence over _redirects for matching routes, so this
// is the single owner of /go/*.
//
// Data (functions/_data/affiliate-links.mjs) and credentials
// (functions/_lib/affiliates.mjs) are generated/maintained elsewhere; this
// handler just wires country -> destination -> 302.

import links from '../_data/affiliate-links.mjs';
import { resolve } from '../_lib/affiliates.mjs';

export function onRequest(context) {
  const { params, request } = context;
  const slug = params.slug;
  const country = request.cf && request.cf.country; // ISO alpha-2, may be undefined locally

  const dest = resolve(links[slug], country);

  if (!dest) {
    return new Response(`Unknown affiliate slug: ${slug}`, {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  // 302 (temporary) so search engines don't index the merchant target; the
  // on-page <a rel="sponsored nofollow"> already tells crawlers not to follow.
  return new Response(null, {
    status: 302,
    headers: {
      Location: dest,
      // Geo-dependent: don't let a CDN cache one country's answer for another.
      'cache-control': 'private, no-store',
    },
  });
}
