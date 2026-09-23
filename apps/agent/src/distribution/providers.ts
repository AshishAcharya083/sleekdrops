// The provider registry: the one place a network's name is bound to the code
// that talks to it.
//
// A second network is one new file that implements SocialProvider and calls
// registerProvider() - nothing here, in the queue or in the worker changes.
// The worker only ever claims work for a provider that is registered, so an
// item queued for an adapter that has not shipped yet waits in 'pending'
// instead of burning its retries on an absence.
import type { SocialProvider } from './types.js';

const providers = new Map<string, SocialProvider>();

/**
 * Bind an adapter to the `provider` value its connections and queue items
 * carry. Last registration wins, so a test can stand a stub in front of the
 * real adapter without reaching into the map.
 */
export function registerProvider(provider: SocialProvider): void {
  providers.set(provider.name, provider);
}

export function getProvider(name: string): SocialProvider | null {
  return providers.get(name) ?? null;
}

/** Which adapters exist right now - the worker's claim filter, and the panel's. */
export function registeredProviders(): string[] {
  return [...providers.keys()].sort();
}

/** Drop a registration. Only a test needs this. */
export function unregisterProvider(name: string): void {
  providers.delete(name);
}
