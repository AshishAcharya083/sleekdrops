// The angle stage where it actually lands: a real Postgres row, the runner
// that routes through it, and the admin API the operator panel reads it back
// through.
//
// The unit tests in agents/angleEditor.test.ts prove the record's
// normalisation. They cannot prove that `angle` is a stage the runner knows
// how to claim, that a keyword stage now hands off to it rather than straight
// to the outliner, or that the record survives the JSONB round trip with its
// information gain intact - all three only happen against the database. Point
// DATABASE_URL at a throwaway server to run these.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ADMIN_TOKEN = 'test-admin-token';
// Before config.js is loaded: the stage below is driven to failure by a Claude
// model with no credential, and an inherited token would turn that into a live
// model call from a test suite that must never make one.
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { getSetting, pool, q } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { ENGINE_AGENTS, NO_LLM_AGENTS, runStage, STAGE_AGENT } = await import('./runner.js');
const { createApp } = await import('../api/server.js');
const { normaliseAngle } = await import('../agents/angleEditor.js');
const { editorialAngleBrief } = await import('../agents/context.js');

import type { ArticleRow, EditorialAngle } from './types.js';

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

if (reachable) await migrate();

/** The admin panel can store a Claude token too; if one is there, stand down. */
const credentialled =
  reachable && (await getSetting<{ claude_token?: string }>('llm', {})).claude_token;
const modelSkip = credentialled
  ? 'the database carries a Claude token - this test must not reach a live model'
  : skip;

const app = createApp();
const AUTH = { Authorization: 'Bearer test-admin-token' };

after(async () => {
  if (reachable) await pool.end();
});

function anAngle(): EditorialAngle {
  return normaliseAngle(
    {
      thesis: 'The Dyson is the wrong buy above A$1,000 and the Shark is the one to get.',
      reader: 'Someone replacing a corded vacuum in a two-bedroom flat with no carpet',
      defensible: true,
      contrarianTake: 'The machine every roundup ranks first is the one owners replace in year two.',
      informationGain: [
        {
          claim: 'The clutch fails inside 12 months on a recurring basis.',
          absentFrom: 'https://choice.com.au/vacuums',
          evidence: '37 of 412 ProductReview entries, 2026-03',
        },
      ],
      shape: 'failure-led',
      shapeRationale: 'The failure data is the only thing the top three do not have.',
      byline: 'home',
      bylineRationale: 'A durability argument about a household appliance.',
    },
    { postType: 'guide', category: 'Home', competitorUrls: ['https://choice.com.au/vacuums'] },
  );
}

async function insertArticle(fields: Record<string, unknown> = {}): Promise<ArticleRow> {
  const row = {
    title: `Best cordless stick vacuums ${randomUUID().slice(0, 8)}`,
    category: 'Home',
    post_type: 'guide',
    ...fields,
  };
  const keys = Object.keys(row);
  const [inserted] = await q<ArticleRow>(
    `INSERT INTO articles (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    Object.values(row),
  );
  return inserted;
}

test('every article stage has an agent, and every prompt stage an engine', () => {
  // The registration a new stage is easiest to half-finish: STAGE_AGENT gives
  // it a named session, ENGINE_AGENTS puts it on the engine the panel toggles
  // and offers it a model override. A stage in one and not the other runs on
  // whatever the other default happens to be, silently.
  assert.equal(STAGE_AGENT.angle, 'angle_editor');
  for (const [stage, agent] of Object.entries(STAGE_AGENT)) {
    if (NO_LLM_AGENTS.has(agent)) continue;
    if (agent === 'image_agent') continue; // pinned to Gemini, by capability
    assert.ok(ENGINE_AGENTS.has(agent), `${stage} runs ${agent}, which no engine claims`);
  }
});

test('the angle stage is a stage the runner can claim and record a session for', { skip: modelSkip }, async () => {
  // Registration in STAGE_AGENT is what turns `stage = 'angle'` into a named
  // agent with its own session row; membership of ENGINE_AGENTS is what puts
  // it on the engine the panel toggles. Both are proved here without a live
  // model and without touching the shared `models` setting (another test file
  // owns that key): the default engine is Claude, this sandbox has no Claude
  // credential, so an engine agent refuses to start and names itself.
  const article = await insertArticle({
    stage: 'angle', status: 'running', claimed_by: 'test-worker', claimed_at: new Date(),
  });

  await runStage(article);

  const [session] = await q<{ agent: string; model: string | null; status: string; error: string }>(
    'SELECT agent, model, status, error FROM agent_sessions WHERE article_id = $1',
    [article.id],
  );
  assert.equal(session.agent, 'angle_editor');
  assert.equal(session.status, 'failed');
  assert.match(
    session.error,
    /angle_editor is set to run on claude-/,
    'the stage runs on the prose engine, not on whatever Gemini default it fell through to',
  );

  const [failed] = await q<ArticleRow>('SELECT * FROM articles WHERE id = $1', [article.id]);
  assert.equal(failed.stage, 'angle', 'a failed stage must not advance the article');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.claimed_by ?? null, null, 'the claim is released so retry can pick it up');
});

test('the angle record survives JSONB and reaches the panel whole', { skip }, async () => {
  // The admin panel renders these keys straight out of the column, and four
  // downstream prompts read the same row. A round trip that flattened
  // informationGain or dropped `defensible` would only ever show up here.
  const angle = anAngle();
  const article = await insertArticle({
    stage: 'outline', status: 'queued', editorial_angle: JSON.stringify(angle),
  });

  const res = await app.fetch(
    new Request(`http://localhost/api/articles/${article.id}`, { headers: AUTH }),
  );
  assert.equal(res.status, 200);
  const { article: seen } = (await res.json()) as { article: ArticleRow };

  assert.deepEqual(seen.editorial_angle, angle);
  assert.equal(seen.editorial_angle?.shape, 'failure-led');
  assert.equal(seen.editorial_angle?.byline, 'home');
  assert.equal(seen.editorial_angle?.informationGain[0].absentFrom, 'https://choice.com.au/vacuums');

  // The same row is what the outliner, writer, editor and reviewer are handed.
  // Reading it back off the wire (not off the object we wrote) is the only way
  // to prove the prompt they get is built from what was persisted.
  const brief = editorialAngleBrief(seen.editorial_angle);
  assert.match(brief, /Thesis: The Dyson is the wrong buy/);
  assert.match(brief, /Structural shape: failure-led/);
  assert.match(brief, /absent from https:\/\/choice\.com\.au\/vacuums/);
});

test('an article with no defensible take says so to the panel and the prompts', { skip }, async () => {
  const angle = normaliseAngle(
    { thesis: 'The Ninja is the pick.', defensible: false, weakness: 'No owner complaints were gathered.', shape: 'ranked-list', byline: 'home' },
    { postType: 'roundup', category: 'Home', competitorUrls: [] },
  );
  const article = await insertArticle({
    post_type: 'roundup', stage: 'write', status: 'queued', editorial_angle: JSON.stringify(angle),
  });

  const res = await app.fetch(
    new Request(`http://localhost/api/articles/${article.id}`, { headers: AUTH }),
  );
  const { article: seen } = (await res.json()) as { article: ArticleRow };

  assert.equal(seen.editorial_angle?.defensible, false);
  assert.equal(seen.editorial_angle?.contrarianTake, '');
  assert.equal(seen.editorial_angle?.weakness, 'No owner complaints were gathered.');
  assert.match(editorialAngleBrief(seen.editorial_angle), /NO DEFENSIBLE CONTRARIAN TAKE/);
});

test('articles queued before this stage existed still read back with no angle', { skip }, async () => {
  const article = await insertArticle({ stage: 'outline', status: 'queued' });
  const res = await app.fetch(
    new Request(`http://localhost/api/articles/${article.id}`, { headers: AUTH }),
  );
  const { article: seen } = (await res.json()) as { article: ArticleRow };
  assert.equal(seen.editorial_angle, null);
  assert.equal(editorialAngleBrief(seen.editorial_angle), '', 'no angle means no angle block');
});
