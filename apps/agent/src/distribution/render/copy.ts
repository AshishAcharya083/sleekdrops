// The caption: a headline the scan cleared, and the two fixtures the caption
// is not allowed to drop.
//
// Two things make social copy different from body copy. The first is that
// telling a model "don't write like an AI" does not work here any more than it
// works on a draft, so the headline is measured with the same detectSlop() the
// reviewer runs and a trip costs the model its one regeneration; past that the
// copy is derived from the dek deterministically, because a caption that reads
// a little flat is a far smaller defect than one that reads as machine filler
// on a public Page.
//
// The second is that the caption carries three things at once - the headline,
// the cue that the link is in the first comment, and the affiliate disclosure
// where the endorsement is actually made - and they compete for the same few
// lines. So the order is fixed, the two fixtures are registered house text
// (content/slop.ts) and are never truncated, and what the headline gets is
// whatever the channel has left after them.
import { getSetting } from '../../db/pool.js';
import { createLogger } from '../../lib/log.js';
import { ANTI_SLOP_RULES } from '../../agents/context.js';
import {
  detectSlop,
  formatSlopReport,
  houseBlock,
  slopSeverity,
  SLOP_PASS_SCORE,
} from '../../content/slop.js';
import {
  chat,
  defaultClaudeModel,
  defaultGeminiModel,
  llmSettings,
} from '../../llm/index.js';
import type { ChannelSpec } from './channels.js';

const log = createLogger('distribution');

/** The registered wording of each fixture. Frozen and versioned in the registry. */
export const AFFILIATE_DISCLOSURE = houseBlock('social-disclosure').text;
export const FIRST_COMMENT_CUE = houseBlock('link-placement-cue').text;

/** What separates the parts of a caption. Counted against the channel's limit. */
const JOIN = '\n\n';

/**
 * The longest headline we will post whatever the channel allows. Facebook will
 * take 63,206 characters; nobody clicks a paragraph, and the point of the
 * budget is to protect the fixtures, not to fill the field.
 */
export const HEADLINE_MAX_CHARS = 220;

/** What the copy is written from. No draft, no dossier - a caption is not a piece. */
export interface CopyRequest {
  title: string;
  dek: string;
  /** The query the piece was built to win, when the keyword stage named one. */
  keyword: string;
  channel: ChannelSpec;
  /** Characters the headline may run to once the fixtures have their space. */
  budget: number;
}

/**
 * One social-copy completion. Injected so the ladder below can be driven
 * without a model - a stub returning known-sloppy text is the only way to test
 * a regeneration deterministically.
 */
export type CopyWriter = (request: CopyRequest, complaint?: string) => Promise<string>;

/** Which rung of the ladder produced the headline that shipped. */
export type CopySource = 'model' | 'regenerated' | 'fallback';

/**
 * Copy that claims a person did something nobody here did.
 *
 * The body rules already forbid this (agents/context.ts) and the byline is one
 * accountable team rather than an invented reviewer, but a caption is written
 * by a different call with a different prompt, and "we tested these for three
 * weeks" is the single most natural thing for a model to open a product post
 * with. So it is measured rather than asked for, exactly like the slop scan.
 */
const AUTHORSHIP_CLAIMS: Array<{ rule: string; re: RegExp }> = [
  {
    rule: 'claims hands-on testing',
    re: /\b(?:hands[- ]on|in our (?:testing|tests|lab)|on (?:our|the) test bench)\b/i,
  },
  {
    rule: 'claims we used the product',
    re: /\b(?:we|i)\s*(?:'|’)?(?:ve|d)?\s+(?:tested|tried|trialled|trialed|used|wore|unboxed|benchmarked|lived with|spent)\b/i,
  },
  {
    rule: 'claims a person or a staffed desk behind the copy',
    re: /\bour (?:testers?|reviewers?|lab|test team)\b/i,
  },
];

/** The claim this text makes about who wrote or used the product, if any. */
export function authorshipClaim(text: string): string | null {
  return AUTHORSHIP_CLAIMS.find((claim) => claim.re.test(text))?.rule ?? null;
}

/**
 * Why this headline cannot ship, or null when it can.
 *
 * The bar is the reviewer's: any high-severity finding (banned vocabulary or a
 * banned phrase - one "delve" is conclusive however good the rest is) or a
 * score under the pass mark. Returned as the text handed back to the model,
 * because a regeneration that is not told what tripped is a coin flip.
 */
export function headlineTrip(headline: string): string | null {
  const text = headline.trim();
  if (text === '') return 'The reply was empty.';

  const claim = authorshipClaim(text);
  if (claim) {
    return `The copy ${claim}. Nobody here has touched these products - write from what the piece says, never from use.`;
  }

  const report = detectSlop(text);
  const high = report.findings.filter((finding) => slopSeverity(finding) === 'high');
  if (high.length > 0 || report.score < SLOP_PASS_SCORE) return formatSlopReport(report);
  return null;
}

/**
 * One line of prose, out of whatever shape the model replied in.
 *
 * Any link the model wrote is deleted rather than kept. Where the link goes is
 * a placement decision made above this call - on a first-comment post a link
 * the copy smuggled into the caption is the one thing the placement exists to
 * avoid, and it would spend the Page's monthly link budget where nothing is
 * counting it.
 */
export function normaliseCopy(reply: string): string {
  return reply
    .replace(/```[a-z]*\n?/gi, ' ')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^["'“‘]+|["'”’]+$/g, '')
    .replace(/[\s:;,–-]+$/, '')
    .trim();
}

/** `text` inside `limit` characters, cut at a word boundary rather than mid-word. */
export function clamp(text: string, limit: number): string {
  if (limit <= 0) return '';
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > limit / 2 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

/**
 * The headline when the model cannot produce one the scan will pass.
 *
 * Derived from the dek rather than written, and derived the same way every
 * time: the dek is the one line of the article already written to be read on
 * its own, and it has been through the editor and the same scan. Falling back
 * to the title is the second choice because a title is built for the SERP.
 */
export function fallbackHeadline(source: { title: string; dek: string }, budget: number): string {
  const dek = normaliseCopy(source.dek);
  const sentence = /^[^.!?]+[.!?]?/.exec(dek)?.[0]?.trim() ?? '';
  const title = normaliseCopy(source.title);
  // The dek has been through the editor, but the rule that nothing we post
  // claims a person used the product is absolute, and this rung is the one
  // nothing downstream checks. A dek that breaks it loses to the title.
  const chosen = sentence !== '' && !authorshipClaim(sentence) ? sentence : title;
  return clamp(chosen, budget);
}

export interface HeadlineResult {
  headline: string;
  source: CopySource;
  /** What tripped the scan on the way here, in the order it happened. */
  trips: string[];
}

/**
 * Generate, measure, regenerate once, then fall back.
 *
 * A writer that throws counts as a trip: an engine that is not configured or a
 * network that timed out must not stop a post going out, because the fallback
 * is a caption the site is happy to publish.
 */
export async function writeHeadline(
  request: CopyRequest,
  writer: CopyWriter,
): Promise<HeadlineResult> {
  const trips: string[] = [];

  const attempt = async (complaint?: string): Promise<{ text: string; trip: string | null }> => {
    try {
      const text = normaliseCopy(await writer(request, complaint));
      return { text, trip: headlineTrip(text) };
    } catch (err) {
      return {
        text: '',
        trip: `The copy call failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };

  const first = await attempt();
  if (!first.trip) return { headline: clamp(first.text, request.budget), source: 'model', trips };
  trips.push(first.trip);

  // A call that never produced text has nothing to complain to the model
  // about; a scan hit does, and handing it back verbatim is what makes the
  // second attempt better than a second roll of the same dice.
  const second = await attempt(first.text === '' ? undefined : first.trip);
  if (!second.trip) {
    return { headline: clamp(second.text, request.budget), source: 'regenerated', trips };
  }
  trips.push(second.trip);

  log.warn('social copy fell back to the dek', {
    channel: request.channel.name,
    trips: trips.length,
    reason: trips[0].split('\n')[0],
  });
  return { headline: fallbackHeadline(request, request.budget), source: 'fallback', trips };
}

/** The caption parts, in the one order they are ever composed in. */
export interface CaptionParts {
  headline: string;
  /** Present only when the link really is going in the first comment. */
  cue: string | null;
  /** Present only when this article's intent is one the site earns on. */
  disclosure: string | null;
  /** Present only when the link is going in the body. */
  url: string | null;
}

/**
 * Headline, cue, disclosure, link - always that order.
 *
 * The cue sits above the disclosure because it is the instruction the reader
 * has to act on, and the disclosure sits above the link because it has to be
 * read before the click it qualifies, not after it.
 */
export function composeCaption(parts: CaptionParts): string {
  return [parts.headline, parts.cue, parts.disclosure, parts.url]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(JOIN);
}

/**
 * What the headline may spend, once the fixtures and the link have theirs.
 *
 * The fixtures are taken off the top rather than trimmed to fit, which is the
 * whole point: the failure mode of one caption budget shared by everything is
 * that the disclosure is what gets cut.
 */
export function headlineBudget(spec: ChannelSpec, parts: Omit<CaptionParts, 'headline'>): number {
  const fixtures = [parts.cue, parts.disclosure, parts.url].filter(
    (part): part is string => typeof part === 'string' && part !== '',
  );
  const spent = fixtures.reduce((total, part) => total + part.length + JOIN.length, 0);
  return Math.max(0, Math.min(spec.captionLimit - spent, HEADLINE_MAX_CHARS));
}

/**
 * The model the copy runs on: the prose engine, with a `social` override in
 * the models setting. Resolved here rather than through the pipeline's
 * `modelFor` because distribution does not import the pipeline runner - and
 * because there is no agent session to fail: an engine that is not configured
 * takes the fallback rung rather than stopping a post.
 */
export async function socialCopyModel(): Promise<string> {
  const settings = await llmSettings();
  const overrides = await getSetting<Record<string, string>>('models', {});
  if (overrides.social) return overrides.social;
  return (settings.prose_engine ?? 'claude') === 'claude'
    ? defaultClaudeModel(settings)
    : defaultGeminiModel(settings);
}

const COPY_SYSTEM = `You write the copy that goes above a link to one article on
a social feed. One or two short sentences, plain English, no hashtags, no
emoji, no quotation marks around the whole thing, no link - the link is placed
for you.

Write what the piece actually found, with its own specifics in it: a price, a
number, a model name, the thing that surprised the reader. A caption that would
fit any product post is the failure.

Nobody here has used, tested or handled the product. Never write "we tested",
"we tried", "hands-on", "our testers" or anything that claims a person did
something nobody here did.

${ANTI_SLOP_RULES}`;

function copyPrompt(request: CopyRequest, complaint?: string): string {
  const parts = [
    `Article headline: ${request.title}`,
    request.dek ? `Standfirst: ${request.dek}` : '',
    request.keyword ? `What the piece is built to answer: ${request.keyword}` : '',
    `Network: ${request.channel.name}. Hard limit: ${request.budget} characters - shorter is better.`,
    'Reply with the caption text only.',
  ].filter((part) => part !== '');
  if (complaint) {
    parts.push(
      `Your previous attempt was rejected by the automated voice scan:\n${complaint}\n` +
        'Rewrite it so none of that is in it. Same facts, different words.',
    );
  }
  return parts.join('\n');
}

/** The real writer. One completion per attempt, warm enough to vary on a retry. */
export const modelWriter: CopyWriter = async (request, complaint) => {
  const result = await chat({
    model: await socialCopyModel(),
    system: COPY_SYSTEM,
    prompt: copyPrompt(request, complaint),
    temperature: 0.8,
    maxTokens: 400,
  });
  return result.text;
};
