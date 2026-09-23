// JSON extraction and the shape contract.
//
// The truncation test is the important one. A dossier reply cut off mid-object
// used to come back as its own `facts` array — valid JSON, plausible shape,
// no products — and the pipeline stored it, reported success, and would have
// published a buying guide with an empty affiliate table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, JSON_REPROMPT_BUDGET, repromptJson, requireKeys } from './index.js';

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

// ── The reprompt budget ────────────────────────────────────────────────────
//
// The card that started this: the outliner replied with malformed JSON, was
// reprompted once, replied with malformed JSON again, and the article died on
// "Expected ',' or ']' in JSON at position 2546". Two bad replies in a row now
// cost a third ask instead of the card.

/**
 * A brief whose section array drops a comma between two objects - balanced
 * braces, malformed content. This is the same shape that produced the
 * reported "Expected ',' or ']' after array element in JSON at position 2546".
 */
const MALFORMED_BRIEF =
  `{"seoTitle":"Best cordless stick vacuums in Australia","dek":"Tested picks.",` +
  `"slug":"best-cordless-stick-vacuums","sections":[{"h2":"How we picked"}` +
  `{"h2":"The shortlist"}],"wordCountTarget":2200}`;

const GOOD_BRIEF =
  `{"seoTitle":"Best cordless stick vacuums in Australia","dek":"Tested picks.",` +
  `"slug":"best-cordless-stick-vacuums","sections":[{"h2":"How we picked"}],` +
  `"wordCountTarget":2200}`;

test('the reported outliner parse failure now recovers on the third ask', async () => {
  const prompts: string[] = [];
  const replies = [MALFORMED_BRIEF, MALFORMED_BRIEF, GOOD_BRIEF];
  const brief = await repromptJson<{ seoTitle: string }>(
    async (prompt) => {
      prompts.push(prompt);
      return replies[prompts.length - 1];
    },
    'Create the SEO content brief for this piece.',
    requireKeys<{ seoTitle: unknown; slug: unknown; sections: unknown }>('seoTitle', 'slug', 'sections'),
  );

  assert.equal(brief.seoTitle, 'Best cordless stick vacuums in Australia');
  assert.equal(prompts.length, 3, 'one call plus the two reprompts the budget allows');
  assert.match(prompts[1], /could not be used/, 'the model is told what was wrong with the reply');
  assert.match(prompts[2], /2 unusable replies/, 'the second reprompt escalates rather than repeating');
});

test('a reply that is never usable still fails, with the parse error intact', async () => {
  let calls = 0;
  await assert.rejects(
    repromptJson<unknown>(async () => {
      calls++;
      return MALFORMED_BRIEF;
    }, 'Create the SEO content brief for this piece.'),
    /in JSON at position/,
    'the message the stage runner classifies as a transient parse failure',
  );
  assert.equal(calls, 1 + JSON_REPROMPT_BUDGET, 'the budget is bounded, not a loop');
});

test('a shape complaint is reprompted, and the complaint is what the model is told', async () => {
  const prompts: string[] = [];
  const value = await repromptJson<{ facts: unknown[] }>(
    async (prompt) => {
      prompts.push(prompt);
      return prompts.length === 1 ? '{"summary":"..."}' : '{"summary":"...","facts":[]}';
    },
    'Synthesize a research dossier.',
    requireKeys<{ facts: unknown }>('facts'),
  );
  assert.deepEqual(value.facts, []);
  assert.match(prompts[1], /Missing required field\(s\): facts/);
});

test('a transport fault is not reprompted - chat() has already retried it', async () => {
  let calls = 0;
  await assert.rejects(
    repromptJson<unknown>(async () => {
      calls++;
      throw new TypeError('fetch failed');
    }, 'Plan web research for this piece.'),
    /fetch failed/,
  );
  assert.equal(calls, 1, 're-asking a down socket for better JSON buys nothing');
});
