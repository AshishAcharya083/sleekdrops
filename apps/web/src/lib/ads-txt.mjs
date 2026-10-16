/**
 * The authorised-sellers file this site publishes at /ads.txt, as a pure rule.
 *
 * The site is set up for two ad partners while it applies to both, and the file
 * is the union of what each needs: Google AdSense's single record, generated
 * from the publisher id, and the file Journey by Mediavine issues once it
 * approves the site, published as issued. A record both carry is written once.
 * Journey requires exclusivity once it serves ads - no other programmatic seller
 * in this file - so the day it launches the publisher id is emptied and the
 * Google record drops out on the next build.
 *
 * Plain ESM because `scripts/generate-ads-txt.mjs` imports it as bare node
 * before the build (the `./robots-policy.mjs` constraint); that script owns the
 * environment, the fetch and the file, this module owns what the file says.
 */

/**
 * Google's certification-authority id, the fourth field of every google.com
 * record. Fixed and public - it identifies Google as the seller, not this site.
 */
export const GOOGLE_TAG_ID = 'f08c47fec0942fa0';

/**
 * The only shape a publisher id may take, kept identical to the check in
 * `./ads-env.ts`. Checked rather than trusted because every record in this file
 * authorises somebody to sell this domain's inventory: a value carrying a
 * newline would append authorised sellers of its own, and a typo would publish
 * a record that authorises nobody.
 */
export const PUBLISHER_ID_PATTERN = /^ca-pub-\d+$/;

/**
 * One authorised-seller record, per the IAB ads.txt specification: the seller's
 * domain, the publisher's account id there, and whether the relationship is
 * DIRECT or RESELLER. The optional certification-authority id after that is not
 * checked. Comment lines (`#`), variable lines (`OWNERDOMAIN=...`) and blank
 * lines are allowed around records.
 */
const RECORD = /^[a-z0-9.-]+\.[a-z]{2,}\s*,\s*[^,\s]+\s*,\s*(DIRECT|RESELLER)\b/i;

/** Whether one line of an ads.txt is a seller record. */
export function isSellerRecord(line) {
  return RECORD.test(line.trim());
}

/** The seller records a candidate file carries - none for a 404 page or HTML. */
export function sellerRecords(contents) {
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && RECORD.test(line));
}

/**
 * A record's identity for de-duplication: domain (case-insensitive), account id
 * (as written - some exchanges' ids are case-sensitive), relationship, and the
 * certification-authority id when present. Anything after `#` is a comment.
 */
export function recordKey(line) {
  const [domain = '', account = '', relationship = '', authority = ''] = line
    .split('#')[0]
    .split(',')
    .map((field) => field.trim());
  return [domain.toLowerCase(), account, relationship.toUpperCase(), authority.toLowerCase()].join(',');
}

/**
 * The google.com record for a publisher id. ads.txt names the publisher WITHOUT
 * the `ca-` prefix the ad tag carries: `ca-pub-123` is seller `pub-123` here,
 * and the tag form passed through verbatim is a record Google cannot match,
 * which reads to the crawler as an unauthorized domain.
 */
export function googleRecord(client) {
  return `google.com, ${client.replace(/^ca-/, '')}, DIRECT, ${GOOGLE_TAG_ID}`;
}

/**
 * The file for one build: the AdSense record when there is a publisher id, then
 * Journey's issued file when there is one - comments and variable lines kept,
 * any record already written above dropped.
 */
export function buildAdsTxt({ marker, client = '', journey = null }) {
  const sections = [];
  const seen = new Set();
  let count = 0;

  if (client) {
    const record = googleRecord(client);
    seen.add(recordKey(record));
    count += 1;
    sections.push(['# Google AdSense - from PUBLIC_ADSENSE_CLIENT for this build.', record].join('\n'));
  }

  if (journey) {
    const lines = journey.contents
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => {
        if (!isSellerRecord(line)) return true;
        const key = recordKey(line);
        if (seen.has(key)) return false;
        seen.add(key);
        count += 1;
        return true;
      });
    sections.push([`# Journey by Mediavine - from ${journey.origin}, as issued.`, ...lines].join('\n'));
  }

  const text = [
    marker,
    '# Do NOT edit by hand - your changes will be overwritten on the next build.',
    '',
    sections.join('\n\n'),
    '',
  ].join('\n');
  return { text, count };
}
