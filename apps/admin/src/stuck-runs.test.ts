/**
 * The stuck-run surface and the retry controls, guarded at source level.
 *
 * The panel has no component harness (a .tsx cannot be imported by node's type
 * stripping), so - as in table-layout.test.ts and overview-resilience.test.ts -
 * these assert against the page sources and the stylesheet. What they are
 * protecting is the set of things that regress silently: a run that stops
 * explaining itself, a publish control that stops being blocked, a timeout
 * that starts looking like a failure, and the accessibility and touch-target
 * rules that no screenshot in a pull request would catch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const styles = read('./styles.css');
const overview = read('./pages/Overview.tsx');
const pipeline = read('./pages/Pipeline.tsx');
const components = read('./components.tsx');
const sessions = read('./pages/Sessions.tsx');
const app = read('./App.tsx');
const events = read('./analytics.ts');
const eventDocs = read('../docs/analytics-events.md');

function rule(selector: string): string {
  const match = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(styles);
  assert.ok(match, `styles.css no longer has a ${selector} rule`);
  return match[1];
}

/** The body of the first `@media (max-width: <px>)` block in the sheet. */
function mediaBlock(maxWidth: number, contains: string): string {
  const blocks = [...styles.matchAll(new RegExp(`@media \\(max-width:\\s*${maxWidth}px\\)\\s*\\{`, 'g'))];
  for (const block of blocks) {
    // Media blocks here are one level deep: read to the matching brace.
    let depth = 1;
    let i = block.index + block[0].length;
    for (; i < styles.length && depth > 0; i++) {
      if (styles[i] === '{') depth++;
      else if (styles[i] === '}') depth--;
    }
    const body = styles.slice(block.index, i);
    if (body.includes(contains)) return body;
  }
  assert.fail(`no @media (max-width: ${maxWidth}px) block mentions ${contains}`);
}

test('the Overview surfaces stuck runs above the stat row', () => {
  const surface = overview.indexOf('<NeedsAttention');
  const grid = overview.indexOf('<div className="grid cols-4">');
  assert.ok(surface !== -1, 'the stuck surface is rendered');
  assert.ok(surface < grid, 'a wedged run is read before the stat figures');
  assert.match(overview, /runs=\{data\.stuck\}/, 'it lists exactly what the agent reported as stuck');
  assert.match(
    overview,
    /if \(!runs && !failed\) return null;/,
    'an agent without the section hides the surface, but a failed one still says so',
  );
  assert.match(overview, /stuck: 'stuck runs'/, 'a failed stuck section names itself in the banner');
  assert.match(overview, /className="attn calm"/, 'all-clear is a state of the same surface');
  assert.match(overview, /function NeedsAttentionSkeleton/, 'and so is the first load');
});

test('a stuck row links at its run and can stop it', () => {
  assert.match(overview, /Open run/);
  assert.match(overview, /onOpenRun\?\.\(run\.article_id\)/, 'the link opens that article');
  assert.match(overview, /`\/api\/articles\/\$\{run\.article_id\}\/cancel`/);
  assert.match(overview, /method: 'POST'/, 'through the same api\\(\\) chokepoint');
  assert.match(app, /const \[runToOpen, setRunToOpen\]/, 'the shell carries the request to the Pipeline tab');
  assert.match(app, /<Pipeline openArticleId=\{runToOpen\} onOpened=\{\(\) => setRunToOpen\(null\)\} \/>/);
  assert.match(pipeline, /setOpenId\(openArticleId\)/, 'and the board opens that run');
});

test('the row-level stop is state-gated, and names what it does', () => {
  assert.match(overview, /const stoppable = isStoppable\(run\.status\)/, 'only in-flight work gets a target');
  assert.match(overview, /\{stoppable && \(/);
  assert.match(overview, /stopControlLabel\(run\.status\)/, 'in-flight work is stopped, queued work cancelled');
  assert.match(overview, /title=\{stopControlHint\(run\.status\)\}/, 'and the control says where the way back is');
  assert.match(overview, /className="btn danger small"/, 'the destructive styling is the redundant signal');
  assert.match(overview, /<span aria-hidden="true">⊘<\/span>/, 'as is the glyph, for a monochrome screen');
  assert.match(
    rule('.attn-row .acts .btn.danger'),
    /margin-left:\s*12px/,
    'held off the row link rather than sitting flush against it',
  );
});

test('a single-row stop asks no dialog, and reports what it hit', () => {
  assert.doesNotMatch(overview, /confirm-overlay/, 'a per-row dialog would only teach dismissal');
  assert.match(
    overview,
    /stoppedNotice\(run\.title, Boolean\(res\?\.cancelling \?\? res\?\.pending\)\)/,
    'named run, honest tense, under either name the agent answers with',
  );
  assert.match(overview, /className="attn-toast notice-banner" role="status"/);
  assert.match(overview, /Open run to re-run/, 'recovery is one click from the report');
  assert.match(overview, /aria-label="Dismiss"/);
  assert.match(
    overview,
    /disabled=\{busy \|\| stopping\}/,
    'the same run is never offered the same stop twice while the stage lets go',
  );
  assert.match(
    overview,
    /stopping=\{stoppedIds\.includes\(run\.article_id\)\}/,
    'and the hold is per run, so triaging the next one does not release the last',
  );
  assert.match(
    overview,
    /runs\.filter\(group\.match\)\.sort\(byLongestRunning\)/,
    'and the rows hold still under a poll, so the click lands on the row it was aimed at',
  );
});

test('elapsed time is rendered against a budget, never as a bare duration', () => {
  for (const [name, source] of [
    ['Overview.tsx', overview],
    ['Pipeline.tsx', pipeline],
  ] as const) {
    assert.match(source, /<Elapsed\b/, `${name}: elapsed cells carry the threshold styling`);
    assert.match(
      source,
      /budgetSeconds=\{(stageBudgetSeconds|sessionBudgetSeconds)\(/,
      `${name}: the budget comes from the agent, never from a literal`,
    );
  }
  assert.match(components, /elapsedBand\(seconds, budgetSeconds, status\)/);
  assert.match(components, /BAND_MARK/, 'the band carries a glyph, not colour alone');
  assert.match(
    components,
    /if \(budgetSeconds === null\)/,
    'a session on no stage prints a plain duration rather than borrowing a budget',
  );
  assert.match(rule('.elapsed.warn'), /color:\s*var\(--amber\)/);
  assert.match(rule('.elapsed.over'), /color:\s*var\(--red\)/);
  assert.match(rule('.elapsed.normal'), /color:\s*var\(--text\)/);
});

test('a timed-out run is never dressed as a failure', () => {
  assert.match(components, /timed_out: 'timeout'/, 'timed_out has a colour of its own');
  assert.doesNotMatch(components, /timed_out: 'red'/);
  assert.match(components, /timed_out: '⏱'/, 'and a glyph of its own');
  const timeout = rule('.badge.timeout');
  assert.match(timeout, /border:\s*1px dashed/, 'outlined, where a failure is filled');
  assert.match(rule('.badge.red'), /background:\s*rgba\(244, 100, 125, 0\.14\)/, 'failed is unchanged');
});

test('a stopped run explains itself in one sentence, with the budget as text', () => {
  assert.match(pipeline, /article\.status === 'timed_out'/);
  assert.match(pipeline, /timedOutSentence\(budgetSeconds\)/, 'the agreed sentence, not a paraphrase');
  assert.match(pipeline, /<BudgetLine budgetSeconds=\{budgetSeconds\} \/>/);
  assert.match(
    pipeline,
    /article\.status !== 'timed_out' && <BudgetLine budgetSeconds=\{budgetSeconds\} \/>/,
    'a run that has not stopped still shows the limit it is running under',
  );
  assert.match(pipeline, /stageBudgetLine\(budgetSeconds\)/);
  assert.match(pipeline, /className="lock"/, 'the read-only budget wears the lock chip');
  const budgetLine = pipeline.slice(pipeline.indexOf('function BudgetLine'), pipeline.indexOf('function RunActions'));
  assert.doesNotMatch(budgetLine, /<input/, 'the budget is configuration, never a field');
});

test('the scrubbed detail is rendered verbatim, not parsed or re-scrubbed', () => {
  assert.match(pipeline, /<pre>\{timedOutSession\?\.error \?\? article\.error\}<\/pre>/);
  assert.match(rule('.detail-panel pre'), /white-space:\s*pre-wrap/);
  assert.doesNotMatch(pipeline, /redactText|sanitizeError/, 'redaction is the agent\'s job and is tested there');
});

test('every recovery the API supports is one click from the run', () => {
  for (const route of ['retry-stage', 'test-stage', 'rerun-all', 'cancel', 'approve-publish']) {
    assert.ok(pipeline.includes(route), `the panel calls ${route}`);
  }
  assert.match(pipeline, /\/test-stage`, \{\s*\n?\s*method: 'POST',\s*\n?\s*body: JSON\.stringify\(\{ stage \}\)/);
  assert.match(pipeline, /api\(`\/api\/articles\/\$\{id\}\/\$\{path\}`/, 'through the one api() chokepoint');
  assert.match(pipeline, /Retry from this stage/);
  assert.match(pipeline, /Test this step only/);
  assert.match(
    pipeline,
    /disabled=\{running \|\| testing !== null \|\| !testable\}/,
    'and never offers to "test" the one stage whose whole job is writing to the live site',
  );
  assert.match(pipeline, /Run whole pipeline again/);
  assert.match(pipeline, /Cancel run/);
});

test('the two expensive actions are confirmed, and say what is regenerated', () => {
  assert.match(pipeline, /setConfirming\(\{ kind: 'retry', stage \}\)/);
  assert.match(pipeline, /setConfirming\(\{ kind: 'rerun' \}\)/);
  const retry = pipeline.slice(pipeline.indexOf('function RetryConfirm'), pipeline.indexOf('function RerunAllConfirm'));
  assert.match(retry, /className="confirm-overlay"/, 'reuses the shipped dialog pattern');
  assert.match(retry, /stagesKeptBy\(stage\)/);
  assert.match(retry, /stagesRegeneratedBy\(stage\)/);
  assert.match(retry, /\{title\}/, 'the confirmation names the article');
  const rerun = pipeline.slice(pipeline.indexOf('function RerunAllConfirm'));
  assert.match(rerun, /acknowledged, setAcknowledged/);
  assert.match(rerun, /disabled=\{!acknowledged\}/, 'the expensive one gates on the cost acknowledgement');
  assert.match(rule('.confirm-modal .stage-split .kept li'), /var\(--green\)/);
  assert.match(rule('.confirm-modal .stage-split .regen li'), /var\(--amber\)/);
});

test('a test run is labelled as writing nothing, and shows its output', () => {
  assert.match(pipeline, /wrote nothing/);
  assert.match(pipeline, /The article, its stages and its stored output are\s*\n?\s*untouched/);
  assert.match(pipeline, /formatOutput\(result\.output\)/);
  assert.match(pipeline, /JSON\.stringify\(output, null, 2\)/, 'raw agent output is pretty-printed');
  assert.match(pipeline, /disabled=\{running \|\| testing !== null \|\|/, 'the control is held while it is out');
  assert.match(pipeline, /Testing \$\{testing\}…/, 'and says what it is doing');
});

test('a running article can be cancelled, and says so while it lets go', () => {
  assert.match(pipeline, /'running', 'queued', 'failed', 'timed_out', 'waiting_approval'/);
  assert.match(pipeline, /running && Boolean\(article\.cancel_requested\)/);
  assert.match(pipeline, /\{cancelling \? 'Cancelling…' : 'Cancel run'\}/);
  assert.match(pipeline, /setInterval\(load, 4000\)/, 'the panel keeps polling so the row moves on its own');
});

test('a run committed to spend is never the one thing nothing can stop', () => {
  const actions = pipeline.slice(pipeline.indexOf('function RunActions'), pipeline.indexOf('/** What an isolated test run'));
  assert.match(actions, /Queuing retry…/, 'the primary names the in-flight retry');
  const cancelButton = actions.indexOf("{cancelling ? 'Cancelling…' : 'Cancel run'}");
  assert.ok(cancelButton !== -1, 'cancel stays on the bar while a retry is queued');
  assert.match(actions, /disabled=\{cancelling\}/, 'and is only disabled by a cancel already in flight');
  assert.match(actions, /Cancel stops the queued retry before it starts/);
});

test('a stale review blocks approval, with the reason stated', () => {
  assert.match(pipeline, /REVIEW_STALE_BANNER/, 'the article carries the banner');
  const approve = pipeline.slice(pipeline.indexOf("article.status === 'waiting_approval'"));
  assert.match(approve, /disabled=\{reviewStale \|\|/, 'the control is disabled, not just warned about');
  assert.match(approve, /aria-disabled=\{reviewStale \? 'true' : undefined\}/);
  assert.match(approve, /\$\{reviewStaleReason\}/, 'and states the reason');
  assert.match(
    pipeline,
    /detail\?\.reviewStaleReason \?\? REVIEW_STALE_REASON/,
    "the agent's own sentence when it sends one, else the one its 409 carries",
  );
  assert.match(
    pipeline,
    /Boolean\(article\?\.review_stale \?\? detail\?\.reviewStale\)/,
    'and the flag is read wherever the agent puts it',
  );
});

test('attempts are grouped per stage, and downstream stages are labelled', () => {
  assert.match(pipeline, /groupAttempts\(sessions\)/);
  assert.match(pipeline, /outOfDateStages\(article, sessions\)/);
  assert.match(pipeline, /<OutOfDateBadge \/>/);
  assert.match(components, /OUT_OF_DATE_LABEL/);
  assert.match(pipeline, /Sessions without a stage/, 'a session with no stage is listed, never guessed');
  assert.match(pipeline, /<details className="attempt"/);
  assert.match(pipeline, /aria-label=\{`Attempt history table for \$\{group\.stage\}`\}/);
  assert.match(rule('.stage-row.stale'), /inset 3px 0 0 var\(--amber\)/, 'and marked on the timeline');
});

test('the triage rows keep one set of columns, whatever controls a row carries', () => {
  // A row whose work can still be stopped carries two controls and one that
  // cannot carries one; a content-sized action column moved the elapsed and
  // status cells to a different x on each row of the same list.
  assert.match(
    rule('.attn-row'),
    /grid-template-columns:\s*minmax\(0,\s*1\.5fr\)\s+118px\s+132px\s+216px/,
    'the action column is sized, not auto',
  );
  assert.match(rule('.attn-row .acts'), /justify-content:\s*flex-end/, 'so the controls hold the edge');
});

test('the wide session tables say they scroll, below the width they stop fitting', () => {
  assert.match(rule('.scroll-hint'), /display:\s*none/, 'silent where everything fits');
  assert.match(mediaBlock(1040, '.scroll-hint'), /display:\s*block/);
  assert.match(overview, /className="scroll-hint"/, 'the recent-sessions card carries it');
  assert.match(sessions, /className="scroll-hint"/, 'and so does the sessions tab');
  assert.match(rule('.card.table-scroll'), /overflow-x:\s*auto/);
});

test('row controls are touch targets from tablet width down', () => {
  assert.match(rule('button.btn'), /min-height:\s*44px/, 'a full-size control is already one');
  const tablet = mediaBlock(900, 'button.btn.small');
  assert.match(tablet, /min-height:\s*44px/, '834px is a touch width, not just 520px');
  assert.match(rule('button.btn.small'), /min-height:\s*32px/, 'the desktop size is unchanged');
  assert.match(mediaBlock(520, 'button.btn.small'), /font-size:\s*13px/, 'phones still get the larger type');
  assert.match(rule('details.attempt > summary'), /min-height:\s*44px/);
});

test('the connection fields take the row at tablet width', () => {
  const tablet = mediaBlock(900, '.topbar .conn');
  assert.match(tablet, /flex-basis:\s*100%/);
  assert.match(tablet, /justify-content:\s*flex-start/);
  assert.match(tablet, /max-width:\s*none/, 'the inputs grow instead of sitting pinned and small');
});

test('a disabled danger control stays readable instead of fading out', () => {
  const disabled = rule("button.btn.danger:disabled,\nbutton.btn.danger[aria-disabled='true']");
  assert.match(disabled, /opacity:\s*1/, 'the generic opacity dim is overridden');
  assert.match(disabled, /background:\s*rgba\(244, 100, 125, 0\.22\)/, 'a solid fill, not a translucent one');
  assert.match(disabled, /color:\s*#ffd7dd/, 'light text on it');
  assert.match(rule('button.btn:disabled'), /opacity:\s*0\.45/, 'which is what it is overriding');
});

test('the detail panel layers above a viewport-fixed backdrop', () => {
  // The backdrop is one viewport tall whatever the panel's content does, so a
  // long run detail never scrolls past the dimmed board into a bare area.
  const overlay = rule('.detail-overlay');
  assert.match(overlay, /position:\s*fixed/);
  assert.match(overlay, /inset:\s*0/);
  assert.match(
    styles,
    /\.detail-panel \{ position: relative; z-index: 1; \}/,
    'the panel sits above the fixed backdrop, however long its content runs',
  );
});

test('the attempt tables announce their sideways scroll below 820px', () => {
  assert.match(rule('.attempt-hint'), /display:\s*none/);
  assert.match(mediaBlock(820, '.attempt-hint'), /display:\s*block/);
  assert.match(rule('.abody table'), /min-width:\s*640px/, 'so the scroll behaves the same everywhere');
  assert.match(pipeline, /className="attempt-hint"/);
  assert.match(pipeline, /Each attempt table scrolls sideways/);
});

test('motion is flattened when the operator asked for less of it', () => {
  const reduced = styles.slice(styles.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.skel, \.live \{ animation: none; \}/);
});

test('the new actions report under the existing taxonomy', () => {
  assert.match(events, /stuckRunOpened: 'Stuck Run Opened'/);
  assert.match(pipeline, /action: 'test_stage'/);
  assert.match(pipeline, /action: name/, 'every other action reports by route name');
  assert.match(eventDocs, /Stuck Run Opened/, 'the doc is the canonical reference');
  assert.match(eventDocs, /retry_stage/);
});
