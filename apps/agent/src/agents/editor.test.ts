// The editor is told about the draft's voice problems exactly once: the
// review's scan issues are dropped on the grounds that the scan is re-derived
// here. That makes the two halves one invariant - whatever issuesForEditor
// filters out, voiceScanBrief has to put back. The cross-corpus repetition
// findings are the case that is easy to break, because they only exist when
// the scan is handed the published corpus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issuesForEditor, voiceScanBrief } from './editor.js';
import { ISSUE_PREFIX } from './seoReviewer.js';
import type { CorpusDocument } from '../content/corpus.js';
import type { ArticleRow } from '../pipeline/types.js';

const PUBLISHED = `If you want the best portable Bluetooth speaker in Australia right now, buy the
JBL Flip 6. It costs $149 RRP and it is the one we would hand to a friend
without a caveat.

## Why the JBL Flip 6 wins

JBL rates the Flip 6 at 12 hours of playback, and the IP67 rating means a
poolside drop is survivable. The bass is thinner than the Bose equivalent, which
matters indoors and not at all outside.`;

/** The published article's opening and shape, with vacuum nouns dropped in. */
const RECYCLED = `If you want the best cordless stick vacuum in Australia right now, buy the
Dyson V15 Detect. It costs $1,449 RRP and it is the one we would hand to a
friend without a caveat.

## Why the Dyson V15 wins

Dyson rates the V15 at 60 minutes of runtime, and the dust sensor means a
carpeted room is measurable rather than guessed at, which is the single reason
we picked it over the cheaper Shark. The weight is worse.`;

const corpus: CorpusDocument[] = [
  { slug: 'best-portable-bluetooth-speakers', title: 'Best speakers', body: PUBLISHED, publishedAt: '2026-03-01' },
];

const review = (issues: NonNullable<ArticleRow['seo_review']>['issues']): ArticleRow['seo_review'] =>
  ({ score: 61, pass: false, issues, summary: '' }) as ArticleRow['seo_review'];

test('scan issues are dropped from the list and the rest ordered most severe first', () => {
  const issues = issuesForEditor(
    review([
      { severity: 'low', issue: `${ISSUE_PREFIX.position}no con on the top pick`, fix: 'Name one.' },
      { severity: 'high', issue: `${ISSUE_PREFIX.scan}AI vocabulary: "delve" x2 (line 14)`, fix: 'Rewrite it.' },
      { severity: 'high', issue: 'Voice scan — recycled opening', fix: 'Rewrite it.' },
      { severity: 'high', issue: `${ISSUE_PREFIX.claim}[price] "$229"`, fix: 'Cut it.' },
    ]),
  );

  assert.deepEqual(
    issues.map((i) => i.severity),
    ['high', 'low'],
  );
  assert.ok(issues[0].issue.startsWith(ISSUE_PREFIX.claim));
});

test('the brief carries the repetition findings the review can fail the draft on', () => {
  const brief = voiceScanBrief(RECYCLED, corpus);

  assert.match(brief, /Recycled phrasing from published articles/);
  assert.match(brief, /Opening reused from a published article/);
  assert.match(brief, /best-portable-bluetooth-speakers/);
});

test('without a corpus the same draft reads clean of repetition, which is why it is passed one', () => {
  assert.doesNotMatch(voiceScanBrief(RECYCLED, []), /published article/);
});
