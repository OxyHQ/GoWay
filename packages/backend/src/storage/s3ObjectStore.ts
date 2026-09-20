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
 * changed since 2012; the whole of it is `presign()` below, and it uses `node:crypto`,
 * which is already there.
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

import { createHash, createHmac } from 'node:crypto';
import type {
  CaptureObjectStore,
  StoredObjectStat,
  UploadTarget,
  UploadTargetRequest,
} from './objectStore';

/**
 * The slice of `fetch` this adapter uses.
 *
 * Narrower than `typeof fetch` on purpose: the global includes runtime-specific
 * extras (bun's `preconnect`, for one) that a test double would have to
 * stub for no reason. The real `fetch` satisfies this, and a four-line fake
 * does too — which is what keeps the adapter testable without a network.
 */
export type ObjectStoreFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<Response>;

/** Credentials to sign with, however they were obtained. */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Present for temporary credentials — an ECS task role, an assumed role. */
  sessionToken?: string;
}

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
const ALGORITHM = 'AWS4-HMAC-SHA256';

/**
 * Percent-encode for SigV4.
 *
 * `encodeURIComponent` leaves `!'()*` alone and AWS does not, so a key
 * containing one would sign differently from how it is sent — a signature
 * mismatch that only appears for some keys. GoWay's own keys are hex and
 * slashes, but an adapter that is only correct for its current caller is a trap
 * for the next one.
 */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Encode an object key: each path segment separately, so `/` survives. */
function encodeKey(key: string): string {
  return key.split('/').map(encodeRfc3986).join('/');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/** `20260920T114530Z` and `20260920`, the two forms SigV4 wants. */
function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = `${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function signingKey(credentials: AwsCredentials, dateStamp: string, region: string): Buffer {
  const dateKey = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, SERVICE);
  return hmac(serviceKey, 'aws4_request');
}

/** `UNSIGNED-PAYLOAD` is correct for a presigned URL: the body is not known at signing time. */
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

interface PresignInput {
  method: 'PUT' | 'GET' | 'HEAD' | 'DELETE';
  /** `https:` against AWS; an explicit endpoint may be plain `http:` locally. */
  protocol: string;
  host: string;
  path: string;
  region: string;
  credentials: AwsCredentials;
  now: Date;
  ttlSeconds: number;
  /** Headers included in the signature. `host` is added automatically. */
  signedHeaders: Record<string, string>;
}

/**
 * Build a presigned URL.
 *
 * The canonical request is assembled in the order SigV4 specifies — method,
 * path, sorted query, sorted signed headers, the signed-header list, the
 * payload hash — because the signature is a hash of that exact text and any
 * disagreement with what the store reconstructs is an opaque 403.
 */
function presign(input: PresignInput): string {
  const { amzDate, dateStamp } = amzDates(input.now);
  const credentialScope = `${dateStamp}/${input.region}/${SERVICE}/aws4_request`;

  // Lower-cased and sorted, because the canonical request is defined that way
  // and the store reconstructs it from what actually arrived. A header name
  // that differs only in case produces a signature mismatch and an opaque 403.
  const headers = new Map<string, string>([['host', input.host]]);
  for (const [name, value] of Object.entries(input.signedHeaders)) {
    headers.set(name.toLowerCase(), value.trim());
  }
  const headerNames = [...headers.keys()].sort();
  const canonicalHeaders = headerNames.map((name) => `${name}:${headers.get(name) ?? ''}\n`).join('');
  const signedHeaderList = headerNames.join(';');

  const query: Record<string, string> = {
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${input.credentials.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(input.ttlSeconds),
    'X-Amz-SignedHeaders': signedHeaderList,
  };
  if (input.credentials.sessionToken) {
    query['X-Amz-Security-Token'] = input.credentials.sessionToken;
  }

  const canonicalQuery = Object.keys(query)
    .sort()
    .map((name) => `${encodeRfc3986(name)}=${encodeRfc3986(query[name] as string)}`)
    .join('&');

  const canonicalRequest = [
    input.method,
    input.path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaderList,
    UNSIGNED_PAYLOAD,
  ].join('\n');

  const stringToSign = [ALGORITHM, amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(input.credentials, dateStamp, input.region), stringToSign).toString('hex');

  return `${input.protocol}//${input.host}${input.path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/**
 * Credentials from the environment, or from the ECS task role.
 *
 * Environment variables first, because that is what a developer and a test
 * have. The container credentials endpoint second, because that is what the
 * deployment actually uses — a task role hands out temporary credentials that
 * rotate, which is the whole reason `AGENTS.md`'s "no long-lived AWS
 * credentials in the app" is satisfiable at all.
 *
 * Deliberately not a full provider chain. IMDS, SSO, profiles and role
 * assumption are the AWS SDK's job; if GoWay ever needs one of them, that is
 * the moment to take the dependency this module exists to avoid.
 */
export function createEnvironmentCredentialsProvider(
  source: NodeJS.ProcessEnv = process.env,
  fetchImpl: ObjectStoreFetch = fetch,
): () => Promise<AwsCredentials> {
  let cached: { credentials: AwsCredentials; expiresAt: number } | null = null;

  return async () => {
    const accessKeyId = source.AWS_ACCESS_KEY_ID;
    const secretAccessKey = source.AWS_SECRET_ACCESS_KEY;
    if (accessKeyId && secretAccessKey) {
      return {
        accessKeyId,
        secretAccessKey,
        ...(source.AWS_SESSION_TOKEN ? { sessionToken: source.AWS_SESSION_TOKEN } : {}),
      };
    }

    // Re-use until a minute before expiry: a credential that expires between
    // signing and the client's upload produces a 403 the contributor cannot act
    // on, and the endpoint is a container-local call, not a network hop.
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.credentials;

    const relative = source.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    const full = source.AWS_CONTAINER_CREDENTIALS_FULL_URI;
    const url = full ?? (relative ? `http://169.254.170.2${relative}` : null);
    if (!url) {
      throw new Error(
        'No AWS credentials: set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, or run with an ECS task role.',
      );
    }

    const response = await fetchImpl(url, {
      headers: source.AWS_CONTAINER_AUTHORIZATION_TOKEN
        ? { Authorization: source.AWS_CONTAINER_AUTHORIZATION_TOKEN }
        : {},
    });
    if (!response.ok) {
      throw new Error(`The container credentials endpoint answered ${response.status}.`);
    }
    const body = (await response.json()) as {
      AccessKeyId?: string;
      SecretAccessKey?: string;
      Token?: string;
      Expiration?: string;
    };
    if (!body.AccessKeyId || !body.SecretAccessKey) {
      throw new Error('The container credentials endpoint returned no credentials.');
    }
    const credentials: AwsCredentials = {
      accessKeyId: body.AccessKeyId,
      secretAccessKey: body.SecretAccessKey,
      ...(body.Token ? { sessionToken: body.Token } : {}),
    };
    cached = {
      credentials,
      expiresAt: body.Expiration ? Date.parse(body.Expiration) : Date.now() + 5 * 60_000,
    };
    return credentials;
  };
}

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
      return { protocol: url.protocol, host: url.host, path: `/${options.bucket}/${encodeKey(key)}` };
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
      };
      const url = await signed('PUT', request.key, request.ttlSeconds, headers);
      return {
        url,
        headers: { 'Content-Type': request.contentType, 'Content-Length': String(request.byteSize) },
        expiresAt: new Date(now().getTime() + request.ttlSeconds * 1000),
      };
    },

    async statObject(key: string): Promise<StoredObjectStat | null> {
      const url = await signed('HEAD', key, 60);
      const response = await fetchImpl(url, { method: 'HEAD' });
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(`The object store answered ${response.status} for a HEAD.`);
      }
      const length = response.headers.get('content-length');
      const etag = response.headers.get('etag');
      return {
        byteSize: length ? Number(length) : 0,
        ...(etag ? { etag: etag.replace(/"/g, '') } : {}),
      };
    },

    async createReadUrl(key: string, ttlSeconds: number): Promise<string> {
      return signed('GET', key, ttlSeconds);
    },

    async deleteObject(key: string): Promise<void> {
      const url = await signed('DELETE', key, 60);
      const response = await fetchImpl(url, { method: 'DELETE' });
      // S3 answers 204 for a delete of an absent key, which is the idempotence
      // the interface promises. 404 is what an S3-compatible store may answer
      // instead, and it means the same thing.
      if (!response.ok && response.status !== 404) {
        throw new Error(`The object store answered ${response.status} for a DELETE.`);
      }
    },
  };
}
