/**
 * The object store this process uses, built once from configuration.
 *
 * `null` when no bucket is configured, and that is a supported deployment:
 * GoWay's map, Places, search and routing do not need contribution storage, so
 * a backend without one still serves everything else and the upload-intent
 * route answers `service_unavailable`. A module that threw here would turn one
 * optional feature into a hard dependency of the whole product.
 */

import { captureConfig } from '../config/capture';
import type { CaptureObjectStore } from './objectStore';
import { createEnvironmentCredentialsProvider, createS3ObjectStore } from './s3ObjectStore';

/**
 * Build the configured store, or `null`.
 *
 * Credentials are resolved PER REQUEST rather than captured here: an ECS task
 * role hands out temporary credentials that rotate, and a store that read them
 * once at boot would start signing with an expired key some hours in — which
 * surfaces as contributors' uploads being refused by S3, far from the cause.
 */
export function createConfiguredObjectStore(): CaptureObjectStore | null {
  if (!captureConfig.enabled || !captureConfig.bucket || !captureConfig.region) return null;
  return createS3ObjectStore({
    bucket: captureConfig.bucket,
    region: captureConfig.region,
    ...(captureConfig.endpoint ? { endpoint: captureConfig.endpoint } : {}),
    resolveCredentials: createEnvironmentCredentialsProvider(),
  });
}

export type { CaptureObjectStore } from './objectStore';
