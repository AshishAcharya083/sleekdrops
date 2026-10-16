/**
 * Platform scoping for the admin API.
 *
 * Every admin call names the one platform it reads and writes through the
 * X-Platform header. There is deliberately no default: a panel that forgot to
 * send it would otherwise quietly operate on whichever brand happened to be
 * first, which is exactly the cross-brand mistake this header exists to rule
 * out.
 */
import type { MiddlewareHandler } from 'hono';
import { loadPlatform, UnknownPlatformError } from '../platform/registry.js';
import type { Platform } from '../platform/types.js';
import type { TraceEnv } from './trace.js';

export const PLATFORM_HEADER = 'X-Platform';

/** Hono environment of the admin API: the trace id plus the request's platform. */
export type ApiEnv = { Variables: TraceEnv['Variables'] & { platform: Platform } };

export type PlatformLoader = (id: string) => Promise<Platform>;

/** Routes that answer without a platform: liveness, and the switcher's own list. */
function isPlatformExempt(method: string, path: string): boolean {
  return path === '/api/health' || (method === 'GET' && path === '/api/platforms');
}

export function platformMiddleware(load: PlatformLoader = loadPlatform): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    if (isPlatformExempt(c.req.method, c.req.path)) return next();
    const id = c.req.header(PLATFORM_HEADER)?.trim() ?? '';
    if (!id) return c.json({ error: `${PLATFORM_HEADER} header is required` }, 400);
    let platform: Platform;
    try {
      platform = await load(id);
    } catch (err) {
      if (err instanceof UnknownPlatformError) return c.json({ error: `unknown platform: ${id}` }, 400);
      throw err;
    }
    c.set('platform', platform);
    return next();
  };
}
