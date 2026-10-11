/**
 * The Street 3D schema's invariants, asserted against real rows.
 *
 * Each of these is a guarantee the scheduler RELIES on rather than enforces:
 * a derivative cannot be permanent or raw, one open job per scene, one served
 * version per scene, an undirected edge stored once, a job that names the
 * subject its kind needs. A regression in any of them would not fail a
 * scheduler test — it would let a second tick do something the first already
 * did.
 *
 * This suite does not skip. See `testDatabase.ts`.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { constraintNameOf } from '@oxy.so/db';
import { createCaptureSession, registerAsset } from '../capture/captureRepository';
import {
  captureDerivatives,
  captureSessions,
  street3dCaptureEdges,
  street3dJobs,
  street3dSceneVersions,
  street3dScenes,
} from '../schema';
import {
  SUITE_SETUP_TIMEOUT_MS,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from './testDatabase';

let suite: SuiteDatabase | null = null;
let assetId: string;
let privacyJobId: string;
let sceneId: string;

async function refusedBy(run: () => PromiseLike<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return (
      constraintNameOf(error) ??
      (error instanceof Error
        ? `${error.message} ${String((error as { cause?: unknown }).cause)}`
        : String(error))
    );
  }
  throw new Error('Expected the statement to be refused, but it succeeded.');
}

const digest = (char: string) => char.repeat(64);

function derivative(overrides: Record<string, unknown> = {}) {
  return {
    assetId,
    jobId: privacyJobId,
    frameIndex: 0,
    objectKey: `derived/privacy/${randomUUID()}.jpg`,
    imageSha256: digest('a'),
    imageByteSize: 10,
    width: 10,
    height: 10,
    privacyPipelineVersion: 'p/1',
    expiresAt: new Date(Date.now() + 86_400_000),
    ...overrides,
  };
}

function sceneJob(version: number, overrides: Record<string, unknown> = {}) {
  return {
    kind: 'scene_reconstruct',
    sceneId,
    sceneVersion: version,
    profile: 'draft',
    maxAttempts: 4,
    inputManifestKey: `jobs/${version}/input.json`,
    inputManifestSha256: digest('b'),
    outputPrefix: `jobs/${version}/`,
    ...overrides,
  };
}

beforeAll(async () => {
  suite = await createSuiteDatabase();
  const db = suite.db;
  const owner = randomUUID();
  const session = await createCaptureSession(db, owner, {
    source: 'camera',
    consentVersion: 'test',
  });
  const registered = await registerAsset(
    db,
    { id: session.id, oxyUserId: owner },
    {
      mediaKind: 'photo',
      source: 'camera',
      contentHash: digest('9'),
      byteSize: 1,
      contentType: 'image/jpeg',
      evidence: [
        { origin: 'user_placed', witness: 'client', coordinate: { latitude: 41, longitude: 2 } },
      ],
    },
    { keyPrefix: 'captures' },
  );
  assetId = registered.asset.id;
  const [job] = await db
    .insert(street3dJobs)
    .values({
      kind: 'capture_privacy',
      assetId,
      maxAttempts: 4,
      outputPrefix: 'derived/privacy/x/',
    })
    .returning();
  privacyJobId = job!.id;
  const [scene] = await db
    .insert(street3dScenes)
    .values({ anchorLatitude: 41, anchorLongitude: 2, radiusMeters: 90 })
    .returning();
  sceneId = scene!.id;
}, SUITE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await destroySuiteDatabase(suite);
});

describe('derivatives are temporary and never raw', () => {
  it('refuses an expiry past the absolute ceiling, a raw class and protection past expiry', async () => {
    const db = suite!.db;
    expect(
      await refusedBy(() =>
        db
          .insert(captureDerivatives)
          .values(derivative({ expiresAt: new Date(Date.now() + 401 * 86_400_000) })),
      ),
    ).toContain('capture_derivatives_expiry_ceiling_check');
    expect(
      await refusedBy(() =>
        db.insert(captureDerivatives).values(derivative({ retentionClass: 'raw_photo' })),
      ),
    ).toContain('capture_derivatives_retention_class_check');
    expect(
      await refusedBy(() =>
        db
          .insert(captureDerivatives)
          .values(derivative({ protectedUntil: new Date(Date.now() + 2 * 86_400_000) })),
      ),
    ).toContain('capture_derivatives_protected_until_check');
    expect(
      await refusedBy(() =>
        db.insert(captureDerivatives).values(derivative({ extensionCount: 4 })),
      ),
    ).toContain('capture_derivatives_extension_count_check');
    expect(
      await refusedBy(() =>
        db.insert(captureDerivatives).values(derivative({ objectKey: 'captures/raw' })),
      ),
    ).toContain('capture_derivatives_key_check');
  });

  it('records a panorama view whole or not at all, with a yaw and field of view that make sense', async () => {
    const db = suite!.db;
    const view = { panoramaIndex: 0, panoramaYawDegrees: 45, panoramaFovDegrees: 90 };
    await db.insert(captureDerivatives).values(derivative({ frameIndex: 10, ...view }));
    expect(
      await refusedBy(() =>
        db.insert(captureDerivatives).values(derivative({ frameIndex: 11, panoramaIndex: 0 })),
      ),
    ).toContain('capture_derivatives_panorama_check');
    expect(
      await refusedBy(() =>
        db
          .insert(captureDerivatives)
          .values(derivative({ frameIndex: 12, ...view, panoramaYawDegrees: 360 })),
      ),
    ).toContain('capture_derivatives_panorama_check');
    expect(
      await refusedBy(() =>
        db
          .insert(captureDerivatives)
          .values(derivative({ frameIndex: 13, ...view, panoramaFovDegrees: 180 })),
      ),
    ).toContain('capture_derivatives_panorama_check');
    expect(
      await refusedBy(() =>
        db
          .insert(captureDerivatives)
          .values(derivative({ frameIndex: 14, ...view, panoramaIndex: -1 })),
      ),
    ).toContain('capture_derivatives_panorama_check');
  });
});

describe('jobs', () => {
  it('allows one open job per scene and one job per version', async () => {
    const db = suite!.db;
    await db.insert(street3dJobs).values(sceneJob(1));
    expect(await refusedBy(() => db.insert(street3dJobs).values(sceneJob(2)))).toContain(
      'street3d_jobs_open_scene_key',
    );
    expect(
      await refusedBy(() =>
        db.insert(street3dJobs).values(sceneJob(1, { state: 'failed', finishedAt: new Date() })),
      ),
    ).toContain('street3d_jobs_scene_version_key');
    expect(
      await refusedBy(() =>
        db
          .insert(street3dJobs)
          .values({ kind: 'capture_privacy', assetId, maxAttempts: 4, outputPrefix: 'derived/y/' }),
      ),
    ).toContain('street3d_jobs_open_asset_key');
  });

  it('refuses a job without its subject, a terminal job without a finish and an unbounded attempt', async () => {
    const db = suite!.db;
    expect(
      await refusedBy(() =>
        db
          .insert(street3dJobs)
          .values({ kind: 'scene_reconstruct', sceneId, maxAttempts: 4, outputPrefix: 'jobs/z/' }),
      ),
    ).toContain('street3d_jobs_subject_check');
    expect(
      await refusedBy(() => db.insert(street3dJobs).values(sceneJob(7, { state: 'completed' }))),
    ).toContain('street3d_jobs_finished_check');
    expect(
      await refusedBy(() =>
        db
          .insert(street3dJobs)
          .values(sceneJob(8, { state: 'failed', finishedAt: new Date(), attempt: 5 })),
      ),
    ).toContain('street3d_jobs_attempt_check');
  });
});

describe('versions and the graph', () => {
  it('serves at most one version per scene and stores an edge once', async () => {
    const db = suite!.db;
    const version = (number: number, jobId: string) => ({
      sceneId,
      version: number,
      jobId,
      state: 'published',
      profile: 'draft',
      publishedAt: new Date(),
      boundsWest: 2,
      boundsSouth: 41,
      boundsEast: 2.001,
      boundsNorth: 41.001,
      footprint: { type: 'Polygon' as const, coordinates: [] },
      worldTransform: {
        anchor: { latitude: 41, longitude: 2, altitudeMeters: 0 },
        frame: 'enu' as const,
        enuFromScene: [],
      },
      initialView: {
        position: [0, 0, 0] as [number, number, number],
        target: [0, 1, 0] as [number, number, number],
      },
      assets: [],
      quality: {
        profile: 'draft' as const,
        registrationRatio: 1,
        alignmentResidualMeters: 1,
        heldOutPsnr: 20,
        placement: 'precise' as const,
      },
      metrics: {},
      provenance: { pipelineVersion: 'p', components: {} },
      observedFrom: new Date(),
      observedTo: new Date(),
      privacyPipelineVersions: ['p/1'],
      resultSha256: digest('c'),
    });
    const [jobA] = await db
      .insert(street3dJobs)
      .values(sceneJob(10, { state: 'completed', finishedAt: new Date() }))
      .returning();
    const [jobB] = await db
      .insert(street3dJobs)
      .values(sceneJob(11, { state: 'completed', finishedAt: new Date() }))
      .returning();
    const [first] = await db
      .insert(street3dSceneVersions)
      .values(version(10, jobA!.id))
      .returning();
    expect(
      await refusedBy(() => db.insert(street3dSceneVersions).values(version(11, jobB!.id))),
    ).toContain('street3d_versions_published_key');
    const unpublished = { ...version(11, jobB!.id), state: 'failed_quality', publishedAt: null };
    expect(
      await refusedBy(() =>
        db.insert(street3dSceneVersions).values({
          ...unpublished,
          navigation: { fieldOfView: { horizontalDegrees: 66, verticalDegrees: 50 } } as never,
        }),
      ),
    ).toContain('street3d_versions_navigation_check');

    const [a] = await db
      .insert(captureDerivatives)
      .values(derivative({ frameIndex: 1 }))
      .returning();
    const [b] = await db
      .insert(captureDerivatives)
      .values(derivative({ frameIndex: 2 }))
      .returning();
    const [low, high] = [a!.id, b!.id].sort();
    expect(
      await refusedBy(() =>
        db.insert(street3dCaptureEdges).values({
          derivativeA: high!,
          derivativeB: low!,
          inliers: 5,
          matcherVersion: 'm',
          observedInVersionId: first!.id,
        }),
      ),
    ).toContain('street3d_capture_edges_order_check');
  });
});

describe('session attribution', () => {
  it('refuses a blank or oversized credit', async () => {
    const db = suite!.db;
    const row = { oxyUserId: randomUUID(), source: 'library', consentVersion: 'test' };
    expect(
      await refusedBy(() => db.insert(captureSessions).values({ ...row, attribution: '   ' })),
    ).toContain('capture_sessions_attribution_check');
    expect(
      await refusedBy(() =>
        db.insert(captureSessions).values({ ...row, attribution: 'x'.repeat(201) }),
      ),
    ).toContain('capture_sessions_attribution_check');
  });
});
