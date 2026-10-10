import { describe, expect, test } from 'bun:test';
import type { StreetSceneManifest } from '@goway.to/sdk';

import { isAllowedAssetUrl, planSceneAssets } from '../assets';
import { embedUrl, encodeBridgeMessage, isOnOrigin, parseBridgeMessage } from '../bridge';
import { createCameraRig, MAX_PITCH } from '../cameraRig';
import { assessDevice, MAX_PIXEL_RATIO } from '../deviceProfile';
import type { Vec3 } from '../types';

const close = (a: readonly number[], b: readonly number[], digits = 6) =>
  a.forEach((value, index) => expect(value).toBeCloseTo(b[index], digits));

describe('assessDevice', () => {
  const capable = {
    webgl2: true,
    devicePixelRatio: 3,
    deviceMemoryGb: 8,
    hardwareConcurrency: 8,
    maxTextureSize: 16384,
  };

  test('no WebGL2 is unsupported', () => {
    expect(assessDevice({ ...capable, webgl2: false }).tier).toBe('unsupported');
  });

  test('a capable device is full, with the pixel ratio capped', () => {
    const result = assessDevice(capable);
    expect(result.tier).toBe('full');
    expect(result.pixelRatio).toBe(MAX_PIXEL_RATIO);
  });

  test('any constrained signal degrades to preview at pixel ratio 1', () => {
    for (const signal of [
      { deviceMemoryGb: 2 },
      { hardwareConcurrency: 2 },
      { saveData: true },
      { effectiveType: '3g' },
      { maxTextureSize: 2048 },
      { deviceMemoryGb: 4, fullSplatBytes: 200_000_000 },
    ]) {
      const result = assessDevice({ ...capable, ...signal });
      expect(result.tier).toBe('preview');
      expect(result.pixelRatio).toBe(1);
      expect(result.reasons.length).toBeGreaterThan(0);
    }
  });

  test('unknown signals are not held against the device', () => {
    expect(assessDevice({ webgl2: true, devicePixelRatio: 1 }).tier).toBe('full');
  });
});

describe('planSceneAssets', () => {
  const asset = (role: 'splat' | 'splat_preview' | 'poster', url: string) =>
    ({
      role,
      url,
      format: role === 'poster' ? 'jpeg' : 'spz',
      byteSize: 1,
      sha256: '',
    }) as StreetSceneManifest['assets'][number];
  const manifest = {
    assets: [
      asset('splat', 'https://cdn.example/full.spz'),
      asset('splat_preview', 'https://cdn.example/preview.spz'),
      asset('poster', 'https://cdn.example/poster.jpg'),
    ],
  };
  const open = { allowedOrigin: null, allowInsecure: false };

  test('full tier loads the preview first, then the full splat', () => {
    const plan = planSceneAssets(manifest, 'full', open);
    expect(plan.first?.role).toBe('splat_preview');
    expect(plan.then?.role).toBe('splat');
    expect(plan.poster?.role).toBe('poster');
  });

  test('preview tier never loads the full splat', () => {
    expect(planSceneAssets(manifest, 'preview', open)).toMatchObject({
      first: { role: 'splat_preview' },
      then: null,
    });
    const fullOnly = { assets: [asset('splat', 'https://cdn.example/full.spz')] };
    expect(planSceneAssets(fullOnly, 'preview', open).first).toBeNull();
  });

  test('without a preview the full splat is loaded once', () => {
    const plan = planSceneAssets(
      { assets: [asset('splat', 'https://cdn.example/full.spz')] },
      'full',
      open,
    );
    expect(plan.first?.role).toBe('splat');
    expect(plan.then).toBeNull();
  });

  test('unsupported loads no splat but keeps the poster', () => {
    expect(planSceneAssets(manifest, 'unsupported', open)).toMatchObject({
      first: null,
      then: null,
      poster: { role: 'poster' },
    });
  });

  test('the asset origin policy is enforced', () => {
    const locked = { allowedOrigin: 'https://scenes.example', allowInsecure: false };
    expect(planSceneAssets(manifest, 'full', locked).first).toBeNull();
    expect(isAllowedAssetUrl('https://SCENES.example/a.spz', locked)).toBe(true);
    expect(isAllowedAssetUrl('https://scenes.example.evil/a.spz', locked)).toBe(false);
    expect(isAllowedAssetUrl('http://cdn.example/a.spz', open)).toBe(false);
    expect(isAllowedAssetUrl('http://cdn.example/a.spz', { ...open, allowInsecure: true })).toBe(
      true,
    );
    expect(isAllowedAssetUrl('javascript:alert(1)', open)).toBe(false);
    expect(isAllowedAssetUrl('http://127.0.0.1:8791/a.spz', open)).toBe(true);
    expect(isAllowedAssetUrl('http://localhost/a.spz', open)).toBe(true);
    expect(isAllowedAssetUrl('http://127.0.0.1@evil.example/a.spz', open)).toBe(false);
    expect(isAllowedAssetUrl('http://localhost.evil.example/a.spz', open)).toBe(false);
  });
});

describe('camera rig', () => {
  const yUp = {
    position: [0, 1.7, 30] as Vec3,
    target: [0, 1.5, 0] as Vec3,
    up: [0, 1, 0] as Vec3,
  };

  test('starts exactly at the initial view', () => {
    const pose = createCameraRig(yUp).pose();
    close(pose.position, yUp.position);
    close(pose.target, yUp.target);
    close(pose.up, [0, 1, 0]);
  });

  test('orbit keeps the distance to the target', () => {
    const rig = createCameraRig(yUp);
    const before = rig.pose();
    const distance = (p: { position: Vec3; target: Vec3 }) =>
      Math.hypot(
        p.position[0] - p.target[0],
        p.position[1] - p.target[1],
        p.position[2] - p.target[2],
      );
    rig.look(0.7, 0.3);
    const after = rig.pose();
    expect(distance(after)).toBeCloseTo(distance(before), 6);
    close(after.target, before.target);
  });

  test('walk keeps the position and turns the view', () => {
    const rig = createCameraRig(yUp);
    rig.setMode('walk');
    rig.look(Math.PI / 2, 0);
    const pose = rig.pose();
    close(pose.position, yUp.position);
    // Looking down -z initially; a quarter turn right looks down +x.
    expect(pose.target[0] - pose.position[0]).toBeGreaterThan(0);
  });

  test('pitch is clamped short of straight up', () => {
    const rig = createCameraRig(yUp);
    rig.setMode('walk');
    rig.look(0, 10);
    const pose = rig.pose();
    const d = [
      pose.target[0] - pose.position[0],
      pose.target[1] - pose.position[1],
      pose.target[2] - pose.position[2],
    ];
    const pitch = Math.asin(d[1] / Math.hypot(d[0], d[1], d[2]));
    expect(pitch).toBeCloseTo(MAX_PITCH, 6);
  });

  test('moving forward follows the ground, not the pitch', () => {
    const rig = createCameraRig(yUp);
    rig.setMode('walk');
    rig.look(0, 0.5);
    rig.move(10, 0, 0);
    const pose = rig.pose();
    expect(pose.position[1]).toBeCloseTo(1.7, 6);
    expect(pose.position[2]).toBeLessThan(30);
  });

  test('respects a non-Y up vector', () => {
    const zUp = {
      position: [0, -30, 1.7] as Vec3,
      target: [0, 0, 1.5] as Vec3,
      up: [0, 0, 1] as Vec3,
    };
    const rig = createCameraRig(zUp);
    rig.setMode('walk');
    rig.move(5, 0, 0);
    close(rig.pose().position, [0, -25, 1.7]);
  });

  test('reset returns to the initial view', () => {
    const rig = createCameraRig(yUp);
    rig.look(1, 0.2);
    rig.zoom(2);
    rig.reset();
    close(rig.pose().position, yUp.position);
  });
});

describe('bridge', () => {
  test('round-trips a place tap', () => {
    expect(
      parseBridgeMessage(encodeBridgeMessage({ type: 'place', placeId: 'gw_mercat_boqueria' })),
    ).toEqual({
      type: 'place',
      placeId: 'gw_mercat_boqueria',
    });
  });

  test('refuses anything else', () => {
    expect(parseBridgeMessage('not json')).toBeNull();
    expect(parseBridgeMessage(JSON.stringify({ type: 'place', placeId: 'x' }))).toBeNull();
    expect(
      parseBridgeMessage(encodeBridgeMessage({ type: 'place', placeId: '../../settings' })),
    ).toBeNull();
    expect(parseBridgeMessage(encodeBridgeMessage({ type: 'place', placeId: '..' }))).toBeNull();
    expect(
      parseBridgeMessage(
        JSON.stringify({ source: 'goway-street3d', type: 'navigate', url: 'https://evil' }),
      ),
    ).toBeNull();
    expect(parseBridgeMessage(12)).toBeNull();
  });

  test('embed URLs and the origin check', () => {
    expect(embedUrl('https://goway.to/', 's 1')).toBe('https://goway.to/street3d/s%201?embed=1');
    expect(isOnOrigin('https://goway.to/street3d/x?embed=1', 'https://goway.to')).toBe(true);
    expect(isOnOrigin('https://goway.to.evil.example/', 'https://goway.to')).toBe(false);
    expect(isOnOrigin('https://goway.to', 'https://goway.to')).toBe(true);
  });
});
