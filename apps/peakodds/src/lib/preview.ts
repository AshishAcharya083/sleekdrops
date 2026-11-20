// The match preview page's model: what the page shows for a preview post at a
// given moment. `now` is passed in, so a build decides expiry with its own
// clock and tests with a fixed one; the browser re-checks pages built before
// kick-off through the expiry markup SiteLayout's script reads.
import type { Edition } from '../data/editions.ts';
import { isEventExpired } from './expiry.ts';
import { picksIn, splitPreviewBody, type PreviewSegment, type RecognisedPick } from './picks.ts';
import type { PeakOddsPost } from './posts.ts';

export type StartLabel = 'Kick-off' | 'Start';

export interface PreviewModel {
  readonly expired: boolean;
  /** 'Kick-off' for the football codes, 'Start' for every other sport. */
  readonly startLabel: StartLabel;
  readonly segments: readonly PreviewSegment[];
  /** Every recognised pick, in body order; empty when the picks table fell back to a plain table. */
  readonly picks: readonly RecognisedPick[];
  /** The sport as it reads mid-sentence: 'football', 'rugby union', 'AFL'. */
  readonly sportInSentence: string;
}

const FOOTBALL_CODES =
  /\b(?:football|soccer|futsal|afl|aflw|nrl|nrlw|rugby|a-league|premier league|epl|la liga|serie a|bundesliga|ligue 1|nfl|uefa|fifa|gaelic)\b/i;

export function buildPreview(post: PeakOddsPost, now: Date): PreviewModel {
  const segments = splitPreviewBody(post);
  return {
    expired: isEventExpired(post.eventStartsAt, now),
    startLabel: FOOTBALL_CODES.test(post.sport) ? 'Kick-off' : 'Start',
    segments,
    picks: picksIn(segments),
    sportInSentence: post.sport
      .split(' ')
      .map((word) => (/^[A-Z][a-z]+$/.test(word) ? word.toLowerCase() : word))
      .join(' '),
  };
}

/** Article structured data for any post, from its own fields. */
export function articleStructuredData(
  post: Pick<PeakOddsPost, 'title' | 'description' | 'author' | 'pubDate' | 'updatedDate'>,
  edition: Pick<Edition, 'locale'>,
  canonicalUrl: string,
): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: post.title,
    description: post.description || post.title,
    author: { '@type': 'Organization', name: post.author },
    datePublished: post.pubDate,
    dateModified: post.updatedDate ?? post.pubDate,
    inLanguage: edition.locale,
    mainEntityOfPage: canonicalUrl,
    publisher: { '@type': 'Organization', name: 'PeakOdds' },
  };
}

/** JSON for a <script type="application/ld+json">, with '<' escaped so no value can close the script. */
export function jsonLdText(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

export interface PeakDrawing {
  readonly summit: { readonly x: number; readonly y: number };
  /** <polygon points> for the peak's outline. */
  readonly outline: string;
  /** <path d> for the contour lines across the peak, every 10%. */
  readonly contours: string;
}

/** Where 0% and 100% sit in a peak's 64 x 52 viewBox. */
export const PEAK_BASELINE_Y = 50;
export const PEAK_TOP_Y = 4;

/** The peak's ridge as [x, share of the summit's height], left to right. */
const RIDGE: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [13, 0.5],
  [20, 0.36],
  [36, 1],
  [49, 0.48],
  [55, 0.4],
  [64, 0],
];

/** A peak whose summit stands `chance` percent of the way from the baseline to the top line. */
export function peakDrawing(chance: number): PeakDrawing {
  const height = ((PEAK_BASELINE_Y - PEAK_TOP_Y) * Math.min(Math.max(chance, 0), 100)) / 100;
  const ridge = RIDGE.map(([x, share]) => [x, share * height] as const);
  const contours: string[] = [];
  const step = (PEAK_BASELINE_Y - PEAK_TOP_Y) / 10;
  for (let level = step; level < height; level += step) {
    for (const [from, to] of spansAbove(ridge, level)) {
      contours.push(`M${round(from)} ${round(PEAK_BASELINE_Y - level)}H${round(to)}`);
    }
  }
  return {
    summit: { x: 36, y: round(PEAK_BASELINE_Y - height) },
    outline: ridge.map(([x, rise]) => `${x},${round(PEAK_BASELINE_Y - rise)}`).join(' '),
    contours: contours.join(''),
  };
}

/** The x spans where the ridge stands above `level`. */
function spansAbove(ridge: ReadonlyArray<readonly [number, number]>, level: number): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let start: number | null = null;
  for (let i = 1; i < ridge.length; i++) {
    const [x0, y0] = ridge[i - 1];
    const [x1, y1] = ridge[i];
    const crossing = x0 + ((level - y0) / (y1 - y0)) * (x1 - x0);
    if (y0 <= level && y1 > level) start = crossing;
    if (y0 > level && y1 <= level && start !== null) {
      spans.push([start, crossing]);
      start = null;
    }
  }
  return spans;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
