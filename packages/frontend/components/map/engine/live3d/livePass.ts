/**
 * GoWay Live in 3D: simple shapes for aircraft, ships and transit vehicles,
 * drawn in the city engine's scene pass with the city engine's renderer —
 * aircraft at their REAL altitude, each on a thin stalk to the ground point it
 * is over, so height reads at a glance.
 *
 * "One engine, one scene" (`docs/MAP_3D_CITY.md`): this is not a second
 * renderer. It is a {@link CityPass} — objects the city engine draws with its
 * own `WebGLRenderer`, in a style layer of their own above the buildings
 * (`city3dLayer.web.ts → addPass`), sharing MapLibre's depth buffer, so a
 * building occludes a low aircraft and a bus behind it.
 *
 * Reached only through `components/engine3d/lazyChunk.ts`.
 *
 * ## What is real and what is styling
 *
 * Position, heading and altitude are the feed's (as the feature interpolates
 * them, within its bounds). SIZE is styling: a 40 m aircraft is a dot at z12,
 * so every shape is drawn at least a few dozen pixels long on screen
 * (`displayScale`, {@link MIN_PIXELS}). The shapes are generic — no livery, no type-specific
 * model — because the feed says nothing about what the vehicle looks like.
 * Bike stations stay 2D: they do not move and have no height.
 */
import * as THREE from 'three';

import type { CityPass, CityView } from '../city3d/cityEngine';
import {
  centeredProjection,
  mercatorPerMetre,
  mercatorXFromLng,
  mercatorYFromLat,
} from '../city3d/tileMath';
import type { MapLiveGlyph, MapLivePoint } from '../../types';
import { anchorMatrix, displayScale } from './anchorMath';

/**
 * Smallest on-screen length of each shape, in CSS pixels: an aircraft must
 * read as one from far below, a bus only needs to be a bus beside its glyph.
 */
const MIN_PIXELS: Record<ShapeKey, number> = { aircraft: 30, vessel: 22, vehicle: 12 };
/** Instances per shape before the buffer grows. */
const INITIAL_CAPACITY = 256;

/** Real lengths in metres, for the scale floor. */
const LENGTH_M: Record<ShapeKey, number> = { aircraft: 38, vessel: 120, vehicle: 14 };

type ShapeKey = 'aircraft' | 'vessel' | 'vehicle';

export interface LivePassOptions {
  glyphs: Readonly<Record<string, MapLiveGlyph>>;
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

function shapeOf(glyph: MapLiveGlyph | undefined): ShapeKey | null {
  if (!glyph) return null;
  if (glyph.shape === 'aircraft') return 'aircraft';
  if (glyph.shape === 'boat') return 'vessel';
  if (glyph.shape === 'vehicle' || glyph.shape === 'arrow') return 'vehicle';
  return null;
}

/** Boxes merged into one geometry, with a baked top-light shade per face (no scene lights needed). */
function boxes(
  parts: readonly { size: [number, number, number]; at: [number, number, number] }[],
): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  for (const part of parts) {
    const box = new THREE.BoxGeometry(...part.size);
    box.translate(...part.at);
    const base = positions.length / 3;
    const pos = box.getAttribute('position');
    const normal = box.getAttribute('normal');
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      // Up-facing faces full, sides 78%, down-facing 55%: reads as a solid in any light.
      const nz = normal.getZ(i);
      const shade = nz > 0.5 ? 1 : nz < -0.5 ? 0.55 : 0.78;
      colors.push(shade, shade, shade);
    }
    const index = box.getIndex();
    if (index) for (let i = 0; i < index.count; i++) indices.push(base + index.getX(i));
    box.dispose();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  return geometry;
}

/** Local metres, nose towards +y, wheels/keel at z = 0 (a vehicle) or centred on z = 0 (an aircraft). */
function geometryFor(shape: ShapeKey): THREE.BufferGeometry {
  switch (shape) {
    case 'aircraft':
      return boxes([
        { size: [3.6, 38, 3.8], at: [0, 0, 0] }, // fuselage
        { size: [34, 6, 0.8], at: [0, 1, -0.6] }, // wings
        { size: [12, 3, 0.6], at: [0, -16.5, 0.8] }, // tailplane
        { size: [0.8, 4, 6.5], at: [0, -16.5, 4] }, // fin
      ]);
    case 'vessel':
      return boxes([
        { size: [18, 110, 8], at: [0, 0, 4] }, // hull
        { size: [12, 6, 6], at: [0, 50, 4] }, // bow block (reads as the front)
        { size: [14, 24, 12], at: [0, -30, 14] }, // superstructure aft
      ]);
    case 'vehicle':
      return boxes([
        { size: [2.6, 12, 3.2], at: [0, 0, 1.6] },
        { size: [2.2, 2, 0.6], at: [0, 6, 3.4] }, // front marker
      ]);
  }
}

interface Batch {
  mesh: THREE.InstancedMesh;
  capacity: number;
}

export function createLivePass(options: LivePassOptions): LivePass {
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    // The model matrix mirrors y (mercator is south-down), which flips which
    // winding three calls front; both sides are drawn rather than guessed.
    side: THREE.DoubleSide,
  });
  const geometries = {
    aircraft: geometryFor('aircraft'),
    vessel: geometryFor('vessel'),
    vehicle: geometryFor('vehicle'),
  } satisfies Record<ShapeKey, THREE.BufferGeometry>;
  const batches = new Map<ShapeKey, Batch>();

  const batch = (shape: ShapeKey, needed: number): Batch => {
    const existing = batches.get(shape);
    if (existing && existing.capacity >= needed) return existing;
    if (existing) {
      scene.remove(existing.mesh);
      existing.mesh.dispose();
    }
    const capacity = Math.max(INITIAL_CAPACITY, 2 ** Math.ceil(Math.log2(Math.max(1, needed))));
    const mesh = new THREE.InstancedMesh(geometries[shape], material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    scene.add(mesh);
    const created = { mesh, capacity };
    batches.set(shape, created);
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
  const color = new THREE.Color();
  const grey = new THREE.Color('#9ca3af');

  return {
    id: 'live3d',
    render(renderer: THREE.WebGLRenderer, view: CityView) {
      const center = { x: mercatorXFromLng(view.center.lng), y: mercatorYFromLat(view.center.lat) };
      camera.projectionMatrix.fromArray(centeredProjection(view.mercatorToClip, center));
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

      const byShape: Record<ShapeKey, MapLivePoint[]> = { aircraft: [], vessel: [], vehicle: [] };
      for (const point of options.points()) {
        const shape = shapeOf(options.glyphs[point.glyph]);
        if (shape && point.opacity > 0) byShape[shape].push(point);
      }

      let stalkCount = 0;
      const stalkPositions: number[] = [];
      const ground = options.groundAt?.() ?? null;
      for (const shape of Object.keys(byShape) as ShapeKey[]) {
        const points = byShape[shape];
        const { mesh } = batch(shape, points.length);
        mesh.count = points.length;
        points.forEach((point, index) => {
          // Sea level is the reference both for the feed's altitude and for
          // the terrain's elevation, so an aircraft is placed by its own
          // number and only kept from sinking into a hill; everything else
          // stands on the drawn ground.
          const groundM = ground
            ? ground(point.coordinate.longitude, point.coordinate.latitude)
            : 0;
          const altitude =
            shape === 'aircraft' ? Math.max(groundM, point.altitude ?? groundM) : groundM;
          const scale = displayScale(
            LENGTH_M[shape],
            view.zoom,
            point.coordinate.latitude,
            MIN_PIXELS[shape],
          );
          matrix.fromArray(
            anchorMatrix(
              {
                longitude: point.coordinate.longitude,
                latitude: point.coordinate.latitude,
                // A grounded aircraft sits on its belly's height, not in the tarmac.
                altitude: altitude + (shape === 'aircraft' ? 2.5 * scale : 0),
                heading: point.heading ?? 0,
                scale,
              },
              center,
            ),
          );
          mesh.setMatrixAt(index, matrix);
          // Stale things are drawn grey: the same rule as the 2D glyph's fade.
          color.set(options.glyphs[point.glyph]?.color ?? '#6b7280');
          if (point.opacity < 1) color.lerp(grey, 0.75);
          mesh.setColorAt(index, color);
          if (shape === 'aircraft' && altitude - groundM > 30) {
            const anchor = anchorMatrix(
              {
                longitude: point.coordinate.longitude,
                latitude: point.coordinate.latitude,
                altitude,
                heading: 0,
                scale: 1,
              },
              center,
            );
            // Column 3 is the translation: the aircraft's point and its ground point.
            const groundZ = groundM * mercatorPerMetre(point.coordinate.latitude);
            stalkPositions.push(
              anchor[12],
              anchor[13],
              groundZ,
              anchor[12],
              anchor[13],
              anchor[14],
            );
            stalkCount++;
          }
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }

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
      for (const geometry of Object.values(geometries)) geometry.dispose();
      stalkGeometry.dispose();
      stalkMaterial.dispose();
      material.dispose();
      options.requestRepaint();
    },
  };
}
