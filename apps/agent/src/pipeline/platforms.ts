// Which platforms the background pipeline is working for right now.
//
// Every platform runs on its own: its own scout cadence, its own share of the
// workers, and its own pause switch. `worker_enabled` is that switch - off, the
// platform neither scouts nor has stages claimed, and every other platform
// carries on as before. A missing row means on, as it always has.
import { getSetting } from '../db/pool.js';
import { listPlatforms } from '../platform/registry.js';
import type { Platform } from '../platform/types.js';

export async function isPlatformPaused(platformId: string): Promise<boolean> {
  return !(await getSetting<boolean>(platformId, 'worker_enabled', true));
}

/** Every platform that is not paused, in registry order. */
export async function activePlatforms(): Promise<Platform[]> {
  const platforms = await listPlatforms();
  const paused = await Promise.all(platforms.map((platform) => isPlatformPaused(platform.id)));
  return platforms.filter((_, i) => !paused[i]);
}
