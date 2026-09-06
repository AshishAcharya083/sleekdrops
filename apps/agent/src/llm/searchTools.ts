// The Claude engine's verification toolbelt — live web search and a page read,
// exposed to the model as MCP tools that run in this process.
//
// Why the pipeline's own Tavily key rather than a hosted search tool: the
// researcher and the keyword strategist already gather their evidence through
// Tavily, so a fact the model checks here comes back from the same index that
// produced the dossier. Two different search providers would let a stage
// "verify" a claim against a source the rest of the pipeline cannot see.
//
// These tools are read-only and network-only. The Claude engine runs with the
// built-in tool set disabled (`tools: []`), so this server is the complete
// list of things an agent can do besides answer.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { fetchPageText } from '../tools/webpage.js';
import { tavilySearch } from '../tools/tavily.js';

/** MCP server name — the `mcp__<server>__<tool>` prefix the CLI allows on. */
const SERVER = 'verify';

export const WEB_SEARCH_TOOL = `mcp__${SERVER}__web_search`;
export const READ_PAGE_TOOL = `mcp__${SERVER}__read_page`;

/** Every tool the search-enabled agents may call, for `allowedTools`. */
export const VERIFY_TOOLS = [WEB_SEARCH_TOOL, READ_PAGE_TOOL];

const SERVER_INSTRUCTIONS = `
Live web access for checking facts. Search returns ranked results with
snippets; read_page returns the text of one page so you can see the claim in
its own source rather than in a summary of it.

Use these to confirm specifics — prices, model numbers, specs, release dates,
availability — and to catch anything in your context that is stale or wrong.
Prefer the primary source (a manufacturer's spec page, a retailer's listing, a
standards body) over any article about it.
`.trim();

const webSearch = tool(
  'web_search',
  'Search the live web. Returns ranked results with title, URL and a snippet. ' +
    'Use it to check a specific fact, price, spec or date against current sources.',
  {
    query: z
      .string()
      .min(2)
      .describe('The search query. Be specific — include the model number, brand or exact phrase you are checking.'),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe('How many results to return (default 6).'),
  },
  async ({ query, maxResults }) => {
    try {
      const hits = await tavilySearch(query, maxResults ?? 6);
      if (hits.length === 0) {
        return text(`No results for "${query}". Treat the claim as unverified.`);
      }
      return text(
        `Results for "${query}":\n\n` +
          hits
            .map((hit, i) => `${i + 1}. ${hit.title}\n   ${hit.url}\n   ${hit.content.slice(0, 600)}`)
            .join('\n\n'),
      );
    } catch (err) {
      return failure(`web_search failed for "${query}": ${message(err)}`);
    }
  },
);

const readPage = tool(
  'read_page',
  'Fetch one public web page and return its readable text. Use it after a search ' +
    'to read a claim in its own source instead of trusting a snippet.',
  {
    url: z.string().url().describe('The full http(s) URL of the page to read.'),
  },
  async ({ url }) => {
    try {
      const page = await fetchPageText(url);
      return text(`${page.title || page.url}\n${page.url}\n\n${page.text}`);
    } catch (err) {
      return failure(`read_page failed for ${url}: ${message(err)}`);
    }
  },
);

/**
 * A fresh server instance per run. `createSdkMcpServer` hands the SDK a live
 * object bound to one query, so sharing one across concurrent stages would
 * cross their tool traffic.
 */
export function verificationServer() {
  return createSdkMcpServer({
    name: SERVER,
    version: '1.0.0',
    instructions: SERVER_INSTRUCTIONS,
    tools: [webSearch, readPage],
    // Both tools are the point of turning search on — never defer them behind
    // tool search, or an agent asked to verify simply won't see them.
    alwaysLoad: true,
  });
}

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] };
}

/**
 * A failed lookup is reported to the model, not thrown. An agent that is told
 * "the tool errored" leaves the claim unverified; one whose tool call vanishes
 * concludes the claim checked out.
 */
function failure(body: string) {
  return { content: [{ type: 'text' as const, text: body }], isError: true };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
