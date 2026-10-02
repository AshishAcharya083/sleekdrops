// Compliance the assembler enforces, not the model: blocked link domains,
// per-platform phrase rules, the preview picks table, and the edition footer.
//
// Every rule here is data the platform or edition carries. SleekDrops blocks no
// domain, has no phrase rules and an empty footer, so its articles pass through
// byte for byte; PeakOdds blocks every bookmaker host, rejects certainty,
// inducement, income and staking language and bookmaker names, and gets its edition's
// responsible-gambling footer appended to every article.
import { PEAKODDS_PLATFORM_ID } from '../platform/peakodds/index.js';
import { PICKS_TABLE_COLUMNS } from '../platform/peakodds/formats.js';
import { PEAKODDS_PHRASE_RULES } from '../platform/peakodds/phrases.js';
import type { PhraseRule, PhraseRules } from '../platform/peakodds/phrases.js';
import type { Edition, Platform } from '../platform/peakodds/contractTypes.js';

/** The slice of a PromptContext the checks read. A full PromptContext satisfies it. */
export interface ComplianceContext {
  platform: Pick<Platform, 'id' | 'name' | 'blockedLinkDomains'>;
  edition: Pick<Edition, 'complianceFooter' | 'currency'>;
}

export interface ComplianceOptions {
  /** The article's post type. A `preview` must carry a valid picks table. */
  postType?: string;
  /** URLs in the article's sources list; a bookmaker page is no source either. */
  sourceUrls?: readonly string[];
  /** The clock an "As at" time is judged against. */
  now?: Date;
}

const PHRASE_RULES: Readonly<Record<string, PhraseRules>> = {
  [PEAKODDS_PLATFORM_ID]: PEAKODDS_PHRASE_RULES,
};

const FOOTER_START = '<!-- compliance-footer -->';
const FOOTER_END = '<!-- /compliance-footer -->';

// ------------------------------------------------------------------ domains

const HOSTNAME = /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9])\b/gi;

function isBlockedHost(host: string, blocked: readonly string[]): string | null {
  const bare = host.toLowerCase().replace(/^www\./, '');
  return blocked.find((domain) => bare === domain || bare.endsWith(`.${domain}`)) ?? null;
}

/** Every blocked domain the text links or names, each once, in order of appearance. */
export function blockedDomainsIn(text: string, blocked: readonly string[]): string[] {
  if (blocked.length === 0) return [];
  const found = new Set<string>();
  for (const match of text.matchAll(HOSTNAME)) {
    const domain = isBlockedHost(match[1], blocked);
    if (domain) found.add(domain);
  }
  return [...found];
}

// ------------------------------------------------------------------ phrases

/**
 * A negation that governs the phrase right after it: "not a sure thing", "no
 * bet is ever a sure thing", "nothing is guaranteed to win", "nobody can make
 * money from betting", "there is never such a thing as a lock", "don't bet the house".
 * Only filler words may sit between, so a negation earlier in the clause
 * ("No doubt about it: a sure thing", "Nothing can stop them - a lock") does
 * not excuse the phrase.
 */
const GOVERNING_NEGATION = new RegExp(
  "\\b(?:no|not|never|nor|neither|without|nothing|none|nobody|no\\s+one|little|hardly|" +
    "(?:isn|aren|wasn|won|can|don|doesn|didn|shouldn|wouldn)['’]t|cannot)\\s+" +
    '(?:such\\s+(?:a\\s+)?thing\\s+as\\s+)?' +
    '(?:(?:a|an|the|any|is|are|was|were|be|can|could|will|would|should|ever|always|really|necessarily|quite|truly|say|said|know|tell|predict|with|bet|bets|pick|picks|tip|tips|result|results|outcome|price|selection)\\s+){0,5}$',
  'i',
);

function isNegated(text: string, index: number): boolean {
  return GOVERNING_NEGATION.test(text.slice(Math.max(0, index - 60), index));
}

function phraseHits(text: string, rules: readonly PhraseRule[]): string[] {
  const hits = new Set<string>();
  for (const rule of rules) {
    for (const match of text.matchAll(rule.pattern)) {
      if (rule.negatable && isNegated(text, match.index)) continue;
      hits.add(`"${match[0]}" (${rule.label})`);
    }
  }
  return [...hits];
}

/** A money amount: "$20", "A$1.5m", "£500", "20 dollars", "USD 100". Not "pounds": that is a fighter's weight as often as a price. */
const CURRENCY_AMOUNT =
  /(?:\b(?:A|AU|US|NZ|C)\$|[$£€¥])\s?\d|\b\d[\d,.]*\s?(?:m|bn|k|million|billion)?\s?(?:AUD|USD|GBP|EUR|NZD|dollars?|euros?)\b|\b(?:AUD|USD|GBP|EUR|NZD)\s?\d/gi;

// ------------------------------------------------------------------ picks table

interface MarkdownTable {
  header: string[];
  rows: string[][];
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

const SEPARATOR_ROW = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/;

function tablesIn(body: string): MarkdownTable[] {
  const lines = body.split('\n');
  const tables: MarkdownTable[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i].trim().startsWith('|') || !SEPARATOR_ROW.test(lines[i + 1].trim())) continue;
    const header = cells(lines[i]);
    const rows: string[][] = [];
    let j = i + 2;
    for (; j < lines.length && lines[j].trim().startsWith('|'); j++) rows.push(cells(lines[j]));
    tables.push({ header, rows });
    i = j - 1;
  }
  return tables;
}

const PICKS_HEADER = PICKS_TABLE_COLUMNS.map((column) => column.toLowerCase());

function isPicksTable(table: MarkdownTable): boolean {
  const header = table.header.map((cell) => cell.toLowerCase());
  return header.includes('market') && header.includes('selection');
}

function hasPicksHeader(table: MarkdownTable): boolean {
  const header = table.header.map((cell) => cell.toLowerCase());
  return header.length === PICKS_HEADER.length && header.every((cell, i) => cell === PICKS_HEADER[i]);
}

const FORBIDDEN_COLUMN = /bookmaker|bookie|\bbook\b|operator|stake|units?\b|wager|bet size|where to bet/i;

/** A bare decimal price: 1.85, 2.10, 15. Never fractional, American or with a currency sign. */
const DECIMAL_ODDS = /^\d{1,4}(?:\.\d{1,2})?$/;

const ZONE_OFFSETS_MINUTES: Readonly<Record<string, number>> = {
  Z: 0,
  AEST: 600,
  AEDT: 660,
  ACST: 570,
  ACDT: 630,
  AWST: 480,
};

const AS_AT = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})\s*(?:(UTC|GMT)\s*(?:([+-]\d{1,2})(?::?(\d{2}))?)?|([+-]\d{2}):?(\d{2})|([A-Z]{1,4}))$/;

/**
 * An "As at" cell as an instant, or null when it does not name a date, a time
 * and an explicit zone: "2026-10-03 14:00 AEST", "2026-10-03 04:00 UTC",
 * "2026-10-03 14:00 UTC+10".
 */
export function parseAsAt(cell: string): Date | null {
  const m = AS_AT.exec(cell.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, utcName, utcHours, utcMinutes, isoHours, isoMinutes, abbreviation] = m;
  let offset: number;
  if (utcName) {
    const sign = utcHours?.startsWith('-') ? -1 : 1;
    offset = utcHours ? sign * (Math.abs(Number(utcHours)) * 60 + Number(utcMinutes ?? 0)) : 0;
  } else if (isoHours) {
    const sign = isoHours.startsWith('-') ? -1 : 1;
    offset = sign * (Math.abs(Number(isoHours)) * 60 + Number(isoMinutes));
  } else {
    const known = ZONE_OFFSETS_MINUTES[abbreviation];
    if (known === undefined) return null;
    offset = known;
  }
  const [year, month, day, hour, minute] = [y, mo, d, h, mi].map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const local = Date.UTC(year, month - 1, day, hour, minute);
  const instant = new Date(local - offset * 60_000);
  // Date.UTC rolls 31 February into March; a calendar day that does not exist is not a time.
  if (new Date(local).getUTCDate() !== day) return null;
  return instant;
}

/** Allowance for a clock that runs a little ahead of the source that stamped the price. */
const FUTURE_TOLERANCE_MS = 10 * 60_000;

function picksTableProblems(body: string, now: Date): string[] {
  const tables = tablesIn(body);
  const problems: string[] = [];
  for (const table of tables) {
    const forbidden = table.header.filter((cell) => FORBIDDEN_COLUMN.test(cell));
    if (forbidden.length > 0) {
      problems.push(`a table carries a forbidden column: ${forbidden.map((c) => `"${c}"`).join(', ')}`);
    }
  }
  const picks = tables.filter(isPicksTable);
  if (picks.length === 0) {
    return [
      ...problems,
      `a preview needs a picks table with exactly the columns ${PICKS_TABLE_COLUMNS.join(' | ')}`,
    ];
  }
  for (const table of picks) {
    if (!hasPicksHeader(table)) {
      problems.push(
        `the picks table has the columns ${table.header.join(' | ')}; it must have exactly ${PICKS_TABLE_COLUMNS.join(' | ')}`,
      );
      continue;
    }
    if (table.rows.length === 0) problems.push('the picks table has no picks');
    for (const [i, row] of table.rows.entries()) {
      const n = i + 1;
      if (row.length !== PICKS_HEADER.length) {
        problems.push(`picks table row ${n} has ${row.length} cells, not ${PICKS_HEADER.length}`);
        continue;
      }
      const [market, selection, odds, asAt] = row;
      if (!market || !selection) problems.push(`picks table row ${n} is missing its market or selection`);
      if (!DECIMAL_ODDS.test(odds) || Number(odds) < 1.01) {
        problems.push(`picks table row ${n}: "${odds}" is not a decimal price (e.g. 1.85)`);
      }
      const seen = parseAsAt(asAt);
      if (!seen) {
        problems.push(
          `picks table row ${n}: "${asAt}" is not an As at time with an explicit zone (e.g. 2026-10-03 14:00 AEST)`,
        );
      } else if (seen.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
        problems.push(`picks table row ${n}: the As at time "${asAt}" is in the future`);
      }
    }
  }
  return problems;
}

/**
 * The oldest "As at" in a preview's picks table, as an ISO instant - the time
 * the stalest price on the page was seen, which is what `odds_as_at` records.
 * Null when there is no valid picks table.
 */
export function previewOddsAsAt(body: string): string | null {
  const times = tablesIn(body)
    .filter(hasPicksHeader)
    .flatMap((table) => table.rows.map((row) => parseAsAt(row[3] ?? '')))
    .filter((time): time is Date => time !== null);
  if (times.length === 0) return null;
  return new Date(Math.min(...times.map((time) => time.getTime()))).toISOString();
}

// ------------------------------------------------------------------ footer

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The body without this edition's footer: the marked block, or the footer text
 * verbatim if an edit pass dropped the markers. For any stage that re-reads an
 * assembled body and should not treat the footer as the writer's copy.
 */
export function stripComplianceFooter(body: string, edition: Pick<Edition, 'complianceFooter'>): string {
  const footer = edition.complianceFooter.trim();
  let bare = body.replace(
    new RegExp(`\\n*${escapeRegExp(FOOTER_START)}[\\s\\S]*?${escapeRegExp(FOOTER_END)}\\n*`, 'g'),
    '\n\n',
  );
  if (footer) bare = bare.split(footer).join('');
  return bare;
}

/**
 * Append the edition's compliance footer from data. Idempotent: the runner
 * writes the assembled body back over the draft, so a re-assembly meets the
 * footer it appended last time and replaces it rather than stacking a second.
 * An edition with no footer gets its body back untouched.
 */
export function appendComplianceFooter(body: string, edition: Pick<Edition, 'complianceFooter'>): string {
  const footer = edition.complianceFooter.trim();
  if (!footer) return body;
  return `${stripComplianceFooter(body, edition).trimEnd()}\n\n${FOOTER_START}\n${footer}\n${FOOTER_END}\n`;
}

// ------------------------------------------------------------------ the check

/**
 * Everything that stops this article being published on this platform, as
 * reader-safe sentences; empty when it passes. The footer this code appends is
 * not checked - it is ours, and its "nothing here is a guarantee" is the point.
 */
export function complianceProblems(
  body: string,
  ctx: ComplianceContext,
  options: ComplianceOptions = {},
): string[] {
  const text = stripComplianceFooter(body, ctx.edition);
  const problems: string[] = [];

  const blocked = ctx.platform.blockedLinkDomains;
  const inBody = blockedDomainsIn(text, blocked);
  if (inBody.length > 0) {
    problems.push(`links or names a blocked domain on ${ctx.platform.name}: ${inBody.join(', ')}`);
  }
  const inSources = blockedDomainsIn((options.sourceUrls ?? []).join('\n'), blocked);
  if (inSources.length > 0) {
    problems.push(`cites a blocked domain as a source: ${inSources.join(', ')}`);
  }

  // An edition with no currency serves readers in many, so it quotes none.
  if (ctx.edition.currency === null) {
    const amounts = [...new Set([...text.matchAll(CURRENCY_AMOUNT)].map((m) => `"${m[0].trim()}"`))];
    if (amounts.length > 0) problems.push(`quotes a currency amount in an edition with no currency: ${amounts.join(', ')}`);
  }

  const rules = PHRASE_RULES[ctx.platform.id];
  if (rules) {
    const categories: Array<[keyof PhraseRules, string]> = [
      ['certainty', 'certainty language'],
      ['inducement', 'inducement terms'],
      ['income', 'betting framed as income'],
      ['staking', 'staking advice'],
      ['bookmaker', 'names a bookmaker'],
    ];
    for (const [key, name] of categories) {
      const hits = phraseHits(text, rules[key]);
      if (hits.length > 0) problems.push(`${name}: ${hits.join(', ')}`);
    }
  }

  if (options.postType === 'preview') {
    problems.push(...picksTableProblems(text, options.now ?? new Date()));
  }
  return problems;
}
