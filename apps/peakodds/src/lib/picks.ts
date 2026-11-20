// Splits a preview's markdown body into what the preview page draws: plain
// markdown, the writer's picks table recognised as picks, and the verdict.
//
// Recognition is all or nothing. A table becomes picks only when its header is
// exactly the agent's PICKS_TABLE_COLUMNS (apps/agent/src/platform/peakodds/formats.ts),
// every row is a complete pick with a bare decimal price above 1, and the post
// records when its prices were seen. Anything less stays in the markdown, where
// it renders as the plain table the writer wrote, so a misread price is never
// drawn as a pick.
import type { PeakOddsPost } from './posts.ts';

export interface RecognisedPick {
  /** 1-based, in body order, across every recognised table. */
  readonly number: number;
  readonly market: string;
  readonly selection: string;
  readonly odds: number;
  /** The markdown under the pick's 'Why <selection>' heading, or null when the body has none. */
  readonly reasoning: string | null;
}

export type PreviewSegment =
  | { readonly kind: 'markdown'; readonly markdown: string }
  | { readonly kind: 'picks'; readonly picks: readonly RecognisedPick[] }
  | { readonly kind: 'verdict'; readonly markdown: string };

/** Mirrors apps/agent/src/platform/peakodds/formats.ts (PICKS_TABLE_COLUMNS), lower-cased. */
const PICKS_HEADER = ['market', 'selection', 'indicative odds (decimal)', 'as at'];
const DECIMAL_ODDS = /^\d{1,4}(?:\.\d{1,2})?$/;
const SEPARATOR_ROW = /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?$/;
const FENCE = /^\s{0,3}(?:```|~~~)/;
const SECTION_HEADING = /^\s{0,3}#{1,2}\s+(.*?)(?:\s+#+)?\s*$/;
/** The agent appends the edition footer between HTML comment markers; a section never runs into it. */
const COMMENT_LINE = /^\s{0,3}<!--/;
const VERDICT_HEADING = /^verdict\b/;

interface LineRange {
  readonly start: number;
  /** Exclusive. */
  readonly end: number;
}

interface PicksTable extends LineRange {
  readonly rows: ReadonlyArray<Omit<RecognisedPick, 'number' | 'reasoning'>>;
}

interface Section extends LineRange {
  /** The heading text, lower-cased and trimmed. */
  readonly title: string;
  /** The first line after the heading. */
  readonly contentStart: number;
}

/**
 * The body as segments in reading order. Recognised picks carry the reasoning
 * of their 'Why <selection>' section, which leaves the markdown; a pick with no
 * such section keeps none, and the section stays where the writer put it.
 */
export function splitPreviewBody(post: Pick<PeakOddsPost, 'body' | 'oddsAsAt'>): PreviewSegment[] {
  const lines = post.body.replace(/\r\n?/g, '\n').split('\n');
  const prose = proseLines(lines);
  const tables = post.oddsAsAt === null ? [] : picksTables(lines, prose);
  const sections = sectionsIn(lines, prose);

  const consumed = new Set<Section>();
  let number = 0;
  const picksByTable = new Map<number, RecognisedPick[]>();
  for (const table of tables) {
    picksByTable.set(
      table.start,
      table.rows.map((row) => {
        const why = sections.find(
          (section) => !consumed.has(section) && section.title === `why ${row.selection}`.toLowerCase(),
        );
        if (why) consumed.add(why);
        number += 1;
        return { ...row, number, reasoning: (why && markdownOf(lines, why.contentStart, why.end)) || null };
      }),
    );
  }
  const verdicts = sections.filter((section) => !consumed.has(section) && VERDICT_HEADING.test(section.title));

  const segments: PreviewSegment[] = [];
  let pending: string[] = [];
  const flush = (): void => {
    const markdown = pending.join('\n').trim();
    if (markdown) segments.push({ kind: 'markdown', markdown });
    pending = [];
  };

  for (let i = 0; i < lines.length; ) {
    const table = tables.find((candidate) => candidate.start === i);
    if (table) {
      flush();
      segments.push({ kind: 'picks', picks: picksByTable.get(table.start) ?? [] });
      i = table.end;
      continue;
    }
    const reasoning = [...consumed].find((section) => section.start === i);
    if (reasoning) {
      i = reasoning.end;
      continue;
    }
    const verdict = verdicts.find((section) => section.start === i);
    const verdictBody = verdict ? markdownOf(lines, verdict.contentStart, verdict.end) : '';
    if (verdict && verdictBody) {
      pending.push(lines[i]);
      flush();
      segments.push({ kind: 'verdict', markdown: verdictBody });
      i = verdict.end;
      continue;
    }
    pending.push(lines[i]);
    i += 1;
  }
  flush();
  return segments;
}

/** Every recognised pick in the segments, in order. */
export function picksIn(segments: readonly PreviewSegment[]): RecognisedPick[] {
  return segments.flatMap((segment) => (segment.kind === 'picks' ? segment.picks : []));
}

/** Which lines are markdown prose rather than the inside of a fenced code block. */
function proseLines(lines: readonly string[]): boolean[] {
  let fenced = false;
  return lines.map((line) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return false;
    }
    return !fenced;
  });
}

function picksTables(lines: readonly string[], prose: readonly boolean[]): PicksTable[] {
  const tables: PicksTable[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!prose[i] || !isTableRow(lines[i]) || !SEPARATOR_ROW.test(lines[i + 1].trim())) continue;
    let end = i + 2;
    while (end < lines.length && prose[end] && isTableRow(lines[end])) end += 1;
    const rows = picksRows(cells(lines[i]), lines.slice(i + 2, end).map(cells));
    if (rows) tables.push({ start: i, end, rows });
    i = end - 1;
  }
  return tables;
}

/** The table's rows as picks, or null when the header or any row fails a check. */
function picksRows(header: readonly string[], rows: ReadonlyArray<readonly string[]>): PicksTable['rows'] | null {
  const isPicksHeader =
    header.length === PICKS_HEADER.length && header.every((cell, i) => cell.toLowerCase() === PICKS_HEADER[i]);
  if (!isPicksHeader || rows.length === 0) return null;
  const picks = rows.map((row) => {
    if (row.length !== PICKS_HEADER.length) return null;
    const [market, selection, oddsCell] = row;
    if (!market || !selection || !DECIMAL_ODDS.test(oddsCell)) return null;
    const odds = Number(oddsCell);
    return odds > 1 ? { market, selection, odds } : null;
  });
  return picks.every((pick) => pick !== null) ? picks : null;
}

function isTableRow(line: string): boolean {
  return line.trim().startsWith('|');
}

/** A table row's cells, trimmed, with escaped pipes kept as text. */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, '|').trim());
}

/** Each h1 or h2 section: its heading line up to the next h1 or h2, or the appended footer. */
function sectionsIn(lines: readonly string[], prose: readonly boolean[]): Section[] {
  const headings = lines.flatMap((line, i) => {
    const match = prose[i] ? SECTION_HEADING.exec(line) : null;
    return match ? [{ line: i, title: match[1].trim().toLowerCase() }] : [];
  });
  return headings.map(({ line, title }) => {
    let end = line + 1;
    while (end < lines.length && !(prose[end] && (SECTION_HEADING.test(lines[end]) || COMMENT_LINE.test(lines[end])))) {
      end += 1;
    }
    return { start: line, end, title, contentStart: line + 1 };
  });
}

function markdownOf(lines: readonly string[], start: number, end: number): string {
  return lines.slice(start, end).join('\n').trim();
}
