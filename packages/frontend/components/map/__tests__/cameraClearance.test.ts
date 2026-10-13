/**
 * The map's eye never inside a building or under the ground
 * (`engine/camera/clearance.ts`, `docs/MAP_CAMERA_CLEARANCE.md`).
 *
 * Two layers, each against real geometry: the volume index the mesh worker
 * builds beside every tile mesh (`engine/camera/volumes.ts`, from the real
 * mesher's packed output) and the landmarks' columns (`models.ts` →
 * `assetVolumes`, from a three.js scene), and the camera rule over them.
 * Without the rule every "corrected" case below draws its eye inside.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';

import { cityTile, SYNTHETIC_CENTRE } from '@/components/map/__tests__/fixtures/syntheticCity';
import { cityQuality } from '@/components/map/engine/quality';
import { QUALITY_PRESETS } from '@/lib/map/quality/profile';
import {
  at,
  building,
  FLAT,
  field,
  footprint,
  K,
  SIZE,
  TILE,
  tileVolumes,
} from './fixtures/clearanceCity';
import {
  applyCorrection,
  CAMERA_CLEARANCE,
  type CameraPose,
  createCameraClearance,
  eyeInside,
  eyeOf,
  liftedPose,
  requirementFor,
} from '@/components/map/engine/camera/clearance';
import type { ModelVolumes, TileVolumes } from '@/components/map/engine/camera/field';
import {
  CELL_INDEX_MAX_BYTES,
  prismRequirement,
  volumeBytes,
} from '@/components/map/engine/camera/volumes';
import { createGltfLoader } from '@/components/map/engine/city3d/gltf';
import { assetVolumes } from '@/components/map/engine/city3d/models';
import { createGround } from '@/components/map/engine/city3d/terrainGround';
import { tileSizeMetres } from '@/components/map/engine/city3d/tileMath';
import { meshCityTile } from '@/components/map/engine/city3d/tileMeshing';
import { EARTH_CIRCUMFERENCE_M, mercatorX, mercatorY } from '@/lib/map/geo';

/** A street-level camera over the test tile: MapLibre's at a 1080 px tall screen. */
function pose(over: Partial<CameraPose> = {}): CameraPose {
  const centre = at(SIZE / 2, SIZE / 2);
  const distanceM = 150;
  return {
    centerX: centre.x,
    centerY: centre.y,
    centerLatitude: SYNTHETIC_CENTRE.lat,
    centerElevationM: 0,
    zoom: 19.6,
    pitch: 75,
    bearing: 0,
    distanceM,
    // MapLibre's near plane: a fiftieth of the screen height at 36.87°.
    nearM: (distanceM * Math.tan((36.87 * Math.PI) / 360)) / 25,
    ...over,
  };
}

const prisms = { marginM: 0, slope: Number.POSITIVE_INFINITY };

describe('the volume index (mesh worker)', () => {
  test('inside a prism it asks for the roof plus the margin; beside it, nothing', () => {
    const centre = at(400, 400);
    const f = field([tileVolumes([building(centre, 40, 40, 30)])]);
    const clearance = { marginM: 2, slope: CAMERA_CLEARANCE.slope };
    expect(f.requiredHeight(centre.x, centre.y, clearance, 0)).toBeCloseTo(32, 1);
    // 15 m out of the wall: the ramp, 2 m per metre past the margin.
    const beside = at(400 + 20 + 15, 400);
    expect(f.requiredHeight(beside.x, beside.y, clearance, 0)).toBeCloseTo(32 - 2 * 13, 0);
    // 40 m out: untouched.
    const away = at(400 + 20 + 40, 400);
    expect(f.requiredHeight(away.x, away.y, clearance, 0)).toBe(0);
    // The prism alone (no margin, no ramp): inside, its top; a metre out, nothing.
    expect(f.requiredHeight(centre.x, centre.y, prisms, 0)).toBeCloseTo(30, 1);
    const wall = at(400 + 21, 400);
    expect(f.requiredHeight(wall.x, wall.y, prisms, 0)).toBe(0);
  });

  test('footprints are hulls, not boxes: a turned building leaves its box corners free', () => {
    const centre = at(500, 500);
    const f = field([tileVolumes([building(centre, 60, 16, 25, 45)])]);
    // Inside the turned footprint.
    expect(f.requiredHeight(centre.x, centre.y, prisms, 0)).toBeCloseTo(25, 1);
    // Inside its axis-aligned box (±27 m), 15 m off the footprint itself.
    const corner = at(500 + 18, 500 - 18);
    expect(f.requiredHeight(corner.x, corner.y, prisms, 0)).toBe(0);
  });

  test('a unit stands on its own ground: on terrain its top is the ground under it plus its height', () => {
    const centre = at(300, 300);
    const hill = createGround(() => 140);
    const f = field([tileVolumes([building(centre, 30, 30, 20)])], { ground: hill });
    expect(f.requiredHeight(centre.x, centre.y, prisms, 0)).toBeCloseTo(160, 0);
  });

  test('built from the city tiles the map draws, and small beside the mesh', () => {
    const n = 2 ** 15;
    const tile = {
      z: 15,
      x: Math.floor(mercatorX(SYNTHETIC_CENTRE.lng) * n),
      y: Math.floor(mercatorY(SYNTHETIC_CENTRE.lat) * n),
    };
    const bytes = cityTile(tile.z, tile.x, tile.y);
    const meshed = meshCityTile(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      tileSizeMetres(tile),
      undefined,
    );
    const volumes = meshed.mesh?.volumes;
    expect(volumes).toBeDefined();
    if (!volumes || !meshed.mesh) return;
    // One prism per unit the grounder places.
    expect(volumes.top.length).toBe(meshed.mesh.polygonStarts.length);
    expect(volumes.maxTop).toBeGreaterThan(10);
    // A tenth of the mesh's GPU bytes, at most.
    expect(volumeBytes(volumes)).toBeLessThan(meshed.mesh.bytes / 10);
  });
});

describe('landmarks: their own bounds, not their footprint prism', () => {
  /** A church in glTF's frame (x left, y up, z front): a 20 m nave and a 100 m spire at its front. */
  function church(): THREE.Group {
    const scene = new THREE.Group();
    const nave = new THREE.Mesh(new THREE.BoxGeometry(30, 20, 60));
    nave.position.set(0, 10, 0);
    const spire = new THREE.Mesh(new THREE.BoxGeometry(6, 100, 6));
    spire.position.set(0, 50, 27);
    scene.add(nave, spire);
    return scene;
  }

  function placed(heading: number): ModelVolumes {
    const volumes = assetVolumes(church());
    if (!volumes) throw new Error('no volumes');
    const anchor = at(600, 600);
    return {
      x: anchor.x,
      y: anchor.y,
      latitude: SYNTHETIC_CENTRE.lat,
      baseM: 0,
      heading,
      scale: 1,
      volumes,
    };
  }

  test('the spire is a spire and the nave is a nave', () => {
    const f = field([], { models: [placed(0)] });
    // Heading 0: the front (+z) faces north, so the spire is 27 m north of the anchor.
    const spire = at(600, 600 - 27);
    const nave = at(600, 600 + 10);
    expect(f.requiredHeight(spire.x, spire.y, prisms, 0)).toBeCloseTo(100, 0);
    expect(f.requiredHeight(nave.x, nave.y, prisms, 0)).toBeCloseTo(20, 0);
    // Beside the church: nothing.
    const beside = at(600 + 40, 600);
    expect(f.requiredHeight(beside.x, beside.y, prisms, 0)).toBe(0);
  });

  test('the Sagrada Família model: 172 m towers over a much lower church, measured as it loads', async () => {
    const bytes = readFileSync(
      join(import.meta.dir, '../../../public/landmarks/sagrada-familia.glb'),
    );
    const gltf = await createGltfLoader().parseAsync(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      '',
    );
    const started = performance.now();
    const volumes = assetVolumes(gltf.scene);
    const ms = performance.now() - started;
    console.log(
      `Sagrada Família columns: ${volumes?.top.length} in ${ms.toFixed(1)} ms, ${volumes ? volumeBytes(volumes) : 0} B`,
    );
    expect(volumes).not.toBeNull();
    if (!volumes) return;
    // The registry's bounds: 172.5 m.
    expect(volumes.maxTop).toBeGreaterThan(165);
    expect(volumes.maxTop).toBeLessThan(175);
    // Most of the footprint is far below the towers.
    const tops = [...volumes.top].sort((a, b) => a - b);
    expect(tops[Math.floor(tops.length / 2)]).toBeLessThan(volumes.maxTop / 2);
    // On the main thread once per asset, beside a parse that costs more.
    expect(ms).toBeLessThan(200);
  });

  test('placed by its heading', () => {
    // Heading 90: the front faces east.
    const f = field([], { models: [placed(90)] });
    const spire = at(600 + 27, 600);
    expect(f.requiredHeight(spire.x, spire.y, prisms, 0)).toBeCloseTo(100, 0);
    const north = at(600, 600 - 27);
    expect(f.requiredHeight(north.x, north.y, prisms, 0)).toBe(0);
  });
});

describe('the camera rule', () => {
  /** A building whose footprint holds the eye of `p`. */
  function aroundEye(p: CameraPose, height: number, side = 30): TileVolumes {
    const eye = eyeOf(p);
    return tileVolumes([building({ x: eye.x, y: eye.y }, side, side, height)]);
  }

  test('the eye of the pose is where MapLibre puts it', () => {
    const p = pose({ bearing: 90 });
    const eye = eyeOf(p);
    // Bearing 90 looks east: the eye is west of the centre, by D·sin(pitch).
    const horizontal = 150 * Math.sin((75 * Math.PI) / 180);
    const perM = 1 / (EARTH_CIRCUMFERENCE_M * Math.cos((p.centerLatitude * Math.PI) / 180));
    expect(eye.x).toBeCloseTo(p.centerX - horizontal * perM, 12);
    expect(eye.y).toBeCloseTo(p.centerY, 12);
    expect(eye.altitudeM).toBeCloseTo(150 * Math.cos((75 * Math.PI) / 180), 6);
  });

  test('inside a prism: raised over the roof, same centre, same bearing, same ground position', () => {
    const p = pose();
    const f = field([aroundEye(p, 60)]);
    expect(eyeInside(p, f, FLAT).inside).toBe(true);
    const correction = createCameraClearance().constrain(p, f, FLAT, 0);
    expect(correction).not.toBeNull();
    const drawn = applyCorrection(p, correction);
    const before = eyeOf(p);
    const after = eyeOf(drawn);
    expect(eyeInside(drawn, f, FLAT).inside).toBe(false);
    expect(after.altitudeM).toBeGreaterThanOrEqual(60 + CAMERA_CLEARANCE.minMarginM - 0.01);
    expect(after.x).toBeCloseTo(before.x, 12);
    expect(after.y).toBeCloseTo(before.y, 12);
    expect(drawn.centerX).toBe(p.centerX);
    expect(drawn.bearing).toBe(p.bearing);
    // Only less pitch and less zoom.
    expect(drawn.pitch).toBeLessThan(p.pitch);
    expect(drawn.zoom).toBeLessThan(p.zoom);
  });

  test('next to a prism: untouched', () => {
    const p = pose();
    const eye = eyeOf(p);
    // 30 m tall, its wall 40 m east of the eye (which is 39 m up).
    const f = field([tileVolumes([building({ x: eye.x + 55 * K, y: eye.y }, 30, 30, 30)])]);
    expect(createCameraClearance().constrain(p, f, FLAT, 0)).toBeNull();
  });

  test('under the ground: raised over the terrain, with the margin', () => {
    const p = pose();
    const ground = () => 100;
    const correction = createCameraClearance().constrain(p, null, ground, 0);
    expect(correction).not.toBeNull();
    const eye = eyeOf(applyCorrection(p, correction));
    expect(eye.altitudeM).toBeGreaterThanOrEqual(100 + CAMERA_CLEARANCE.minMarginM - 0.01);
  });

  test('a correction is a fixed point: asking again changes nothing (no fight when a gesture resumes)', () => {
    const p = pose();
    const f = field([aroundEye(p, 60)]);
    const drawn = applyCorrection(p, createCameraClearance().constrain(p, f, FLAT, 0));
    expect(createCameraClearance().constrain(drawn, f, FLAT, 0)).toBeNull();
    const again = requirementFor(drawn, f, FLAT);
    expect(again.altitudeM).toBeCloseTo(eyeOf(drawn).altitudeM, 1);
  });

  test('the margin keeps the near plane out of the wall', () => {
    const p = pose({ distanceM: 400, nearM: 8 });
    const f = field([aroundEye(p, 200)]);
    const drawn = applyCorrection(p, createCameraClearance().constrain(p, f, FLAT, 0));
    const { marginM } = requirementFor(drawn, f, FLAT);
    expect(marginM).toBeGreaterThanOrEqual(CAMERA_CLEARANCE.nearPlanes * drawn.nearM - 0.01);
    expect(eyeOf(drawn).altitudeM).toBeGreaterThanOrEqual(200 + marginM - 0.05);
  });

  test('a rotation past a tower: never inside, never a snap, the bearing always turns', () => {
    const start = pose({ bearing: 0 });
    // A 60 m tower where the eye passes at bearing 90.
    const f = field([aroundEye({ ...start, bearing: 90 }, 60)]);
    const rule = createCameraClearance();
    let previous: ReturnType<typeof eyeOf> | null = null;
    let insideWithout = 0;
    let corrected = 0;
    for (let i = 0; i <= 720; i++) {
      const asked = pose({ bearing: i / 2 });
      if (eyeInside(asked, f, FLAT).inside) insideWithout++;
      const correction = rule.constrain(asked, f, FLAT, i * 16);
      if (correction) corrected++;
      const drawn = applyCorrection(asked, correction);
      expect(drawn.bearing).toBe(asked.bearing);
      expect(eyeInside(drawn, f, FLAT).inside).toBe(false);
      const eye = eyeOf(drawn);
      if (previous) {
        const metres = Math.hypot(eye.x - previous.x, eye.y - previous.y) / K;
        // The field rises at most `slope` per metre moved: no jump.
        expect(Math.abs(eye.altitudeM - previous.altitudeM)).toBeLessThanOrEqual(
          (CAMERA_CLEARANCE.slope + 1) * metres + 0.05,
        );
      }
      previous = eye;
    }
    // The test means something: without the rule the eye went through it.
    expect(insideWithout).toBeGreaterThan(10);
    expect(corrected).toBeGreaterThan(insideWithout);
    // And back down: far from the tower the camera is exactly as asked.
    expect(rule.constrain(pose({ bearing: 270 }), f, FLAT, 99_999)).toBeNull();
  });

  test('a camera held still gives the same camera every time (no oscillation)', () => {
    const p = pose();
    const f = field([aroundEye(p, 60)]);
    const rule = createCameraClearance();
    const first = rule.constrain(p, f, FLAT, 0);
    for (let i = 1; i < 30; i++) expect(rule.constrain(p, f, FLAT, i * 16)).toEqual(first);
  });

  test('a building that arrives under the eye lifts it over time, not in one frame', () => {
    const p = pose();
    const tower = aroundEye(p, 80);
    const f = field([]);
    const rule = createCameraClearance();
    expect(rule.constrain(p, f, FLAT, 0)).toBeNull();
    f.setTiles([tower]);
    const full = eyeOf(applyCorrection(p, rule.settle(p, f, FLAT))).altitudeM;
    const base = eyeOf(p).altitudeM;
    const lifts: number[] = [];
    for (let i = 1; i <= 60; i++) {
      lifts.push(eyeOf(applyCorrection(p, rule.constrain(p, f, FLAT, i * 16))).altitudeM - base);
    }
    // Eased: the first frame is a fraction of it, and it never goes back.
    expect(lifts[0]).toBeGreaterThan(0);
    expect(lifts[0]).toBeLessThan((full - base) * 0.2);
    for (let i = 1; i < lifts.length; i++)
      expect(lifts[i]).toBeGreaterThanOrEqual(lifts[i - 1] - 1e-9);
    // Settled within half a second.
    expect(lifts[31]).toBeGreaterThan((full - base) * 0.97);
  });

  test('a move of the camera itself is never eased: it is corrected at once', () => {
    const p = pose();
    const f = field([aroundEye(p, 60)]);
    const rule = createCameraClearance();
    // From clear sky straight down into the roof in one step (a jump of the tilt).
    rule.constrain(pose({ pitch: 30 }), f, FLAT, 0);
    const drawn = applyCorrection(p, rule.constrain(p, f, FLAT, 16));
    expect(eyeInside(drawn, f, FLAT).inside).toBe(false);
  });

  test('not run far from the city', () => {
    const p = pose({ zoom: 12, distanceM: 40_000 });
    expect(createCameraClearance().constrain(p, null, () => 1e6, 0)).toBeNull();
  });

  test('liftedPose keeps the centre and the eye over the same ground', () => {
    const p = pose({ bearing: 33 });
    const lifted = liftedPose(p, 120);
    const drawn = { ...p, ...lifted, distanceM: p.distanceM * 2 ** (p.zoom - lifted.zoom) };
    expect(eyeOf(drawn).altitudeM).toBeCloseTo(120, 6);
    expect(eyeOf(drawn).x).toBeCloseTo(eyeOf(p).x, 12);
    expect(eyeOf(drawn).y).toBeCloseTo(eyeOf(p).y, 12);
  });

  test('the ramp is continuous at the margin and falls at the slope', () => {
    const clearance = { marginM: 3, slope: 2 };
    expect(prismRequirement(30, 0, clearance)).toBe(33);
    expect(prismRequirement(30, 3, clearance)).toBe(33);
    expect(prismRequirement(30, 3.001, clearance)).toBeCloseTo(33, 2);
    expect(prismRequirement(30, 8, clearance)).toBe(23);
  });
});

describe('cost', () => {
  test('a fraction of a millisecond per camera change over a dense synthetic district, at the low preset', () => {
    // Nine z15 city tiles around the synthetic centre: Eixample-like blocks,
    // indexed within the low preset's bounds (phones).
    const { low } = QUALITY_PRESETS;
    const limits = {
      maxBytes: low.camera.volumeBytesPerTile,
      maxFootprintVertices: low.camera.footprintVertices,
    };
    const n = 2 ** 15;
    const cx = Math.floor(mercatorX(SYNTHETIC_CENTRE.lng) * n);
    const cy = Math.floor(mercatorY(SYNTHETIC_CENTRE.lat) * n);
    const tiles: TileVolumes[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const tile = { z: 15, x: cx + dx, y: cy + dy };
        const bytes = cityTile(tile.z, tile.x, tile.y);
        const { mesh } = meshCityTile(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
          tileSizeMetres(tile),
          undefined,
          limits,
        );
        if (mesh?.volumes) tiles.push({ tile, volumes: mesh.volumes });
      }
    }
    expect(tiles.length).toBe(9);
    const f = field(tiles, { ground: createGround(() => 30) });
    const rule = createCameraClearance();
    const centre = { x: mercatorX(SYNTHETIC_CENTRE.lng), y: mercatorY(SYNTHETIC_CENTRE.lat) };
    const calls = 20_000;
    let corrected = 0;
    const started = performance.now();
    for (let i = 0; i < calls; i++) {
      const p = pose({
        centerX: centre.x,
        centerY: centre.y,
        centerElevationM: 30,
        bearing: (i * 0.3) % 360,
        pitch: 70 + (i % 100) / 10,
        distanceM: 60 + (i % 400),
      });
      if (rule.constrain(p, f, () => 30, i * 16)) corrected++;
    }
    const perCallMs = (performance.now() - started) / calls;
    console.log(
      `camera clearance, low preset: ${(perCallMs * 1000).toFixed(1)} µs per camera change (${calls} changes, ${corrected} corrected, 9 dense tiles)`,
    );
    expect(corrected).toBeGreaterThan(0);
    expect(perCallMs).toBeLessThan(0.25);
  });
});

describe('the index is bounded by the quality profile (`camera`)', () => {
  const circle = (r: number, sides: number) =>
    Array.from({ length: sides }, (_, i): [number, number] => [
      r * Math.cos((2 * Math.PI * i) / sides),
      r * Math.sin((2 * Math.PI * i) / sides),
    ]);

  test('a round footprint past the vertex cap is its enclosing rectangle, never smaller', () => {
    const centre = at(300, 300);
    const round = footprint(centre, circle(20, 24), 40);
    const free = tileVolumes([round]).volumes;
    const capped = tileVolumes([round], {
      maxBytes: Number.POSITIVE_INFINITY,
      maxFootprintVertices: 8,
    }).volumes;
    expect(free.hullStarts[1] - free.hullStarts[0]).toBeGreaterThan(8);
    expect(capped.hullStarts[1] - capped.hullStarts[0]).toBe(4);
    // Every point of the circle is still inside the capped prism.
    const f = field([{ tile: TILE, volumes: capped }]);
    for (const [east, south] of circle(19.8, 24)) {
      const p = at(300 + east, 300 + south);
      expect(f.requiredHeight(p.x, p.y, prisms, 0)).toBeCloseTo(40, 0);
    }
  });

  test('over its bytes, a tile falls back to rectangles, then to cells: never over, never thinner', () => {
    // A dense district of turned, many-sided buildings.
    const features = [];
    const centres: Array<{ x: number; y: number; h: number }> = [];
    for (let i = 0; i < 30; i++) {
      for (let j = 0; j < 30; j++) {
        const c = at(60 + i * 28, 60 + j * 28);
        const h = 10 + ((i * 7 + j * 3) % 40);
        features.push(footprint(c, circle(8, 12), h, (i * 13 + j * 7) % 90));
        centres.push({ ...c, h });
      }
    }
    const unlimited = volumeBytes(tileVolumes(features).volumes);
    for (const maxBytes of [Math.floor(unlimited * 0.8), CELL_INDEX_MAX_BYTES]) {
      const { volumes } = tileVolumes(features, { maxBytes, maxFootprintVertices: 16 });
      expect(volumeBytes(volumes)).toBeLessThanOrEqual(maxBytes);
      const f = field([{ tile: TILE, volumes }]);
      for (const c of centres) {
        expect(f.requiredHeight(c.x, c.y, prisms, 0)).toBeGreaterThanOrEqual(c.h - 0.05);
      }
    }
  });

  test('every preset can honour its cap, and the low one holds a dense district', () => {
    for (const tier of ['low', 'medium', 'high'] as const) {
      const { camera } = QUALITY_PRESETS[tier];
      expect(camera.volumeBytesPerTile).toBeGreaterThanOrEqual(CELL_INDEX_MAX_BYTES);
      expect(cityQuality({ ...QUALITY_PRESETS[tier], reason: 'test' }, 4).volumes).toEqual({
        maxBytes: camera.volumeBytesPerTile,
        maxFootprintVertices: camera.footprintVertices,
      });
    }
    const n = 2 ** 15;
    const tile = {
      z: 15,
      x: Math.floor(mercatorX(SYNTHETIC_CENTRE.lng) * n),
      y: Math.floor(mercatorY(SYNTHETIC_CENTRE.lat) * n),
    };
    const bytes = cityTile(tile.z, tile.x, tile.y);
    const { low } = QUALITY_PRESETS;
    const { mesh } = meshCityTile(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      tileSizeMetres(tile),
      undefined,
      {
        maxBytes: low.camera.volumeBytesPerTile,
        maxFootprintVertices: low.camera.footprintVertices,
      },
    );
    expect(mesh?.volumes).toBeDefined();
    if (!mesh?.volumes) return;
    expect(volumeBytes(mesh.volumes)).toBeLessThanOrEqual(low.camera.volumeBytesPerTile);
  });
});
