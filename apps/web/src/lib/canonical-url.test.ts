/**
 * The site middleware, driven the way Cloudflare drives it: a real `Request`, a
 * `context.env` holding the Pages `ASSETS` binding, and a `next()` that stands
 * in for the rest of the platform (the asset server, and the /go Function).
 *
 * What is actually being asserted here is the absence of a redirect. The site
 * used to serve a permanent 308 from /blog/<slug> to /blog/<slug>/ and now
 * serves the exact opposite one, so any client still holding the old direction
 * has a closed loop with no 200 in it - ERR_TOO_MANY_REDIRECTS, until Chrome
 * drops the poisoned entry. A redirect of any status on either leg keeps that
 * loop closed; only a 200 breaks it for a visitor who cannot be asked to clear
 * their cache. So the first assertion of almost every test below is `200`, and
 * the second is that nothing else on the site changed shape.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { onRequest } from '../../functions/_middleware.js';
import { canonicalPathFor } from '../../functions/_lib/canonical.mjs';

const ORIGIN = 'https://sleekdrops.com';
const ARTICLE_HTML = '<!doctype html><title>Repro</title>';

const SECURITY_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=31536000',
};

/** The Pages asset server: the files this build wrote, served as it serves them. */
function openAssets(files: Record<string, string> = { '/blog/repro': ARTICLE_HTML }) {
  const requests: Request[] = [];
  return {
    requests,
    get paths() {
      return requests.map((request) => new URL(request.url).pathname);
    },
    binding: {
      fetch(request: Request) {
        requests.push(request);
        const body = files[new URL(request.url).pathname];
        return Promise.resolve(
          body === undefined
            ? new Response('not found', { status: 404, headers: SECURITY_HEADERS })
            : new Response(body, { status: 200, headers: SECURITY_HEADERS }),
        );
      },
    },
  };
}

/** A context the way Pages builds one, with a `next()` that records being reached. */
function contextFor(url: string, init: RequestInit = {}) {
  const assets = openAssets();
  const passed: true[] = [];
  return {
    assets,
    get passedThrough() {
      return passed.length > 0;
    },
    context: {
      request: new Request(`${ORIGIN}${url}`, init),
      env: { ASSETS: assets.binding },
      next: () => {
        passed.push(true);
        return new Response('from the platform', { status: 200 });
      },
    },
  };
}

test('a trailing-slash URL is served the canonical asset, not a redirect', async () => {
  const probe = contextFor('/blog/repro/');
  const response = await onRequest(probe.context);

  // The whole fix: no 3xx anywhere on this leg, so a client holding the old
  // permanent redirect to here finds a page instead of another hop.
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('location'), null);
  assert.equal(await response.text(), ARTICLE_HTML);
  assert.deepEqual(probe.assets.paths, ['/blog/repro'], 'the slash-less asset is what must be fetched');
  assert.equal(probe.passedThrough, false, 'the platform would have redirected this one');
});

test('the response carries the asset\'s own headers, _headers policy included', async () => {
  const probe = contextFor('/blog/repro/');
  const response = await onRequest(probe.context);

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    assert.equal(response.headers.get(name), value, `${name} must survive the middleware`);
  }
});

test('a missing page keeps its 404 rather than becoming a 200', async () => {
  const probe = contextFor('/blog/gone/');
  const response = await onRequest(probe.context);

  assert.equal(response.status, 404);
});

test('a HEAD request is served the same way', async () => {
  const probe = contextFor('/blog/repro/', { method: 'HEAD' });
  const response = await onRequest(probe.context);

  assert.equal(response.status, 200);
  assert.deepEqual(probe.assets.paths, ['/blog/repro']);
  assert.equal(probe.assets.requests[0].method, 'HEAD', 'the asset is asked for the same way');
});

test('the query string rides along to the asset', async () => {
  const probe = contextFor('/blog/repro/?utm_source=news');
  await onRequest(probe.context);

  assert.equal(probe.assets.requests[0].url, `${ORIGIN}/blog/repro?utm_source=news`);
});

test('a canonical, slash-less URL is passed through untouched', async () => {
  const probe = contextFor('/blog/repro');
  const response = await onRequest(probe.context);

  assert.equal(probe.passedThrough, true);
  assert.equal(await response.text(), 'from the platform');
  assert.deepEqual(probe.assets.paths, [], 'the platform already serves this one directly');
});

test('/go/* is passed through untouched, in both URL forms', async () => {
  for (const path of ['/go/ninja-blast', '/go/ninja-blast/', '/go/']) {
    const probe = contextFor(path);
    await onRequest(probe.context);

    assert.equal(probe.passedThrough, true, `${path} belongs to the affiliate Function`);
    assert.deepEqual(probe.assets.paths, [], `${path} must not be answered from static assets`);
  }
});

test('the site root is passed through untouched', async () => {
  // The one trailing slash that is not a duplicate of anything.
  const probe = contextFor('/');
  await onRequest(probe.context);

  assert.equal(probe.passedThrough, true);
  assert.deepEqual(probe.assets.paths, []);
});

test('a non-GET request is passed through untouched', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const probe = contextFor('/blog/repro/', { method });
    await onRequest(probe.context);

    assert.equal(probe.passedThrough, true, `${method} is not an asset request`);
    assert.deepEqual(probe.assets.paths, [], `${method} must not be answered with a page`);
  }
});

test('a broken ASSETS binding degrades to the platform, not to a 500', async () => {
  // Middleware runs on every route, so the failure mode of this one file is the
  // whole site. The old redirect is bad; a 500 on every page is worse.
  const probe = contextFor('/blog/repro/');
  probe.context.env.ASSETS = {
    fetch: () => Promise.reject(new Error('binding unavailable')),
  };

  const response = await onRequest(probe.context);

  assert.equal(response.status, 200);
  assert.equal(probe.passedThrough, true);
});

test('a missing ASSETS binding does the same', async () => {
  const probe = contextFor('/blog/repro/');
  probe.context.env = {} as typeof probe.context.env;

  await onRequest(probe.context);

  assert.equal(probe.passedThrough, true);
});

test('_routes.json keeps every Function route on the middleware', () => {
  // The middleware runs on `/*`, so the asset-heavy paths are excluded to keep
  // the invocation count down. An exclude that reached a Function route would
  // take it offline silently - /go/* above all, which is the site's conversion.
  const routes = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../public/_routes.json', import.meta.url)), 'utf8'),
  );

  assert.deepEqual(routes.include, ['/*']);
  for (const rule of routes.exclude) {
    assert.match(
      rule,
      /^\/(_astro|fonts)\//,
      `${rule}: only the hashed asset directories may skip the middleware`,
    );
  }
});

test('canonicalPathFor strips every trailing slash, and answers null for the rest', () => {
  assert.equal(canonicalPathFor('/blog/repro/'), '/blog/repro');
  assert.equal(canonicalPathFor('/blog/repro//'), '/blog/repro');
  assert.equal(canonicalPathFor('/blog/'), '/blog');
  assert.equal(canonicalPathFor('/blog/repro'), null, 'already canonical');
  assert.equal(canonicalPathFor('/'), null, 'the root is not a duplicate URL');
  assert.equal(canonicalPathFor('//'), null, 'nothing to serve');
});
