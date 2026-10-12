/**
 * Builds the configured adapters.
 *
 * The ONE place configuration becomes concrete geocoders. Everything else in
 * this package — the service, the merge, the routes — sees `SearchProvider[]`
 * and cannot tell which implementations are behind it, which is what makes
 * "point the same contracts at a self-hosted instance with no consumer API
 * redesign" a configuration change rather than a refactor.
 *
 * Photon is always first: it serves the search box. Nominatim follows it when
 * a deployment configures an instance (`SEARCH_NOMINATIM_BASE_URL`) — for
 * explicit forward, reverse and structured lookups only, which its own adapter
 * enforces. Order decides which adapter's candidate represents a group of
 * duplicates, and which failure is reported when every provider fails.
 */

import type { SearchConfig } from '../config/search';
import { createNominatimProvider } from './nominatimProvider';
import { createPhotonProvider } from './photonProvider';
import type { FetchLike, SearchProvider } from './provider';

export interface ProviderFactoryOptions {
  config: SearchConfig;
  /**
   * Defaults to the runtime's global `fetch` — present in Bun and Node 18+, and
   * looked up per call so a test can install a double without this module
   * having captured the real one.
   */
  fetch?: FetchLike;
}

export function createProviders(options: ProviderFactoryOptions): SearchProvider[] {
  const { config } = options;
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  const shared = { fetch: fetchImpl, timeoutMs: config.timeoutMs, attempts: config.attempts };

  const providers = [createPhotonProvider({ config: config.photon, ...shared })];
  if (config.nominatim) {
    providers.push(createNominatimProvider({ config: config.nominatim, ...shared }));
  }
  return providers;
}
