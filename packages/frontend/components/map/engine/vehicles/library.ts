/**
 * The model library at runtime: GoWay's one set of vehicles, vessels and
 * people (`lib/map/modelLibrary.ts`, built by `scripts/build-model-library.ts`)
 * loaded into plain three.js geometry that any instanced renderer can draw —
 * city life (`cityLife/lifeRenderer.ts`) and the live layer alike, so neither
 * keeps a model set of its own. Design note: `docs/MODEL_LIBRARY.md`.
 *
 * Each model comes back as two {@link LibraryLod}s, every primitive of a
 * level of detail merged into ONE indexed geometry (one draw per level):
 *
 *  - `position`, `normal` — float metres in the glTF frame (+Y up, front +Z,
 *    +X the model's left, origin on the ground at the footprint's centre).
 *    `vehicles/glsl.ts` → `LIBRARY_FRAME` turns it into a map's x-forward,
 *    y-left, z-up frame in the shader, so the arrays are never copied.
 *  - `color` — linear vertex colour (glass, trim, tyres, clothes, skin); on
 *    the tintable paint, a grey: the shade the paint is multiplied by.
 *  - `paint` — 1 on the tintable body, 0 elsewhere.
 *
 * A person also carries its animation ({@link LibraryAnimation}): every
 * baked frame of its `move` and `idle` clips as absolute positions of the
 * near level's vertices, for a vertex-animation texture
 * ({@link createAnimationTexture}) the shader reads by `gl_VertexID`.
 *
 * Reached only through the three.js chunk (`components/engine3d/lazyChunk.ts`).
 */
import * as THREE from 'three';

import {
  MODEL_LIBRARY_MANIFEST,
  MODEL_LIBRARY_PATH,
  type ModelLibrary,
  type ModelLibraryEntry,
  parseModelLibrary,
} from '@/lib/map/modelLibrary';

import { createGltfLoader } from '../city3d/gltf';

export interface LibraryLod {
  geometry: THREE.BufferGeometry;
  triangles: number;
}

export interface LibraryAnimation {
  /** Vertices per frame (the near level's). */
  vertexCount: number;
  /** Frames, all clips back to back (the manifest's `clips` index into them). */
  frameCount: number;
  /** `frameCount × vertexCount` xyz, glTF frame, metres. */
  positions: Float32Array;
}

export interface LibraryModel {
  entry: ModelLibraryEntry;
  near: LibraryLod;
  far: LibraryLod;
  animation?: LibraryAnimation;
}

export interface LoadModelLibraryOptions {
  /** Where the library is served; the app's own `/models/library` by default. */
  baseUrl?: string;
  /** Load only these keys (all when absent). */
  keys?: readonly string[];
  signal?: AbortSignal;
}

/** Fetch the manifest and the requested models; see the module header. */
export async function loadModelLibrary(
  options: LoadModelLibraryOptions = {},
): Promise<Map<string, LibraryModel>> {
  const base = options.baseUrl ?? MODEL_LIBRARY_PATH;
  const manifestUrl = options.baseUrl ? `${base}/manifest.json` : MODEL_LIBRARY_MANIFEST;
  const response = await fetch(manifestUrl, { credentials: 'omit', signal: options.signal });
  if (!response.ok) throw new Error(`model library manifest ${response.status}`);
  const library: ModelLibrary = parseModelLibrary(await response.json());
  const wanted = options.keys ? new Set(options.keys) : null;
  const entries = library.models.filter((entry) => !wanted || wanted.has(entry.key));
  if (wanted) {
    for (const key of wanted) {
      if (!entries.some((entry) => entry.key === key)) throw new Error(`no library model "${key}"`);
    }
  }
  const models = await Promise.all(
    entries.map(async (entry) => {
      const file = await fetch(`${base}/${entry.file}`, {
        credentials: 'omit',
        signal: options.signal,
      });
      if (!file.ok) throw new Error(`${entry.key}: ${file.status}`);
      const bytes = await file.arrayBuffer();
      // The manifest says how big the file is; anything else is not this build's.
      if (bytes.byteLength !== entry.bytes) throw new Error(`${entry.key}: unexpected size`);
      return parseLibraryModel(entry, bytes);
    }),
  );
  return new Map(models.map((model) => [model.entry.key, model]));
}

/** One library GLB's bytes into a {@link LibraryModel} (also how the tests read them from disk). */
export async function parseLibraryModel(
  entry: ModelLibraryEntry,
  bytes: ArrayBuffer,
): Promise<LibraryModel> {
  const gltf = await createGltfLoader().parseAsync(bytes, '');
  return readModel(entry, gltf.scene);
}

/** Merge one parsed library GLB into {@link LibraryModel}. */
function readModel(entry: ModelLibraryEntry, scene: THREE.Object3D): LibraryModel {
  scene.updateMatrixWorld(true);
  const lod = (name: 'near' | 'far') => {
    // The LOD nodes are the scene's roots (a primitive inside may share the name).
    const node =
      scene.children.find((child) => child.name === name || child.userData.name === name) ??
      scene.getObjectByName(name);
    if (!node) throw new Error(`${entry.key}: no "${name}" node`);
    return mergeLod(entry.key, node);
  };
  const near = lod('near');
  const far = lod('far');
  const model: LibraryModel = {
    entry,
    near: { geometry: near.geometry, triangles: near.triangles },
    far: { geometry: far.geometry, triangles: far.triangles },
  };
  if (entry.clips) {
    const { move, idle } = entry.clips;
    const frameCount = Math.max(move.first + move.count, idle.first + idle.count);
    if (near.frames.length < frameCount) {
      throw new Error(`${entry.key}: ${near.frames.length} frames, clips need ${frameCount}`);
    }
    const vertexCount = near.geometry.attributes.position.count;
    const positions = new Float32Array(frameCount * vertexCount * 3);
    for (let f = 0; f < frameCount; f++) positions.set(near.frames[f], f * vertexCount * 3);
    model.animation = { vertexCount, frameCount, positions };
  }
  return model;
}

/** Every mesh under `node`, merged; morph targets turned into absolute frames. */
function mergeLod(
  key: string,
  node: THREE.Object3D,
): { geometry: THREE.BufferGeometry; triangles: number; frames: Float32Array[] } {
  const meshes: THREE.Mesh[] = [];
  node.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) meshes.push(object as THREE.Mesh);
  });
  if (meshes.length === 0) throw new Error(`${key}: "${node.name}" has no mesh`);
  let vertices = 0;
  let indices = 0;
  let targets = -1;
  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    vertices += geometry.attributes.position.count;
    indices += geometry.index ? geometry.index.count : geometry.attributes.position.count;
    const count = geometry.morphAttributes.position?.length ?? 0;
    if (targets >= 0 && count !== targets) throw new Error(`${key}: primitives disagree on frames`);
    targets = count;
  }
  const position = new Float32Array(vertices * 3);
  const normal = new Float32Array(vertices * 3);
  const color = new Float32Array(vertices * 3);
  const paint = new Float32Array(vertices);
  const index = vertices < 65536 ? new Uint16Array(indices) : new Uint32Array(indices);
  const frames = Array.from({ length: Math.max(targets, 0) }, () => new Float32Array(vertices * 3));
  const v = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();
  const linear = new THREE.Matrix3();
  let base = 0;
  let at = 0;
  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    const material = mesh.material as THREE.Material;
    const isPaint = material.name === 'paint';
    const p = geometry.attributes.position;
    const n = geometry.attributes.normal;
    const c = geometry.attributes.color;
    normalMatrix.getNormalMatrix(mesh.matrixWorld);
    linear.setFromMatrix4(mesh.matrixWorld);
    const relative = geometry.morphTargetsRelative;
    for (let i = 0; i < p.count; i++) {
      const o = (base + i) * 3;
      v.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld);
      position[o] = v.x;
      position[o + 1] = v.y;
      position[o + 2] = v.z;
      if (n) {
        v.fromBufferAttribute(n, i).applyMatrix3(normalMatrix).normalize();
        normal[o] = v.x;
        normal[o + 1] = v.y;
        normal[o + 2] = v.z;
      }
      // On paint the vertex colour is the kit's shade of it (white when flat).
      for (let k = 0; k < 3; k++) color[o + k] = c ? c.getComponent(i, k) : 1;
      paint[base + i] = isPaint ? 1 : 0;
      (geometry.morphAttributes.position ?? []).forEach((target, f) => {
        v.fromBufferAttribute(target, i);
        if (relative) {
          // A delta: scaled like the base, never moved.
          v.applyMatrix3(linear);
          frames[f][o] = position[o] + v.x;
          frames[f][o + 1] = position[o + 1] + v.y;
          frames[f][o + 2] = position[o + 2] + v.z;
        } else {
          v.applyMatrix4(mesh.matrixWorld);
          frames[f][o] = v.x;
          frames[f][o + 1] = v.y;
          frames[f][o + 2] = v.z;
        }
      });
    }
    const source = geometry.index;
    const count = source ? source.count : p.count;
    for (let i = 0; i < count; i++) index[at++] = base + (source ? source.getX(i) : i);
    base += p.count;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(color, 3));
  geometry.setAttribute('paint', new THREE.BufferAttribute(paint, 1));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  for (const mesh of meshes) mesh.geometry.dispose();
  return { geometry, triangles: indices / 3, frames };
}

/**
 * A person's frames as a vertex-animation texture: one row per frame, one
 * texel per vertex (xyz, glTF frame), read with `texelFetch` by `gl_VertexID`.
 */
export function createAnimationTexture(animation: LibraryAnimation): THREE.DataTexture {
  const { vertexCount, frameCount, positions } = animation;
  const data = new Float32Array(vertexCount * frameCount * 4);
  for (let i = 0; i < vertexCount * frameCount; i++) {
    data[i * 4] = positions[i * 3];
    data[i * 4 + 1] = positions[i * 3 + 1];
    data[i * 4 + 2] = positions[i * 3 + 2];
    data[i * 4 + 3] = 1;
  }
  const texture = new THREE.DataTexture(
    data,
    vertexCount,
    frameCount,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
