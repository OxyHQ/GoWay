/**
 * Publish this process's traffic and its infrastructure heartbeat to Oxy.
 *
 * Every Oxy service reports through the shared ecosystem telemetry in
 * `@oxy.so/core/server`, which feeds the central API's `/platform-activity`
 * namespace and the live dashboard on oxy.so. The service name is `goway`, the
 * ECS service name, because that is what the dashboard's registry lists.
 *
 * ## Why there is no `OXY_ECOSYSTEM_ACTIVITY_ENABLED`
 *
 * What such a flag would stand for is "am I a deployed process, or somebody's
 * laptop", and that is a fact about where the code runs rather than something
 * to type into a task definition. ECS sets the container credentials endpoint on
 * every task and nothing else does, which is the same signal the credential-free
 * service token uses to prove what this process IS (oxy ADR 0026). GoWay runs on
 * its own task role and holds no Oxy service key pair, so attesting that role is
 * also how the publisher authenticates.
 *
 * So: on the infrastructure it publishes, in a local checkout or a test run it
 * does not, and neither needs configuring.
 *
 * Started from `server.ts` only. `createApp()` and `attachRealtime()` take the
 * observers as arguments, so constructing the app in a test starts no publisher,
 * installs no fetch wrapper and posts nothing anywhere.
 */

import { canAttestWorkloadIdentity, createEcosystemTraffic } from '@oxy.so/core/server';

export type PlatformActivity = ReturnType<typeof createEcosystemTraffic>;

export interface PlatformActivityDeps {
  canAttest: () => boolean;
  create: typeof createEcosystemTraffic;
}

const defaultDeps: PlatformActivityDeps = {
  canAttest: () => canAttestWorkloadIdentity(),
  create: createEcosystemTraffic,
};

/**
 * Start the publisher, or return `undefined` where this process cannot attest a
 * workload identity. `ready` is read on every heartbeat (every 10 seconds) and
 * decides whether the dashboard shows this instance online.
 */
export function startPlatformActivity(
  ready: () => boolean,
  deps: PlatformActivityDeps = defaultDeps,
): PlatformActivity | undefined {
  if (!deps.canAttest()) return undefined;
  const traffic = deps.create({ service: 'goway', ready });
  traffic.installFetch();
  return traffic;
}
