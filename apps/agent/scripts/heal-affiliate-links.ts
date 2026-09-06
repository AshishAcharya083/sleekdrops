// One-off migration: rewrite every affiliate_links row in D1 into the
// region-aware Amazon shape the /go/ resolver now understands:
//   regions_json = { network:'amazon', search:<term>, asins?:{ au:'B0..' } }
//
// - Amazon product URLs are liveness-probed; dead ASINs (the 404s readers hit)
//   are dropped so those regions fall back to a search-results link.
// - Non-Amazon destinations (e.g. the news.com.au row that slipped through)
//   are replaced entirely by Amazon search links.
//
// Usage:  pnpm tsx scripts/heal-affiliate-links.ts --dry     # preview
//         pnpm tsx scripts/heal-affiliate-links.ts           # apply
//         pnpm tsx scripts/heal-affiliate-links.ts --force   # re-verify healed rows too
import { AMAZON_MARKETPLACES, amazonSearchUrl, parseAmazonUrl } from '../src/content/contract.js';
import type { AmazonRegion } from '../src/content/contract.js';
import { verifyAmazonProductUrl } from '../src/tools/amazon.js';
import { d1Query } from '../src/tools/d1.js';

const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');

interface Row {
  slug: string;
  default_url: string;
  regions_json: string | null;
  note: string | null;
}

/** Product search term from the note ("<product>, Amazon …") or the slug. */
function searchTermFor(row: Row): string {
  const note = row.note ?? '';
  const beforeAmazon = note.split(/,\s*Amazon/i)[0].trim();
  if (beforeAmazon.length >= 4) return beforeAmazon.slice(0, 100);
  return row.slug.replace(/-/g, ' ');
}

function usedBy(row: Row): string | null {
  const m = (row.note ?? '').match(/used by\s+(\S+)/i);
  return m ? m[1] : null;
}

const rows = await d1Query<Row>(
  'SELECT slug, default_url, regions_json, note FROM affiliate_links ORDER BY slug',
);
console.log(`${rows.length} affiliate link row(s) in D1${DRY ? ' — DRY RUN' : ''}\n`);

let healed = 0;
for (const row of rows) {
  let regions: Record<string, unknown> = {};
  try {
    regions = row.regions_json ? JSON.parse(row.regions_json) : {};
  } catch {
    /* malformed → rebuild from scratch */
  }
  if (regions.network === 'amazon' && !FORCE) {
    console.log(`  = ${row.slug}: already region-aware, skipping (--force to re-verify)`);
    continue;
  }

  const search =
    typeof regions.search === 'string' && regions.search ? regions.search : searchTermFor(row);

  // Every product URL this row knows about, probed for liveness. Already-healed
  // rows keep their ASINs in regions_json.asins — reconstruct URLs from those.
  const storedAsins =
    regions.asins && typeof regions.asins === 'object'
      ? (Object.entries(regions.asins as Record<string, string>)
          .filter(([r]) => r in AMAZON_MARKETPLACES)
          .map(([r, asin]) => `https://${AMAZON_MARKETPLACES[r as AmazonRegion]}/dp/${asin}`))
      : [];
  const candidates = [
    row.default_url,
    ...storedAsins,
    ...Object.entries(regions)
      .filter(([k]) => !['network', 'search', 'asins'].includes(k))
      .map(([, v]) => v)
      .filter((v): v is string => typeof v === 'string'),
  ];
  const asins: Record<string, string> = {};
  const dead: string[] = [];
  for (const url of candidates) {
    const parsed = parseAmazonUrl(url);
    if (!parsed || asins[parsed.region]) continue;
    const verified = await verifyAmazonProductUrl(url);
    if (verified) asins[verified.region] = verified.asin;
    else dead.push(`${parsed.region}:${parsed.asin}`);
  }

  const today = new Date().toISOString().slice(0, 10);
  const owner = usedBy(row);
  const next = {
    default_url: amazonSearchUrl(search),
    regions_json: JSON.stringify({
      network: 'amazon',
      search,
      ...(Object.keys(asins).length > 0 ? { asins } : {}),
    }),
    note:
      `${search} — ${Object.keys(asins).length > 0 ? `ASIN(s) ${Object.entries(asins).map(([r, a]) => `${a} (${r})`).join(', ')} verified ${today}` : 'search link (no live ASIN)'}` +
      (dead.length > 0 ? `; dropped dead ${dead.join(', ')}` : '') +
      (owner ? `, used by ${owner}` : ''),
  };

  const wasApproved = parseAmazonUrl(row.default_url) !== null;
  console.log(
    `  ✚ ${row.slug}${wasApproved ? '' : '  [NON-AMAZON DESTINATION REPLACED]'}\n` +
      `      was: ${row.default_url}\n` +
      `      now: search "${search}"${Object.keys(asins).length > 0 ? ` + asins ${JSON.stringify(asins)}` : ''}${dead.length > 0 ? ` (dead: ${dead.join(', ')})` : ''}`,
  );

  if (!DRY) {
    await d1Query(
      `UPDATE affiliate_links
       SET default_url = ?1, regions_json = ?2, note = ?3, updated_at = datetime('now')
       WHERE slug = ?4`,
      [next.default_url, next.regions_json, next.note, row.slug],
    );
  }
  healed += 1;
}

console.log(`\n${DRY ? 'Would heal' : 'Healed'} ${healed} row(s).`);
if (!DRY && healed > 0) {
  console.log(
    'Note: the link table is baked into the Pages Function at build time — ' +
      'trigger a site rebuild (push to develop/main or content-updated dispatch) to serve the healed rows.',
  );
}
