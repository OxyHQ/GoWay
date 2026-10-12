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
 * The one other writer is an operator's licensed import
 * (`street3d/licensedImport.ts`), which PUTs files it has already validated
 * and hashed from the operator's machine.
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
 * A chunked RAD is many objects that must stay together: a viewer resolves
 * every chunk name the header lists against the header's own URL. Its header
 * and chunks therefore keep their file names, inside a directory named by the
 * digest of the WHOLE tree ({@link radTreeDigest}):
 * `<prefix>/<sceneId>/v<version>/<treeSha256>/<header>.rad` beside
 * `…/<treeSha256>/<header>-<n>.radc`. Not the header's own digest: a header
 * names its chunks but does not hash them, so two trees with one header and
 * different chunk bytes would otherwise share keys.
 *
 * The scene bucket holds no raw media and no derivative: published output
 * survives the deletion of every input, and the capture sweeper never looks
 * here.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { StreetSceneAssetFormat } from '@goway/contracts';
import { createS3Client, s3ErrorCode, S3RequestError, type S3ClientOptions } from '../aws/s3Client';
import { encodeKey, signRequest, type AwsCredentials, type AwsFetch } from '../aws/sigv4';
import type { StoredSceneAsset, StoredSceneObject } from '../db/schema';
import type { StoredObjectStat } from '../storage/objectStore';
import { assertScopedKey, JOBS_PREFIX, statFromHeaders } from './jobObjectStore';

/** One year, immutable. See this module's header. */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * The `Content-Type` an asset is served with. Splat formats are opaque bytes
 * to HTTP; a chunk of a chunked RAD is served as its tree is.
 */
export const FORMAT_CONTENT_TYPE: Readonly<Record<StreetSceneAssetFormat, string>> = {
  spz: 'application/octet-stream',
  rad: 'application/octet-stream',
  jpeg: 'image/jpeg',
};

/** The file extension of a single-object asset's key. */
const FORMAT_EXTENSION: Readonly<Record<StreetSceneAssetFormat, string>> = {
  spz: 'spz',
  rad: 'rad',
  jpeg: 'jpg',
};

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

export interface PutAssetRequest {
  /** Key in the scene bucket, under the configured scene prefix. */
  key: string;
  /** A local file, already validated and hashed by the caller. */
  filePath: string;
  contentType: string;
  /** Expected digest and size; the stored object is verified against both. */
  sha256: string;
  byteSize: number;
}

/** The scene bucket, as everything that publishes, restores or purges sees it. */
export interface SceneAssetStore {
  /** Upload a local file, then verify. Idempotent: the key is content-hashed. */
  putFile(request: PutAssetRequest): Promise<void>;
  head(key: string): Promise<StoredObjectStat | null>;
  /** Idempotent. */
  delete(key: string): Promise<void>;
}

/** The scene bucket beside the temporary one: what the reconstruction pipeline publishes through. */
export interface PipelineSceneAssetStore extends SceneAssetStore {
  /** Server-side copy, then verify. Idempotent: the key is content-hashed. */
  copyFromStaging(request: CopyAssetRequest): Promise<void>;
}

/** `<prefix>/<sceneId>/v<version>/`: every object of one version, and the CDN path a disable invalidates. */
export function sceneVersionPrefix(prefix: string, sceneId: string, version: number): string {
  return `${prefix}/${sceneId}/v${version}/`;
}

/** `<prefix>/<sceneId>/v<version>/<sha256>.<ext>`: an asset that is one object. */
export function sceneAssetKey(
  prefix: string,
  sceneId: string,
  version: number,
  sha256: string,
  format: StreetSceneAssetFormat,
): string {
  return `${sceneVersionPrefix(prefix, sceneId, version)}${sha256}.${FORMAT_EXTENSION[format]}`;
}

/**
 * The digest that names a chunked RAD's directory: SHA-256 over the header's
 * digest and every chunk's name and digest, in name order. Any changed byte of
 * the tree gives another directory. See this module's header.
 */
export function radTreeDigest(
  headerSha256: string,
  chunks: readonly { name: string; sha256: string }[],
): string {
  const lines = [...chunks]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((chunk) => `${chunk.name}\t${chunk.sha256}`);
  return createHash('sha256')
    .update(['goway-street3d-rad-tree/1', headerSha256, ...lines].join('\n'), 'utf8')
    .digest('hex');
}

/**
 * `<prefix>/<sceneId>/v<version>/<treeSha256>/<name>`: a file of a chunked
 * RAD — its header or one of its chunks — under the name the header uses.
 */
export function radTreeKey(
  prefix: string,
  sceneId: string,
  version: number,
  treeSha256: string,
  name: string,
): string {
  return `${sceneVersionPrefix(prefix, sceneId, version)}${treeSha256}/${name}`;
}

/** Every scene-bucket object an asset occupies: itself, then any chunks beside it. */
export function assetObjects(asset: StoredSceneAsset): StoredSceneObject[] {
  return [
    { key: asset.key, sha256: asset.sha256, byteSize: asset.byteSize },
    ...(asset.chunks ?? []),
  ];
}

/** The SHA-256 of a local file, streamed, and its size. */
export async function hashFile(filePath: string): Promise<{ sha256: string; byteSize: number }> {
  const hash = createHash('sha256');
  let byteSize = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
    byteSize += (chunk as Buffer).byteLength;
  }
  return { sha256: hash.digest('hex'), byteSize };
}

/** Whether a stored object is the one expected: its size, and its digest when the store reports one. */
export function storedAs(stat: StoredObjectStat | null, expected: StoredSceneObject): boolean {
  return (
    stat !== null &&
    stat.byteSize === expected.byteSize &&
    (stat.checksumSha256 === undefined || stat.checksumSha256 === expected.sha256)
  );
}

export interface S3SceneAssetStoreOptions extends S3ClientOptions {
  sceneBucket: string;
  scenePrefix: string;
  /**
   * The temporary bucket copies are made FROM. Absent for a store that only
   * an operator's import writes to; a copy is then refused.
   */
  stagingBucket?: string;
}

/**
 * One PUT per object, so one object is at most S3's single-PUT ceiling (5 GB)
 * and is read into memory whole; a chunked RAD keeps every object small.
 */
const PUT_TIMEOUT_MS = 600_000;

export function createS3SceneAssetStore(
  options: S3SceneAssetStoreOptions,
): PipelineSceneAssetStore {
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
      if (!options.stagingBucket)
        throw new Error('No temporary bucket is configured to copy from.');
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

    async putFile(request) {
      assertScopedKey(request.key, [scenePrefix]);
      const body = new Uint8Array(await readFile(request.filePath));
      if (body.byteLength !== request.byteSize) {
        throw new Error('A file to publish changed size after it was validated.');
      }
      const response = await client.send({
        method: 'PUT',
        bucket: options.sceneBucket,
        key: request.key,
        headers: {
          'content-type': request.contentType,
          'cache-control': IMMUTABLE_CACHE_CONTROL,
          // S3 refuses the PUT unless the bytes it received have this digest,
          // and stores it for the HEAD below to report.
          'x-amz-checksum-sha256': Buffer.from(request.sha256, 'hex').toString('base64'),
        },
        body,
        timeoutMs: PUT_TIMEOUT_MS,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new S3RequestError(response.status, s3ErrorCode(text), 'a PUT');
      }
      if (!storedAs(await head(request.key), request)) {
        throw new Error('A published asset is missing or does not match its validated digest.');
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

// ── Local development ─────────────────────────────────────────────────────

export interface FilesystemSceneAssetStoreOptions {
  /** The directory that stands in for the scene bucket. */
  root: string;
  scenePrefix: string;
}

/**
 * The scene bucket as a local directory, for development only
 * (`STREET3D_SCENE_LOCAL_DIR`): a key is a path under `root`. Served by
 * `bun run street3d:serve-assets`, which sets the content type from the
 * extension and the immutable cache policy, as the bucket's metadata would.
 *
 * Same contract as the bucket: scoped keys, verified writes (to a temporary
 * name, renamed into place only once the digest matches), idempotent deletes.
 * It has no server-side copy from the temporary bucket, so the reconstruction
 * pipeline cannot run against it — only an operator's import can.
 */
export function createFilesystemSceneAssetStore(
  options: FilesystemSceneAssetStoreOptions,
): SceneAssetStore {
  const root = resolve(options.root);
  const scenePrefix = `${options.scenePrefix}/`;

  function pathOf(key: string): string {
    assertScopedKey(key, [scenePrefix]);
    const path = resolve(root, key);
    if (!path.startsWith(`${root}${sep}`))
      throw new Error('Refused a key outside the scene directory.');
    return path;
  }

  return {
    async putFile(request) {
      const path = pathOf(request.key);
      await mkdir(dirname(path), { recursive: true });
      const partial = `${path}.${randomUUID()}.partial`;
      try {
        await copyFile(request.filePath, partial);
        const written = await hashFile(partial);
        if (!storedAs({ byteSize: written.byteSize, checksumSha256: written.sha256 }, request)) {
          throw new Error('A published asset does not match its validated digest.');
        }
        await rename(partial, path);
      } finally {
        await rm(partial, { force: true });
      }
    },

    async head(key) {
      try {
        const stats = await stat(pathOf(key));
        return stats.isFile() ? { byteSize: stats.size } : null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },

    async delete(key) {
      const path = pathOf(key);
      await rm(path, { force: true });
      // Directories the deletion emptied go too, up to the root, so a purged
      // version leaves nothing behind. A directory still holding a file stays.
      for (let directory = dirname(path); directory.startsWith(`${root}${sep}`); ) {
        try {
          await rmdir(directory);
        } catch {
          break;
        }
        directory = dirname(directory);
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
