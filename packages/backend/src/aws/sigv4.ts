/**
 * AWS Signature Version 4, written once, for every AWS service GoWay talks to.
 *
 * ## Why GoWay signs its own requests
 *
 * The backend needs a handful of calls from three AWS services: presigned PUT
 * and GET plus HEAD/GET/PUT/COPY/DELETE/LIST on S3, `SendMessage` and friends on
 * SQS, and one `CreateInvalidation` on CloudFront. The AWS SDK for those is
 * several megabytes and dozens of transitive packages in a process whose other
 * dependencies are Express, drizzle and pino — and a runtime dependency is a
 * supply-chain surface and a version to keep reviewed. SigV4 is a documented,
 * stable algorithm that has not changed since 2012; the whole of it is this
 * file, on `node:crypto`, which is already there.
 *
 * It was first written inside `storage/s3ObjectStore.ts`, for presigned URLs
 * only. Street 3D needed the HEADER form as well (SQS and CloudFront have no
 * presigned flavour, and an S3 request whose body the backend writes should
 * sign that body's hash rather than `UNSIGNED-PAYLOAD`), so the primitives moved
 * here and every adapter shares them. Two copies of a signer are two places a
 * canonicalization bug can hide in, and a signature mismatch is an opaque 403
 * that names neither.
 *
 * If GoWay ever needs multipart uploads, the full credential provider chain,
 * retries with jitter or S3 Express, that trade flips and the SDK should be
 * taken. The adapters implement GoWay interfaces, which is what keeps such a
 * swap a contained change.
 *
 * ## Nothing here logs
 *
 * A presigned URL is a bearer token and an `Authorization` header is a
 * credential-derived secret. Neither is ever written to a log by this module,
 * and callers must not log them either (#13).
 */

import { createHash, createHmac } from 'node:crypto';

/**
 * The slice of `fetch` the AWS adapters use.
 *
 * Narrower than `typeof fetch` on purpose: the global includes runtime-specific
 * extras (bun's `preconnect`, for one) that a test double would have to stub for
 * no reason. The real `fetch` satisfies this, and a four-line fake does too —
 * which is what keeps every adapter testable without a network.
 */
export type AwsFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
    signal?: AbortSignal;
  },
) => Promise<Response>;

/** Credentials to sign with, however they were obtained. */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Present for temporary credentials — an ECS task role, an assumed role. */
  sessionToken?: string;
}

export const SIGV4_ALGORITHM = 'AWS4-HMAC-SHA256';

/** `UNSIGNED-PAYLOAD` is correct for a presigned URL: the body is not known at signing time. */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

/**
 * Percent-encode for SigV4.
 *
 * `encodeURIComponent` leaves `!'()*` alone and AWS does not, so a key
 * containing one would sign differently from how it is sent — a signature
 * mismatch that only appears for some keys. GoWay's own keys are hex and
 * slashes, but a signer that is only correct for its current caller is a trap
 * for the next one.
 */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Encode an object key: each path segment separately, so `/` survives. */
export function encodeKey(key: string): string {
  return key.split('/').map(encodeRfc3986).join('/');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** Lower-case hex SHA-256 of a string (as UTF-8) or of raw bytes. */
export function sha256Hex(data: string | Uint8Array): string {
  const hash = createHash('sha256');
  if (typeof data === 'string') hash.update(data, 'utf8');
  else hash.update(data);
  return hash.digest('hex');
}

/** `20260920T114530Z` and `20260920`, the two forms SigV4 wants. */
export function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = `${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function signingKey(credentials: AwsCredentials, dateStamp: string, region: string, service: string): Buffer {
  const dateKey = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, 'aws4_request');
}

/**
 * Lower-cased, trimmed and sorted headers, plus the `host` header.
 *
 * The canonical request is DEFINED over lower-case names in sorted order and
 * the service reconstructs it from what actually arrived, so a header that
 * differs only in case produces a signature mismatch and an opaque 403.
 */
function canonicalHeaderBlock(host: string, signed: Record<string, string>) {
  const headers = new Map<string, string>([['host', host]]);
  for (const [name, value] of Object.entries(signed)) {
    headers.set(name.toLowerCase(), value.trim().replace(/\s+/g, ' '));
  }
  const names = [...headers.keys()].sort();
  return {
    canonicalHeaders: names.map((name) => `${name}:${headers.get(name) ?? ''}\n`).join(''),
    signedHeaderList: names.join(';'),
  };
}

function canonicalQueryString(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((name) => `${encodeRfc3986(name)}=${encodeRfc3986(query[name] as string)}`)
    .join('&');
}

function signature(input: {
  credentials: AwsCredentials;
  region: string;
  service: string;
  now: Date;
  canonicalRequest: string;
}): { signature: string; credentialScope: string; amzDate: string } {
  const { amzDate, dateStamp } = amzDates(input.now);
  const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [SIGV4_ALGORITHM, amzDate, credentialScope, sha256Hex(input.canonicalRequest)].join('\n');
  return {
    signature: hmac(signingKey(input.credentials, dateStamp, input.region, input.service), stringToSign).toString('hex'),
    credentialScope,
    amzDate,
  };
}

export interface PresignInput {
  method: 'PUT' | 'GET' | 'HEAD' | 'DELETE';
  service: string;
  /** `https:` against AWS; an explicit endpoint may be plain `http:` locally. */
  protocol: string;
  host: string;
  /** Already encoded, e.g. via {@link encodeKey}. */
  path: string;
  region: string;
  credentials: AwsCredentials;
  now: Date;
  ttlSeconds: number;
  /** Headers included in the signature. `host` is added automatically. */
  signedHeaders: Record<string, string>;
}

/**
 * Build a presigned URL (the query-string form of SigV4).
 *
 * The canonical request is assembled in the order SigV4 specifies — method,
 * path, sorted query, sorted signed headers, the signed-header list, the
 * payload hash — because the signature is a hash of that exact text and any
 * disagreement with what the store reconstructs is an opaque 403.
 */
export function presign(input: PresignInput): string {
  const { amzDate, dateStamp } = amzDates(input.now);
  const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const { canonicalHeaders, signedHeaderList } = canonicalHeaderBlock(input.host, input.signedHeaders);

  const query: Record<string, string> = {
    'X-Amz-Algorithm': SIGV4_ALGORITHM,
    'X-Amz-Credential': `${input.credentials.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(input.ttlSeconds),
    'X-Amz-SignedHeaders': signedHeaderList,
  };
  if (input.credentials.sessionToken) {
    query['X-Amz-Security-Token'] = input.credentials.sessionToken;
  }
  const canonicalQuery = canonicalQueryString(query);

  const canonicalRequest = [
    input.method,
    input.path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaderList,
    UNSIGNED_PAYLOAD,
  ].join('\n');

  const signed = signature({
    credentials: input.credentials,
    region: input.region,
    service: input.service,
    now: input.now,
    canonicalRequest,
  });
  return `${input.protocol}//${input.host}${input.path}?${canonicalQuery}&X-Amz-Signature=${signed.signature}`;
}

export interface SignRequestInput {
  method: string;
  service: string;
  region: string;
  /** Absolute URL. Its path must already be encoded; its query is canonicalized here. */
  url: string;
  credentials: AwsCredentials;
  now: Date;
  /** Headers to send AND sign (`content-type`, `x-amz-target`, `x-amz-copy-source`…). */
  headers?: Record<string, string>;
  /** The exact body that will be sent. Its hash is signed; never `UNSIGNED-PAYLOAD`. */
  body?: string | Uint8Array;
  /**
   * Send and sign `x-amz-content-sha256`. S3 requires it and every other
   * service ignores it, so it defaults on; the switch exists so the signer can
   * be checked against AWS's own published test vectors, which omit it.
   */
  includeContentSha256?: boolean;
}

/**
 * Sign a request with an `Authorization` header (the header form of SigV4).
 *
 * Returns the complete header set to send: the caller's headers, `x-amz-date`,
 * `x-amz-content-sha256`, the session token when there is one, and
 * `authorization`. Every header returned is covered by the signature — a header
 * added after signing would be sent unsigned, which S3 tolerates and SQS and
 * CloudFront may not, and which is in any case a request GoWay did not mean to
 * authorize.
 *
 * The payload hash is the REAL hash of the body. A body the backend wrote (an
 * input manifest, a cancel marker, an SQS message) is known at signing time, and
 * signing it means a proxy cannot substitute another one.
 */
export function signRequest(input: SignRequestInput): Record<string, string> {
  const url = new URL(input.url);
  const payloadHash = sha256Hex(input.body ?? '');
  const { amzDate } = amzDates(input.now);

  const toSign: Record<string, string> = {
    ...(input.headers ?? {}),
    'x-amz-date': amzDate,
    ...(input.includeContentSha256 === false ? {} : { 'x-amz-content-sha256': payloadHash }),
  };
  if (input.credentials.sessionToken) {
    toSign['x-amz-security-token'] = input.credentials.sessionToken;
  }

  const query: Record<string, string> = {};
  for (const [name, value] of url.searchParams.entries()) query[name] = value;
  const { canonicalHeaders, signedHeaderList } = canonicalHeaderBlock(url.host, toSign);

  const canonicalRequest = [
    input.method.toUpperCase(),
    url.pathname || '/',
    canonicalQueryString(query),
    canonicalHeaders,
    signedHeaderList,
    payloadHash,
  ].join('\n');

  const signed = signature({
    credentials: input.credentials,
    region: input.region,
    service: input.service,
    now: input.now,
    canonicalRequest,
  });

  return {
    ...toSign,
    authorization:
      `${SIGV4_ALGORITHM} Credential=${input.credentials.accessKeyId}/${signed.credentialScope}, ` +
      `SignedHeaders=${signedHeaderList}, Signature=${signed.signature}`,
  };
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
  fetchImpl: AwsFetch = fetch,
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
