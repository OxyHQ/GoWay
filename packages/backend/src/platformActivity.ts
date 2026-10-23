/**
 * Publish this process's traffic and its infrastructure heartbeat to Oxy.
 *
 * Every Oxy service reports through the shared ecosystem telemetry in
 * `@oxy.so/core/server`, which feeds the central API's `/platform-activity`
 * namespace and the live dashboard on oxy.so. The service name is `goway`, the
 * ECS service name, because that is what the dashboard's registry lists.
 *
 * Own workload identity comes from the shared temporary AWS role provider,
 * including authenticated development roles. Missing or revoked authority is
 * reported by the shared publisher, not inferred from ECS environment markers.
 * A publisher still needs a configured infrastructure region.
 *
 * Started from `server.ts` only. `createApp()` and `attachRealtime()` take the
 * observers as arguments, so constructing the app in a test starts no publisher,
 * installs no fetch wrapper and posts nothing anywhere.
 */

import { createEcosystemTraffic } from '@oxy.so/core/server';
import { workloadCredentials } from './oxy/workload';

export type PlatformActivity = ReturnType<typeof createEcosystemTraffic>;

export interface PlatformActivityDeps {
  region?: string;
  create: typeof createEcosystemTraffic;
}

const defaultDeps: PlatformActivityDeps = {
  create: createEcosystemTraffic,
};

/**
 * Start the publisher with the registered workload identity. `ready` is read on every heartbeat (every 10 seconds) and
 * decides whether the dashboard shows this instance online.
 */
export function startPlatformActivity(
  ready: () => boolean,
  deps: PlatformActivityDeps = defaultDeps,
): PlatformActivity | undefined {
  const region = deps.region ?? process.env.AWS_REGION;
  if (!region) return undefined;
  const traffic = deps.create({ service: 'goway', ready, region, workloadCredentials });
  traffic.installFetch();
  return traffic;
}
