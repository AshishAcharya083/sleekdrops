/**
 * Small formatting helpers used across components. Centralised so date
 * strings stay consistent: long form in article body, short in card meta.
 */

const longDate = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});

const shortDate = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
});

const mediumDate = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

export function formatLong(date: Date): string {
  return longDate.format(date);
}

export function formatShort(date: Date): string {
  return shortDate.format(date);
}

export function formatMedium(date: Date): string {
  return mediumDate.format(date);
}

export function isoDate(date: Date): string {
  return date.toISOString();
}

/**
 * URL-safe slug from arbitrary user-facing text — used for tag URLs.
 * "Smart home" → "smart-home", "WFH 🚀" → "wfh".
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Italicise the last word of a headline so the editorial display style
 * ("…desk you should *actually* buy") renders consistently from data.
 * Returns HTML-escaped output with one `<em>` wrap.
 */
export function emphasiseLastWord(title: string): string {
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const trailingDot = title.endsWith('.') ? '.' : '';
  const trimmed = trailingDot ? title.slice(0, -1) : title;
  const lastSpace = trimmed.lastIndexOf(' ');
  if (lastSpace < 0) return escape(title);
  const head = trimmed.slice(0, lastSpace);
  const tail = trimmed.slice(lastSpace + 1);
  return `${escape(head)} <em>${escape(tail)}</em>${trailingDot}`;
}
