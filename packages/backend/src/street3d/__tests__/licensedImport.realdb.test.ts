/**
 * Licensed imports against real PostGIS: what the operator command records,
 * what the public API serves from it, idempotency, disable/enable, and the
 * paths that must never treat an imported scene as reconstruction work.
 *
 * The scene bucket is the in-memory fake (so purges and CDN invalidations are
 * observable); `cli.realdb.test.ts` runs the real command against a local
 * scene directory.
 *
 * This suite does not skip. See `db/__tests__/testDatabase.ts`.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { streetSceneManifestSchema } from '@goway/contracts';
import { parseStreet3dConfig } from '../../config/street3d';
import { street3dJobs, street3dSceneVersions, street3dScenes } from '../../db/schema';
import { findCoverage, findPublishedManifest } from '../../db/street3d/public';
import {
  requireSuite,
  createSuiteDatabase,
  destroySuiteDatabase,
  SUITE_SETUP_TIMEOUT_MS,
  type SuiteDatabase,
} from '../../db/__tests__/testDatabase';
import { defined } from '../../__tests__/defined';
import {
  adminDisableVersion,
  adminEnableVersion,
  adminImportLicensed,
  adminRebuildScene,
  adminStatus,
  type AdminDeps,
} from '../admin';
import { assetObjects } from '../sceneAssetStore';
import { FakeCdn, FakeJobStore, FakeSceneStore } from './fakes';
import { importManifest, KABUKICHO, writeLicensedImport } from './licensedImportFixtures';

const config = parseStreet3dConfig({
  STREET3D_PUBLIC_ASSET_BASE_URL: 'https://cdn.example.test/street3d',
});

let suite: SuiteDatabase | null = null;
let sceneStore: FakeSceneStore;
let cdn: FakeCdn;

const db = () => requireSuite(suite).db;
const deps = (): AdminDeps => ({ db: db(), services: null, bucket: { sceneStore, cdn }, config });

beforeAll(async () => {
  suite = await createSuiteDatabase();
}, SUITE_SETUP_TIMEOUT_MS);
afterAll(async () => {
  await destroySuiteDatabase(suite);
});
beforeEach(async () => {
  await db().execute(
    sql`truncate table ${street3dSceneVersions}, ${street3dScenes} restart identity cascade`,
  );
  sceneStore = new FakeSceneStore(new FakeJobStore());
  cdn = new FakeCdn();
});

async function versionRow(id: string) {
  return defined(
    (await db().select().from(street3dSceneVersions).where(eq(street3dSceneVersions.id, id)))[0],
  );
}

async function imported(manifestPath: string) {
  const outcome = await adminImportLicensed(deps(), manifestPath);
  if (!outcome.imported) throw new Error(`import refused: ${JSON.stringify(outcome)}`);
  return outcome;
}

describe('importing a licensed scene', () => {
  it('publishes a scene and version with its licence, attestation and no job', async () => {
    const disk = writeLicensedImport();
    const outcome = await imported(disk.manifestPath);
    expect(outcome).toMatchObject({
      created: true,
      version: 1,
      state: 'published',
      profile: 'standard',
      objects: 7,
      uploaded: 7,
    });

    const [scene] = await db()
      .select()
      .from(street3dScenes)
      .where(eq(street3dScenes.id, outcome.sceneId));
    expect(scene).toMatchObject({
      source: 'licensed_import',
      state: 'published',
      currentVersionId: outcome.versionId,
      lastAllocatedVersion: 1,
      rebuildRequestedAt: null,
    });
    const version = await versionRow(outcome.versionId);
    expect(version).toMatchObject({
      source: 'licensed_import',
      jobId: null,
      privacyPipelineVersions: [],
      privacyAttestation: {
        basis: 'licensor_redacted',
        reviewedBy: 'operator@goway.test',
      },
      provenance: {
        pipelineVersion: 'import:licensed/1',
        components: { capture: 'XGRIDS PortalCam', 'spark-build-lod': '2.3.1' },
      },
      licence: {
        licensor: 'Kawaii World Industries Co., Ltd. (Locahun 3D)',
        grantReference: 'LH3D-TEST-0001',
        permits: ['commercial_use', 'format_conversion', 'public_display'],
        importRun: { command: 'import-licensed' },
      },
    });
    expect(await db().select().from(street3dJobs)).toEqual([]);
    // Every object, chunks included, is in the bucket, immutable.
    for (const object of version.assets.flatMap(assetObjects)) {
      expect(await sceneStore.head(object.key)).toMatchObject({ byteSize: object.byteSize });
    }

    // What a viewer reads: the contract, honest about what was not measured.
    const manifest = defined(await findPublishedManifest(db(), outcome.sceneId));
    expect(streetSceneManifestSchema.parse(manifest)).toEqual(manifest);
    expect(manifest.privacyPipelineVersions).toEqual([]);
    expect(manifest.privacyBasis).toBe('licensor_redacted');
    expect(manifest.quality).toEqual({
      profile: 'standard',
      registrationRatio: 1,
      alignmentResidualMeters: 4,
      placement: 'approximate',
    });
    expect(manifest.attributions).toEqual([
      '3D scan © Kawaii World Industries Co., Ltd. (Locahun 3D)',
    ]);
    const served = JSON.stringify(manifest);
    // No reviewer, licence record, placement note, bucket key or chunk list.
    for (const secret of [
      'operator@goway.test',
      'LH3D-TEST-0001',
      'Placed by hand',
      '"key"',
      '"chunks"',
    ]) {
      expect(served).not.toContain(secret);
    }
    expect(manifest.assets.map((asset) => asset.role)).toEqual([
      'splat',
      'splat_environment',
      'poster',
    ]);

    const coverage = await findCoverage(db(), {
      west: KABUKICHO.longitude - 0.01,
      south: KABUKICHO.latitude - 0.01,
      east: KABUKICHO.longitude + 0.01,
      north: KABUKICHO.latitude + 0.01,
    });
    expect(coverage.scenes.map((scene) => scene.id)).toEqual([outcome.sceneId]);
    expect(coverage.scenes[0]?.posterUrl).toBe(
      manifest.assets.find((asset) => asset.role === 'poster')?.url,
    );

    const status = await adminStatus(deps());
    expect(status.scenes).toContainEqual({
      source: 'licensed_import',
      state: 'published',
      count: 1,
    });
    expect(status.storage.sceneVersions).toContainEqual({
      source: 'licensed_import',
      state: 'published',
      count: 1,
      bytes: outcome.bytes,
    });
  });

  it('is idempotent: a re-run records nothing and restores only what is missing', async () => {
    const disk = writeLicensedImport();
    const first = await imported(disk.manifestPath);
    const again = await imported(disk.manifestPath);
    expect(again).toMatchObject({
      created: false,
      versionId: first.versionId,
      version: 1,
      uploaded: 0,
    });
    expect(await db().select().from(street3dSceneVersions)).toHaveLength(1);

    const version = await versionRow(first.versionId);
    const chunk = defined(version.assets[0]?.chunks?.[1]);
    sceneStore.objects.delete(chunk.key);
    expect(await imported(disk.manifestPath)).toMatchObject({ created: false, uploaded: 1 });
    expect(await sceneStore.head(chunk.key)).not.toBeNull();
  });

  it('publishes a new delivery of the same scene as its next version', async () => {
    const first = await imported(writeLicensedImport().manifestPath);
    const second = await imported(
      writeLicensedImport({ sceneId: first.sceneId }, { seed: 'redelivery' }).manifestPath,
    );
    expect(second).toMatchObject({ created: true, sceneId: first.sceneId, version: 2 });
    expect((await versionRow(first.versionId)).state).toBe('superseded');
    expect((await findPublishedManifest(db(), first.sceneId))?.version).toBe(2);

    expect(
      await adminImportLicensed(
        deps(),
        writeLicensedImport({ sceneId: 'no-such-scene' }).manifestPath,
      ),
    ).toMatchObject({ imported: false, reason: 'scene_not_found' });
  });

  it('refuses without a scene bucket, and refuses a manifest with no privacy attestation', async () => {
    const disk = writeLicensedImport();
    expect(
      await adminImportLicensed({ db: db(), services: null, config }, disk.manifestPath),
    ).toEqual({ imported: false, reason: 'scene_store_not_configured' });
    disk.writeManifest(importManifest({ privacy: undefined }));
    expect(await adminImportLicensed(deps(), disk.manifestPath)).toEqual({
      imported: false,
      reason: 'manifest_invalid',
      detail: 'privacy',
    });
    expect(sceneStore.puts).toEqual([]);
    expect(await db().select().from(street3dScenes)).toEqual([]);
  });
});

describe('operating an imported scene', () => {
  it('disables (purging every chunk) and enables again from the files it came from', async () => {
    const disk = writeLicensedImport();
    const outcome = await imported(disk.manifestPath);
    const objects = (await versionRow(outcome.versionId)).assets.flatMap(assetObjects);

    expect(await adminDisableVersion(deps(), outcome.versionId, 'licence review')).toEqual({
      disabled: true,
      purged: 1,
      purgePending: false,
    });
    expect(await findPublishedManifest(db(), outcome.sceneId)).toBeNull();
    expect(sceneStore.objects.size).toBe(0);
    expect(new Set(sceneStore.deleted)).toEqual(new Set(objects.map((object) => object.key)));
    expect(cdn.invalidations).toEqual([
      {
        paths: [`/street3d/scenes/${outcome.sceneId}/v1/*`],
        callerReference: `goway-street3d-disable-${outcome.versionId}`,
      },
    ]);
    const [scene] = await db()
      .select()
      .from(street3dScenes)
      .where(eq(street3dScenes.id, outcome.sceneId));
    expect(scene).toMatchObject({ state: 'candidate', currentVersionId: null });

    // A re-run must not put a disabled version's bytes back in front of the public.
    expect(await adminImportLicensed(deps(), disk.manifestPath)).toEqual({
      imported: false,
      reason: 'version_disabled',
      versionId: outcome.versionId,
    });
    expect(sceneStore.objects.size).toBe(0);

    expect(await adminEnableVersion(deps(), outcome.versionId)).toEqual({
      enabled: false,
      reason: 'assets_gone',
    });
    const other = writeLicensedImport({}, { seed: 'not-this-one' });
    expect(
      await adminEnableVersion(deps(), outcome.versionId, { importManifest: other.manifestPath }),
    ).toMatchObject({ enabled: false, reason: 'manifest_mismatch' });

    expect(
      await adminEnableVersion(deps(), outcome.versionId, { importManifest: disk.manifestPath }),
    ).toEqual({ enabled: true, state: 'published', restoredAssets: objects.length });
    expect((await findPublishedManifest(db(), outcome.sceneId))?.version).toBe(1);
    expect(sceneStore.objects.size).toBe(objects.length);
  });

  it('never queues a rebuild of an imported scene', async () => {
    const outcome = await imported(writeLicensedImport().manifestPath);
    expect(await adminRebuildScene(deps(), outcome.sceneId, 'standard')).toEqual({
      requested: false,
    });
    const [scene] = await db()
      .select()
      .from(street3dScenes)
      .where(eq(street3dScenes.id, outcome.sceneId));
    expect(scene?.rebuildRequestedAt).toBeNull();
  });
});
