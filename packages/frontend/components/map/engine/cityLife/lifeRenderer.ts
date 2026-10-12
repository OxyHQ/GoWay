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
 * animates through the map's ONE animation clock (`perf/animationClock.ts`):
 * the whole map is redrawn on each of its ticks — at the quality profile's
 * `frame.animationHz` (30, 20 or 15) — so this is the feature's real cost,
 * and the clock's rate is its knob. When the clock pauses (tab hidden, or
 * nobody has touched the map for the profile's `idlePauseMs`) the worker
 * pauses with it and the city stands still until the next interaction.
 *
 * Every frame shown is SIMULATED; `onActiveChange` is how the host keeps the
 * "Simulated" label on screen for exactly as long as any of it is drawn.
 */
import * as THREE from 'three';

import type { AnimationClock } from '../../perf/animationClock';
import type { CityLight } from '../city3d/occlusion';
import type { CityOverlay, CityOverlayFrame } from '../city3d/overlay';
import { GROUND, type Ground, gridAt } from '../city3d/terrainGround';
import { metresPerPixel } from '../city3d/lod';
import {
  centeredProjection,
  latFromMercatorY,
  multiplyMat4,
  tileModelMatrix,
} from '../city3d/tileMath';
import { type LibraryLod, type LibraryModel, loadModelLibrary } from '../vehicles/library';
import {
  LIFE_FRAGMENT_SHADER,
  LOD_MIN_PX,
  LIFE_VERTEX_SHADER,
  SHADOW_FRAGMENT_SHADER,
  SHADOW_VERTEX_SHADER,
} from './lifeShaders';
import { getLiveCoverage, type LiveCoverage, subscribeLiveCoverage } from '@/lib/live/coverage';

import { coveredTiles, liveClassesInView, type RealClass } from './realCoverage';
import type {
  SimFrameMessage,
  SimStatsMessage,
  SimWorkerRequest,
  SimWorkerResponse,
} from './protocol';
import { simFrame } from '../roads/roadGraph';
import { type PersonGeometry, person } from './people';
import { CAR_MODEL_SPECS, CAR_MODELS, type CarModel } from './sim/fleet';
import type { SimBudget } from './sim/simulation';

/** How far behind real time the city is drawn, ms (two simulation steps). */
const DELAY_MS = 100;
/** Agents are drawn (and simulated) from this zoom up. */
export const CITY_LIFE_MIN_ZOOM = 15.5;
/** The simulation's step, seconds (for the shader's walking pace). */
const STEP_S = 0.05;

export interface CityLifeOptions {
  /** Absolute `{z}/{x}/{y}` template of the road tiles. */
  roadTileTemplate: string;
  /** The basemap's vector tiles, for roads where no road archive tile exists (`omtRoads.ts`). */
  basemapRoads?: { template: string; zoom: number; sourceLayer: string };
  budget: SimBudget;
  seed: number;
  /** The map's animation clock: frames while agents are drawn, paused with it. */
  clock: AnimationClock;
  /** Called when agents start or stop being drawn: the host shows the "Simulated" label meanwhile. */
  onActiveChange: (active: boolean) => void;
  /** What is simulated and what is live in view, whenever it changes (the label). */
  onLabel?: (content: { simulated: ('cars' | 'buses' | 'people')[]; live: RealClass[] }) => void;
  /** Development statistics. */
  onStats?: (stats: CityLifeStats) => void;
}

export interface CityLifeStats extends Omit<SimStatsMessage, 'type'> {
  framesPerSecond: number;
  /** Triangles drawn by city life in the last sampled frame, by level of detail. */
  triangles: { near: number; far: number; shadow: number };
}

/** An instanced view of a library level: its attributes, shared, never copied. */
function geometryFor(lod: LibraryLod): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry();
  for (const name of ['position', 'normal', 'color', 'paint']) {
    geometry.setAttribute(name, lod.geometry.getAttribute(name));
  }
  geometry.setIndex(lod.geometry.getIndex());
  return geometry;
}

/** An instanced view of a person level (`people.ts`). */
function personGeometryFor(model: PersonGeometry): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(model.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(model.normals, 3));
  geometry.setAttribute('part', new THREE.BufferAttribute(model.parts, 1));
  geometry.setIndex(new THREE.BufferAttribute(model.indices, 1));
  return geometry;
}

/** The unit quad the contact shadow is drawn on, ±1 in x and y. */
function shadowQuad(): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3),
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
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
  /** The model's size for the detail test, m. */
  nearSize: number;
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

  /**
   * One model's batch: its two levels (`near`, `far`), what it is, and its
   * size — width, height, length, metres (a vehicle's as the library built
   * it; a person's nominal).
   */
  const makeBatch = (model: {
    near: THREE.InstancedBufferGeometry;
    far: THREE.InstancedBufferGeometry;
    person: boolean;
    taxi: boolean;
    maxLength: number;
    size: readonly [number, number, number];
  }): Batch => {
    const isPerson = model.person;
    const [width, height, length] = model.size;
    const empty = () => new THREE.InstancedBufferAttribute(new Float32Array(4), 4);
    const prev = empty();
    const curr = empty();
    const style = new THREE.InstancedBufferAttribute(new Uint8Array(4), 4, true);
    const ground = new THREE.InstancedBufferAttribute(new Float32Array(1), 1);
    for (const attribute of [prev, curr, style, ground]) attribute.setUsage(THREE.DynamicDrawUsage);
    const nearSize = isPerson ? 2.6 : length;
    const perModel = {
      uIsPerson: { value: isPerson ? 1 : 0 },
      uIsTaxi: { value: model.taxi ? 1 : 0 },
      // The kit taxi's door panels, between its sills and its waist.
      uDoorBand: { value: new THREE.Vector2(height * 0.15, height * 0.6) },
      uMaxLength: { value: model.maxLength },
      uModelLength: { value: length },
      uNearSize: { value: nearSize },
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
    for (const [lod, level] of [
      [0, model.near],
      [1, model.far],
    ] as const) {
      add(
        level,
        new THREE.RawShaderMaterial({
          glslVersion: THREE.GLSL3,
          vertexShader: LIFE_VERTEX_SHADER,
          fragmentShader: LIFE_FRAGMENT_SHADER,
          uniforms: {
            ...shared,
            ...light,
            ...perModel,
            uLod: { value: lod },
          },
          // The engine's model matrix is mirrored, so three calls the models'
          // outward faces back faces — as with the buildings (`cityEngine.ts`).
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
    add(
      shadowQuad(),
      new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: SHADOW_VERTEX_SHADER,
        fragmentShader: SHADOW_FRAGMENT_SHADER,
        uniforms: {
          ...shared,
          ...perModel,
          uLod: { value: 2 },
          uHalfSize: {
            value: isPerson
              ? new THREE.Vector2(0.45, 0.45)
              : new THREE.Vector2(length / 2, width / 2),
          },
          uShadowStrength: { value: isPerson ? 0.3 : 0.42 },
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
    return { geometries, materials, nearSize, prev, curr, style, ground };
  };

  // People are city life's own (`people.ts`); vehicles come from the library.
  const peopleBatch = makeBatch({
    near: personGeometryFor(person('near')),
    far: personGeometryFor(person('far')),
    person: true,
    taxi: false,
    maxLength: 1,
    size: [0.4, 1.72, 0.3],
  });
  /** Filled once the library has loaded; until then nothing is drawn. */
  let carBatches: Record<CarModel, Batch> | null = null;
  const libraryModels: LibraryModel[] = [];
  loadModelLibrary({ keys: CAR_MODELS.map((model) => `vehicle.${model}`) })
    .then((library) => {
      if (disposed) {
        for (const model of library.values()) {
          model.near.geometry.dispose();
          model.far.geometry.dispose();
        }
        return;
      }
      carBatches = Object.fromEntries(
        CAR_MODELS.map((name) => {
          const model = library.get(`vehicle.${name}`) as LibraryModel;
          libraryModels.push(model);
          return [
            name,
            makeBatch({
              near: geometryFor(model.near),
              far: geometryFor(model.far),
              person: false,
              taxi: name === 'taxi',
              maxLength: CAR_MODEL_SPECS[name].length[1],
              size: model.entry.size,
            }),
          ];
        }),
      ) as Record<CarModel, Batch>;
      uploaded = null;
      // A frame to show the models in, through the clock.
      ticket.setAnimating(wanted);
    })
    .catch((error: unknown) => {
      // Without its models city life draws nothing — and so claims nothing.
      if (!disposed) console.warn('city life: the model library did not load', error);
    });

  // ── The worker ──
  const worker = new Worker(new URL('./simWorker', import.meta.url));
  const send = (message: SimWorkerRequest) => worker.postMessage(message);
  send({
    type: 'init',
    template: options.roadTileTemplate,
    seed: options.seed,
    budget: options.budget,
    fallback: options.basemapRoads,
  });

  // Real first: forward the live layer's FRESH coverage to the simulation
  // (`realCoverage.ts`). With the live layer off it reports nothing.
  let coverage: LiveCoverage = getLiveCoverage();
  let coverageKey = '';
  const unsubscribeCoverage = subscribeLiveCoverage((next) => {
    coverage = next;
    const tiles = coveredTiles(next);
    const key = JSON.stringify(tiles);
    if (key === coverageKey) return;
    coverageKey = key;
    send({ type: 'coverage', tiles });
  });
  let labelKey = '';

  /** The last few states, oldest first. */
  const frames: SimFrameMessage[] = [];
  let uploaded: { a: SimFrameMessage; b: SimFrameMessage } | null = null;
  let disposed = false;
  let active = false;
  /** Whether the last frame wanted agents drawn (zoom, fade), states or not. */
  let wanted = false;
  let paused = false;
  /** Paused because nothing is drawn (zoomed out, faded): the worker idles. */
  let pausedByView = false;
  let lastViewKey = '';
  let lastViewSent = 0;
  let drawnFrames = 0;
  let fpsWindowStart = performance.now();
  let fps = 0;
  let triangles = { near: 0, far: 0, shadow: 0 };

  /** The worker runs while agents are drawn and the clock is not paused. */
  const syncWorker = () => {
    const pause = pausedByView || ticket.paused;
    if (pause === paused || disposed) return;
    paused = pause;
    send({ type: pause ? 'pause' : 'resume' });
  };
  const ticket = options.clock.join('cityLife', syncWorker);

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
    if (!carBatches) return out;
    for (const name of CAR_MODELS) {
      const [from, to] = frame.ranges[name];
      tally(frame.cars, from, to, carBatches[name], carBatches[name].nearSize);
    }
    tally(frame.people, 0, frame.people.length / 4, peopleBatch, peopleBatch.nearSize);
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
    ticket.setAnimating(wanted);
  };

  const setActive = (next: boolean) => {
    if (next === active) return;
    active = next;
    group.visible = next;
    options.onActiveChange(next);
    pausedByView = !next;
    syncWorker();
    ticket.setAnimating(next);
  };

  // ── Terrain: each agent stands on the ground the buildings and trees do ──
  //
  // The engine's ONE ground (`terrainGround.ts` → `Ground`): the grids the
  // buildings and trees stand on — the same cache, so a z15 city tile's grid is
  // sampled once for both — read bilinearly, so an agent agrees with the kerb
  // beside it.
  let ground: Ground | null = null;
  /** Grids not yet sampled that one upload may sample; the rest read the raw sampler meanwhile. */
  const GRIDS_PER_UPLOAD = 4;
  let gridBudget = 0;
  const groundAt = (
    origin: { x: number; y: number },
    tileM: number,
    x: number,
    y: number,
  ): number => {
    if (!ground) return 0;
    const fx = origin.x + x / tileM;
    const fy = origin.y - y / tileM;
    const tile = { z: 15, x: Math.floor(fx), y: Math.floor(fy) };
    if (ground.hasGrid(tile) || gridBudget-- > 0) {
      return gridAt(ground.grid(tile), GROUND.grid, fx - tile.x, fy - tile.y);
    }
    const n = 2 ** 15;
    const value = ground.sample((fx / n) * 360 - 180, latFromMercatorY(fy / n));
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
    if (!ground) {
      if (values[0] !== 0 || values[count - 1] !== 0) values.fill(0);
    } else {
      // Metres per z15 tile at the origin: once per batch, not per agent.
      const tileM = 4096 * simFrame(origin.x, origin.y).metresPerUnit;
      for (let i = 0; i < count; i++) {
        values[i] = curr[i * 4 + 3] > 0 ? groundAt(origin, tileM, curr[i * 4], curr[i * 4 + 1]) : 0;
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
      const ready = carBatches !== null;
      setActive(on && ready && frames.length > 0);
      if (!on || !carBatches || frames.length === 0) {
        ticket.setAnimating(false);
        return;
      }

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
      if (options.onLabel && b !== uploaded?.b) {
        const simulated: ('cars' | 'buses' | 'people')[] = [];
        if (b.inView.cars > 0) simulated.push('cars');
        if (b.inView.buses > 0) simulated.push('buses');
        if (b.inView.people > 0) simulated.push('people');
        const live = liveClassesInView(coverage, view.bounds);
        const key = `${simulated.join()}|${live.join()}`;
        if (key !== labelKey) {
          labelKey = key;
          options.onLabel({ simulated, live });
        }
      }
      if (!uploaded || uploaded.a !== a || uploaded.b !== b) {
        uploaded = { a, b };
        // The DEM sharpens as its tiles load: re-sample now and then.
        // New terrain arrives through `setGround`, which drops the grids.
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
      // CSS pixels per metre at the centre (the LOD's own scale, `lod.ts`).
      shared.uPxPerM.value = 1 / metresPerPixel(view.zoom, view.center.lat);
      if (b.taxiDoors) {
        shared.uTaxiDoors.value.set(
          b.taxiDoors[0] / 255,
          b.taxiDoors[1] / 255,
          b.taxiDoors[2] / 255,
        );
      }

      group.matrixWorld.fromArray(tileModelMatrix({ z: 15, x: b.origin.x, y: b.origin.y }, center));
      for (const child of group.children) child.matrixWorld.copy(group.matrixWorld);
      ticket.setAnimating(true);

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
    },

    setGround(next) {
      ground = next;
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
      ticket.dispose();
      worker.terminate();
      unsubscribeCoverage();
      if (active) options.onActiveChange(false);
      group.removeFromParent();
      for (const batch of [...Object.values(carBatches ?? {}), peopleBatch] as Batch[]) {
        for (const geometry of batch.geometries) geometry.dispose();
        for (const material of batch.materials) material.dispose();
      }
      for (const model of libraryModels) {
        model.near.geometry.dispose();
        model.far.geometry.dispose();
      }
    },
  };
  return overlay;
}
