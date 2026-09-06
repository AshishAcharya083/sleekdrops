import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TEXT_LIMIT,
  redactEmails,
  redactText,
  sanitizeError,
  scrubProps,
  stripUrlQueries,
  toPath,
} from './scrub.ts';

test('drops every credential the panel handles', () => {
  const out = scrubProps({
    gemini_api_key: 'AIzaSyDoNotShipThis',
    claude_token: 'sk-ant-oat01-do-not-ship-this',
    Authorization: 'Bearer super-secret-admin-token',
    admin_token: 'super-secret-admin-token',
    token: 'super-secret-admin-token',
    apiKey: 'AIzaSyDoNotShipThis',
    password: 'hunter2',
  });
  assert.deepEqual(out, {});
});

test('drops operator-authored free text', () => {
  const out = scrubProps({
    title: 'Best budget standing desks for small apartments (2026)',
    instructions: 'Focus on sub-$400 options, lead with the Omidesk',
    feedback: 'Lead with the Dyson, drop the price table',
    content: '# my research notes',
    references: [{ name: 'a.md', content: 'secret notes' }],
    why_trending: 'people are searching for it',
  });
  assert.deepEqual(out, {});
});

test('keeps allowlisted structural dimensions', () => {
  const out = scrubProps({
    tab: 'Topics',
    surface: 'manual-drawer',
    action: 'approve',
    count: 3,
    reference_count: 2,
    instructions_provided: true,
    category: 'Home',
    post_type: 'guide',
    article_id: '0d1c8f5a-3c2b-4a5e-9f10-2b3c4d5e6f70',
    http_status: 409,
    worker_enabled: false,
  });
  assert.deepEqual(out, {
    tab: 'Topics',
    surface: 'manual-drawer',
    action: 'approve',
    count: 3,
    reference_count: 2,
    instructions_provided: true,
    category: 'Home',
    post_type: 'guide',
    article_id: '0d1c8f5a-3c2b-4a5e-9f10-2b3c4d5e6f70',
    http_status: 409,
    worker_enabled: false,
  });
});

test('an unknown property is dropped by default, not kept until named', () => {
  assert.deepEqual(scrubProps({ some_future_field: 'anything at all' }), {});
});

test('reduces path-like properties to a path so query strings cannot escape', () => {
  const out = scrubProps({
    route: '/api/topics?token=super-secret&status=draft',
    path: 'https://admin.example.com/panel?token=super-secret#frag',
  });
  assert.deepEqual(out, { route: '/api/topics', path: '/panel' });
});

test('redacts emails from surviving string values', () => {
  assert.deepEqual(scrubProps({ source: 'reported by jordan@example.com' }), {
    source: 'reported by [redacted]',
  });
});

test('drops non-primitive values, which could nest anything', () => {
  assert.deepEqual(scrubProps({ count: { n: 1 }, tab: ['Topics'], action: null, mode: undefined }), {});
});

test('handles a missing payload', () => {
  assert.deepEqual(scrubProps(), {});
  assert.deepEqual(scrubProps(null), {});
});

test('keeps the component stack but redacts and truncates it', () => {
  const stack = `at Topics (https://admin.example.com/assets/index.js?token=secret:12:3)\n`.repeat(200);
  const out = scrubProps({ component_stack: stack });
  const kept = out.component_stack as string;
  assert.equal(kept.length, TEXT_LIMIT);
  assert.equal(kept.includes('token=secret'), false);
  assert.equal(kept.includes('at Topics'), true);
});

test('redactEmails, stripUrlQueries and toPath do one job each', () => {
  assert.equal(redactEmails('mail a@b.co and c.d@e.f.gh'), 'mail [redacted] and [redacted]');
  assert.equal(stripUrlQueries('failed GET https://api.example.com/x?token=abc#f now'), 'failed GET https://api.example.com/x now');
  assert.equal(toPath('/api/topics?status=draft'), '/api/topics');
  assert.equal(toPath('/api/published/some-slug#frag'), '/api/published/some-slug');
});

test('redactText caps length so one payload cannot carry a whole document', () => {
  assert.equal(redactText('x'.repeat(TEXT_LIMIT + 500)).length, TEXT_LIMIT);
});

test('sanitizeError redacts the message and the stack but keeps a stack', () => {
  const original = new Error('failed for jordan@example.com at https://api.example.com/x?token=abc');
  const safe = sanitizeError(original);
  assert.equal(safe.message, 'failed for [redacted] at https://api.example.com/x');
  assert.equal(typeof safe.stack, 'string');
  assert.equal(safe.stack!.includes('token=abc'), false);
  assert.equal(original.message.includes('token=abc'), true, 'the caught error is left untouched');
});

test('sanitizeError gives a stack to values thrown without one', () => {
  for (const thrown of ['a bare string', { code: 500 }, 42, null]) {
    const safe = sanitizeError(thrown);
    assert.ok(safe instanceof Error);
    assert.ok(safe.message.length > 0);
    assert.match(safe.stack ?? '', /scrub|test/, 'every capture ships a stack trace');
  }
});

test('sanitizeError keeps the error name for grouping', () => {
  const original = new TypeError('x is not a function');
  assert.equal(sanitizeError(original).name, 'TypeError');
});

test('sanitizeError keeps message and stack for an error from another realm', () => {
  // An error crossing a realm boundary (an iframe, a library's own error type)
  // fails instanceof Error but is still the thing worth reporting.
  const crossRealm = {
    name: 'RangeError',
    message: 'out of range at https://api.example.com/x?token=abc',
    stack: 'RangeError: out of range\n    at frame.js:1:1',
  };
  const safe = sanitizeError(crossRealm);
  assert.equal(safe.name, 'RangeError');
  assert.equal(safe.message, 'out of range at https://api.example.com/x');
  assert.equal(safe.stack, 'RangeError: out of range\n    at frame.js:1:1');
});
