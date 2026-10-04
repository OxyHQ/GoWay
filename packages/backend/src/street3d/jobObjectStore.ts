/**
 * The temporary bucket, as the Street 3D scheduler sees it — and only the two
 * prefixes it may touch.
 *
 * The temporary bucket (`CAPTURE_S3_BUCKET`) holds three things:
 *
 *   - `captures/` — raw media. Owned by the capture flow and its sweeper; this
 *     store refuses every key under it. The scheduler never reads raw bytes —
 *     only the external worker does, for privacy preprocessing.
 *   - `derived/`  — privacy-safe frames and masks the worker wrote.
 *   - `jobs/`     — input manifests and cancel markers the BACKEND writes, and
 *     per-attempt outputs (results, compressed assets) the worker writes.
 *
 * The prefix guard is structural rather than a convention: a bug that computed
 * a raw capture key and handed it to `delete` here is refused before a request
 * is signed, and a manifest can only ever be written under `jobs/`.
 *
 * Nothing here is versioned or public. Published scenes are copied OUT of this
 * bucket into the scene bucket by `sceneAssetStore.ts`, after validation.
 */

import { createS3Client, s3ErrorCode, S3RequestError, type S3ClientOptions } from '../aws/s3Client';
import { sha256Hex } from '../aws/sigv4';
import type { StoredObjectStat } from '../storage/objectStore';

export const JOBS_PREFIX = 'jobs/';
export const DERIVED_PREFIX = 'derived/';

export interface JobObjectStore {
  /** Write JSON under `jobs/`. Returns the digest and size of the exact bytes written. */
  putJson(key: string, value: unknown): Promise<{ sha256: string; byteSize: number; body: string }>;
  /** Read an object under `jobs/` or `derived/`, refusing one larger than `maxBytes`. `null` when absent. */
  getBytes(key: string, maxBytes: number): Promise<Uint8Array | null>;
  head(key: string): Promise<StoredObjectStat | null>;
  /** Idempotent. Refuses a delete that produced a version marker instead of erasing bytes. */
  delete(key: string): Promise<void>;
  /** Keys under a `jobs/` or `derived/` prefix, at most `limit`. */
  list(prefix: string, limit: number): Promise<string[]>;
}

/** Refuse a key outside the allowed prefixes, or one that could escape them. */
export function assertScopedKey(key: string, prefixes: readonly string[]): void {
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    key.length > 1024 ||
    key.startsWith('/') ||
    key.split('/').includes('..') ||
    !prefixes.some((prefix) => key.startsWith(prefix))
  ) {
    throw new Error(`Refused an object key outside ${prefixes.join(' and ')}.`);
  }
}

/** Serialize a value exactly once, so the digest describes the bytes stored. */
export function serializeJson(value: unknown): { body: string; sha256: string; byteSize: number } {
  const body = JSON.stringify(value);
  return { body, sha256: sha256Hex(body), byteSize: Buffer.byteLength(body, 'utf8') };
}

export interface S3JobObjectStoreOptions extends S3ClientOptions {
  bucket: string;
}

export function createS3JobObjectStore(options: S3JobObjectStoreOptions): JobObjectStore {
  const client = createS3Client(options);
  const readable = [JOBS_PREFIX, DERIVED_PREFIX] as const;

  async function failure(response: Response, operation: string): Promise<never> {
    const text = await response.text().catch(() => '');
    throw new S3RequestError(response.status, s3ErrorCode(text), operation);
  }

  return {
    async putJson(key, value) {
      assertScopedKey(key, [JOBS_PREFIX]);
      const serialized = serializeJson(value);
      const response = await client.send({
        method: 'PUT',
        bucket: options.bucket,
        key,
        headers: {
          'content-type': 'application/json',
          // S3 recomputes this and refuses the PUT on a mismatch, so the digest
          // written into the job envelope is the digest of what is stored.
          'x-amz-checksum-sha256': Buffer.from(serialized.sha256, 'hex').toString('base64'),
        },
        body: serialized.body,
      });
      if (!response.ok) await failure(response, 'a PUT');
      return serialized;
    },

    async getBytes(key, maxBytes) {
      assertScopedKey(key, readable);
      const response = await client.send({ method: 'GET', bucket: options.bucket, key });
      if (response.status === 404) return null;
      if (!response.ok) await failure(response, 'a GET');
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > maxBytes) {
        await response.body?.cancel();
        throw new Error(`An object exceeded the ${maxBytes}-byte read ceiling.`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) throw new Error(`An object exceeded the ${maxBytes}-byte read ceiling.`);
      return bytes;
    },

    async head(key) {
      assertScopedKey(key, readable);
      const response = await client.send({
        method: 'HEAD',
        bucket: options.bucket,
        key,
        headers: { 'x-amz-checksum-mode': 'ENABLED' },
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new S3RequestError(response.status, undefined, 'a HEAD');
      return statFromHeaders(response.headers);
    },

    async delete(key) {
      assertScopedKey(key, readable);
      const response = await client.send({ method: 'DELETE', bucket: options.bucket, key });
      // As in the capture store: a version marker hides pixels without erasing
      // them, and the temporary bucket must be unversioned.
      if (response.headers.get('x-amz-delete-marker') === 'true') {
        throw new Error('Deletion created a version marker instead of erasing bytes.');
      }
      if (!response.ok && response.status !== 404) await failure(response, 'a DELETE');
    },

    async list(prefix, limit) {
      assertScopedKey(prefix, readable);
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const response = await client.send({
          method: 'GET',
          bucket: options.bucket,
          key: '',
          query: {
            'list-type': '2',
            prefix,
            'max-keys': String(Math.min(1000, limit - keys.length)),
            ...(token ? { 'continuation-token': token } : {}),
          },
        });
        if (!response.ok) await failure(response, 'a LIST');
        const xml = await response.text();
        for (const match of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(decodeXml(match[1] as string));
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
          ? (/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] ?? undefined)
          : undefined;
      } while (token && keys.length < limit);
      // A listing is a prefix match on the server; filter again so a key the
      // guard would refuse can never come back out of here.
      return keys.filter((key) => key.startsWith(prefix)).slice(0, limit);
    },
  };
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** What a HEAD response says about the object. The checksum is S3's, never an ETag. */
export function statFromHeaders(headers: Headers): StoredObjectStat {
  const length = headers.get('content-length');
  const checksum = headers.get('x-amz-checksum-sha256');
  const contentType = headers.get('content-type');
  const etag = headers.get('etag');
  return {
    byteSize: length ? Number(length) : 0,
    // A full-object checksum is base64 of 32 bytes. A composite (multipart)
    // checksum carries a `-N` suffix and is NOT a digest of the object, so it is
    // not reported as one.
    ...(checksum && !checksum.includes('-')
      ? { checksumSha256: Buffer.from(checksum, 'base64').toString('hex') }
      : {}),
    ...(contentType ? { contentType } : {}),
    ...(etag ? { etag: etag.replace(/"/g, '') } : {}),
  };
}
