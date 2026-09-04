import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CLICK_ID_PARAM,
  PLACEMENT_PARAM,
  POSITION_PARAM,
  TRACE_ID_PARAM,
  decorateGoHref,
  isGoLink,
} from './outbound.ts';
import * as click from '../../functions/_lib/click.mjs';

const CLICK_ID = '3f6b1c22-9b1a-4f0e-8c2a-2b4f7d1e5a90';
const TRACE_ID = '3f6b1c229b1a4f0e8c2a2b4f7d1e5a90';

test('only this site’s /go route is decorated', () => {
  assert.equal(isGoLink('/go/ninja-blast'), true);
  assert.equal(isGoLink('/go/ninja-blast?utm=x'), true);
  assert.equal(isGoLink('https://sleekdrops.com/go/ninja-blast'), true);
  assert.equal(isGoLink('/deals/ninja-blast'), false);
  assert.equal(isGoLink('https://www.amazon.com/dp/B01'), false);
  assert.equal(isGoLink('#today'), false);
  assert.equal(isGoLink(''), false);
  assert.equal(isGoLink(undefined), false);
});

test('a decorated /go link carries the click id, trace id, placement and position', () => {
  const href = decorateGoHref('/go/ninja-blast', {
    clickId: CLICK_ID,
    traceId: TRACE_ID,
    placement: 'deal-card',
    position: 2,
  });
  const params = new URL(href, 'https://sleekdrops.com').searchParams;
  assert.equal(params.get(CLICK_ID_PARAM), CLICK_ID);
  assert.equal(params.get(TRACE_ID_PARAM), TRACE_ID);
  assert.equal(params.get(PLACEMENT_PARAM), 'deal-card');
  assert.equal(params.get(POSITION_PARAM), '2');
  // A relative link stays relative - the anchor is rewritten in place.
  assert.ok(href.startsWith('/go/ninja-blast?'));
});

test('position 0 is a slot, not an absent value', () => {
  const href = decorateGoHref('/go/x', { clickId: CLICK_ID, position: 0 });
  assert.equal(new URL(href, 'https://sd.test').searchParams.get(POSITION_PARAM), '0');
});

test('absent context adds no empty parameters', () => {
  const href = decorateGoHref('/go/x', { clickId: CLICK_ID });
  assert.equal(href, `/go/x?${CLICK_ID_PARAM}=${CLICK_ID}`);
});

test('a second click replaces the first click id rather than stacking parameters', () => {
  const first = decorateGoHref('/go/x', { clickId: CLICK_ID, placement: 'deal-detail' });
  const second = decorateGoHref(first, { clickId: 'second-click-id', placement: 'deal-detail' });
  const params = new URL(second, 'https://sd.test').searchParams;
  assert.deepEqual(params.getAll(CLICK_ID_PARAM), ['second-click-id']);
  assert.deepEqual(params.getAll(PLACEMENT_PARAM), ['deal-detail']);
});

test('a destination this site does not own is never rewritten', () => {
  const merchant = 'https://www.amazon.com/dp/B01?tag=sleekdrops-20';
  assert.equal(decorateGoHref(merchant, { clickId: CLICK_ID }), merchant);
  assert.equal(decorateGoHref('/deals/ninja-blast', { clickId: CLICK_ID }), '/deals/ninja-blast');
});

test('an absolute /go link keeps its origin', () => {
  const href = decorateGoHref('https://sleekdrops.com/go/x', { clickId: CLICK_ID });
  assert.ok(href.startsWith('https://sleekdrops.com/go/x?'));
});

test('no click id means no decoration - an unjoinable id is worse than none', () => {
  assert.equal(decorateGoHref('/go/x', { clickId: '' }), '/go/x');
});

test('the browser and the redirect Function agree on the parameter names', () => {
  // outbound.ts is TypeScript and click.mjs runs in the Workers runtime, so the
  // names are restated rather than shared. A rename on one side that this test
  // does not catch would silently strip the click id from every server row.
  assert.deepEqual(
    {
      click: CLICK_ID_PARAM,
      trace: TRACE_ID_PARAM,
      placement: PLACEMENT_PARAM,
      position: POSITION_PARAM,
    },
    {
      click: click.CLICK_ID_PARAM,
      trace: click.TRACE_ID_PARAM,
      placement: click.PLACEMENT_PARAM,
      position: click.POSITION_PARAM,
    },
  );
});

test('what the browser writes is what the Function reads back', () => {
  const href = decorateGoHref('/go/ninja-blast', {
    clickId: CLICK_ID,
    traceId: TRACE_ID,
    placement: 'promo-card',
    position: 7,
  });
  assert.deepEqual(click.readClickContext(new URL(href, 'https://sleekdrops.com')), {
    clickId: CLICK_ID,
    traceId: TRACE_ID,
    placement: 'promo-card',
    position: 7,
  });
});
