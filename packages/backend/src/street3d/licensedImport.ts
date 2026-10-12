/**
 * Publishing a scene GoWay LICENSED rather than reconstructed — the operator
 * path behind `street3d:admin import-licensed`.
 *
 * ## A first-class source, not a back door
 *
 * A licensed scan (the first: Kabukicho Ichibangai, Shinjuku, from Locahun 3D,
 * captured with an XGRIDS PortalCam) arrives as files on an operator's machine:
 * a level-of-detail RAD the operator converted, its chunks, a poster, and a
 * JSON manifest saying where it is and under what licence. It becomes a scene
 * and a version like any other — same tables, same public manifest, same
 * disable and enable — with `source = 'licensed_import'`, no job and no
 * capture inputs. The schema keeps it that way: a licensed scene can never be
 * queued, rebuilt or clustered with contributions (`street3d_scenes_import_check`,
 * `nearestScenes`), and a version's source is always its scene's.
 *
 * ## Privacy is attested, never assumed
 *
 * The imagery never entered GoWay's capture privacy pipeline, so the version
 * claims no pipeline version (`privacyPipelineVersions` is empty, by CHECK).
 * The manifest must say instead how the scene was cleared — a closed
 * {@link STREET_SCENE_PRIVACY_BASES} basis, who reviewed it and a note — or
 * nothing is published. Only the basis is served; who reviewed it stays here.
 *
 * ## Everything is checked before anything is written
 *
 * {@link prepareLicensedImport} reads and validates the manifest with the
 * public contract's own schemas, checks the transform is a similarity and the
 * footprint lies in the bounds, refuses a licence that does not permit public
 * display of a converted scene, reads the RAD header and verifies every chunk
 * it names (present beside it, the declared size, a chunk's magic), and hashes
 * every file. Only then does {@link importLicensedScene} upload — content-hashed
 * keys, so a retry rewrites identical bytes — and record the scene and version
 * in ONE transaction.
 *
 * ## Idempotent by digest
 *
 * The import digest covers every manifest value and every asset byte (not the
 * file paths, which are the operator's machine). Re-running the same import
 * finds the version that digest already produced (`street3d_versions_import_key`)
 * and only re-uploads objects that are missing from the bucket. A disabled
 * version is the exception: re-uploading it would serve what moderation took
 * down, so a re-run is refused and `enable-version --manifest` is the way back.
 */

import { createHash } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { z } from 'zod';
import { uuidv7 } from '@oxy.so/db';
import {
  STREET_SCENE_PRIVACY_BASES,
  STREET_SCENE_PROFILES,
  geoBoundingBoxSchema,
  streetSceneInitialViewSchema,
  streetSceneManifestSchema,
  streetSceneNavigationSchema,
  streetSceneQualitySchema,
  streetSceneWorldTransformSchema,
  type GeoBoundingBox,
  type StreetSceneNavigation,
  type StreetSceneProfile,
  type StreetSceneQuality,
} from '@goway/contracts';
import type { Street3dConfig } from '../config/street3d';
import type { Database } from '../db/postgres';
import {
  STREET3D_LICENCE_PERMISSIONS,
  type StoredSceneAsset,
  type Street3dLicence,
} from '../db/schema';
import {
  findImportedVersion,
  loadImportTarget,
  recordLicensedImport,
  type ImportedVersionRow,
} from '../db/street3d/imports';
import { distanceMeters } from '../search/ranking';
import { canonicalJson } from '../utils/canonicalJson';
import { navigationOf } from './navigation';
import {
  chunkFiles,
  inlineChunksFit,
  isRadChunk,
  MAX_RAD_HEADER_BYTES,
  parseRadHeader,
  RadHeaderError,
} from './radHeader';
import {
  assetObjects,
  FORMAT_CONTENT_TYPE,
  hashFile,
  radTreeDigest,
  radTreeKey,
  sceneAssetKey,
  storedAs,
  type PutAssetRequest,
  type SceneAssetStore,
} from './sceneAssetStore';
import { publicAssetUrl } from './sceneValidation';
import type { SceneBucketServices } from './services';

/** `provenance.pipelineVersion` of every licensed import this module records. */
export const LICENSED_IMPORT_PIPELINE_VERSION = 'import:licensed/1';

/** A manifest larger than this is not a manifest. */
const MAX_MANIFEST_BYTES = 1024 * 1024;

/** A chunked RAD's header keeps its name in the published key, so it must be one plain segment. */
const RAD_HEADER_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.rad$/;

/** JPEG's start-of-image marker. */
const JPEG_MAGIC = [0xff, 0xd8, 0xff] as const;

/** An operator refusal: a closed `reason`, and a `detail` that names fields or files' roles, never a value or a path. */
export class ImportRefused extends Error {
  constructor(
    readonly reason: string,
    readonly detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'ImportRefused';
  }
}

const text = (max: number) => z.string().trim().min(1).max(max);
const assetPath = text(1024);

/**
 * The import manifest — an operator's file, not an API body, so it lives here
 * beside the worker contract rather than in `@goway/contracts`. Every value a
 * viewer will read is parsed with the public contract's own schema.
 */
export const licensedImportManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** Publish as the next version of this licensed scene. Absent: a new scene. */
    sceneId: text(64).optional(),
    anchor: streetSceneWorldTransformSchema.shape.anchor,
    /** Column-major 4×4 similarity, scene → ENU metres around `anchor`. */
    enuFromScene: streetSceneWorldTransformSchema.shape.enuFromScene,
    initialView: streetSceneInitialViewSchema,
    navigation: streetSceneNavigationSchema.optional(),
    footprint: streetSceneManifestSchema.shape.footprint,
    bounds: geoBoundingBoxSchema,
    observedFrom: streetSceneManifestSchema.shape.observedFrom,
    observedTo: streetSceneManifestSchema.shape.observedTo,
    /** Credits shown with the scene, e.g. the licensor's required notice. */
    attributions: z.array(text(300)).min(1).max(10),
    licence: z
      .object({
        licensor: text(200),
        name: text(200),
        tier: text(120).optional(),
        grantReference: text(200),
        grantedAt: z.iso.date(),
        permits: z.array(z.enum(STREET3D_LICENCE_PERMISSIONS)).min(1),
      })
      .strict(),
    privacy: z
      .object({
        basis: z.enum(STREET_SCENE_PRIVACY_BASES),
        /** Who reviewed it. Kept for accountability, never served. */
        reviewedBy: text(120),
        note: text(500),
      })
      .strict(),
    placement: streetSceneQualitySchema.shape.placement,
    /** Why the placement is what it says (how the scan was georeferenced). Never served. */
    placementNote: text(500),
    alignmentResidualMeters: z.number().min(0).max(1000),
    provenance: z
      .object({
        /** Capture device and converter versions, e.g. `{ "spark-build-lod": "2.3.1" }`. */
        components: z.record(text(60), text(200)),
      })
      .strict(),
    /** Paths relative to the manifest file. */
    assets: z
      .object({
        /** A RAD header; a chunked tree's `.radc` chunks sit beside it. */
        splat: assetPath,
        /** Optional far shell, also a RAD. */
        environment: assetPath.optional(),
        /** A JPEG. */
        poster: assetPath,
      })
      .strict(),
  })
  .strict();
export type LicensedImportManifest = z.infer<typeof licensedImportManifestSchema>;

/** One validated, hashed local file. */
export interface PreparedFile {
  path: string;
  /** Its file name: a chunked RAD's header and chunks keep theirs in the bucket. */
  name: string;
  sha256: string;
  byteSize: number;
}

/** A validated RAD: its header file, and the chunk files it names (none when inline). */
export interface PreparedRad {
  header: PreparedFile;
  chunks: PreparedFile[];
  gaussians: number;
  /** Header and chunks together. */
  byteSize: number;
}

export interface LicensedImportPlan {
  manifest: LicensedImportManifest;
  splat: PreparedRad;
  environment: PreparedRad | null;
  poster: PreparedFile;
  /** See this module's header. Stored as the version's `result_sha256`. */
  digest: string;
  radiusMeters: number;
  profile: StreetSceneProfile;
  navigation: StreetSceneNavigation | null;
}

/** Whether a column-major 4×4 is a proper similarity: uniform scale, rotation, translation. */
export function isSimilarity(m: readonly number[]): boolean {
  if (m.length !== 16 || !m.every(Number.isFinite)) return false;
  if (m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1) return false;
  const columns = [0, 4, 8].map((start) => [m[start], m[start + 1], m[start + 2]] as number[]);
  const dot = (a: number[], b: number[]) =>
    (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
  const [x, y, z] = columns as [number[], number[], number[]];
  const scale2 = dot(x, x);
  if (!(scale2 > 1e-12)) return false;
  const tolerance = 1e-6 * scale2;
  const orthogonal =
    Math.abs(dot(x, y)) <= tolerance &&
    Math.abs(dot(x, z)) <= tolerance &&
    Math.abs(dot(y, z)) <= tolerance;
  const uniform =
    Math.abs(dot(y, y) - scale2) <= tolerance && Math.abs(dot(z, z) - scale2) <= tolerance;
  const cross = [
    (x[1] ?? 0) * (y[2] ?? 0) - (x[2] ?? 0) * (y[1] ?? 0),
    (x[2] ?? 0) * (y[0] ?? 0) - (x[0] ?? 0) * (y[2] ?? 0),
    (x[0] ?? 0) * (y[1] ?? 0) - (x[1] ?? 0) * (y[0] ?? 0),
  ];
  // Right-handed: a reflection would turn the scene inside out against ENU.
  return orthogonal && uniform && dot(cross, z) > 0;
}

/** Whether a position lies in a box, honouring a box across the antimeridian. */
function inBox(box: GeoBoundingBox, longitude: number, latitude: number): boolean {
  const withinLongitude =
    box.west <= box.east
      ? longitude >= box.west && longitude <= box.east
      : longitude >= box.west || longitude <= box.east;
  return withinLongitude && latitude >= box.south && latitude <= box.north;
}

/**
 * The profile an imported tree is recorded at: the smallest whose budget holds
 * its Gaussians and bytes, else the largest. Budgets bound what GoWay's worker
 * spends and what a viewer loads WHOLE; a paged level-of-detail tree is never
 * loaded whole, so its size alone does not refuse it.
 */
export function fittingProfile(
  config: Street3dConfig,
  gaussians: number,
  byteSize: number,
): StreetSceneProfile {
  const largest = STREET_SCENE_PROFILES[STREET_SCENE_PROFILES.length - 1] as StreetSceneProfile;
  return (
    STREET_SCENE_PROFILES.find(
      (profile) =>
        gaussians <= config.budgets[profile].maxGaussians &&
        byteSize <= config.budgets[profile].maxAssetBytes,
    ) ?? largest
  );
}

/** The first `length` bytes of a file (fewer when it is shorter). */
async function readPrefix(path: string, length: number): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const buffer = new Uint8Array(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function prepareFile(path: string, role: string): Promise<PreparedFile> {
  const stats = await stat(path).catch(() => null);
  if (!stats?.isFile() || stats.size === 0) {
    throw new ImportRefused('asset_missing', `${role} is not a non-empty file`);
  }
  const hashed = await hashFile(path);
  return { path, name: basename(path), ...hashed };
}

/**
 * Validate a RAD and every chunk its header names. See `radHeader.ts` for the
 * layout; a chunk file must sit beside the header, be exactly the size the
 * header says, and start like a chunk.
 */
async function prepareRad(path: string, role: string): Promise<PreparedRad> {
  const header = await prepareFile(path, role);
  let parsed: ReturnType<typeof parseRadHeader>;
  try {
    parsed = parseRadHeader(await readPrefix(path, MAX_RAD_HEADER_BYTES));
  } catch (error) {
    if (error instanceof RadHeaderError)
      throw new ImportRefused('rad_invalid', `${role}: ${error.message}`);
    throw error;
  }
  if (!inlineChunksFit(parsed, header.byteSize)) {
    throw new ImportRefused(
      'rad_invalid',
      `${role}: an inline chunk runs past the end of the file`,
    );
  }
  const files = chunkFiles(parsed);
  if (files.length > 0 && !RAD_HEADER_FILENAME.test(header.name)) {
    throw new ImportRefused(
      'rad_invalid',
      `${role}: a chunked header needs a plain *.rad file name`,
    );
  }
  const chunks: PreparedFile[] = [];
  for (const chunk of files) {
    const chunkPath = resolve(dirname(path), chunk.filename);
    const prepared = await prepareFile(chunkPath, `${role} chunk ${chunk.filename}`);
    if (prepared.byteSize !== chunk.bytes) {
      throw new ImportRefused(
        'rad_chunk_mismatch',
        `${role} chunk ${chunk.filename} is not the size its header says`,
      );
    }
    if (!isRadChunk(await readPrefix(chunkPath, 4))) {
      throw new ImportRefused(
        'rad_chunk_mismatch',
        `${role} chunk ${chunk.filename} is not a RAD chunk`,
      );
    }
    chunks.push(prepared);
  }
  return {
    header,
    chunks,
    gaussians: parsed.meta.count,
    byteSize: header.byteSize + chunks.reduce((sum, chunk) => sum + chunk.byteSize, 0),
  };
}

async function preparePoster(path: string): Promise<PreparedFile> {
  const poster = await prepareFile(path, 'poster');
  const prefix = await readPrefix(path, JPEG_MAGIC.length);
  if (!JPEG_MAGIC.every((byte, index) => prefix[index] === byte)) {
    throw new ImportRefused('asset_format', 'poster is not a JPEG');
  }
  return poster;
}

function radDigest(rad: PreparedRad) {
  return {
    header: { name: rad.header.name, sha256: rad.header.sha256, byteSize: rad.header.byteSize },
    chunks: rad.chunks.map((chunk) => ({
      name: chunk.name,
      sha256: chunk.sha256,
      byteSize: chunk.byteSize,
    })),
  };
}

/**
 * Read, validate and hash everything an import names. Writes nothing.
 *
 * @throws {ImportRefused} With the first reason the import cannot be published.
 */
export async function prepareLicensedImport(
  manifestPath: string,
  config: Street3dConfig,
  now: Date,
): Promise<LicensedImportPlan> {
  const path = resolve(manifestPath);
  const stats = await stat(path).catch(() => null);
  if (!stats?.isFile() || stats.size > MAX_MANIFEST_BYTES) {
    throw new ImportRefused('manifest_unreadable', 'the manifest is not a file of at most 1 MiB');
  }
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new ImportRefused('manifest_unreadable', 'the manifest is not JSON');
  }
  const parsed = licensedImportManifestSchema.safeParse(json);
  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)')),
    ];
    throw new ImportRefused('manifest_invalid', fields.join(', '));
  }
  const manifest = parsed.data;

  if (!isSimilarity(manifest.enuFromScene)) {
    throw new ImportRefused('manifest_invalid', 'enuFromScene is not a right-handed similarity');
  }
  if (Date.parse(manifest.observedFrom) > Date.parse(manifest.observedTo)) {
    throw new ImportRefused('manifest_invalid', 'observedFrom is after observedTo');
  }
  if (Date.parse(manifest.observedTo) > now.getTime()) {
    throw new ImportRefused('manifest_invalid', 'observedTo is in the future');
  }
  if (manifest.bounds.south > manifest.bounds.north) {
    throw new ImportRefused('manifest_invalid', 'bounds');
  }
  const ring = manifest.footprint.coordinates[0] ?? [];
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (
    manifest.footprint.coordinates.length !== 1 ||
    ring.length < 4 ||
    !first ||
    !last ||
    first[0] !== last[0] ||
    first[1] !== last[1]
  ) {
    throw new ImportRefused('manifest_invalid', 'footprint must be one closed ring');
  }
  if (
    !inBox(manifest.bounds, manifest.anchor.longitude, manifest.anchor.latitude) ||
    !ring.every(([longitude, latitude]) =>
      inBox(manifest.bounds, longitude ?? Number.NaN, latitude ?? Number.NaN),
    )
  ) {
    throw new ImportRefused('manifest_invalid', 'the anchor and footprint must lie within bounds');
  }
  const radiusMeters = Math.ceil(
    Math.max(
      ...ring.map(([longitude, latitude]) =>
        distanceMeters(manifest.anchor, {
          longitude: longitude ?? Number.NaN,
          latitude: latitude ?? Number.NaN,
        }),
      ),
    ),
  );
  if (!(radiusMeters > 0 && radiusMeters <= 1000)) {
    throw new ImportRefused(
      'manifest_invalid',
      'the footprint must reach at most 1000 m from the anchor',
    );
  }
  // A licensed scene reaches viewers converted: a level-of-detail tree and a poster.
  for (const needed of ['public_display', 'format_conversion'] as const) {
    if (!manifest.licence.permits.includes(needed)) {
      throw new ImportRefused('licence_insufficient', `licence.permits lacks ${needed}`);
    }
  }
  if (
    manifest.placement === 'precise' &&
    manifest.alignmentResidualMeters > config.precisePlacementResidualMeters
  ) {
    throw new ImportRefused(
      'placement_inconsistent',
      `a precise placement needs alignmentResidualMeters within ${config.precisePlacementResidualMeters} m`,
    );
  }
  if (Object.keys(manifest.provenance.components).length === 0) {
    throw new ImportRefused('manifest_invalid', 'provenance.components names no converter');
  }

  const base = dirname(path);
  const splat = await prepareRad(resolve(base, manifest.assets.splat), 'splat');
  const environment = manifest.assets.environment
    ? await prepareRad(resolve(base, manifest.assets.environment), 'environment')
    : null;
  const poster = await preparePoster(resolve(base, manifest.assets.poster));

  const { assets: _paths, ...values } = manifest;
  const digest = createHash('sha256')
    .update(
      canonicalJson({
        format: 'goway-street3d-licensed-import/1',
        manifest: values,
        files: {
          splat: radDigest(splat),
          environment: environment ? radDigest(environment) : null,
          poster: { sha256: poster.sha256, byteSize: poster.byteSize },
        },
      }),
      'utf8',
    )
    .digest('hex');

  return {
    manifest,
    splat,
    environment,
    poster,
    digest,
    radiusMeters,
    profile: fittingProfile(config, splat.gaussians, splat.byteSize),
    navigation: navigationOf(
      manifest.navigation?.viewpoints,
      manifest.navigation?.fieldOfView,
      manifest.navigation?.reachMeters,
    ),
  };
}

/** Where a plan's files go for one scene version: the stored assets, and the uploads that put them there. */
export function placeImport(
  plan: LicensedImportPlan,
  config: Street3dConfig,
  sceneId: string,
  version: number,
): { assets: StoredSceneAsset[]; uploads: PutAssetRequest[] } {
  const prefix = config.sceneKeyPrefix;
  const assets: StoredSceneAsset[] = [];
  const uploads: PutAssetRequest[] = [];
  const upload = (file: PreparedFile, key: string, contentType: string) =>
    uploads.push({
      key,
      filePath: file.path,
      contentType,
      sha256: file.sha256,
      byteSize: file.byteSize,
    });

  const placeRad = (rad: PreparedRad, role: 'splat' | 'splat_environment') => {
    const contentType = FORMAT_CONTENT_TYPE.rad;
    let key: string;
    let chunks: StoredSceneAsset['chunks'];
    if (rad.chunks.length === 0) {
      key = sceneAssetKey(prefix, sceneId, version, rad.header.sha256, 'rad');
    } else {
      const tree = radTreeDigest(rad.header.sha256, rad.chunks);
      key = radTreeKey(prefix, sceneId, version, tree, rad.header.name);
      chunks = rad.chunks.map((chunk) => {
        const chunkKey = radTreeKey(prefix, sceneId, version, tree, chunk.name);
        upload(chunk, chunkKey, contentType);
        return { key: chunkKey, sha256: chunk.sha256, byteSize: chunk.byteSize };
      });
    }
    upload(rad.header, key, contentType);
    assets.push({
      role,
      format: 'rad',
      url: publicAssetUrl(config, key),
      key,
      byteSize: rad.header.byteSize,
      sha256: rad.header.sha256,
      gaussians: rad.gaussians,
      ...(chunks ? { chunks } : {}),
    });
  };

  placeRad(plan.splat, 'splat');
  if (plan.environment) placeRad(plan.environment, 'splat_environment');
  const posterKey = sceneAssetKey(prefix, sceneId, version, plan.poster.sha256, 'jpeg');
  upload(plan.poster, posterKey, FORMAT_CONTENT_TYPE.jpeg);
  assets.push({
    role: 'poster',
    format: 'jpeg',
    url: publicAssetUrl(config, posterKey),
    key: posterKey,
    byteSize: plan.poster.byteSize,
    sha256: plan.poster.sha256,
  });
  return { assets, uploads };
}

/**
 * Upload every object the bucket does not already hold as expected. Returns
 * how many were written. Idempotent: an object already there is left alone.
 */
async function ensureUploaded(
  store: SceneAssetStore,
  uploads: readonly PutAssetRequest[],
): Promise<number> {
  let written = 0;
  for (const request of uploads) {
    if (storedAs(await store.head(request.key), request)) continue;
    await store.putFile(request);
    written += 1;
  }
  return written;
}

/**
 * The uploads that restore an EXISTING version's objects from a plan: every
 * stored object must be one the plan places, under the same key and digest.
 */
function uploadsFor(
  version: Pick<ImportedVersionRow, 'sceneId' | 'version' | 'assets' | 'resultSha256'>,
  plan: LicensedImportPlan,
  config: Street3dConfig,
): PutAssetRequest[] {
  if (plan.digest !== version.resultSha256) {
    throw new ImportRefused(
      'manifest_mismatch',
      'the manifest is not the one this version was imported from',
    );
  }
  const planned = new Map(
    placeImport(plan, config, version.sceneId, version.version).uploads.map(
      (upload) => [upload.key, upload] as const,
    ),
  );
  return version.assets.flatMap(assetObjects).map((object) => {
    const upload = planned.get(object.key);
    if (!upload || upload.sha256 !== object.sha256) {
      throw new ImportRefused('manifest_mismatch', 'the version was stored under other keys');
    }
    return upload;
  });
}

/** Restore a licensed version's missing objects from the files it was imported from. Returns how many were written. */
export async function restoreLicensedImportAssets(
  store: SceneAssetStore,
  config: Street3dConfig,
  version: Pick<ImportedVersionRow, 'sceneId' | 'version' | 'assets' | 'resultSha256'>,
  plan: LicensedImportPlan,
): Promise<number> {
  return ensureUploaded(store, uploadsFor(version, plan, config));
}

export interface LicensedImportDeps {
  db: Database;
  bucket: SceneBucketServices | null;
  config: Street3dConfig;
  now?: () => Date;
}

export type LicensedImportOutcome =
  | {
      imported: true;
      /** False when this exact import was already recorded: nothing new, missing objects restored. */
      created: boolean;
      sceneId: string;
      versionId: string;
      version: number;
      state: string;
      profile: StreetSceneProfile;
      objects: number;
      bytes: number;
      uploaded: number;
    }
  | { imported: false; reason: string; versionId?: string; detail?: string };

/**
 * Publish a prepared import: upload, then record the scene and version in one
 * transaction. See this module's header.
 */
export async function importLicensedScene(
  deps: LicensedImportDeps,
  plan: LicensedImportPlan,
): Promise<LicensedImportOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  if (!deps.bucket) return { imported: false, reason: 'scene_store_not_configured' };
  if (!deps.config.publicAssetBaseUrl) {
    return { imported: false, reason: 'public_asset_origin_not_configured' };
  }
  const store = deps.bucket.sceneStore;
  const totals = (assets: readonly StoredSceneAsset[]) => {
    const objects = assets.flatMap(assetObjects);
    return {
      objects: objects.length,
      bytes: objects.reduce((sum, object) => sum + object.byteSize, 0),
    };
  };

  const existing = await findImportedVersion(deps.db, plan.digest);
  if (existing) {
    if (existing.state === 'disabled') {
      return { imported: false, reason: 'version_disabled', versionId: existing.id };
    }
    const uploaded = await restoreLicensedImportAssets(store, deps.config, existing, plan);
    return {
      imported: true,
      created: false,
      sceneId: existing.sceneId,
      versionId: existing.id,
      version: existing.version,
      state: existing.state,
      profile: existing.profile as StreetSceneProfile,
      ...totals(existing.assets),
      uploaded,
    };
  }

  const target = plan.manifest.sceneId
    ? await loadImportTarget(deps.db, plan.manifest.sceneId)
    : { sceneId: uuidv7(), version: 1, isNew: true as const };
  if ('refused' in target) return { imported: false, reason: target.refused };

  const { assets, uploads } = placeImport(plan, deps.config, target.sceneId, target.version);
  const uploaded = await ensureUploaded(store, uploads);

  const { manifest } = plan;
  const quality: StreetSceneQuality = {
    profile: plan.profile,
    // The licensor delivers a finished scene: there is no frame GoWay failed
    // to register. No held-out PSNR — GoWay trained nothing to hold frames out of.
    registrationRatio: 1,
    alignmentResidualMeters: manifest.alignmentResidualMeters,
    placement: manifest.placement,
  };
  const licence: Street3dLicence = {
    licensor: manifest.licence.licensor,
    name: manifest.licence.name,
    ...(manifest.licence.tier ? { tier: manifest.licence.tier } : {}),
    grantReference: manifest.licence.grantReference,
    grantedAt: manifest.licence.grantedAt,
    permits: [...new Set(manifest.licence.permits)].sort(),
    importRun: { command: 'import-licensed', runId: uuidv7(), at: now.toISOString() },
  };
  const recorded = await recordLicensedImport(
    deps.db,
    {
      sceneId: target.sceneId,
      isNew: target.isNew,
      version: target.version,
      anchor: { latitude: manifest.anchor.latitude, longitude: manifest.anchor.longitude },
      radiusMeters: plan.radiusMeters,
      digest: plan.digest,
      values: {
        profile: plan.profile,
        boundsWest: manifest.bounds.west,
        boundsSouth: manifest.bounds.south,
        boundsEast: manifest.bounds.east,
        boundsNorth: manifest.bounds.north,
        footprint: { type: 'Polygon', coordinates: manifest.footprint.coordinates },
        worldTransform: {
          anchor: manifest.anchor,
          frame: 'enu',
          enuFromScene: [...manifest.enuFromScene],
        },
        initialView: manifest.initialView,
        navigation: plan.navigation,
        assets,
        quality,
        metrics: {
          gaussians: plan.splat.gaussians,
          assetBytes: totals(assets).bytes,
        },
        provenance: {
          pipelineVersion: LICENSED_IMPORT_PIPELINE_VERSION,
          components: manifest.provenance.components,
          placementNote: manifest.placementNote,
        },
        observedFrom: new Date(manifest.observedFrom),
        observedTo: new Date(manifest.observedTo),
        attributions: manifest.attributions,
        licence,
        privacyAttestation: {
          basis: manifest.privacy.basis,
          reviewedBy: manifest.privacy.reviewedBy,
          note: manifest.privacy.note,
        },
      },
    },
    now,
  );
  if ('refused' in recorded) return { imported: false, reason: recorded.refused };
  return {
    imported: true,
    created: recorded.created,
    sceneId: recorded.sceneId,
    versionId: recorded.versionId,
    version: recorded.version,
    state: recorded.state,
    profile: plan.profile,
    ...totals(assets),
    uploaded,
  };
}
