/**
 * Builds the configured adapters.
 *
 * The ONE place a provider id becomes a concrete geocoder. Everything else in
 * this package — the service, the merge, the routes — sees `SearchProvider[]`
 * and cannot tell which implementations are behind it, which is what makes
 * "point the same contracts at a self-hosted instance with no consumer API
 * redesign" a configuration change rather than a refactor.
 *
 * The `Record<SearchProviderId, …>` is TOTAL on purpose: adding an id to
 * `SEARCH_PROVIDER_IDS` without writing its adapter is a compile error rather
 * than an `undefined` that only shows up as a runtime crash in the one
 * deployment that enabled it.
 */

import type { SearchConfig, SearchProviderId } from '../config/search';
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

  const factories: Record<SearchProviderId, () => SearchProvider> = {
    photon: () => createPhotonProvider({ config: config.photon, ...shared }),
    nominatim: () => createNominatimProvider({ config: config.nominatim, ...shared }),
  };

  return config.providers.map((id) => factories[id]());
}
