/**
 * The routing provider this process uses, built from configuration.
 *
 * Lazily and once: the provider holds no connection and opens nothing, but
 * building it at module load would mean importing anything in this directory
 * parses routing configuration, and a test that only wants the polyline decoder
 * would need an engine endpoint.
 *
 * `null` means "this deployment has no routing engine configured", which is a
 * legitimate state rather than a misconfiguration — the map, Places and search
 * do not need one. The HTTP layer turns it into `service_unavailable` for
 * `POST /routes` alone.
 */

import { routingConfig, type RoutingConfig } from '../config/routing';
import type { RoutingProvider } from './provider';
import { createValhallaProvider } from './valhalla';

export type { RoutingCallOptions, RoutingProvider, RoutePoint, RoutingRequest } from './provider';
export { createValhallaProvider } from './valhalla';
export { decodePolyline, VALHALLA_POLYLINE_PRECISION } from './polyline';

/** Build the provider a configuration describes, or `null` when none is. */
export function createRoutingProvider(settings: RoutingConfig): RoutingProvider | null {
  if (!settings.enabled || settings.valhallaUrl === undefined) return null;

  // One engine today. A second one is a branch here and a file beside
  // `valhalla.ts` — nothing above `RoutingProvider` changes.
  return createValhallaProvider({
    url: settings.valhallaUrl,
    ...(settings.valhallaApiKey === undefined ? {} : { apiKey: settings.valhallaApiKey }),
    timeoutMs: settings.timeoutMs,
    modes: settings.modes,
    maxAlternatives: settings.maxAlternatives,
    userAgent: settings.userAgent,
  });
}

let provider: RoutingProvider | null | undefined;

/** The process-wide provider, built on first use. */
export function getRoutingProvider(): RoutingProvider | null {
  // `undefined` is "not built yet"; `null` is "built, and there is none".
  if (provider === undefined) provider = createRoutingProvider(routingConfig);
  return provider;
}
