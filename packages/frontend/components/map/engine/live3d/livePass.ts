/**
 * GoWay Live in 3D: each live vehicle as a small, rounded model in city
 * life's maquette style (`liveModels.ts`) — a train as its consist, every car
 * placed on the track by the feature (`MapLivePoint.parts`) so a train bends
 * round a curve car by car; an aircraft at its REAL altitude on a thin stalk
 * to the ground point it is over.
 *
 * "One engine, one scene" (`docs/MAP_3D_CITY.md`): this is not a second
 * renderer. It is a {@link CityPass} — objects the city engine draws with its
 * own `WebGLRenderer`, in a style layer of their own above the buildings
 * (`city3dLayer.web.ts → addPass`), sharing MapLibre's depth buffer.
 *
 * Reached only through `components/engine3d/lazyChunk.ts`.
 *
 * ## What is real and what is styling
 *
 * Position, heading, altitude and the cars' placement on the published track
 * come from the feed (as the feature interpolates them, within its bounds).
 * Trains, buses and ships are drawn at their real size; an aircraft, a dot at
 * a city zoom, is drawn at least {@link AIRCRAFT_MIN_PIXELS} long. The models
 * are generic forms in the operator's colours as flat bands — no logo, number
 * or text. Light is baked (a soft top light), so a model reads as a solid in
 * any map light. Stale things are drawn grey.
 */
import * as THREE from 'three';

import type { CityPass, CityView } from '../city3d/cityEngine';
import {
  centeredProjection,
  mercatorPerMetre,
  mercatorXFromLng,
  mercatorYFromLat,
} from '../city3d/tileMath';
import type { MapLiveGlyph, MapLiveModel, MapLivePoint } from '../../types';
import { anchorMatrix, displayScale } from './anchorMath';
import { buildLiveModel } from './liveModels';

/** Smallest on-screen length of an aircraft, in CSS pixels. */
const AIRCRAFT_MIN_PIXELS = 30;
/** Below this zoom every car is drawn in its far form (a car is a few pixels). */
const NEAR_ZOOM = 14.5;
const INITIAL_CAPACITY = 64;
/** Model-space light: from above, a little from the front-left. */
const LIGHT = new THREE.Vector3(-0.3, 0.4, 0.86).normalize();

export interface LivePassOptions {
  glyphs: Readonly<Record<string, MapLiveGlyph>>;
  models: Readonly<Record<string, MapLiveModel>>;
  /** The points to draw this frame (the 2D layer's own sample). */
  points: () => readonly MapLivePoint[];
  /**
   * The height the map draws its ground at, in metres, or `null` on a flat
   * map — the 3D terrain's elevation. Things on the ground stand on it; an
   * aircraft's height above sea level is compared with it.
   */
  groundAt?: () => ((longitude: number, latitude: number) => number) | null;
  requestRepaint: () => void;
}

export type LivePass = CityPass;

interface Batch {
  mesh: THREE.InstancedMesh;
  capacity: number;
}

/** A model's geometry with its livery and a baked soft light. */
function geometryOf(model: MapLiveModel, detail: 'near' | 'far'): THREE.BufferGeometry {
  const built = buildLiveModel(model, detail);
  const colors = new Float32Array(built.colors.length);
  const n = new THREE.Vector3();
  for (let i = 0; i < built.colors.length; i += 3) {
    n.set(
      built.normals[i] as number,
      built.normals[i + 1] as number,
      built.normals[i + 2] as number,
    );
    const shade = 0.58 + 0.42 * Math.max(0, n.dot(LIGHT)) + 0.08 * Math.max(0, n.z);
    colors[i] = Math.min(1, (built.colors[i] as number) * shade);
    colors[i + 1] = Math.min(1, (built.colors[i + 1] as number) * shade);
    colors[i + 2] = Math.min(1, (built.colors[i + 2] as number) * shade);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(built.positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(built.indices, 1));
  return geometry;
}

export function createLivePass(options: LivePassOptions): LivePass {
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  // Unlit: the light is baked into the vertex colours. Both sides, because
  // the model matrix mirrors y (mercator is south-down).
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const geometries = new Map<string, THREE.BufferGeometry>();
  const batches = new Map<string, Batch>();

  const batch = (
    key: string,
    model: MapLiveModel,
    detail: 'near' | 'far',
    needed: number,
  ): Batch => {
    const id = `${key}|${detail}`;
    const existing = batches.get(id);
    if (existing && existing.capacity >= needed) return existing;
    if (existing) {
      scene.remove(existing.mesh);
      existing.mesh.dispose();
    }
    let geometry = geometries.get(id);
    if (!geometry) {
      geometry = geometryOf(model, detail);
      geometries.set(id, geometry);
    }
    const capacity = Math.max(INITIAL_CAPACITY, 2 ** Math.ceil(Math.log2(Math.max(1, needed))));
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    scene.add(mesh);
    const created = { mesh, capacity };
    batches.set(id, created);
    return created;
  };

  // Stalks: one segment per airborne aircraft, ground → altitude.
  const stalkGeometry = new THREE.BufferGeometry();
  let stalkCapacity = 0;
  const stalkMaterial = new THREE.LineBasicMaterial({
    color: 0x6b7280,
    transparent: true,
    opacity: 0.7,
  });
  const stalks = new THREE.LineSegments(stalkGeometry, stalkMaterial);
  stalks.frustumCulled = false;
  scene.add(stalks);

  const matrix = new THREE.Matrix4();
  const white = new THREE.Color(1, 1, 1);
  const grey = new THREE.Color('#9ca3af');
  const color = new THREE.Color();

  return {
    id: 'live3d',
    render(renderer: THREE.WebGLRenderer, view: CityView) {
      const center = { x: mercatorXFromLng(view.center.lng), y: mercatorYFromLat(view.center.lat) };
      camera.projectionMatrix.fromArray(centeredProjection(view.mercatorToClip, center));
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      const detail = view.zoom >= NEAR_ZOOM ? 'near' : 'far';
      const ground = options.groundAt?.() ?? null;

      // Instances per model, collected first so each batch is sized once.
      const perModel = new Map<
        string,
        { model: MapLiveModel; items: { matrix: number[]; stale: boolean }[] }
      >();
      const stalkPositions: number[] = [];
      for (const point of options.points()) {
        if (point.opacity <= 0 || !point.model) continue;
        const model = options.models[point.model];
        if (!model) continue;
        let entry = perModel.get(point.model);
        if (!entry) {
          entry = { model, items: [] };
          perModel.set(point.model, entry);
        }
        const stale = point.opacity < 1;
        if (model.form === 'aircraft') {
          const { latitude, longitude } = point.coordinate;
          const groundM = ground ? ground(longitude, latitude) : 0;
          const altitude = Math.max(groundM, point.altitude ?? groundM);
          const scale = displayScale(model.carLength, view.zoom, latitude, AIRCRAFT_MIN_PIXELS);
          // The fuselage is centred on z = 0: lift it by its half-height so a parked one sits on its wheels.
          entry.items.push({
            matrix: anchorMatrix(
              {
                longitude,
                latitude,
                altitude: altitude + 2.6 * scale,
                heading: point.heading ?? 0,
                scale,
              },
              center,
            ),
            stale,
          });
          if (altitude - groundM > 30) {
            const top = anchorMatrix(
              { longitude, latitude, altitude, heading: 0, scale: 1 },
              center,
            );
            const groundZ = groundM * mercatorPerMetre(latitude);
            stalkPositions.push(
              top[12] as number,
              top[13] as number,
              groundZ,
              top[12] as number,
              top[13] as number,
              top[14] as number,
            );
          }
          continue;
        }
        const parts = point.parts ?? [
          { coordinate: point.coordinate, heading: point.heading ?? 0 },
        ];
        for (const part of parts) {
          const { latitude, longitude } = part.coordinate;
          entry.items.push({
            matrix: anchorMatrix(
              {
                longitude,
                latitude,
                altitude: ground ? ground(longitude, latitude) : 0,
                heading: part.heading,
                scale: 1,
              },
              center,
            ),
            stale,
          });
        }
      }

      for (const existing of batches.values()) existing.mesh.count = 0;
      for (const [key, { model, items }] of perModel) {
        const { mesh } = batch(key, model, detail, items.length);
        mesh.count = items.length;
        items.forEach((item, index) => {
          matrix.fromArray(item.matrix);
          mesh.setMatrixAt(index, matrix);
          color.copy(item.stale ? grey : white);
          mesh.setColorAt(index, color);
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }

      const stalkCount = stalkPositions.length / 6;
      if (stalkCount * 2 > stalkCapacity) {
        stalkCapacity = Math.max(512, 2 ** Math.ceil(Math.log2(stalkCount * 2)));
        stalkGeometry.setAttribute(
          'position',
          new THREE.BufferAttribute(new Float32Array(stalkCapacity * 3), 3).setUsage(
            THREE.DynamicDrawUsage,
          ),
        );
      }
      const attribute = stalkGeometry.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (attribute) {
        (attribute.array as Float32Array).set(stalkPositions);
        attribute.needsUpdate = true;
      }
      stalkGeometry.setDrawRange(0, stalkCount * 2);

      renderer.render(scene, camera);
    },
    dispose() {
      for (const { mesh } of batches.values()) {
        scene.remove(mesh);
        mesh.dispose();
      }
      batches.clear();
      for (const geometry of geometries.values()) geometry.dispose();
      geometries.clear();
      stalkGeometry.dispose();
      stalkMaterial.dispose();
      material.dispose();
      options.requestRepaint();
    },
  };
}
