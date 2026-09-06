// What the Claude engine is allowed to do. These are the guarantees an
// operator cannot check by reading a session row: that a stage which was not
// asked to verify anything cannot reach the network, and that neither shape
// can read the host's files or settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryOptions } from './claude.js';
import { READ_PAGE_TOOL, VERIFY_TOOLS, WEB_SEARCH_TOOL } from './searchTools.js';

const env = { PATH: '/usr/bin' };

test('a stage that does not verify gets one turn and no tools at all', () => {
  const options = queryOptions({ system: 'you are a writer' }, 'claude-opus-5', env);
  assert.equal(options.maxTurns, 1);
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.allowedTools, []);
  assert.equal('mcpServers' in options, false);
});

test('a verifying stage gets the search tools and room to use them', () => {
  const options = queryOptions({ search: true }, 'claude-opus-5', env);
  assert.ok(options.maxTurns > 1, 'tool use needs more than one turn');
  assert.deepEqual(options.allowedTools, VERIFY_TOOLS);
  assert.deepEqual(VERIFY_TOOLS, [WEB_SEARCH_TOOL, READ_PAGE_TOOL]);
  assert.ok('mcpServers' in options, 'the search server has to be attached');
});

test('search adds tools without opening the built-in set', () => {
  // The MCP server is the complete list of what an agent can do. If the
  // built-in preset ever leaked in, a stage could read files and run commands.
  for (const opts of [{}, { search: true }]) {
    assert.deepEqual(queryOptions(opts, 'claude-opus-5', env).tools, []);
  }
});

test('the host machine cannot steer a run', () => {
  // No ~/.claude/settings.json, no project CLAUDE.md, no MCP servers from a
  // config file — a published article must not depend on the box it ran on.
  for (const opts of [{}, { search: true }]) {
    const options = queryOptions(opts, 'claude-opus-5', env);
    assert.deepEqual(options.settingSources, []);
    assert.equal(options.strictMcpConfig, true);
    assert.notEqual(options.cwd, process.cwd());
  }
});

test('the credential env is passed through untouched', () => {
  const options = queryOptions({}, 'claude-opus-5', { ...env, CLAUDE_CODE_OAUTH_TOKEN: 'tok' });
  assert.equal(options.env.CLAUDE_CODE_OAUTH_TOKEN, 'tok');
});
