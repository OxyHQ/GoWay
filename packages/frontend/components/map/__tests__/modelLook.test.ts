/**
 * How models are lit (`engine/city3d/modelLook.ts`, `models.ts`): the eye the
 * shading uses is the real one, night comes from the asset's own extras, and
 * the lights dim and turn blue at night.
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';

import { eyeOf } from '@/components/map/engine/city3d/models';
import {
  applyNight,
  createModelLights,
  environmentIntensity,
  prepareNight,
} from '@/components/map/engine/city3d/modelLook';

describe('eyeOf', () => {
  test("recovers a perspective camera's position from its view-projection", () => {
    const camera = new THREE.PerspectiveCamera(22, 1.5, 0.01, 1000);
    camera.position.set(3, -40, 25);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const viewProjection = camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse);
    const eye = eyeOf(viewProjection);
    expect(eye.distanceTo(camera.position)).toBeLessThan(1e-6);
  });
});

describe('night from the asset', () => {
  function body(extras: unknown) {
    const material = new THREE.MeshStandardMaterial();
    material.userData = { goway: extras };
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    // A quantised GLB's node: scaled and offset.
    mesh.scale.setScalar(10);
    mesh.position.set(0, 5, 0);
    const root = new THREE.Group();
    root.add(mesh);
    return { root, material };
  }

  test('a `night` material glows only at night, by its own colour and strength', () => {
    const { root, material } = body({ night: { color: [1, 0.5, 0.25], strength: 2 } });
    const glowing = prepareNight(root, { value: 0 });
    expect(glowing).toEqual([material]);
    applyNight(glowing, 0);
    expect(material.emissive.getHex()).toBe(0x000000);
    applyNight(glowing, 1);
    expect(material.emissive.r).toBeCloseTo(2);
    expect(material.emissive.g).toBeCloseTo(1);
    applyNight(glowing, 0.5);
    expect(material.emissive.b).toBeCloseTo(0.25);
  });

  test('an `uplight` material gets the shader patch, with heights in asset metres', () => {
    const { root, material } = body({
      uplight: { color: [1, 0.8, 0.6], reach: 40, strength: 0.5 },
    });
    const night = { value: 1 };
    expect(prepareNight(root, night)).toEqual([]);
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: '#include <common>\n#include <begin_vertex>',
      fragmentShader: '#include <common>\n#include <emissivemap_fragment>',
    };
    material.onBeforeCompile(shader as never, undefined as never);
    expect(shader.uniforms.uGowayNight).toBe(night);
    // y in metres = 10·y + 5 for this node.
    const row = shader.uniforms.uGowayHeightRow.value as THREE.Vector4;
    expect([row.x, row.y, row.z, row.w]).toEqual([0, 10, 0, 5]);
    expect((shader.uniforms.uGowayUplight.value as THREE.Vector3).x).toBeCloseTo(0.5);
    expect(shader.fragmentShader).toContain('totalEmissiveRadiance += uGowayUplight');
  });

  test('materials without extras, or with malformed ones, are left alone', () => {
    expect(prepareNight(body(undefined).root, { value: 1 })).toEqual([]);
    expect(
      prepareNight(body({ night: { color: 'warm', strength: 1 } }).root, { value: 1 }),
    ).toEqual([]);
  });
});

describe('lights', () => {
  test('dim and turn blue at night; the environment fades', () => {
    const lights = createModelLights();
    const sun = { position: [0.3, -0.5, 0.8] as const, color: [1, 1, 1] as const, intensity: 0.4 };
    lights.update({ ...sun, night: 0 });
    const day = { sun: lights.sun.intensity, sky: lights.hemisphere.color.clone() };
    lights.update({ ...sun, night: 1 });
    expect(lights.sun.intensity).toBeLessThan(day.sun * 0.2);
    expect(lights.hemisphere.color.b).toBeGreaterThan(lights.hemisphere.color.r);
    expect(environmentIntensity(1)).toBeLessThan(environmentIntensity(0) * 0.3);
  });
});

describe('decals', () => {
  test('a pane laid proud of its wall gets a depth bias toward the eye', () => {
    const material = new THREE.MeshStandardMaterial();
    material.userData = { goway: { decal: true } };
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material));
    prepareNight(root, { value: 0 });
    expect(material.polygonOffset).toBe(true);
    expect(material.polygonOffsetUnits).toBeLessThan(0);
  });
});
