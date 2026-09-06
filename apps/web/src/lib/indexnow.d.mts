/** Types for the plain-ESM IndexNow helpers in ./indexnow.mjs. */

export const INDEXNOW_ENDPOINT: string;
export const KEY_FILE: string;

export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
}

export interface Submission {
  host: string;
  key: string;
  keyLocation: string;
  urlList: string[];
}

export function isValidKey(key: unknown): key is string;
export function parseSitemapUrls(xml: string): SitemapEntry[];
export function parseSitemapIndex(xml: string): string[];
export function selectChangedUrls(entries: SitemapEntry[], window: { now: Date; sinceHours: number }): string[];
export function buildSubmission(input: { siteUrl: string; key: string; urls: string[] }): Submission;
