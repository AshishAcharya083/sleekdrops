/** Types for the plain-ESM ads.txt rule in ./ads-txt.mjs. */

export const GOOGLE_TAG_ID: string;
export const PUBLISHER_ID_PATTERN: RegExp;

export function isSellerRecord(line: string): boolean;
export function sellerRecords(contents: string): string[];
export function recordKey(line: string): string;
export function googleRecord(client: string): string;

/** Journey's issued file and where it came from (`ads/ads.txt` or the ADS_TXT_URL). */
export interface JourneySource {
  contents: string;
  origin: string;
}

export interface AdsTxtInput {
  /** The first line, which marks the file as generated. */
  marker: string;
  /** A validated AdSense publisher id (`ca-pub-<digits>`), or empty for none. */
  client?: string;
  /** Journey's issued file, or null until Journey issues one. */
  journey?: JourneySource | null;
}

export function buildAdsTxt(input: AdsTxtInput): { text: string; count: number };
