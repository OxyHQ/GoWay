/**
 * The S3 adapter behind {@link CaptureObjectStore}.
 *
 * ## Why this signs requests itself instead of taking the AWS SDK
 *
 * GoWay needs four things from S3: a presigned PUT, a HEAD, a presigned GET and
 * a DELETE. `@aws-sdk/client-s3` plus `@aws-sdk/s3-request-presigner` is
 * several megabytes and dozens of transitive packages for those four, in a
 * process whose other dependencies are Express, drizzle and pino — and a
 * runtime dependency is a supply-chain surface and a version to keep reviewed.
 * SigV4 query-string signing is a documented, stable algorithm that has not
 * changed since 2012; the whole of it is `aws/sigv4.ts`, shared with the Street
 * 3D queue, job-store and CDN adapters, and it uses `node:crypto`, which is
 * already there.
 *
 * If GoWay ever needs multipart uploads, the credential provider chain,
 * retries with jitter or S3 Express, that trade flips and the SDK should be
 * taken. It is not a principled refusal, it is a proportionate one, and the
 * interface it implements is what makes swapping it a contained change.
 *
 * ## What a presigned URL does and does not protect
 *
 * A presigned PUT authorizes ONE key, for ONE method, until ONE deadline. It is
 * a bearer token in a URL: anyone who has it can use it until it expires, which
 * is why the TTL is short and why it is never logged (#13 — signed URLs must
 * not appear in ordinary application logs).
 *
 * `Content-Type` and `Content-Length` are signed headers, so the target cannot
 * be spent on a different kind or size of object than the one the backend
 * authorized and recorded. That is what makes the `capture_media_objects` row
 * written beforehand an accurate description of what can arrive.
 */

import {
  createEnvironmentCredentialsProvider,
  encodeKey,
  presign,
  type AwsCredentials,
  type AwsFetch,
  type PresignInput,
} from '../aws/sigv4';
import type {
  CaptureObjectStore,
  StoredObjectStat,
  UploadTarget,
  UploadTargetRequest,
} from './objectStore';

/**
 * The slice of `fetch` this adapter uses. The signing primitives, this type and
 * the credential provider live in `aws/sigv4.ts`, shared with the Street 3D
 * adapters; they are re-exported here so existing callers keep one import.
 */
export type ObjectStoreFetch = AwsFetch;
export type { AwsCredentials };
export { createEnvironmentCredentialsProvider };

export interface S3ObjectStoreOptions {
  bucket: string;
  region: string;
  /**
   * An explicit endpoint, for a non-AWS store or a local MinIO. Absent means
   * the regional AWS endpoint, and virtual-hosted-style addressing.
   */
  endpoint?: string;
  /** Resolved per request, so a rotating task-role credential is picked up. */
  resolveCredentials: () => Promise<AwsCredentials>;
  /** Injected so a test can drive the adapter without a network. */
  fetchImpl?: ObjectStoreFetch;
  /** Injected so signature tests are deterministic. */
  now?: () => Date;
}

const SERVICE = 's3';

/**
 * Build the S3-backed object store.
 *
 * Virtual-hosted-style addressing (`<bucket>.s3.<region>.amazonaws.com`) by
 * default, path-style against an explicit endpoint — which is what MinIO and
 * most S3-compatible stores expect, and what makes a local development store
 * possible without a second code path.
 */
export function createS3ObjectStore(options: S3ObjectStoreOptions): CaptureObjectStore {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());

  function address(key: string): { protocol: string; host: string; path: string } {
    // Path-style against an explicit endpoint — what MinIO and most
    // S3-compatible stores expect — and virtual-hosted-style against AWS.
    if (options.endpoint) {
      const url = new URL(options.endpoint);
      return {
        protocol: url.protocol,
        host: url.host,
        path: `/${options.bucket}/${encodeKey(key)}`,
      };
    }
    return {
      protocol: 'https:',
      host: `${options.bucket}.s3.${options.region}.amazonaws.com`,
      path: `/${encodeKey(key)}`,
    };
  }

  async function signed(
    method: PresignInput['method'],
    key: string,
    ttlSeconds: number,
    signedHeaders: Record<string, string> = {},
  ): Promise<string> {
    const { protocol, host, path } = address(key);
    return presign({
      method,
      service: SERVICE,
      protocol,
      host,
      path,
      region: options.region,
      credentials: await options.resolveCredentials(),
      now: now(),
      ttlSeconds,
      signedHeaders,
    });
  }

  return {
    async createUploadTarget(request: UploadTargetRequest): Promise<UploadTarget> {
      // Both headers are SIGNED, so the target cannot be spent on a different
      // media type or a different size than the one the backend recorded. A
      // presigned PUT that pins neither is an unbounded write permission.
      const headers = {
        'content-type': request.contentType,
        'content-length': String(request.byteSize),
        'x-amz-checksum-sha256': Buffer.from(request.contentHash, 'hex').toString('base64'),
        'if-none-match': '*',
      };
      const url = await signed('PUT', request.key, request.ttlSeconds, headers);
      return {
        url,
        headers: { ...headers },
        expiresAt: new Date(now().getTime() + request.ttlSeconds * 1000),
      };
    },

    async statObject(key: string): Promise<StoredObjectStat | null> {
      const headers = { 'x-amz-checksum-mode': 'ENABLED' };
      const url = await signed('HEAD', key, 60, headers);
      const response = await fetchImpl(url, {
        method: 'HEAD',
        headers,
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(`The object store answered ${response.status} for a HEAD.`);
      }
      const length = response.headers.get('content-length');
      const etag = response.headers.get('etag');
      const checksum = response.headers.get('x-amz-checksum-sha256');
      const contentType = response.headers.get('content-type');
      return {
        byteSize: length ? Number(length) : 0,
        ...(checksum ? { checksumSha256: Buffer.from(checksum, 'base64').toString('hex') } : {}),
        ...(contentType ? { contentType } : {}),
        ...(etag ? { etag: etag.replace(/"/g, '') } : {}),
      };
    },

    async createReadUrl(key: string, ttlSeconds: number): Promise<string> {
      return signed('GET', key, ttlSeconds);
    },

    async deleteObject(key: string): Promise<void> {
      const url = await signed('DELETE', key, 60);
      const response = await fetchImpl(url, {
        method: 'DELETE',
        signal: AbortSignal.timeout(30_000),
      });
      // A marker hides a versioned object but retains its pixels. Never report
      // that as successful erasure. Temporary captures require an unversioned
      // bucket; version purging needs a separate adapter before enabling it.
      if (response.headers.get('x-amz-delete-marker') === 'true') {
        throw new Error('Capture deletion created a version marker instead of erasing bytes.');
      }
      // S3 answers 204 for a delete of an absent key, which is the idempotence
      // the interface promises. 404 is what an S3-compatible store may answer
      // instead, and it means the same thing.
      if (!response.ok && response.status !== 404) {
        throw new Error(`The object store answered ${response.status} for a DELETE.`);
      }
    },
  };
}
