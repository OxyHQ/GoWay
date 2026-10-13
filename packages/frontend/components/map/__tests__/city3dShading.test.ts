/**
 * The city-3D occlusion and lighting numbers, and the shaders built from
 * them.
 *
 * The shaders (TSL) are checked only for what they are built FROM: that both
 * building materials, map-lit and sky-lit, hold the tested constants. Whether
 * they draw what the numbers say is a rendering question, answered by the
 * visibility gate and recorded in `docs/MAP_3D_CITY.md`.
 */
import { describe, expect, test } from 'bun:test';

import {
  AO,
  type CityLight,
  cornerOcclusion,
  extrusionDirectional,
  groundOcclusion,
  luminance,
  smoothstep,
} from '@/components/map/engine/city3d/occlusion';
import {
  createBuildingMaterials,
  createBuildingUniforms,
} from '@/components/map/engine/city3d/tsl/buildingMaterial';
import {
  clayResponse,
  createSkyBuildingMaterials,
} from '@/components/map/engine/city3d/tsl/skyBuildingMaterial';
import { createSkyNodes } from '@/components/map/engine/city3d/tsl/skyNodes';
import { FrontSide, Vector3 } from 'three/webgpu';

import { constantsOf, skyRefs } from './tslGraph';

describe('ground occlusion', () => {
  test('darkest at the ground, none above the reach, monotonic between', () => {
    expect(groundOcclusion(0)).toBeCloseTo(AO.groundMin, 12);
    expect(groundOcclusion(-5)).toBeCloseTo(AO.groundMin, 12);
    expect(groundOcclusion(AO.groundReachM)).toBe(1);
    expect(groundOcclusion(100)).toBe(1);
    let previous = 0;
    for (let z = 0; z <= AO.groundReachM; z += 0.25) {
      const value = groundOcclusion(z);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  test('smoothstep is GLSL’s', () => {
    expect(smoothstep(0, 1, 0.5)).toBe(0.5);
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
  });
});

describe('corner occlusion', () => {
  test('full depth at a right-angled inside corner, gone at the reach', () => {
    expect(cornerOcclusion(1, 0)).toBeCloseTo(1 - AO.cornerDepth, 12);
    expect(cornerOcclusion(1, AO.cornerReachM)).toBe(1);
    expect(cornerOcclusion(1, AO.cornerReachM / 2)).toBeCloseTo(1 - AO.cornerDepth / 2, 12);
    expect(cornerOcclusion(0, 0)).toBe(1);
  });
});

describe('extrusion lighting (MapLibre’s formula)', () => {
  // GoWay's light-mode sun light at a mid-morning sun: map-anchored, radial
  // 1.15, south-east, polar 40°.
  const p = 40 * (Math.PI / 180);
  const a = 135 * (Math.PI / 180);
  const light: CityLight = {
    position: [
      1.15 * Math.sin(a) * Math.sin(p),
      1.15 * Math.cos(a) * Math.sin(p),
      1.15 * Math.cos(p),
    ],
    intensity: 0.2,
    color: [1, 1, 1],
  };
  const pale = luminance([0.97, 0.93, 0.85]);

  test('a face turned away sits at the floor, 1 − intensity', () => {
    expect(extrusionDirectional([-Math.SQRT1_2, Math.SQRT1_2, 0], light, pale)).toBeCloseTo(
      0.8,
      12,
    );
  });

  test('roofs and sun-facing walls are lit, shaded walls are not — in both appearances', () => {
    for (const intensity of [0.2, 0.45]) {
      const lit = { ...light, intensity };
      const roof = extrusionDirectional([0, 0, 1], lit, pale);
      const sunny = extrusionDirectional([Math.SQRT1_2, -Math.SQRT1_2, 0], lit, pale);
      const shady = extrusionDirectional([-Math.SQRT1_2, Math.SQRT1_2, 0], lit, pale);
      expect(roof).toBeGreaterThan(shady);
      expect(sunny).toBeGreaterThan(shady);
      expect(shady).toBeCloseTo(1 - intensity, 12);
    }
  });

  test('a dark colour may be lit above 1, as MapLibre lets it be', () => {
    const dark = luminance([0.3, 0.31, 0.45]);
    expect(extrusionDirectional([0, 0, 1], { ...light, intensity: 0.45 }, dark)).toBeGreaterThan(1);
  });

  test('luminance is Rec. 709', () => {
    expect(luminance([1, 1, 1])).toBeCloseTo(1, 12);
    expect(luminance([0, 1, 0])).toBeCloseTo(0.7152, 12);
  });
});

describe('the shaders', () => {
  const uniforms = () =>
    createBuildingUniforms({
      uLow: { value: new Vector3() },
      uTall: { value: new Vector3() },
      uVeryTall: { value: new Vector3() },
      uTallM: { value: 60 },
      uVeryTallM: { value: 180 },
      uLightPosition: { value: new Vector3(0, 0, 1) },
      uLightIntensity: { value: 0.5 },
      uLightColor: { value: new Vector3(1, 1, 1) },
      uOpacity: { value: 1 },
      uGrounded: { value: 0 },
    });

  test('both building materials hold the tested occlusion', () => {
    const mapLit = createBuildingMaterials(uniforms(), FrontSide);
    const skyLit = createSkyBuildingMaterials({
      uniforms: uniforms(),
      sky: createSkyNodes(skyRefs(true), 12),
      response: clayResponse,
      side: FrontSide,
    });
    for (const materials of [mapLit, skyLit]) {
      for (const format of ['openmaptiles', 'goway'] as const) {
        const values = constantsOf(materials.get(format, false).colorNode);
        expect(values).toContain(AO.groundMin);
        expect(values).toContain(AO.groundReachM);
      }
    }
  });
});
