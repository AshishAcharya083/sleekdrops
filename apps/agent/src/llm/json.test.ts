// JSON extraction and the shape contract.
//
// The truncation test is the important one. A dossier reply cut off mid-object
// used to come back as its own `facts` array — valid JSON, plausible shape,
// no products — and the pipeline stored it, reported success, and would have
// published a buying guide with an empty affiliate table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, requireKeys } from './index.js';

test('a bare JSON object parses', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
});

test('a fenced object parses', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
});

test('an object wrapped in prose parses', () => {
  assert.deepEqual(extractJson('Here you go:\n{"a":1}\nHope that helps.'), { a: 1 });
});

test('a top-level array parses', () => {
  assert.deepEqual(extractJson('[1,2,3]'), [1, 2, 3]);
});

test('braces inside strings do not end the scan', () => {
  assert.deepEqual(extractJson('note {"a":"}{","b":2} end'), { a: '}{', b: 2 });
});

test('a truncated object throws instead of returning a nested fragment', () => {
  const cut = `{"summary": "Samsung's 2026 foldables...",
 "facts": [{"fact": "Announced 22 July 2026", "sourceUrl": "https://news.samsung.com/au/x"}],
 "products": [{"name": "Galaxy Z Fold 8", "brand": "Samsu`;
  assert.throws(() => extractJson(cut), /Truncated JSON/);
});

test('a truncated object does not fall through to a later complete array', () => {
  // The old scan tried '{' then '[' independently, so an unterminated object
  // followed by any complete array handed back the array.
  const cut = '{"summary":"cut off here';
  assert.throws(() => extractJson(`${cut}\n[1,2,3]`), /Truncated JSON/);
});

test('text with no JSON at all throws', () => {
  assert.throws(() => extractJson('I could not complete that request.'), /No JSON value/);
});

test('requireKeys rejects an array where an object was asked for', () => {
  const check = requireKeys<{ facts: unknown }>('facts');
  const complaint = check([{ fact: 'x' }]);
  assert.match(String(complaint), /got an array/);
});

test('requireKeys names every missing field, and passes a complete object', () => {
  const check = requireKeys<{ a: unknown; b: unknown; c: unknown }>('a', 'b', 'c');
  assert.match(String(check({ a: 1 })), /b, c/);
  assert.equal(check({ a: 1, b: 2, c: 3 }), null);
});

test('requireKeys tolerates a null-valued key but not a missing one', () => {
  // A model that answers "no Amazon URL" with null is complying, not failing.
  const check = requireKeys<{ amazonUrl: unknown }>('amazonUrl');
  assert.equal(check({ amazonUrl: null }), null);
  assert.match(String(check({})), /amazonUrl/);
});
