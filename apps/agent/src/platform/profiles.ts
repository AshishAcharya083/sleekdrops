// Every platform seeded from code, and the boot step that writes the ones the
// database does not have yet.
import { pool } from '../db/pool.js';
import { clearPlatformCache } from './registry.js';
import { peakoddsSeed } from './peakodds/index.js';
import { sleekdropsSeed } from './sleekdrops/index.js';
import type { PlatformSeed } from './types.js';

export const PLATFORM_SEEDS: readonly PlatformSeed[] = [sleekdropsSeed, peakoddsSeed];

/** The editable part of a seed, as platform_profile_versions.profile records it. */
function editableProfile({ platform, editions }: PlatformSeed) {
  return {
    brand_text: platform.brandText,
    audience: platform.audience,
    editorial_rules: platform.editorialRules,
    agent_goals: platform.agentGoals,
    scout_queries: platform.scoutQueries,
    editions: editions.map((e) => ({
      id: e.id,
      scout_queries: e.scoutQueries,
      compliance_footer: e.complianceFooter,
    })),
  };
}

/**
 * Insert each seeded platform the database does not have, with its editions
 * and version 1 of its profile (author 'seed'). A platform that already exists
 * is left alone: from then on the database copy is the one operators edit, and
 * a deploy must not put the code copy back over it.
 */
export async function seedPlatforms(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Instances booting together would otherwise both see "not seeded yet".
    await client.query("SELECT pg_advisory_xact_lock(hashtext('platform_seed'))");
    for (const seed of PLATFORM_SEEDS) {
      const p = seed.platform;
      const inserted = await client.query(
        `INSERT INTO platforms
           (id, name, byline_name, brand_text, audience, categories, post_types, article_shapes,
            editorial_rules, monetisation, blocked_link_domains, blocked_topics, scout_queries,
            agent_goals, publish_target)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11::jsonb,
                 $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [
          p.id,
          p.name,
          p.bylineName,
          p.brandText,
          p.audience,
          JSON.stringify(p.categories),
          JSON.stringify(p.postTypes),
          JSON.stringify(p.articleShapes),
          p.editorialRules,
          p.monetisation,
          JSON.stringify(p.blockedLinkDomains),
          JSON.stringify(p.blockedTopics),
          JSON.stringify(p.scoutQueries),
          JSON.stringify(p.agentGoals),
          JSON.stringify(p.publishTarget),
        ],
      );
      if (inserted.rowCount === 0) continue;
      for (const e of seed.editions) {
        await client.query(
          `INSERT INTO editions
             (platform_id, id, name, time_zone, currency, locale, scout_queries, compliance_footer)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
          [p.id, e.id, e.name, e.timeZone, e.currency, e.locale, JSON.stringify(e.scoutQueries), e.complianceFooter],
        );
      }
      await client.query(
        `WITH v AS (
           INSERT INTO platform_profile_versions (platform_id, version, profile, author)
           VALUES ($1, 1, $2::jsonb, 'seed') RETURNING id
         )
         UPDATE platforms SET profile_version = (SELECT id FROM v) WHERE id = $1`,
        [p.id, JSON.stringify(editableProfile(seed))],
      );
      // A new platform has no channels connected yet, so it starts with distribution off.
      await client.query(
        `INSERT INTO settings (platform_id, key, value) VALUES ($1, 'distribution_enabled', 'false'::jsonb)
         ON CONFLICT (platform_id, key) DO NOTHING`,
        [p.id],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  clearPlatformCache();
}
