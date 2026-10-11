/**
 * The city-life renderer: simulated cars and people drawn in the city-3D
 * scene, as one instanced draw per model, placed between the simulation's
 * last two states on the GPU (`lifeShaders.ts`).
 *
 * A {@link CityOverlay} of the city engine — same scene, camera, depth buffer
 * and light as the buildings, so a building occludes a car behind it and the
 * sun lights both alike. Reached only through `components/engine3d/lazyChunk.ts`
 * (it imports three.js), and only when `lib/map/cityLifeFlag.ts` asked for it.
 *
 * ## Time
 *
 * The worker stamps each state with the wall-clock instant it represents
 * (`performance.timeOrigin + now()`, which the two threads share). This draws
 * the city {@link DELAY_MS} in the past, between the two states that bracket
 * that instant, so a late message makes motion momentarily slower rather than
 * jerky, and the step rate never shows.
 *
 * ## Repaint
 *
 * MapLibre draws only when something asks. While agents are on screen this
 * asks for a frame at most every {@link FRAME_MS} (30 fps): the whole map is
 * redrawn each time, so this is the feature's real cost, and halving the rate
 * halves it. With the tab hidden the browser stops animation frames, and the
 * worker is paused too.
 *
 * Every frame shown is SIMULATED; `onActiveChange` is how the host keeps the
 * "Simulated" label on screen for exactly as long as any of it is drawn.
 */
import * as THREE from 'three';

import type { CityLight } from '../city3d/occlusion';
import type { CityOverlay, CityOverlayFrame } from '../city3d/overlay';
import { GROUND, type GroundSampler, gridAt, groundGrid } from '../city3d/terrainGround';
import {
  centeredProjection,
  EARTH_CIRCUMFERENCE_M,
  multiplyMat4,
  tileModelMatrix,
} from '../city3d/tileMath';
import { type ModelGeometry, person, shadowQuad, VEHICLE_MODELS } from './agentModels';
import {
  LIFE_FRAGMENT_SHADER,
  LOD_MIN_PX,
  LIFE_VERTEX_SHADER,
  SHADOW_FRAGMENT_SHADER,
  SHADOW_VERTEX_SHADER,
} from './lifeShaders';
import type {
  SimFrameMessage,
  SimStatsMessage,
  SimWorkerRequest,
  SimWorkerResponse,
} from './protocol';
import { simFrame } from './sim/network';
import type { SimBudget } from './sim/simulation';
import { CAR_MODEL_SPECS, CAR_MODELS, type CarModel } from './sim/traffic';

/** How far behind real time the city is drawn, ms (two simulation steps). */
const DELAY_MS = 100;
/** Fastest repaint the layer asks for while agents are visible. */
const FRAME_MS = 33;
/** Agents are drawn (and simulated) from this zoom up. */
export const CITY_LIFE_MIN_ZOOM = 15.5;
/** The simulation's step, seconds (for the shader's walking pace). */
const STEP_S = 0.05;

export interface CityLifeOptions {
  /** Absolute `{z}/{x}/{y}` template of the road tiles. */
  roadTileTemplate: string;
  budget: SimBudget;
  seed: number;
  requestRepaint: () => void;
  /** Called when agents start or stop being drawn: the host shows the "Simulated" label meanwhile. */
  onActiveChange: (active: boolean) => void;
  /** Development statistics. */
  onStats?: (stats: CityLifeStats) => void;
}

export interface CityLifeStats extends Omit<SimStatsMessage, 'type'> {
  framesPerSecond: number;
  /** Triangles drawn by city life in the last sampled frame, by level of detail. */
  triangles: { near: number; far: number; shadow: number };
}

function geometryFor(model: ModelGeometry): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(model.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(model.normals, 3));
  geometry.setAttribute('part', new THREE.BufferAttribute(model.parts, 1));
  geometry.setIndex(new THREE.BufferAttribute(model.indices, 1));
  return geometry;
}

/**
 * One model's instances: the four instanced attributes, shared by THREE
 * draws over them — the near mesh, the far mesh, and the contact shadow —
 * so an instance is uploaded once and drawn as whichever it should be
 * (`lifeShaders.ts` → level of detail).
 */
interface Batch {
  geometries: THREE.InstancedBufferGeometry[];
  materials: THREE.RawShaderMaterial[];
  prev: THREE.InstancedBufferAttribute;
  curr: THREE.InstancedBufferAttribute;
  style: THREE.InstancedBufferAttribute;
  ground: THREE.InstancedBufferAttribute;
}

export function createCityLife(options: CityLifeOptions): CityOverlay {
  const light = {
    uLightPosition: { value: new THREE.Vector3(0, 0, 1) },
    uLightIntensity: { value: 0.5 },
    uLightColor: { value: new THREE.Vector3(1, 1, 1) },
  };
  const shared = {
    uAlpha: { value: 0 },
    uTime: { value: 0 },
    uStep: { value: STEP_S },
    uPxPerM: { value: 0 },
    uTaxiDoors: { value: new THREE.Vector3(1, 0.8, 0.3) },
  };
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  group.matrixWorldAutoUpdate = false;
  group.visible = false;

  const quad = shadowQuad();
  const makeBatch = (
    lods: { near: ModelGeometry; far: ModelGeometry },
    kind: { person: boolean; taxi: boolean; maxLength: number },
  ): Batch => {
    const empty = () => new THREE.InstancedBufferAttribute(new Float32Array(4), 4);
    const prev = empty();
    const curr = empty();
    const style = new THREE.InstancedBufferAttribute(new Uint8Array(4), 4, true);
    const ground = new THREE.InstancedBufferAttribute(new Float32Array(1), 1);
    for (const attribute of [prev, curr, style, ground]) attribute.setUsage(THREE.DynamicDrawUsage);
    const perModel = {
      uIsPerson: { value: kind.person ? 1 : 0 },
      uIsTaxi: { value: kind.taxi ? 1 : 0 },
      uMaxLength: { value: kind.maxLength },
      uModelLength: { value: lods.near.length },
      uNearSize: { value: kind.person ? 2.6 : lods.near.length },
    };
    const geometries: THREE.InstancedBufferGeometry[] = [];
    const materials: THREE.RawShaderMaterial[] = [];
    const add = (
      geometry: THREE.InstancedBufferGeometry,
      material: THREE.RawShaderMaterial,
      renderOrder: number,
    ) => {
      geometry.setAttribute('aPrev', prev);
      geometry.setAttribute('aCurr', curr);
      geometry.setAttribute('aStyle', style);
      geometry.setAttribute('aGround', ground);
      geometry.instanceCount = 0;
      const mesh = new THREE.Mesh(geometry, material);
      // The engine writes the group's matrix; instances move in the shader,
      // so three's bounds know nothing about where they are: never cull.
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = renderOrder;
      group.add(mesh);
      geometries.push(geometry);
      materials.push(material);
    };
    for (const [lod, model] of [
      [0, lods.near],
      [1, lods.far],
    ] as const) {
      add(
        geometryFor(model),
        new THREE.RawShaderMaterial({
          glslVersion: THREE.GLSL3,
          vertexShader: LIFE_VERTEX_SHADER,
          fragmentShader: LIFE_FRAGMENT_SHADER,
          uniforms: { ...shared, ...light, ...perModel, uLod: { value: lod } },
          // The mirrored model matrix: see `agentModels.ts` and `cityEngine.ts`.
          side: THREE.BackSide,
          blending: THREE.CustomBlending,
          blendSrc: THREE.OneFactor,
          blendDst: THREE.OneMinusSrcAlphaFactor,
          transparent: false,
        }),
        0,
      );
    }
    // The contact shadow, after the opaque city (three draws transparent
    // last), depth-tested so a building in front hides it.
    const shadowGeometry = new THREE.InstancedBufferGeometry();
    shadowGeometry.setAttribute('position', new THREE.BufferAttribute(quad.positions, 3));
    shadowGeometry.setIndex(new THREE.BufferAttribute(quad.indices, 1));
    add(
      shadowGeometry,
      new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: SHADOW_VERTEX_SHADER,
        fragmentShader: SHADOW_FRAGMENT_SHADER,
        uniforms: {
          ...shared,
          ...perModel,
          uLod: { value: 2 },
          uHalfSize: { value: new THREE.Vector2(lods.near.halfLength, lods.near.halfWidth) },
          uShadowStrength: { value: kind.person ? 0.3 : 0.42 },
        },
        side: THREE.DoubleSide,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        transparent: true,
        depthWrite: false,
      }),
      -1,
    );
    return { geometries, materials, prev, curr, style, ground };
  };

  const carBatches = Object.fromEntries(
    CAR_MODELS.map((model) => [
      model,
      makeBatch(
        { near: VEHICLE_MODELS[model]('near'), far: VEHICLE_MODELS[model]('far') },
        { person: false, taxi: model === 'taxi', maxLength: CAR_MODEL_SPECS[model].length[1] },
      ),
    ]),
  ) as Record<CarModel, Batch>;
  const peopleBatch = makeBatch(
    { near: person('near'), far: person('far') },
    { person: true, taxi: false, maxLength: 1 },
  );

  // ── The worker ──
  const worker = new Worker(new URL('./simWorker', import.meta.url));
  const send = (message: SimWorkerRequest) => worker.postMessage(message);
  send({
    type: 'init',
    template: options.roadTileTemplate,
    seed: options.seed,
    budget: options.budget,
  });

  /** The last few states, oldest first. */
  const frames: SimFrameMessage[] = [];
  let uploaded: { a: SimFrameMessage; b: SimFrameMessage } | null = null;
  let disposed = false;
  let active = false;
  /** Whether the last frame wanted agents drawn (zoom, fade), states or not. */
  let wanted = false;
  let paused = false;
  let lastViewKey = '';
  let lastViewSent = 0;
  let repaintTimer: ReturnType<typeof setTimeout> | null = null;
  let drawnFrames = 0;
  let fpsWindowStart = performance.now();
  let fps = 0;
  let triangles = { near: 0, far: 0, shadow: 0 };
  /**
   * Development statistics: the shader's level-of-detail test replayed on the
   * CPU for one frame a second, so the triangle cost is a number, not a guess.
   */
  const countTriangles = (
    frame: SimFrameMessage,
    projection: number[],
    model: ArrayLike<number>,
    pxPerM: number,
  ) => {
    const pm = multiplyMat4(projection, model);
    const out = { near: 0, far: 0, shadow: 0 };
    const tally = (states: Float32Array, from: number, to: number, batch: Batch, size: number) => {
      const nearTris = (batch.geometries[0].index?.count ?? 0) / 3;
      const farTris = (batch.geometries[1].index?.count ?? 0) / 3;
      for (let i = from; i < to; i++) {
        if (states[i * 4 + 3] <= 0) continue;
        const x = states[i * 4];
        const y = states[i * 4 + 1];
        const cx = pm[0] * x + pm[4] * y + pm[12];
        const cy = pm[1] * x + pm[5] * y + pm[13];
        const w = pm[3] * x + pm[7] * y + pm[15];
        const px = ((pxPerM * projection[15]) / Math.max(w, 1e-9)) * size;
        const onScreen = w > 0 && Math.abs(cx) < w * 1.15 && Math.abs(cy) < w * 1.15;
        if (onScreen && px >= LOD_MIN_PX) out.near += nearTris;
        else out.far += farTris;
        out.shadow += 2;
      }
    };
    for (const name of CAR_MODELS) {
      const [from, to] = frame.ranges[name];
      tally(
        frame.cars,
        from,
        to,
        carBatches[name],
        carBatches[name].materials[0].uniforms.uNearSize.value as number,
      );
    }
    tally(frame.people, 0, frame.people.length / 4, peopleBatch, 2.6);
    return out;
  };

  worker.onmessage = (event: MessageEvent<SimWorkerResponse>) => {
    if (disposed) return;
    const message = event.data;
    if (message.type === 'stats') {
      const { type: _type, ...rest } = message;
      options.onStats?.({ ...rest, framesPerSecond: fps, triangles });
      return;
    }
    frames.push(message);
    if (frames.length > 4) frames.shift();
    // The map draws only when asked: the first state must ask for the frame
    // that will show it.
    schedule();
  };

  const schedule = () => {
    if (disposed || repaintTimer || !wanted) return;
    repaintTimer = setTimeout(() => {
      repaintTimer = null;
      if (!disposed && wanted) options.requestRepaint();
    }, FRAME_MS);
  };

  const setActive = (next: boolean) => {
    if (next === active) return;
    active = next;
    group.visible = next;
    options.onActiveChange(next);
    const pause = !next;
    if (pause !== paused) {
      paused = pause;
      send({ type: pause ? 'pause' : 'resume' });
    }
    if (next) schedule();
  };

  const onVisibility = () => {
    if (typeof document === 'undefined') return;
    const hidden = document.visibilityState === 'hidden';
    if (hidden && !paused) {
      paused = true;
      send({ type: 'pause' });
    } else if (!hidden && paused && active) {
      paused = false;
      send({ type: 'resume' });
    }
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);

  // ── Terrain: each agent stands on the ground the buildings and trees do ──
  //
  // Not the raw sampler: the drawn terrain is a SURFACE model that reads roof
  // tops, so `terrainGround.ts` opens it (`groundGrid`) into the ground under
  // the blocks, per tile, and buildings and trees read that grid. Cars and
  // people read the same grid — z15 tiles, the city tiles' own — bilinearly.
  let sampler: GroundSampler | null = null;
  const grids = new Map<string, Float32Array>();
  let groundOrigin = '';
  /** Fresh grids built per upload at most; the rest wait (and read the raw sample meanwhile). */
  const GRIDS_PER_UPLOAD = 4;
  let gridBudget = 0;
  const groundAt = (origin: { x: number; y: number }, x: number, y: number): number => {
    if (!sampler) return 0;
    const tileM = 4096 * simFrame(origin.x, origin.y).metresPerUnit;
    const fx = origin.x + x / tileM;
    const fy = origin.y - y / tileM;
    const tx = Math.floor(fx);
    const ty = Math.floor(fy);
    const key = `${tx}/${ty}`;
    let grid = grids.get(key);
    if (!grid && gridBudget > 0) {
      gridBudget--;
      grid = groundGrid({ z: 15, x: tx, y: ty }, sampler);
      grids.set(key, grid);
    }
    if (grid) return gridAt(grid, GROUND.grid, fx - tx, fy - ty);
    const n = 2 ** 15;
    const lat = (360 / Math.PI) * Math.atan(Math.exp(Math.PI * (1 - (2 * fy) / n))) - 90;
    const value = sampler((fx / n) * 360 - 180, lat);
    return Number.isFinite(value) ? value : 0;
  };
  const groundFor = (batch: Batch, curr: Float32Array, origin: { x: number; y: number }) => {
    const count = curr.length / 4;
    let values = batch.ground.array as Float32Array;
    if (values.length !== count) {
      values = new Float32Array(count);
      batch.ground = new THREE.InstancedBufferAttribute(values, 1);
      batch.ground.setUsage(THREE.DynamicDrawUsage);
      for (const geometry of batch.geometries) geometry.setAttribute('aGround', batch.ground);
    }
    if (!sampler) {
      if (values[0] !== 0 || values[count - 1] !== 0) values.fill(0);
    } else {
      for (let i = 0; i < count; i++) {
        values[i] = curr[i * 4 + 3] > 0 ? groundAt(origin, curr[i * 4], curr[i * 4 + 1]) : 0;
      }
    }
    batch.ground.needsUpdate = true;
  };

  const upload = (
    batch: Batch,
    a: Float32Array,
    b: Float32Array,
    style: Uint8Array,
    from: number,
    to: number,
  ) => {
    const prev = a.subarray(from * 4, to * 4);
    const curr = b.subarray(from * 4, to * 4);
    const paint = style.subarray(from * 4, to * 4);
    if (batch.prev.array.length !== prev.length) {
      // A GL buffer keeps the size it was created with: a new length needs new
      // attributes (once, on the first state — capacities are fixed after that).
      batch.prev = new THREE.InstancedBufferAttribute(prev, 4);
      batch.curr = new THREE.InstancedBufferAttribute(curr, 4);
      batch.style = new THREE.InstancedBufferAttribute(paint, 4, true);
      for (const attribute of [batch.prev, batch.curr, batch.style]) {
        attribute.setUsage(THREE.DynamicDrawUsage);
      }
      for (const geometry of batch.geometries) {
        geometry.setAttribute('aPrev', batch.prev);
        geometry.setAttribute('aCurr', batch.curr);
        geometry.setAttribute('aStyle', batch.style);
      }
    } else {
      batch.prev.array = prev;
      batch.curr.array = curr;
      batch.style.array = paint;
      batch.prev.needsUpdate = true;
      batch.curr.needsUpdate = true;
      batch.style.needsUpdate = true;
    }
    for (const geometry of batch.geometries) geometry.instanceCount = to - from;
  };

  const overlay: CityOverlay = {
    attach(scene) {
      scene.add(group);
    },

    update({ view, center, opacity }: CityOverlayFrame) {
      if (disposed) return;
      const on = opacity > 0 && view.zoom >= CITY_LIFE_MIN_ZOOM;
      wanted = on;
      // Tell the simulation where the camera is (throttled; it only moves agents).
      const key = `${view.center.lng.toFixed(5)},${view.center.lat.toFixed(5)},${view.zoom.toFixed(2)}`;
      const t = performance.now();
      if (key !== lastViewKey && t - lastViewSent > 150) {
        lastViewKey = key;
        lastViewSent = t;
        send({
          type: 'view',
          center: { lng: view.center.lng, lat: view.center.lat },
          zoom: view.zoom,
          bounds: view.bounds,
        });
      }
      setActive(on && frames.length > 0);
      if (!on || frames.length === 0) return;

      // The two states around "now − DELAY".
      const renderTime = performance.timeOrigin + performance.now() - DELAY_MS;
      let a = frames[0];
      let b = frames[0];
      for (let i = frames.length - 1; i >= 0; i--) {
        if (frames[i].time <= renderTime) {
          a = frames[i];
          b = frames[Math.min(i + 1, frames.length - 1)];
          break;
        }
      }
      if (a.origin.x !== b.origin.x || a.origin.y !== b.origin.y) a = b;
      if (!uploaded || uploaded.a !== a || uploaded.b !== b) {
        uploaded = { a, b };
        const originKey = `${b.origin.x}/${b.origin.y}`;
        // The DEM sharpens as its tiles load: re-sample now and then.
        // New terrain arrives through `setGround`, which drops the grids.
        if (originKey !== groundOrigin) {
          grids.clear();
          groundOrigin = originKey;
        }
        gridBudget = GRIDS_PER_UPLOAD;
        for (const model of CAR_MODELS) {
          const [from, to] = b.ranges[model];
          upload(carBatches[model], a.cars, b.cars, b.carStyle, from, to);
          groundFor(carBatches[model], b.cars.subarray(from * 4, to * 4), b.origin);
        }
        upload(peopleBatch, a.people, b.people, b.peopleStyle, 0, b.people.length / 4);
        groundFor(peopleBatch, b.people, b.origin);
      }
      const span = b.time - a.time;
      shared.uAlpha.value = span > 0 ? Math.max(0, Math.min(1, (renderTime - a.time) / span)) : 1;
      shared.uTime.value = (t / 1000) % 3600;
      // CSS pixels per metre at the centre: 512-px tiles, mercator's 1/cos(lat).
      shared.uPxPerM.value =
        (512 * 2 ** view.zoom) /
        (EARTH_CIRCUMFERENCE_M * Math.cos((view.center.lat * Math.PI) / 180));
      if (b.taxiDoors) {
        shared.uTaxiDoors.value.set(
          b.taxiDoors[0] / 255,
          b.taxiDoors[1] / 255,
          b.taxiDoors[2] / 255,
        );
      }

      group.matrixWorld.fromArray(tileModelMatrix({ z: 15, x: b.origin.x, y: b.origin.y }, center));
      for (const child of group.children) child.matrixWorld.copy(group.matrixWorld);

      drawnFrames++;
      if (t - fpsWindowStart > 1000) {
        fps = Math.round((drawnFrames * 1000) / (t - fpsWindowStart));
        drawnFrames = 0;
        fpsWindowStart = t;
        if (options.onStats) {
          triangles = countTriangles(
            b,
            centeredProjection(view.mercatorToClip, center),
            group.matrixWorld.elements,
            shared.uPxPerM.value,
          );
        }
      }
      schedule();
    },

    setGround(next) {
      sampler = next;
      grids.clear();
      uploaded = null;
    },

    setLight(next: CityLight) {
      light.uLightPosition.value.set(...next.position);
      light.uLightIntensity.value = next.intensity;
      light.uLightColor.value.set(...next.color);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (repaintTimer) clearTimeout(repaintTimer);
      worker.terminate();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
      if (active) options.onActiveChange(false);
      group.removeFromParent();
      for (const batch of [...Object.values(carBatches), peopleBatch]) {
        for (const geometry of batch.geometries) geometry.dispose();
        for (const material of batch.materials) material.dispose();
      }
    },
  };
  return overlay;
}
