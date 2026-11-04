/**
 * The process's one Oxy client.
 *
 * Every Oxy call GoWay makes — verifying sessions and socket handshakes, rate
 * limiting, account and application-permission reads as the caller (user
 * clients), and its own file references — goes through this `OxyServer`. A
 * call that needs a different timeout or no retries says so per call
 * (`ServiceCallOptions`), never with a second client.
 *
 * - **Workload identity, no keys.** In a deployment the service token is the
 *   ECS task role's attested workload identity (Oxy ADR 0049), whose live
 *   binding names the GoWay application and environment.
 * - **`serviceIdentity: 'when-anonymous'`**: a read with no user session goes
 *   out with that service token, charged to GoWay rather than to the fleet's
 *   shared NAT address; a process that cannot mint one sends it anonymous.
 * - **`applicationId`** names whose application roles
 *   `requireAppPermission` reads (`oxy/appPermissions`).
 */

import { OxyServer } from '@oxy.so/core/server';
import { config } from '../config';
import { workloadCredentials } from './workload';

/** GoWay's Oxy application (`seedOxyApplicationsSpecs.ts` in the oxy repository). */
export const GOWAY_APPLICATION_ID = '73176d04c3654667138c23ec';

export const oxy = new OxyServer({
  baseURL: config.oxyApiUrl,
  applicationId: GOWAY_APPLICATION_ID,
  serviceIdentity: 'when-anonymous',
  workloadCredentials,
});
