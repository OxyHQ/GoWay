/**
 * The scene bucket — published Street 3D assets, behind a CDN — and the CDN.
 *
 * ## Only the backend writes here, and only after validation
 *
 * The external worker writes its compressed assets to `jobs/<jobId>/…` in the
 * temporary bucket and has no credential for this one. The backend validates a
 * result (gates, budgets, sizes, checksums, input privacy) and only then
 * server-side COPIES the assets across. A worker bug, or a compromised worker,
 * therefore cannot put a byte in front of the public.
 *
 * ## Keys are content-hashed and immutable
 *
 * `<prefix>/<sceneId>/v<version>/<sha256>.<ext>`. The digest in the key is
 * what makes `Cache-Control: immutable` honest: those bytes can never change
 * under that URL, so a client and the CDN may cache them indefinitely and verify
 * them with the `sha256` the manifest carries. A disabled version's objects are
 * DELETED and the CDN path invalidated, so the URL then answers an error —
 * never different bytes.
 *
 * The scene bucket holds no raw media and no derivative: published output
 * survives the deletion of every input, and the capture sweeper never looks
 * here.
 */

import { createS3Client, s3ErrorCode, S3RequestError, type S3ClientOptions } from '../aws/s3Client';
import { encodeKey, signRequest, type AwsCredentials, type AwsFetch } from '../aws/sigv4';
import type { StoredObjectStat } from '../storage/objectStore';
import { assertScopedKey, JOBS_PREFIX, statFromHeaders } from './jobObjectStore';

/** One year, immutable. See this module's header. */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export interface CopyAssetRequest {
  /** Key in the temporary bucket, under `jobs/`. */
  sourceKey: string;
  /** Key in the scene bucket, under the configured scene prefix. */
  destinationKey: string;
  contentType: string;
  /** Expected digest and size; the copy is verified against both. */
  sha256: string;
  byteSize: number;
}

export interface SceneAssetStore {
  /** Server-side copy, then verify. Idempotent: the key is content-hashed. */
  copyFromStaging(request: CopyAssetRequest): Promise<void>;
  head(key: string): Promise<StoredObjectStat | null>;
  /** Idempotent. */
  delete(key: string): Promise<void>;
}

/** `<prefix>/<sceneId>/v<version>/<sha256>.<ext>`. */
export function sceneAssetKey(
  prefix: string,
  sceneId: string,
  version: number,
  sha256: string,
  format: 'spz' | 'jpeg',
): string {
  return `${prefix}/${sceneId}/v${version}/${sha256}.${format === 'jpeg' ? 'jpg' : 'spz'}`;
}

export interface S3SceneAssetStoreOptions extends S3ClientOptions {
  sceneBucket: string;
  scenePrefix: string;
  /** The temporary bucket copies are made FROM. */
  stagingBucket: string;
}

export function createS3SceneAssetStore(options: S3SceneAssetStoreOptions): SceneAssetStore {
  const client = createS3Client(options);
  const scenePrefix = `${options.scenePrefix}/`;

  async function head(key: string): Promise<StoredObjectStat | null> {
    assertScopedKey(key, [scenePrefix]);
    const response = await client.send({
      method: 'HEAD',
      bucket: options.sceneBucket,
      key,
      headers: { 'x-amz-checksum-mode': 'ENABLED' },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new S3RequestError(response.status, undefined, 'a HEAD');
    return statFromHeaders(response.headers);
  }

  return {
    async copyFromStaging(request) {
      assertScopedKey(request.sourceKey, [JOBS_PREFIX]);
      assertScopedKey(request.destinationKey, [scenePrefix]);
      const response = await client.send({
        method: 'PUT',
        bucket: options.sceneBucket,
        key: request.destinationKey,
        headers: {
          'x-amz-copy-source': `/${options.stagingBucket}/${encodeKey(request.sourceKey)}`,
          // REPLACE, so the published object carries GoWay's content type and
          // cache policy rather than whatever the worker uploaded with.
          'x-amz-metadata-directive': 'REPLACE',
          'content-type': request.contentType,
          'cache-control': IMMUTABLE_CACHE_CONTROL,
          // Ask S3 to compute a full-object SHA-256 on the copy, so the verify
          // below compares against the store's own digest.
          'x-amz-checksum-algorithm': 'SHA256',
        },
        timeoutMs: 120_000,
      });
      // CopyObject can answer 200 with an <Error> body when the copy failed
      // after the response started. A 200 alone is not success.
      const text = await response.text().catch(() => '');
      if (!response.ok || /<Error>/.test(text)) {
        throw new S3RequestError(response.status, s3ErrorCode(text), 'a COPY');
      }
      const stat = await head(request.destinationKey);
      if (!stat || stat.byteSize !== request.byteSize) {
        throw new Error('A published asset copy is missing or not the validated size.');
      }
      if (stat.checksumSha256 !== undefined && stat.checksumSha256 !== request.sha256) {
        throw new Error('A published asset copy does not match its validated digest.');
      }
    },

    head,

    async delete(key) {
      assertScopedKey(key, [scenePrefix]);
      const response = await client.send({ method: 'DELETE', bucket: options.sceneBucket, key });
      if (!response.ok && response.status !== 404) {
        const text = await response.text().catch(() => '');
        throw new S3RequestError(response.status, s3ErrorCode(text), 'a DELETE');
      }
    },
  };
}

// ── CDN ────────────────────────────────────────────────────────────────────

/** Invalidate cached paths. A GoWay interface; CloudFront is one adapter. */
export interface CdnInvalidator {
  invalidate(paths: readonly string[], callerReference: string): Promise<void>;
}

export interface CloudFrontInvalidatorOptions {
  distributionId: string;
  resolveCredentials: () => Promise<AwsCredentials>;
  fetchImpl?: AwsFetch;
  now?: () => Date;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * CloudFront `CreateInvalidation` (REST-XML, API 2020-05-31).
 *
 * CloudFront is a global service signed in `us-east-1`. `callerReference` makes
 * a retried invalidation for the same disable idempotent on CloudFront's side.
 */
export function createCloudFrontInvalidator(options: CloudFrontInvalidatorOptions): CdnInvalidator {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  return {
    async invalidate(paths, callerReference) {
      if (paths.length === 0) return;
      const url = `https://cloudfront.amazonaws.com/2020-05-31/distribution/${encodeURIComponent(options.distributionId)}/invalidation`;
      const body =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<InvalidationBatch xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/">' +
        `<Paths><Quantity>${paths.length}</Quantity><Items>` +
        paths.map((path) => `<Path>${escapeXml(path)}</Path>`).join('') +
        `</Items></Paths><CallerReference>${escapeXml(callerReference)}</CallerReference>` +
        '</InvalidationBatch>';
      const headers = signRequest({
        method: 'POST',
        service: 'cloudfront',
        region: 'us-east-1',
        url,
        credentials: await options.resolveCredentials(),
        now: now(),
        headers: { 'content-type': 'application/xml' },
        body,
      });
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new S3RequestError(response.status, s3ErrorCode(text), 'a CDN invalidation');
      }
    },
  };
}
