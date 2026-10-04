/**
 * The Street 3D adapters this process uses, built once from configuration.
 *
 * `null` when the pipeline is not configured — which is the default and a
 * supported deployment. Nothing in the map's request path calls this; only the
 * scheduler, the admin command and the contributor-withdrawal hook do, and each
 * of them treats `null` as "Street 3D is off here", never as an error that
 * could take the API down.
 *
 * Credentials are resolved PER REQUEST (see `aws/sigv4.ts`): an ECS task role's
 * temporary credentials rotate, and a client that captured them at boot would
 * start failing some hours in, far from the cause.
 */

import { createEnvironmentCredentialsProvider } from '../aws/sigv4';
import { captureConfig } from '../config/capture';
import { street3dConfig, type Street3dConfig } from '../config/street3d';
import { createS3JobObjectStore, type JobObjectStore } from './jobObjectStore';
import {
  createCloudFrontInvalidator,
  createS3SceneAssetStore,
  type CdnInvalidator,
  type SceneAssetStore,
} from './sceneAssetStore';
import { createSqsWorkQueue, type WorkQueue } from './workQueue';

/** Every external dependency of the scheduler, as GoWay interfaces. Fakeable in tests. */
export interface Street3dServices {
  jobsQueue: WorkQueue;
  eventsQueue: WorkQueue;
  /** The jobs queue's DLQ, when configured. */
  deadLetterQueue: WorkQueue | null;
  /** The temporary bucket, restricted to `jobs/` and `derived/`. */
  jobStore: JobObjectStore;
  sceneStore: SceneAssetStore;
  cdn: CdnInvalidator | null;
}

/**
 * Build the adapters, or `null` when the queues, the scene bucket, the public
 * asset origin or the temporary bucket are not all configured.
 */
export function createConfiguredStreet3dServices(
  settings: Street3dConfig = street3dConfig,
): Street3dServices | null {
  if (!settings.pipelineConfigured || !captureConfig.enabled || !captureConfig.bucket || !captureConfig.region) {
    return null;
  }
  const region = settings.region as string;
  const resolveCredentials = createEnvironmentCredentialsProvider();
  const queue = (queueUrl: string) =>
    createSqsWorkQueue({
      queueUrl,
      region,
      ...(settings.sqsEndpoint ? { endpoint: settings.sqsEndpoint } : {}),
      resolveCredentials,
    });
  return {
    jobsQueue: queue(settings.jobsQueueUrl as string),
    eventsQueue: queue(settings.eventsQueueUrl as string),
    deadLetterQueue: settings.jobsDeadLetterQueueUrl ? queue(settings.jobsDeadLetterQueueUrl) : null,
    jobStore: createS3JobObjectStore({
      bucket: captureConfig.bucket,
      region: captureConfig.region,
      ...(captureConfig.endpoint ? { endpoint: captureConfig.endpoint } : {}),
      resolveCredentials,
    }),
    sceneStore: createS3SceneAssetStore({
      sceneBucket: settings.sceneBucket as string,
      scenePrefix: settings.sceneKeyPrefix,
      stagingBucket: captureConfig.bucket,
      region,
      ...(settings.sceneEndpoint ? { endpoint: settings.sceneEndpoint } : {}),
      resolveCredentials,
    }),
    cdn: settings.cdnDistributionId
      ? createCloudFrontInvalidator({ distributionId: settings.cdnDistributionId, resolveCredentials })
      : null,
  };
}

/**
 * The temporary bucket's `jobs/` and `derived/` view, from the capture
 * configuration alone. The cleanup sweeper uses it to retire derivatives and
 * job artifacts even on a deployment whose reconstruction pipeline is off — a
 * derivative that exists must still die on schedule.
 */
export function createConfiguredJobObjectStore(): JobObjectStore | null {
  if (!captureConfig.enabled || !captureConfig.bucket || !captureConfig.region) return null;
  return createS3JobObjectStore({
    bucket: captureConfig.bucket,
    region: captureConfig.region,
    ...(captureConfig.endpoint ? { endpoint: captureConfig.endpoint } : {}),
    resolveCredentials: createEnvironmentCredentialsProvider(),
  });
}
