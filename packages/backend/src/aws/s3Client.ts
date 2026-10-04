/**
 * A minimal, header-signed S3 REST client — the transport under the Street 3D
 * stores, never an interface feature code imports.
 *
 * `storage/s3ObjectStore.ts` PRESIGNS URLs a contributor's device uses. The
 * Street 3D stores are different: the backend itself writes manifests and
 * cancel markers, reads worker results, copies validated assets into the scene
 * bucket and deletes what has expired. Those calls are signed with an
 * `Authorization` header over the real payload hash (`aws/sigv4.ts`).
 *
 * Addressing matches the capture store: virtual-hosted-style against AWS,
 * path-style against an explicit endpoint (MinIO, an emulator), so a local
 * development store needs no second code path.
 *
 * Errors carry the HTTP status and the S3 error CODE only. An S3 error body can
 * echo the request's key and, for a signature mismatch, the canonical request;
 * neither belongs in a log line (#13).
 */

import { encodeKey, encodeRfc3986, signRequest, type AwsCredentials, type AwsFetch } from './sigv4';

export interface S3ClientOptions {
  region: string;
  /** An explicit endpoint for a non-AWS store; absent means AWS, virtual-hosted-style. */
  endpoint?: string;
  resolveCredentials: () => Promise<AwsCredentials>;
  fetchImpl?: AwsFetch;
  now?: () => Date;
}

export interface S3Request {
  method: 'GET' | 'HEAD' | 'PUT' | 'DELETE' | 'POST';
  bucket: string;
  /** Object key, unencoded. `''` addresses the bucket itself (e.g. a listing). */
  key: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Milliseconds before the request is abandoned. */
  timeoutMs?: number;
}

/** A failed S3 call. `code` is S3's own error code when the body named one. */
export class S3RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    operation: string,
  ) {
    super(`The object store answered ${status}${code ? ` (${code})` : ''} for ${operation}.`);
    this.name = 'S3RequestError';
  }
}

export interface S3Client {
  send(request: S3Request): Promise<Response>;
}

/** The `<Code>` of an S3 XML error body, if there is one. Never the message. */
export function s3ErrorCode(body: string): string | undefined {
  const match = /<Code>([A-Za-z0-9.]{1,64})<\/Code>/.exec(body);
  return match?.[1];
}

export function createS3Client(options: S3ClientOptions): S3Client {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());

  function url(bucket: string, key: string, query: Record<string, string>): string {
    const search = Object.keys(query)
      .sort()
      .map((name) => `${encodeRfc3986(name)}=${encodeRfc3986(query[name] as string)}`)
      .join('&');
    const suffix = search ? `?${search}` : '';
    if (options.endpoint) {
      const base = new URL(options.endpoint);
      const path = key ? `/${bucket}/${encodeKey(key)}` : `/${bucket}/`;
      return `${base.protocol}//${base.host}${path}${suffix}`;
    }
    return `https://${bucket}.s3.${options.region}.amazonaws.com/${key ? encodeKey(key) : ''}${suffix}`;
  }

  return {
    async send(request: S3Request): Promise<Response> {
      const target = url(request.bucket, request.key, request.query ?? {});
      const headers = signRequest({
        method: request.method,
        service: 's3',
        region: options.region,
        url: target,
        credentials: await options.resolveCredentials(),
        now: now(),
        headers: request.headers ?? {},
        ...(request.body === undefined ? {} : { body: request.body }),
      });
      return fetchImpl(target, {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        signal: AbortSignal.timeout(request.timeoutMs ?? 30_000),
      });
    },
  };
}
