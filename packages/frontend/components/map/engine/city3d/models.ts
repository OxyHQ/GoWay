/**
 * Coordinate-anchored 3D models in the city scene — phase 1 of
 * `docs/SDK_MAP_MODELS.md` (web).
 *
 * Part of the ONE three.js engine the map has (`cityEngine.ts`): the same
 * renderer, the same custom layer, the same frame, the same depth buffer. It
 * is reached only through the city engine, which is reached only through
 * `components/engine3d/lazyChunk.ts`, so a map with no models and no city
 * downloads none of it (`components/__tests__/engine3dChunk.test.ts`).
 *
 * ## Frames
 *
 *  - **Asset:** glTF's own — metres, +Y up, front +Z, origin at the base
 *    centre, which is the anchor. glTF's +X is therefore the model's LEFT.
 *  - **Placement:** `heading` clockwise from north about up, then `pitch`
 *    about the model's right axis (nose up +), then `roll` about its forward
 *    axis (right side down +), all in local East-North-Up — the contract's
 *    `modelPlacementSchema`.
 *  - **World (this module's scene):** mercator units relative to the camera
 *    centre, but with `y` pointing NORTH. The city's tiles use MapLibre's
 *    y-south directly and pay for it with a mirrored model matrix, which three
 *    then mis-culls (`cityEngine.ts` draws `BackSide` to compensate). For
 *    models — arbitrary glTF with three's own lit materials, whose normals and
 *    culling three must get right without help — the mirror goes into the
 *    CAMERA instead (`y → −y` folded into the projection), so every model
 *    matrix is a proper rotation and the materials need no special-casing.
 *    That is why models are drawn with their own camera: one renderer, one
 *    frame, one depth buffer, two `render` calls.
 *
 * ## Occlusion
 *
 * `occlusion: 'buildings'` (the default) depth-tests against everything
 * already in the map's depth buffer — `fill-extrusion` buildings when MapLibre
 * draws them (the layer sits directly before `building-3d`, and both share
 * MapLibre's 3D depth), the city meshes when the city engine does. `'none'`
 * draws over everything.
 *
 * ## Budgets (the note's, enforced here)
 *
 * A file over {@link MAX_MODEL_FILE_BYTES} or {@link MAX_MODEL_TRIANGLES}, an
 * asset past the {@link MAX_DISTINCT_ASSETS}th, an instance past the
 * {@link MAX_MODEL_INSTANCES}th, and a URL that is not HTTPS (or this page's
 * own origin, or loopback in development) are refused, and that model is
 * reported as `fallback` — drawn by `MapCanvas` as its marker instead.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { ModelPlacement } from '@goway.to/sdk';

import type { CityLight } from './occlusion';
import type { GroundSampler } from './terrainGround';
import {
  centeredProjection,
  type MercatorPoint,
  mercatorPerMetre,
  mercatorXFromLng,
  mercatorYFromLat,
} from './tileMath';

/** A file larger than this is refused before it is parsed. */
export const MAX_MODEL_FILE_BYTES = 2 * 1024 * 1024;
/** A model with more triangles than this is refused after parsing. */
export const MAX_MODEL_TRIANGLES = 50_000;
/** Distinct assets per map. */
export const MAX_DISTINCT_ASSETS = 20;
/** Drawn instances per map. */
export const MAX_MODEL_INSTANCES = 300;

/** One model as the engine receives it: the canvas has already validated and resolved it. */
export interface ModelSpec {
  id: string;
  /** Absolute URL of a GLB. */
  url: string;
  placement: ModelPlacement;
  sizing: { mode: 'world' } | { mode: 'screen'; heightPx: number };
  minZoom: number;
  maxZoom: number;
  occlusion: 'buildings' | 'none';
  tint?: string;
}

export type ModelStatus = 'drawn' | 'fallback';

/** What the host knows about its camera this frame (a subset of `CityView`). */
export interface ModelView {
  mercatorToClip: ArrayLike<number>;
  zoom: number;
  center: { lng: number; lat: number };
}

export interface ModelLayer {
  setModels(specs: readonly ModelSpec[]): void;
  /** Move one model without re-sending the set (a vehicle, every frame). */
  setPlacement(id: string, placement: ModelPlacement): void;
  setLight(light: CityLight): void;
  /** Draw. The caller has reset three's GL state. */
  render(
    renderer: THREE.WebGLRenderer,
    view: ModelView,
    canvas: { width: number; height: number },
  ): void;
  /** The model under a CSS-pixel point of the last frame, by its bounds. */
  pick(point: { x: number; y: number }): string | null;
  /**
   * Where each drawn model's anchor landed on screen in the last frame, CSS
   * px — for the alignment check against the host's own projection.
   */
  anchors(): Array<{ id: string; lng: number; lat: number; x: number; y: number }>;
  /**
   * The drawn ground (`terrainGround.ts`), or `null` on a flat map. A
   * placement's altitude is metres above the DRAWN ground (`@goway.to/sdk` →
   * `ModelPlacement`), so on 3D terrain each model stands on the hill under
   * it rather than at sea level inside it.
   */
  setGround(sample: GroundSampler | null): void;
  /** Whether anything could draw (lets the engine skip the pass). */
  readonly active: boolean;
  dispose(): void;
}

interface Asset {
  scene: THREE.Group;
  /** Bounds in the asset's own metres. */
  bounds: THREE.Box3;
  animations: THREE.AnimationClip[];
}

interface Instance {
  spec: ModelSpec;
  root: THREE.Group;
  /** Bounds of the asset, cached for sizing and picking. */
  bounds: THREE.Box3;
  mixer: THREE.AnimationMixer | null;
  status: ModelStatus;
  /** Screen rectangle of the last frame, CSS px; `null` when not drawn. */
  rect: { left: number; top: number; right: number; bottom: number } | null;
  /** The anchor's screen position in the last frame, CSS px. */
  anchor: { x: number; y: number } | null;
}

/** Is this a URL the model layer may fetch? HTTPS, this page's origin, or loopback. */
export function isAllowedModelUrl(url: string, pageOrigin: string | null): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url, pageOrigin ?? undefined);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  if (pageOrigin && parsed.origin === pageOrigin) return true;
  if (parsed.protocol !== 'http:') return false;
  return ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
}

/**
 * glTF (X left, Y up, Z front) → local ENU at heading 0 (front north):
 * X → west, Y → up, Z → north. A proper rotation (determinant +1).
 */
// biome-ignore format: a 4×4 matrix reads as four rows (`Matrix4.set` is row-major).
const GLTF_TO_ENU = new THREE.Matrix4().set(
  -1, 0, 0, 0,
  0, 0, 1, 0,
  0, 1, 0, 0,
  0, 0, 0, 1,
);

const DEG = Math.PI / 180;

/**
 * The model matrix in the module's world (centre-relative mercator, y north),
 * in float64 until three copies it. Exported for the alignment test.
 */
export function modelMatrix(
  placement: ModelPlacement,
  center: MercatorPoint,
  scale: number,
  /** The drawn ground under the model, in metres (0 on a flat map). */
  groundM = 0,
): THREE.Matrix4 {
  const { latitude, longitude } = placement.position;
  const k = mercatorPerMetre(latitude);
  let dx = mercatorXFromLng(longitude) - center.x;
  // The nearest world copy: a model just across the antimeridian is beside
  // the camera, not a whole world away.
  dx -= Math.round(dx);
  const dy = mercatorYFromLat(latitude) - center.y;
  const { heading, pitch, roll } = placement.orientation;
  const rotation = new THREE.Matrix4()
    .makeRotationZ(-heading * DEG)
    .multiply(new THREE.Matrix4().makeRotationX(pitch * DEG))
    .multiply(new THREE.Matrix4().makeRotationY(roll * DEG));
  return new THREE.Matrix4()
    .makeTranslation(dx, -dy, (placement.altitude.meters + groundM) * k)
    .multiply(new THREE.Matrix4().makeScale(k, k, k))
    .multiply(rotation)
    .multiply(GLTF_TO_ENU)
    .multiply(new THREE.Matrix4().makeScale(scale, scale, scale));
}

/** The models' camera: the host projection with the centre folded in and y flipped north. */
export function modelProjection(view: ModelView): { matrix: THREE.Matrix4; center: MercatorPoint } {
  const center = { x: mercatorXFromLng(view.center.lng), y: mercatorYFromLat(view.center.lat) };
  const projection = new THREE.Matrix4().fromArray(centeredProjection(view.mercatorToClip, center));
  return { matrix: projection.multiply(new THREE.Matrix4().makeScale(1, -1, 1)), center };
}

function countTriangles(object: THREE.Object3D): number {
  let triangles = 0;
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry;
    triangles += (geometry.index?.count ?? geometry.attributes.position?.count ?? 0) / 3;
  });
  return triangles;
}

/**
 * Any CSS colour as three's colour, through the browser's own parser.
 *
 * A tint is a CSS colour (the doc's contract), and a theme hands over whatever
 * its tokens are — `oklch(…)`, `color(display-p3 …)`, a named colour — most of
 * which `THREE.Color` cannot parse (it warns and keeps WHITE, which is how the
 * first vehicle came out uncoloured). Painting one pixel and reading it back
 * is the parser every browser already has; the result is sRGB bytes.
 */
function cssColour(css: string): THREE.Color | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = '#000';
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
}

/** Recolour the materials named `paint…`, as munim-maps does, on a private copy. */
function applyTint(root: THREE.Object3D, tint: string): void {
  const colour = cssColour(tint);
  if (!colour) return;
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    // The instance's materials are already its own (`instanceBody`).
    const recolour = (material: THREE.Material) => {
      if (!/^paint/i.test(material.name)) return material;
      const paint = material as THREE.MeshStandardMaterial;
      if (paint.color) paint.color.copy(colour);
      return material;
    };
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(recolour)
      : recolour(mesh.material);
  });
}

/**
 * One instance's copy of an asset: shared geometry, but MATERIALS OF ITS OWN.
 *
 * `Object3D.clone` shares materials, and both occlusion (`depthTest`) and tint
 * are material state — so on a shared material the last instance configured
 * decided for every other instance of the same GLB (PR #123 review). Each
 * material is cloned once per instance (keeping sharing WITHIN the instance)
 * and freed with it ({@link disposeInstanceBody}); geometry stays shared and
 * is freed with the asset.
 */
function instanceBody(source: THREE.Object3D): THREE.Object3D {
  const body = source.clone(true);
  const copies = new Map<THREE.Material, THREE.Material>();
  const own = (material: THREE.Material) => {
    let copy = copies.get(material);
    if (!copy) {
      copy = material.clone();
      copies.set(material, copy);
    }
    return copy;
  };
  body.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(own) : own(mesh.material);
  });
  return body;
}

function disposeInstanceBody(body: THREE.Object3D): void {
  body.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      material.dispose();
    }
  });
}

function setDepthTest(root: THREE.Object3D, depthTest: boolean): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      material.depthTest = depthTest;
    }
    mesh.renderOrder = depthTest ? 0 : 1;
    // Placement is the engine's; three must not cull with its own idea of
    // where a model is (its frustum is built from the same matrices, but a
    // bounding sphere in metres under a 1e-8 scale is not worth trusting).
    mesh.frustumCulled = false;
  });
}

/**
 * A response body, read with a running byte cap: the read is cancelled the
 * moment it passes `cap`. A `Content-Length` is a claim — absent on chunked
 * responses, and free to understate — so the budget is enforced on the bytes
 * that actually arrive rather than after buffering all of them (PR #123
 * review).
 */
export async function readCapped(response: Response, cap: number): Promise<ArrayBuffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > cap) throw new Error('model file over budget');
    return buffer;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw new Error('model file over budget');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

export interface ModelLayerOptions {
  requestRepaint: () => void;
  onStatus: (id: string, status: ModelStatus) => void;
  /** Where relative URLs resolve and which origin counts as "this page". */
  pageOrigin: string | null;
}

export function createModelLayer(options: ModelLayerOptions): ModelLayer {
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  const hemisphere = new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.6);
  // Hemisphere "up" is the world's +z here (mercator, y north, z up).
  hemisphere.position.set(0, 0, 1);
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(0.3, -0.5, 0.8);
  scene.add(hemisphere, sun, sun.target);

  const loader = new GLTFLoader();
  const assets = new Map<string, Promise<Asset>>();
  const instances = new Map<string, Instance>();
  const pending = new Map<string, { spec: ModelSpec }>();
  let lastFrame = 0;
  let disposed = false;
  let lastProjection: THREE.Matrix4 | null = null;
  let ground: GroundSampler | null = null;

  const report = (instance: Instance, status: ModelStatus) => {
    if (instance.status === status) return;
    instance.status = status;
    options.onStatus(instance.spec.id, status);
  };

  const loadAsset = (url: string): Promise<Asset> => {
    const cached = assets.get(url);
    if (cached) return cached;
    if (assets.size >= MAX_DISTINCT_ASSETS) {
      return Promise.reject(new Error(`more than ${MAX_DISTINCT_ASSETS} distinct model assets`));
    }
    const promise = (async () => {
      if (!isAllowedModelUrl(url, options.pageOrigin)) throw new Error('model URL is not HTTPS');
      // No credentials: a model URL must never be able to carry a session.
      const response = await fetch(url, { credentials: 'omit' });
      if (!response.ok) throw new Error(`model ${response.status}`);
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > MAX_MODEL_FILE_BYTES) throw new Error('model file over budget');
      const buffer = await readCapped(response, MAX_MODEL_FILE_BYTES);
      const gltf = await new Promise<GLTF>((resolve, reject) =>
        loader.parse(buffer, '', resolve, reject),
      );
      const triangles = countTriangles(gltf.scene);
      if (triangles > MAX_MODEL_TRIANGLES) throw new Error('model over the triangle budget');
      const bounds = new THREE.Box3().setFromObject(gltf.scene);
      return { scene: gltf.scene, bounds, animations: gltf.animations };
    })();
    assets.set(url, promise);
    return promise;
  };

  const instantiate = (spec: ModelSpec, asset: Asset): Instance => {
    const root = new THREE.Group();
    const body = instanceBody(asset.scene);
    if (spec.tint) applyTint(body, spec.tint);
    setDepthTest(body, spec.occlusion !== 'none');
    root.add(body);
    root.matrixAutoUpdate = false;
    root.visible = false;
    scene.add(root);
    let mixer: THREE.AnimationMixer | null = null;
    // The first clip loops, as in munim-maps.
    if (asset.animations[0]) {
      mixer = new THREE.AnimationMixer(body);
      mixer.clipAction(asset.animations[0]).play();
    }
    return {
      spec,
      root,
      bounds: asset.bounds.clone(),
      mixer,
      status: 'fallback',
      rect: null,
      anchor: null,
    };
  };

  const remove = (id: string) => {
    const instance = instances.get(id);
    if (!instance) return;
    scene.remove(instance.root);
    instance.mixer?.stopAllAction();
    disposeInstanceBody(instance.root);
    instances.delete(id);
    // Whoever was told "drawn" must hear it is not any more: the canvas keeps
    // a set of drawn ids, and an id re-added later would otherwise start out
    // with no marker while its asset loads (PR #123 review).
    if (!disposed && instance.status === 'drawn') options.onStatus(id, 'fallback');
  };

  const layer: ModelLayer = {
    get active() {
      return instances.size > 0;
    },

    setModels(specs) {
      // Only the first MAX_MODEL_INSTANCES are drawn. An id past the cap is
      // dropped like an absent one — including one that WAS drawn before a
      // reorder pushed it past (PR #123 review) — and stays its marker.
      const drawable = specs.slice(0, MAX_MODEL_INSTANCES);
      const wanted = new Set(drawable.map((s) => s.id));
      for (const id of [...instances.keys()]) if (!wanted.has(id)) remove(id);
      for (const id of [...pending.keys()]) if (!wanted.has(id)) pending.delete(id);
      for (const spec of specs.slice(MAX_MODEL_INSTANCES)) {
        if (!wanted.has(spec.id)) options.onStatus(spec.id, 'fallback');
      }

      drawable.forEach((spec) => {
        const existing = instances.get(spec.id);
        if (
          existing &&
          existing.spec.url === spec.url &&
          existing.spec.tint === spec.tint &&
          existing.spec.occlusion === spec.occlusion
        ) {
          existing.spec = spec;
          return;
        }
        if (existing) remove(spec.id);
        const queued = pending.get(spec.id);
        if (queued && queued.spec.url === spec.url) {
          // Already loading this asset: keep the load, take the newer spec.
          queued.spec = spec;
          return;
        }
        // The entry is the load's identity; `setPlacement` updates its spec in
        // place (a vehicle moves every frame while its asset downloads), and the
        // load lands with whatever the latest placement is.
        const entry = { spec };
        pending.set(spec.id, entry);
        loadAsset(spec.url).then(
          (asset) => {
            if (disposed || pending.get(spec.id) !== entry) return;
            pending.delete(spec.id);
            instances.set(spec.id, instantiate(entry.spec, asset));
            options.requestRepaint();
          },
          (cause: unknown) => {
            if (disposed || pending.get(spec.id) !== entry) return;
            pending.delete(spec.id);
            // A failed load costs that model: its marker stays.
            if (typeof __DEV__ !== 'undefined' && __DEV__)
              console.warn(`[goway/map] model "${spec.id}" not drawn: ${String(cause)}`);
            options.onStatus(spec.id, 'fallback');
          },
        );
      });
      options.requestRepaint();
    },

    setPlacement(id, placement) {
      const instance = instances.get(id);
      if (instance) instance.spec = { ...instance.spec, placement };
      const queued = pending.get(id);
      if (queued) queued.spec = { ...queued.spec, placement };
      options.requestRepaint();
    },

    setLight(light) {
      // ENU toward the light; this world is y-north too, so it carries over.
      const [x, y, z] = light.position;
      sun.position.set(x, y, Math.max(0.05, z));
      sun.color.setRGB(...light.color);
      // MapLibre's intensity darkens unlit faces; keep the same feel: a dim
      // sky lets the sun do more of the shaping.
      hemisphere.intensity = 1.2 + (1 - light.intensity) * 0.8;
      options.requestRepaint();
    },

    render(renderer, view, canvas) {
      if (disposed || instances.size === 0) return;
      const { matrix, center } = modelProjection(view);
      camera.projectionMatrix.copy(matrix);
      camera.projectionMatrixInverse.copy(matrix).invert();
      lastProjection = matrix;

      const now = performance.now();
      const delta = lastFrame > 0 ? (now - lastFrame) / 1000 : 0;
      lastFrame = now;
      let animating = false;
      const corner = new THREE.Vector3();
      for (const instance of instances.values()) {
        const { spec } = instance;
        const inWindow = view.zoom >= spec.minZoom && view.zoom <= spec.maxZoom;
        if (!inWindow) {
          instance.root.visible = false;
          instance.rect = null;
          report(instance, 'fallback');
          continue;
        }
        // One read of the drawn ground per model per frame (~0.5 µs): a
        // vehicle moving every frame stays on the road as the road climbs.
        const groundM = ground
          ? ground(spec.placement.position.longitude, spec.placement.position.latitude)
          : 0;
        let scale = spec.placement.scale;
        if (spec.sizing.mode === 'screen') {
          // Pixels per metre at the anchor, measured through this frame's own
          // projection, so a pitched camera sizes a far model correctly.
          const unit = modelMatrix(spec.placement, center, 1, groundM);
          const origin = new THREE.Vector3(0, 0, 0).applyMatrix4(unit).applyMatrix4(matrix);
          const east = new THREE.Vector3(-1, 0, 0).applyMatrix4(unit).applyMatrix4(matrix);
          const north = new THREE.Vector3(0, 0, 1).applyMatrix4(unit).applyMatrix4(matrix);
          const px = (v: THREE.Vector3) => ({
            x: (v.x * canvas.width) / 2,
            y: (v.y * canvas.height) / 2,
          });
          const o = px(origin);
          const e = px(east);
          const n = px(north);
          const perMetre = Math.max(
            Math.hypot(e.x - o.x, e.y - o.y),
            Math.hypot(n.x - o.x, n.y - o.y),
          );
          const height = Math.max(0.01, instance.bounds.max.y - instance.bounds.min.y);
          if (perMetre > 0 && Number.isFinite(perMetre)) {
            scale = Math.max(scale, spec.sizing.heightPx / (height * perMetre));
          }
        }
        instance.root.matrix.copy(modelMatrix(spec.placement, center, scale, groundM));
        instance.root.matrixWorldNeedsUpdate = true;
        instance.root.visible = true;
        if (instance.mixer) {
          instance.mixer.update(delta);
          animating = true;
        }

        // Screen rectangle for picking.
        let left = Number.POSITIVE_INFINITY;
        let top = Number.POSITIVE_INFINITY;
        let right = Number.NEGATIVE_INFINITY;
        let bottom = Number.NEGATIVE_INFINITY;
        let behind = false;
        const { min, max } = instance.bounds;
        for (let i = 0; i < 8; i++) {
          corner.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z);
          corner.applyMatrix4(instance.root.matrix);
          const clip = new THREE.Vector4(corner.x, corner.y, corner.z, 1).applyMatrix4(matrix);
          if (clip.w <= 0) {
            behind = true;
            break;
          }
          const x = ((clip.x / clip.w + 1) / 2) * canvas.width;
          const y = ((1 - clip.y / clip.w) / 2) * canvas.height;
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
        instance.rect = behind ? null : { left, top, right, bottom };
        const a = new THREE.Vector4(0, 0, 0, 1)
          .applyMatrix4(instance.root.matrix)
          .applyMatrix4(matrix);
        instance.anchor =
          a.w > 0
            ? { x: ((a.x / a.w + 1) / 2) * canvas.width, y: ((1 - a.y / a.w) / 2) * canvas.height }
            : null;
        report(instance, 'drawn');
      }
      scene.updateMatrixWorld(true);
      renderer.render(scene, camera);
      if (animating) options.requestRepaint();
    },

    pick(point) {
      if (!lastProjection) return null;
      // Forgiving, as the note asks: a 3 m car on a phone is a small target.
      const slack = 8;
      let best: { id: string; area: number } | null = null;
      for (const instance of instances.values()) {
        const r = instance.rect;
        if (!r || instance.status !== 'drawn') continue;
        if (
          point.x >= r.left - slack &&
          point.x <= r.right + slack &&
          point.y >= r.top - slack &&
          point.y <= r.bottom + slack
        ) {
          const area = (r.right - r.left) * (r.bottom - r.top);
          if (!best || area < best.area) best = { id: instance.spec.id, area };
        }
      }
      return best?.id ?? null;
    },

    setGround(sample) {
      ground = sample;
      options.requestRepaint();
    },

    anchors() {
      const out: Array<{ id: string; lng: number; lat: number; x: number; y: number }> = [];
      for (const instance of instances.values()) {
        if (instance.status !== 'drawn' || !instance.anchor) continue;
        const { latitude, longitude } = instance.spec.placement.position;
        out.push({ id: instance.spec.id, lng: longitude, lat: latitude, ...instance.anchor });
      }
      return out;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const id of [...instances.keys()]) remove(id);
      pending.clear();
      // Geometries and materials of loaded assets.
      for (const promise of assets.values()) {
        promise.then(
          (asset) =>
            asset.scene.traverse((child) => {
              const mesh = child as THREE.Mesh;
              if (!mesh.isMesh) return;
              mesh.geometry.dispose();
              for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
                material.dispose();
            }),
          () => {},
        );
      }
      assets.clear();
    },
  };
  return layer;
}
