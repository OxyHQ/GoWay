/**
 * The worker contract, against the canonical fixtures.
 *
 * Every `.json` file in `packages/reconstruction-worker/contract/fixtures/` is
 * parsed here, and an unrecognised file FAILS the suite rather than being
 * skipped: a fixture the backend never reads is a contract the backend never
 * agreed to. The worker's own tests parse the same files with its pydantic
 * models, which is what keeps the two languages from drifting apart.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { z } from 'zod';
import { streetSceneAssetSchema } from '@goway/contracts';
import type { EligibleFrame } from '../../db/street3d/scenes';
import { manifestFrames } from '../formation';
import {
  capturePrivacyResultSchema,
  jobEnvelopeSchema,
  sceneInputManifestSchema,
  sceneReconstructResultSchema,
  workerEventSchema,
} from '../workerContract';

const FIXTURES = resolve(__dirname, '../../../../reconstruction-worker/contract/fixtures');

function schemaFor(file: string): z.ZodType {
  if (file.startsWith('job.')) return jobEnvelopeSchema;
  if (file.startsWith('event.')) return workerEventSchema;
  if (file.startsWith('result.capture_privacy.')) return capturePrivacyResultSchema;
  if (file === 'result.scene_reconstruct.json') return sceneReconstructResultSchema;
  if (file === 'scene_input_manifest.json') return sceneInputManifestSchema;
  if (file === 'scene_input_manifest.pre-gravity.json') return sceneInputManifestSchema;
  throw new Error(`No backend parser is registered for fixture ${file}`);
}

function fixture(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')) as Record<string, unknown>;
}

describe('worker contract fixtures', () => {
  const files = readdirSync(FIXTURES)
    .filter((file) => file.endsWith('.json'))
    .sort();

  it('finds the fixture directory', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  for (const file of files) {
    it(`parses ${file}`, () => {
      const result = schemaFor(file).safeParse(fixture(file));
      if (!result.success) throw new Error(`${file}: ${JSON.stringify(result.error.issues)}`);
      expect(result.success).toBe(true);
    });
  }

  it('carries measured gravity per frame, and still reads a manifest written before it', () => {
    const current = sceneInputManifestSchema.parse(fixture('scene_input_manifest.json'));
    const legacy = sceneInputManifestSchema.parse(fixture('scene_input_manifest.pre-gravity.json'));
    expect(
      current.frames.flatMap((frame) => (frame.gravity ? [[frame.frameId, frame.gravity]] : [])),
    ).toEqual([['f-01', [0.0346, 0.9919, 0.1219]]]);
    expect(legacy.schemaVersion).toBe(current.schemaVersion);
    expect(legacy.frames.every((frame) => frame.gravity === undefined)).toBe(true);
    expect(legacy.frames.map((frame) => frame.frameId)).toEqual(
      current.frames.map((frame) => frame.frameId),
    );
    for (const bad of [
      [0, 0.5, 0],
      [0, 1],
      [0, 1, 0, 0],
      [Number.NaN, 1, 0],
    ]) {
      const raw = fixture('scene_input_manifest.json') as { frames: Record<string, unknown>[] };
      (raw.frames[0] as Record<string, unknown>).gravity = bad;
      expect(sceneInputManifestSchema.safeParse(raw).success).toBe(false);
    }
  });

  it('reads the gravity metrics of a result, which an older worker omits', () => {
    const result = sceneReconstructResultSchema.parse(fixture('result.scene_reconstruct.json'));
    expect(result.metrics.gravityFrames).toBe(1);
    expect(result.metrics.gravityLeveledFrames).toBe(0);
    const raw = fixture('result.scene_reconstruct.json') as { metrics: Record<string, unknown> };
    delete raw.metrics.gravityFrames;
    delete raw.metrics.gravityLeveledFrames;
    delete raw.metrics.medianGravityResidualDegrees;
    expect(sceneReconstructResultSchema.safeParse(raw).success).toBe(true);
    raw.metrics.medianGravityResidualDegrees = -1;
    expect(sceneReconstructResultSchema.safeParse(raw).success).toBe(false);
  });

  it('fails closed on a pass without frames or with surviving metadata', () => {
    const passed = fixture('result.capture_privacy.json');
    expect(capturePrivacyResultSchema.safeParse({ ...passed, frames: [] }).success).toBe(false);
    expect(
      capturePrivacyResultSchema.safeParse({ ...passed, metadataStripped: false }).success,
    ).toBe(false);
    expect(
      capturePrivacyResultSchema.safeParse({ ...passed, verdict: 'failed', frames: [] }).success,
    ).toBe(true);
  });

  it('refuses unknown failure classes, stages and schema versions', () => {
    const failed = fixture('event.failed.json');
    expect(
      workerEventSchema.safeParse({ ...failed, failure: { code: 'gpu_on_fire', retryable: true } })
        .success,
    ).toBe(false);
    expect(
      workerEventSchema.safeParse({ ...fixture('event.heartbeat.json'), stage: 'dreaming' })
        .success,
    ).toBe(false);
    expect(workerEventSchema.safeParse({ ...failed, schemaVersion: 2 }).success).toBe(false);
    expect(workerEventSchema.safeParse({ ...failed, type: 'exploded' }).success).toBe(false);
  });

  it('bounds the optional navigation inputs', () => {
    const result = fixture('result.scene_reconstruct.json');
    const older = { ...result, viewpoints: undefined, captureFieldOfView: undefined };
    expect(sceneReconstructResultSchema.safeParse(older).success).toBe(true);
    const viewpoint = { position: [0, 0, 1.6], forward: [0, 1, 0] };
    expect(
      sceneReconstructResultSchema.safeParse({ ...result, viewpoints: Array(2000).fill(viewpoint) })
        .success,
    ).toBe(true);
    expect(
      sceneReconstructResultSchema.safeParse({ ...result, viewpoints: Array(2001).fill(viewpoint) })
        .success,
    ).toBe(false);
    expect(
      sceneReconstructResultSchema.safeParse({
        ...result,
        viewpoints: [{ ...viewpoint, position: [0, 0] }],
      }).success,
    ).toBe(false);
    expect(
      sceneReconstructResultSchema.safeParse({
        ...result,
        viewpoints: [{ ...viewpoint, forward: [0, Infinity, 0] }],
      }).success,
    ).toBe(false);
    expect(
      sceneReconstructResultSchema.safeParse({
        ...result,
        captureFieldOfView: { horizontalDegrees: 180, verticalDegrees: 50 },
      }).success,
    ).toBe(false);
    expect(
      sceneReconstructResultSchema.safeParse({
        ...result,
        captureFieldOfView: { horizontalDegrees: 66, verticalDegrees: 0.5 },
      }).success,
    ).toBe(false);
  });

  it('takes only the assets the worker produces, each one the public contract can publish', () => {
    const result = fixture('result.scene_reconstruct.json') as { assets: { role: string }[] };
    const assets = sceneReconstructResultSchema.parse(result).assets;
    expect(assets.map((asset) => asset.role).sort()).toEqual(['poster', 'splat', 'splat_preview']);
    for (const asset of assets) {
      const published = streetSceneAssetSchema.safeParse({
        ...asset,
        url: `https://scenes.example.test/${asset.sha256}`,
      });
      expect(published.success).toBe(true);
    }
    // A level-of-detail tree and an environment shell are published formats
    // the worker does not emit and publication cannot copy (a chunked RAD is
    // many objects): refused, never half-published.
    const splat = result.assets[0];
    for (const bad of [
      { ...splat, format: 'rad' },
      { ...splat, role: 'splat_environment', format: 'rad' },
    ]) {
      expect(
        sceneReconstructResultSchema.safeParse({
          ...result,
          assets: [bad, ...result.assets.slice(1)],
        }).success,
      ).toBe(false);
    }
  });

  it('refuses keys that escape their prefix', () => {
    const job = fixture('job.capture_privacy.json');
    expect(jobEnvelopeSchema.safeParse({ ...job, outputPrefix: '../captures/' }).success).toBe(
      false,
    );
    expect(jobEnvelopeSchema.safeParse({ ...job, outputPrefix: '/derived/x/' }).success).toBe(
      false,
    );
  });

  it('carries the declared projection, perspective when a party predates it', () => {
    const job = fixture('job.capture_privacy.json');
    const equirectangular = jobEnvelopeSchema.parse(
      fixture('job.capture_privacy.equirectangular.json'),
    );
    expect(equirectangular.jobType === 'capture_privacy' && equirectangular.projection).toBe(
      'equirectangular',
    );
    const older = jobEnvelopeSchema.parse({ ...job, projection: undefined });
    expect(older.jobType === 'capture_privacy' && older.projection).toBe('perspective');
    expect(jobEnvelopeSchema.safeParse({ ...job, projection: 'fisheye' }).success).toBe(false);
  });

  it('accepts panorama views only from a result that verified a panorama', () => {
    const views = fixture('result.capture_privacy.equirectangular.json');
    const parsed = capturePrivacyResultSchema.parse(views);
    expect(parsed.projection).toBe('equirectangular');
    expect(parsed.frames.map((frame) => frame.panorama?.yawDegrees)).toEqual([0, 45, 0]);
    // Views reported under a perspective verdict, or a panorama reported as flat frames: refused.
    expect(
      capturePrivacyResultSchema.safeParse({ ...views, projection: 'perspective' }).success,
    ).toBe(false);
    const flat = fixture('result.capture_privacy.json');
    expect(
      capturePrivacyResultSchema.safeParse({ ...flat, projection: 'equirectangular' }).success,
    ).toBe(false);
    // A result from a worker that predates projections reads as perspective.
    expect(capturePrivacyResultSchema.parse({ ...flat, projection: undefined }).projection).toBe(
      'perspective',
    );
    const frames = views.frames as Record<string, unknown>[];
    const badYaw = {
      ...views,
      frames: [{ ...frames[0], panorama: { index: 0, yawDegrees: 360, horizontalFovDegrees: 90 } }],
    };
    expect(capturePrivacyResultSchema.safeParse(badYaw).success).toBe(false);
    // An upper-ring view states its pitch; a horizon-only worker's views omit it.
    expect(parsed.frames.map((frame) => frame.panorama?.pitchDegrees)).toEqual([0, 0, 45]);
    const { pitchDegrees: _omitted, ...horizonOnly } = frames[0].panorama as Record<
      string,
      unknown
    >;
    expect(
      capturePrivacyResultSchema.safeParse({
        ...views,
        frames: [{ ...frames[0], panorama: horizonOnly }],
      }).success,
    ).toBe(true);
    const badPitch = {
      ...views,
      frames: [{ ...frames[0], panorama: { ...(frames[0].panorama as object), pitchDegrees: 91 } }],
    };
    expect(capturePrivacyResultSchema.safeParse(badPitch).success).toBe(false);
  });

  it("hands a privacy result's views back to the solve with the pitch the worker stated", () => {
    // The fixture result's views, as `applyPrivacyResult` stores them and `loadEligibleFrames` reads them back.
    const result = capturePrivacyResultSchema.parse(
      fixture('result.capture_privacy.equirectangular.json'),
    );
    const stored = (pitchOf: (stated: number | undefined) => number | null) =>
      result.frames.map(
        (frame): EligibleFrame => ({
          derivativeId: `d-${frame.frameIndex}`,
          assetId: result.assetId,
          sessionId: 's-1',
          frameIndex: frame.frameIndex,
          imageKey: frame.imageKey,
          imageSha256: frame.imageSha256,
          maskKey: frame.maskKey ?? null,
          maskSha256: frame.maskSha256 ?? null,
          width: frame.width,
          height: frame.height,
          privacyPipelineVersion: result.privacyPipelineVersion,
          expiresAt: new Date('2027-01-01T00:00:00.000Z'),
          capturedAt: null,
          privacyCompletedAt: null,
          latitude: 48.8684,
          longitude: 2.3021,
          accuracyMeters: null,
          altitudeMeters: null,
          headingDegrees: null,
          focalLength35mm: null,
          panoramaIndex: frame.panorama?.index ?? null,
          panoramaYawDegrees: frame.panorama?.yawDegrees ?? null,
          panoramaPitchDegrees: pitchOf(frame.panorama?.pitchDegrees),
          panoramaFovDegrees: frame.panorama?.horizontalFovDegrees ?? null,
          gravityX: null,
          gravityY: null,
          gravityZ: null,
          geoCell: 'u09whb',
          assetState: 'waiting_for_overlap',
        }),
      );
    const manifestWith = (frames: EligibleFrame[]) =>
      sceneInputManifestSchema.parse({
        ...fixture('scene_input_manifest.json'),
        frames: manifestFrames('job-1', frames),
      });
    const manifest = manifestWith(stored((stated) => stated ?? null));
    expect(manifest.frames.map((frame) => frame.panorama)).toEqual(
      result.frames.map((frame) => frame.panorama),
    );
    expect(manifest.frames.map((frame) => frame.panorama?.pitchDegrees)).toEqual([0, 0, 45]);
    // A view stored without a pitch (from a horizon-only worker) is handed back without one.
    const legacy = manifestWith(stored(() => null));
    expect(legacy.frames.every((frame) => !('pitchDegrees' in (frame.panorama as object)))).toBe(
      true,
    );
  });
});
