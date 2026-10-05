/**
 * Street 3D policy, as pure functions: configuration defaults, the
 * information-gain rule, manifest framing and the coarse-coverage helpers.
 */

import '../../__tests__/testEnv';
import { describe, expect, it } from 'bun:test';
import { parseStreet3dConfig } from '../../config/street3d';
import type { EligibleFrame } from '../../db/street3d/scenes';
import { hasInformationGain, isReconstructable, manifestFrames } from '../formation';
import { contributionBand, coverageAreaId, decodeGeohash, headingSector, inputFingerprint, sequenceGroup } from '../geo';
import { sanitizeDetail } from '../../db/street3d/jobs';

describe('Street 3D configuration', () => {
  it('is inert with nothing set', () => {
    const config = parseStreet3dConfig({});
    expect(config).toMatchObject({ schedulerEnabled: false, viewingEnabled: false, pipelineConfigured: false, sceneKeyPrefix: 'scenes' });
    expect(config.budgets.draft).toEqual({ maxTrainingIterations: 7000, maxGaussians: 1_500_000, maxAssetBytes: 60_000_000, maxTrainingLongEdgePixels: 1600 });
    expect(config.gates.minHeldOutPsnr).toBe(17);
  });

  it('is configured only when queues, region, scene bucket and public origin are all present', () => {
    const base = {
      AWS_REGION: 'eu-west-1',
      STREET3D_JOBS_QUEUE_URL: 'https://sqs.eu-west-1.amazonaws.com/1/jobs',
      STREET3D_EVENTS_QUEUE_URL: 'https://sqs.eu-west-1.amazonaws.com/1/events',
      STREET3D_SCENE_BUCKET: 'goway-scenes',
      STREET3D_PUBLIC_ASSET_BASE_URL: 'https://scenes.example.test',
      STREET3D_SCHEDULER_ENABLED: 'true',
    };
    expect(parseStreet3dConfig(base)).toMatchObject({ pipelineConfigured: true, schedulerEnabled: true });
    expect(parseStreet3dConfig({ ...base, STREET3D_SCENE_BUCKET: '' }).pipelineConfigured).toBe(false);
  });

  it('names every malformed variable at once', () => {
    expect(() => parseStreet3dConfig({ STREET3D_JOBS_QUEUE_URL: 'not a url', STREET3D_MIN_ELIGIBLE_FRAMES: '-1', STREET3D_SCHEDULER_ENABLED: 'perhaps' }))
      .toThrow(/jobsQueueUrl[\s\S]*minEligibleFrames|minEligibleFrames[\s\S]*jobsQueueUrl/);
  });
});

function frame(id: string, fields: Partial<EligibleFrame> = {}): EligibleFrame {
  return {
    derivativeId: id, assetId: `a-${id}`, sessionId: 's-1', frameIndex: 0, imageKey: `derived/privacy/${id}.jpg`,
    imageSha256: id.padEnd(64, '0').slice(0, 64), maskKey: null, maskSha256: null, width: 10, height: 10,
    privacyPipelineVersion: 'p/1', expiresAt: new Date(Date.now() + 100 * 86_400_000), capturedAt: null,
    privacyCompletedAt: null, latitude: 41, longitude: 2, accuracyMeters: null, altitudeMeters: null,
    headingDegrees: null, focalLength35mm: null, panoramaIndex: null, panoramaYawDegrees: null, panoramaFovDegrees: null,
    geoCell: 'sp3e9bh00', assetState: 'waiting_for_overlap',
    ...fields,
  };
}

describe('information gain', () => {
  const config = parseStreet3dConfig({ STREET3D_MIN_ELIGIBLE_FRAMES: '3', STREET3D_MIN_HEADING_SECTORS: '2', STREET3D_REBUILD_MIN_NEW_FRAMES: '4' });

  it('needs enough frames, and enough headings when headings are known at all', () => {
    expect(isReconstructable([frame('1'), frame('2')], config)).toBe(false);
    expect(isReconstructable([frame('1'), frame('2'), frame('3')], config)).toBe(true);
    const sameWay = ['1', '2', '3'].map((id) => frame(id, { headingDegrees: 90 }));
    expect(isReconstructable(sameWay, config)).toBe(false);
    expect(isReconstructable([...sameWay, frame('4', { headingDegrees: 270 })], config)).toBe(true);
  });

  it('is not a fixed count: a new heading or an expiring input also counts, nothing new never does', () => {
    const previous = ['1', '2', '3'];
    const old = previous.map((id) => frame(id, { headingDegrees: 0 }));
    expect(hasInformationGain(old, previous, config, new Date())).toBe(false);
    expect(hasInformationGain([...old, frame('4', { headingDegrees: 10 })], previous, config, new Date())).toBe(false);
    expect(hasInformationGain([...old, frame('4', { headingDegrees: 180 })], previous, config, new Date())).toBe(true);
    expect(hasInformationGain([...old, frame('4', { expiresAt: new Date(Date.now() + 86_400_000) })], previous, config, new Date())).toBe(true);
    expect(hasInformationGain([...old, ...['4', '5', '6', '7'].map((id) => frame(id))], previous, config, new Date())).toBe(true);
  });

  it('groups frames by an opaque per-job token, never the session id', () => {
    const frames = manifestFrames('job-1', [frame('1', { sessionId: 'session-x' }), frame('2', { sessionId: 'session-x' }), frame('3', { sessionId: 'session-y' })]);
    const groups = frames.map((entry) => entry.sequenceGroup);
    expect(new Set(groups).size).toBe(2);
    expect(JSON.stringify(frames)).not.toContain('session-');
    expect(frames.map((entry) => entry.sequenceIndex)).toEqual([0, 1, 0]);
    expect(sequenceGroup('job-2', 'session-x')).not.toBe(groups[0]);
  });

  it('hands panorama views to the solve as a rig, each looking its own way', () => {
    const views = [0, 45, 90, 135, 180, 225, 270, 315].map((yaw, k) =>
      frame(`v${k}`, { assetId: 'a-pano', frameIndex: k, headingDegrees: 300, focalLength35mm: 6, panoramaIndex: 0, panoramaYawDegrees: yaw, panoramaFovDegrees: 90 }),
    );
    const manifest = manifestFrames('job-1', views);
    expect(manifest.map((entry) => entry.panorama)).toEqual(
      [0, 45, 90, 135, 180, 225, 270, 315].map((yaw) => ({ index: 0, yawDegrees: yaw, horizontalFovDegrees: 90 })),
    );
    // A view's heading is the capture's plus its yaw; its intrinsics are its field of view, not the 360° lens.
    expect(manifest.map((entry) => entry.prior.headingDegrees)).toEqual([300, 345, 30, 75, 120, 165, 210, 255]);
    expect(manifest.every((entry) => entry.camera === undefined)).toBe(true);
    // One panorama covers every sector, so it satisfies the heading rule alone.
    const strict = parseStreet3dConfig({ STREET3D_MIN_ELIGIBLE_FRAMES: '8', STREET3D_MIN_HEADING_SECTORS: '6' });
    expect(isReconstructable(views, strict)).toBe(true);
  });
});

describe('geometry and privacy helpers', () => {
  it('sectors headings, fingerprints order-free and decodes cells', () => {
    expect([0, 22, 23, 359, 180].map(headingSector)).toEqual([0, 0, 1, 0, 4]);
    expect(inputFingerprint(['b', 'a'])).toBe(inputFingerprint(['a', 'b']));
    const { center, bounds } = decodeGeohash('u09wh2h');
    expect(center.latitude).toBeGreaterThan(bounds.south);
    expect(center.latitude).toBeLessThan(bounds.north);
    expect(bounds.north - bounds.south).toBeLessThan(0.002);
    expect(coverageAreaId('u09wh2h')).not.toContain('u09wh2h');
    expect([1, 4, 5, 19, 20, 500].map(contributionBand)).toEqual(['1-4', '1-4', '5-19', '5-19', '20+', '20+']);
  });

  it('keeps worker failure details short and free of paths and URLs', () => {
    const detail = sanitizeDetail('solver died at /home/someone/scratch/job/x.bin see https://internal.invalid/log?id=1');
    expect(detail).not.toMatch(/\/home|https?:/);
    expect(sanitizeDetail('x'.repeat(5000))?.length).toBe(200);
  });
});
