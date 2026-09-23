// The parts of the insights job that are pure: when the next reading is due,
// when the collection window shuts, and what a reading concludes. The database
// side - the claim, the join and what the flag is written to - is
// insights.db.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/unreachable';

const {
  INSIGHT_CHECKPOINT_SECONDS,
  INSIGHT_RETRY_SECONDS,
  INSIGHT_WINDOW_SECONDS,
  UNCLICKABLE_CLICK_RATE,
  UNCLICKABLE_COMMENT_LINK,
  UNCLICKABLE_MIN_IMPRESSIONS,
  insightsFlag,
  nextInsightsPollAt,
  retryInsightsPollAt,
} = await import('./insights.js');

const POSTED_AT = new Date('2026-09-01T12:00:00.000Z');

/** `seconds` after the post landed. */
function after(seconds: number): Date {
  return new Date(POSTED_AT.getTime() + seconds * 1_000);
}

// ── The polling schedule ───────────────────────────────────────────────────

test('the cadence widens: each checkpoint is further from the last', () => {
  const gaps = INSIGHT_CHECKPOINT_SECONDS.map((seconds, i) =>
    i === 0 ? seconds : seconds - INSIGHT_CHECKPOINT_SECONDS[i - 1],
  );
  for (let i = 1; i < gaps.length; i++) {
    assert.ok(gaps[i] > gaps[i - 1], `checkpoint ${i} must wait longer than the one before it`);
  }
});

test('a freshly posted item is polled at every checkpoint in turn', () => {
  let now = POSTED_AT;
  const taken: number[] = [];
  for (let reading = 0; reading < INSIGHT_CHECKPOINT_SECONDS.length + 1; reading++) {
    const due = nextInsightsPollAt(POSTED_AT, now);
    if (!due) break;
    taken.push((due.getTime() - POSTED_AT.getTime()) / 1_000);
    // The reading happens the moment it falls due, which is the worst case for
    // the schedule: a poll that lands exactly on a checkpoint must move on to
    // the next one rather than repeat this one.
    now = due;
  }
  assert.deepEqual(taken, [...INSIGHT_CHECKPOINT_SECONDS]);
});

test('polling stops after the last checkpoint, however late the first reading is', () => {
  assert.equal(nextInsightsPollAt(POSTED_AT, after(INSIGHT_CHECKPOINT_SECONDS.at(-1)!)), null);
  assert.equal(nextInsightsPollAt(POSTED_AT, after(365 * 24 * 3_600)), null);
});

test('an item whose readings started late catches up in one reading, not five', () => {
  // A post read back for the first time four days in: the missed checkpoints
  // would all report the same numbers, so the next due one is the seventh day.
  const due = nextInsightsPollAt(POSTED_AT, after(4 * 24 * 3_600));
  assert.equal(due?.toISOString(), after(7 * 24 * 3_600).toISOString());
});

// ── Retrying a failed reading ──────────────────────────────────────────────

test('a failed reading is retried, and gives up at the end of the window', () => {
  const early = retryInsightsPollAt(POSTED_AT, after(3_600));
  assert.equal(early?.toISOString(), after(3_600 + INSIGHT_RETRY_SECONDS).toISOString());

  // Room past the last checkpoint for the retries that get the final reading.
  assert.ok(INSIGHT_WINDOW_SECONDS > INSIGHT_CHECKPOINT_SECONDS.at(-1)!);
  assert.ok(retryInsightsPollAt(POSTED_AT, after(INSIGHT_CHECKPOINT_SECONDS.at(-1)!)));

  // And nothing retries past it - a post nobody can read back stops being polled.
  assert.equal(retryInsightsPollAt(POSTED_AT, after(INSIGHT_WINDOW_SECONDS)), null);
});

// ── The low-click flag ─────────────────────────────────────────────────────

test('impressions with near-zero clicks flags a first-comment link as unclickable', () => {
  assert.equal(
    insightsFlag({ placement: 'first_comment', impressions: 4_000, clicks: 0 }),
    UNCLICKABLE_COMMENT_LINK,
  );
  assert.equal(
    insightsFlag({
      placement: 'first_comment',
      impressions: UNCLICKABLE_MIN_IMPRESSIONS,
      clicks: 0,
    }),
    UNCLICKABLE_COMMENT_LINK,
  );
});

test('a first-comment post that is earning clicks is not flagged', () => {
  assert.equal(insightsFlag({ placement: 'first_comment', impressions: 4_000, clicks: 96 }), null);
  // Exactly at the threshold rate is "clicks are arriving", not a failure.
  const atRate = Math.ceil(4_000 * UNCLICKABLE_CLICK_RATE);
  assert.equal(
    insightsFlag({ placement: 'first_comment', impressions: 4_000, clicks: atRate }),
    null,
  );
});

test('a quiet post is not evidence of a broken link', () => {
  assert.equal(
    insightsFlag({
      placement: 'first_comment',
      impressions: UNCLICKABLE_MIN_IMPRESSIONS - 1,
      clicks: 0,
    }),
    null,
  );
});

test('only a first-comment placement can carry this flag', () => {
  // An in_body post carries its link in the caption; zero clicks there is a
  // post nobody engaged with, not a link nobody could follow.
  assert.equal(insightsFlag({ placement: 'in_body', impressions: 40_000, clicks: 0 }), null);
});

test('a counter the network did not report proves nothing either way', () => {
  assert.equal(insightsFlag({ placement: 'first_comment', impressions: 4_000, clicks: null }), null);
  assert.equal(insightsFlag({ placement: 'first_comment', impressions: null, clicks: 0 }), null);
});
