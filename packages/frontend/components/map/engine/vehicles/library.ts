/**
 * The model library at runtime: GoWay's one set of vehicles and vessels
 * (`lib/map/modelLibrary.ts`, built by `scripts/build-model-library.ts`)
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
 *  - `color` — linear vertex colour (windows, trim, tyres, lamps); on
 *    the tintable paint, a grey: the shade the paint is multiplied by.
 *  - `paint` — 1 on the tintable body, 0 elsewhere.
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

export interface LibraryModel {
  entry: ModelLibraryEntry;
  near: LibraryLod;
  far: LibraryLod;
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
  return {
    entry,
    near: { geometry: near.geometry, triangles: near.triangles },
    far: { geometry: far.geometry, triangles: far.triangles },
  };
}

/** Every mesh under `node`, merged into one geometry. */
function mergeLod(
  key: string,
  node: THREE.Object3D,
): { geometry: THREE.BufferGeometry; triangles: number } {
  const meshes: THREE.Mesh[] = [];
  node.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) meshes.push(object as THREE.Mesh);
  });
  if (meshes.length === 0) throw new Error(`${key}: "${node.name}" has no mesh`);
  let vertices = 0;
  let indices = 0;
  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    vertices += geometry.attributes.position.count;
    indices += geometry.index ? geometry.index.count : geometry.attributes.position.count;
  }
  const position = new Float32Array(vertices * 3);
  const normal = new Float32Array(vertices * 3);
  const color = new Float32Array(vertices * 3);
  const paint = new Float32Array(vertices);
  const index = vertices < 65536 ? new Uint16Array(indices) : new Uint32Array(indices);
  const v = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();
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
  return { geometry, triangles: indices / 3 };
}
