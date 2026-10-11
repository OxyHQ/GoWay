/**
 * Coordinate-anchored models (SDK_MAP_MODELS phase 1), without WebGL:
 *
 *  - the frames: a model's anchor lands exactly where its coordinate is in
 *    MapLibre's own mercator, its front faces its heading, it stands up;
 *  - the alignment check: the anchor projected through the models' camera
 *    is the coordinate projected through the host matrix (the in-browser half
 *    of this check is `__gowayModelAlignment`; see docs/MAP_CAMERA_STUDIO.md);
 *  - the NaN gate and the marker fallback;
 *  - which URLs the layer may fetch.
 */
import { describe, expect, test } from 'bun:test';
import { MercatorCoordinate } from 'maplibre-gl';
import * as THREE from 'three';

import {
  isAllowedModelUrl,
  modelMatrix,
  modelProjection,
} from '@/components/map/engine/city3d/models';
import { mercatorPerMetre } from '@/components/map/engine/city3d/tileMath';
import {
  drawableModels,
  MODEL_MARKER_PREFIX,
  modelFallbackMarker,
  modelIdOfMarker,
} from '@/components/map/models';
import type { MapModel } from '@/components/map/types';

const SAGRADA = { latitude: 41.4036, longitude: 2.1744 };
const placement = (heading = 0, extra: object = {}) => ({
  position: SAGRADA,
  altitude: { meters: 0, reference: 'ground' as const },
  orientation: { heading, pitch: 0, roll: 0 },
  scale: 1,
  ...extra,
});

describe('model frames', () => {
  const ml = MercatorCoordinate.fromLngLat([SAGRADA.longitude, SAGRADA.latitude]);
  const center = { x: ml.x - 1e-5, y: ml.y + 2e-5 };

  test('the glTF origin is the anchor, relative to the centre, y north', () => {
    const origin = new THREE.Vector3(0, 0, 0).applyMatrix4(modelMatrix(placement(), center, 1));
    expect(origin.x).toBeCloseTo(ml.x - center.x, 15);
    // World y is NORTH: mercator y grows south, so it is negated.
    expect(origin.y).toBeCloseTo(-(ml.y - center.y), 15);
    expect(origin.z).toBe(0);
  });

  test('on 3D terrain the anchor stands on the drawn ground, its altitude above that', () => {
    // MapLibre puts a custom layer's z at absolute elevation once terrain is
    // on; a model left at z = 0 would be inside the hill (Barcelona's Sagrada
    // Família stands ~60 m up).
    const k = mercatorPerMetre(SAGRADA.latitude);
    const grounded = new THREE.Vector3(0, 0, 0).applyMatrix4(
      modelMatrix(placement(0, { altitude: { meters: 5, reference: 'ground' } }), center, 1, 60),
    );
    expect(grounded.z / k).toBeCloseTo(65, 6);
    // Flat map: the ground argument defaults to 0, so nothing else moved.
    const flat = new THREE.Vector3(0, 0, 0).applyMatrix4(modelMatrix(placement(), center, 1));
    expect(flat.z).toBe(0);
  });

  test('front (+Z) faces the heading; up (+Y) is up; one metre is one metre', () => {
    const k = mercatorPerMetre(SAGRADA.latitude);
    const front = (heading: number) => {
      const m = modelMatrix(placement(heading), center, 1);
      const o = new THREE.Vector3().applyMatrix4(m);
      return new THREE.Vector3(0, 0, 1).applyMatrix4(m).sub(o).divideScalar(k);
    };
    const north = front(0);
    expect(north.x).toBeCloseTo(0, 9);
    expect(north.y).toBeCloseTo(1, 9);
    const east = front(90);
    expect(east.x).toBeCloseTo(1, 9);
    expect(east.y).toBeCloseTo(0, 9);
    const m = modelMatrix(placement(37), center, 1);
    const up = new THREE.Vector3(0, 1, 0).applyMatrix4(m).sub(new THREE.Vector3().applyMatrix4(m));
    expect(up.z / k).toBeCloseTo(1, 9);
    // A proper rotation: three culls and lights it without special cases.
    expect(m.determinant()).toBeGreaterThan(0);
  });

  test('pitch raises the nose; altitude lifts the anchor', () => {
    const k = mercatorPerMetre(SAGRADA.latitude);
    const m = modelMatrix(
      placement(0, {
        orientation: { heading: 0, pitch: 30, roll: 0 },
        altitude: { meters: 10, reference: 'ground' },
      }),
      center,
      1,
    );
    const o = new THREE.Vector3().applyMatrix4(m);
    expect(o.z / k).toBeCloseTo(10, 9);
    const nose = new THREE.Vector3(0, 0, 1).applyMatrix4(m).sub(o).divideScalar(k);
    expect(nose.z).toBeCloseTo(Math.sin(Math.PI / 6), 9);
  });

  test('alignment: through the models camera, the anchor projects where the host projects the coordinate', () => {
    // A perspective-ish host matrix (any invertible mercator → clip matrix will do).
    const host = new THREE.Matrix4()
      .makePerspective(-0.4, 0.4, 0.3, -0.3, 0.5, 100)
      .multiply(new THREE.Matrix4().makeRotationX(-0.9))
      .multiply(new THREE.Matrix4().makeTranslation(-0.5, -0.5, -0.001))
      .multiply(new THREE.Matrix4().makeScale(2000, 2000, 2000));
    const view = {
      mercatorToClip: host.elements,
      zoom: 17,
      center: { lng: SAGRADA.longitude + 0.001, lat: SAGRADA.latitude - 0.0005 },
    };
    const { matrix, center: c } = modelProjection(view);
    const anchor = new THREE.Vector3()
      .applyMatrix4(modelMatrix(placement(123), c, 3))
      .applyMatrix4(matrix);
    const direct = new THREE.Vector3(ml.x, ml.y, 0).applyMatrix4(host);
    expect(anchor.x).toBeCloseTo(direct.x, 6);
    expect(anchor.y).toBeCloseTo(direct.y, 6);
  });
});

describe('model URLs', () => {
  test('HTTPS, this page, or loopback; nothing else', () => {
    expect(isAllowedModelUrl('https://cdn.example/car.glb', 'https://goway.to')).toBe(true);
    expect(isAllowedModelUrl('/models/library/vehicle.sedan.glb', 'https://goway.to')).toBe(true);
    expect(isAllowedModelUrl('/models/library/vehicle.sedan.glb', 'http://localhost:8081')).toBe(
      true,
    );
    expect(isAllowedModelUrl('http://127.0.0.1:9000/a.glb', null)).toBe(true);
    expect(isAllowedModelUrl('http://cdn.example/car.glb', 'https://goway.to')).toBe(false);
    expect(isAllowedModelUrl('data:model/gltf-binary;base64,AAAA', 'https://goway.to')).toBe(false);
    expect(isAllowedModelUrl('javascript:alert(1)', 'https://goway.to')).toBe(false);
    expect(isAllowedModelUrl('not a url', null)).toBe(false);
  });
});

describe('the NaN gate and the fallback marker', () => {
  const model = (id: string, position: { latitude: number; longitude: number }): MapModel => ({
    id,
    placement: { position },
    asset: { kind: 'catalogue', key: 'vehicle.car' },
    accessibilityLabel: `Model ${id}`,
    fallback: { kind: 'vehicle', label: 'Car' },
  });

  test('a model whose placement does not parse costs that model only', () => {
    const drawn = drawableModels([
      model('ok', SAGRADA),
      model('nan', { latitude: Number.NaN, longitude: 2 }),
      model('pole', { latitude: 91, longitude: 2 }),
    ]);
    expect(drawn.map((d) => d.model.id)).toEqual(['ok']);
    expect(drawn[0].url).toBe('/models/library/vehicle.sedan.glb');
    expect(drawn[0].placement.scale).toBe(1);
  });

  test('an unknown catalogue key draws its marker and nothing else', () => {
    const [entry] = drawableModels([
      { ...model('x', SAGRADA), asset: { kind: 'catalogue', key: 'vehicle.spaceship' } },
    ]);
    expect(entry.url).toBeNull();
  });

  test('the fallback is a marker at the anchor, and maps back to its model', () => {
    const [entry] = drawableModels([model('car', SAGRADA)]);
    const marker = modelFallbackMarker(entry.model, entry.placement);
    expect(marker).toEqual({
      id: `${MODEL_MARKER_PREFIX}car`,
      coordinate: SAGRADA,
      kind: 'vehicle',
      label: 'Car',
      accessibilityLabel: 'Model car',
    });
    expect(modelIdOfMarker(marker.id)).toBe('car');
    expect(modelIdOfMarker('gw_mercat_boqueria')).toBeNull();
  });
});
