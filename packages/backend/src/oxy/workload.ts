import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';

/** Temporary role credentials on ECS and authenticated development hosts.
 * Oxy's live workload registration binds the application and environment.
 */
export const workloadCredentials = createAwsWorkloadCredentialProvider();
