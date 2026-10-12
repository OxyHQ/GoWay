/**
 * A still, untextured model as ONE draw (two when it has decals): every mesh
 * merged into the asset's own space, each material's look baked into the
 * vertices it covers, and one node material reading it back
 * (`docs/MAP_NATIVE_3D.md` → Phase 2, models).
 *
 * Why: the TSL pass pays its CPU per draw (`WebGPURenderer`'s WebGL2 backend
 * issues ~30 GL calls for a lit draw), and a landmark is 5–25 meshes of one
 * material each — 16 draws for the Sagrada Família, the same building. Baked,
 * a landmark costs one or two.
 *
 * What is baked per vertex (`BATCH_ATTRIBUTES`): the base colour, roughness
 * and metalness, the emission by day, the glow at night
 * (`extras.goway.night`: colour × strength, × the layer's night factor in the
 * shader) and the floodlight wash (`extras.goway.uplight`: colour × strength
 * and reach; the height and the wall facing come from the vertex, in asset
 * metres — `modelLook.ts` explains the look). Decals (`extras.goway.decal`)
 * draw as their own batch with the depth bias they ask for.
 *
 * Only an asset that loses nothing is batched ({@link batchable}): no
 * animation, no skin or morph, every material a plain glTF metal-rough one
 * with no texture, opaque, single-sided and not a tintable `paint…` (a tint
 * is per instance). Anything else is drawn mesh by mesh, as before.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshStandardNodeMaterial, type Node } from 'three/webgpu';
import {
  abs,
  attribute,
  clamp,
  exp,
  float,
  max,
  normalGeometry,
  normalize,
  output,
  positionGeometry,
  select,
  sRGBTransferOETF,
  uniform,
  varying,
  vec3,
  vec4,
} from 'three/tsl';

import type { NightUniform } from './modelLook';

/** Per-vertex material attributes, with their sizes. */
export const BATCH_ATTRIBUTES = {
  /** Base colour, linear. */
  mColor: 3,
  /** Roughness, metalness. */
  mPbr: 2,
  /** Emission by day, linear (glTF's emissive × intensity). */
  mEmissive: 3,
  /** Emission at full night (`night.color × strength`); replaces the day's. */
  mNight: 3,
  /** The floodlight wash: colour × strength, and its reach in metres (0: none). */
  mUplight: 4,
} as const;

interface GowayExtras {
  night?: { color: [number, number, number]; strength: number };
  uplight?: { color: [number, number, number]; reach: number; strength: number };
  decal?: boolean;
}

const extrasOf = (material: THREE.Material): GowayExtras =>
  (material.userData as { goway?: GowayExtras }).goway ?? {};

const isRgb = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every((c) => typeof c === 'number' && Number.isFinite(c));

/** Whether an asset can be drawn as batches without losing anything. */
export function batchable(scene: THREE.Object3D, animations: readonly unknown[]): boolean {
  if (animations.length > 0) return false;
  let meshes = 0;
  let ok = true;
  scene.traverse((node) => {
    const mesh = node as THREE.Mesh & { isSkinnedMesh?: boolean };
    if (!mesh.isMesh) return;
    meshes++;
    const material = mesh.material as THREE.MeshStandardMaterial;
    const geometry = mesh.geometry;
    if (
      Array.isArray(mesh.material) ||
      mesh.isSkinnedMesh ||
      Object.keys(geometry.morphAttributes).length > 0 ||
      !geometry.getAttribute('position') ||
      !geometry.getAttribute('normal') ||
      material.type !== 'MeshStandardMaterial' ||
      material.map ||
      material.normalMap ||
      material.roughnessMap ||
      material.metalnessMap ||
      material.emissiveMap ||
      material.aoMap ||
      material.alphaMap ||
      material.transparent ||
      material.opacity < 1 ||
      material.alphaTest > 0 ||
      material.vertexColors ||
      material.side !== THREE.FrontSide ||
      material.flatShading ||
      material.envMapIntensity !== 1 ||
      /^paint/i.test(material.name)
    )
      ok = false;
  });
  return ok && meshes > 1;
}

/** A float copy of an attribute, whatever it is stored as (interleaved, normalised integers). */
function asFloats(
  source: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
): THREE.BufferAttribute {
  const size = source.itemSize;
  const array = new Float32Array(source.count * size);
  for (let i = 0; i < source.count; i++) {
    for (let c = 0; c < size; c++) array[i * size + c] = source.getComponent(i, c);
  }
  return new THREE.BufferAttribute(array, size);
}

/** One batch's geometry: the meshes' own space folded in, their look per vertex. */
function bakeMesh(mesh: THREE.Mesh, toAsset: THREE.Matrix4): THREE.BufferGeometry {
  const material = mesh.material as THREE.MeshStandardMaterial;
  const source = mesh.geometry;
  const geometry = new THREE.BufferGeometry();
  // As floats: a quantised GLB (`KHR_mesh_quantization`) stores normalised
  // integers, which the asset's transform would overflow and clamp.
  geometry.setAttribute('position', asFloats(source.getAttribute('position')));
  geometry.setAttribute('normal', asFloats(source.getAttribute('normal')));
  if (source.index) geometry.setIndex(source.index.clone());
  geometry.applyMatrix4(toAsset);
  const count = geometry.getAttribute('position').count;
  const extras = extrasOf(material);
  const night = extras.night && isRgb(extras.night.color) ? extras.night : null;
  const uplight =
    extras.uplight && isRgb(extras.uplight.color) && extras.uplight.reach > 0
      ? extras.uplight
      : null;
  const emissive = material.emissive.clone().multiplyScalar(material.emissiveIntensity);
  const values: Record<keyof typeof BATCH_ATTRIBUTES, number[]> = {
    mColor: [material.color.r, material.color.g, material.color.b],
    mPbr: [material.roughness, material.metalness],
    // A night material's emission is its glow × the night factor, by day none.
    mEmissive: night ? [0, 0, 0] : [emissive.r, emissive.g, emissive.b],
    mNight: night ? night.color.map((c) => c * (Number(night.strength) || 0)) : [0, 0, 0],
    mUplight: uplight
      ? [...uplight.color.map((c) => c * (Number(uplight.strength) || 0)), uplight.reach]
      : [0, 0, 0, 0],
  };
  for (const [name, size] of Object.entries(BATCH_ATTRIBUTES) as [
    keyof typeof BATCH_ATTRIBUTES,
    number,
  ][]) {
    const array = new Float32Array(count * size);
    for (let i = 0; i < count; i++) array.set(values[name], i * size);
    geometry.setAttribute(name, new THREE.BufferAttribute(array, size));
  }
  return geometry;
}

/**
 * The node material that reads a batch back. `decal`: the depth bias decals
 * ask for (`modelLook.ts`). The night factor is the layer's live value.
 */
export function batchMaterial(night: NightUniform, decal: boolean): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  material.name = decal ? 'goway-batch-decal' : 'goway-batch';
  material.colorNode = attribute('mColor', 'vec3');
  const pbr = attribute('mPbr', 'vec2');
  material.roughnessNode = pbr.x;
  material.metalnessNode = pbr.y;
  const factor = uniform(night.value).onRenderUpdate(() => night.value);
  const uplight = attribute('mUplight', 'vec4');
  // The wash: full at the base, ~5% at `reach`; walls take it, roofs a little.
  const height = varying(positionGeometry.y);
  const wall = varying(float(1).sub(abs(normalize(normalGeometry).y)));
  const wash = select(
    uplight.w.greaterThan(0),
    uplight.xyz.mul(
      factor
        .mul(exp(max(height, 0).mul(-3).div(max(uplight.w, 1e-3))))
        .mul(clamp(wall, 0, 1).mul(0.75).add(0.25)),
    ),
    vec3(0),
  );
  material.emissiveNode = attribute('mEmissive', 'vec3')
    .add(attribute('mNight', 'vec3').mul(factor))
    .add(wash);
  // Raw values into the map's frame, encoded as `WebGLRenderer` encoded them.
  const result = output as unknown as Node<'vec4'>;
  const encoded = sRGBTransferOETF(result.rgb) as unknown as Node<'vec3'>;
  material.outputNode = vec4(encoded, result.a);
  if (decal) {
    material.polygonOffset = true;
    material.polygonOffsetFactor = -1;
    material.polygonOffsetUnits = -4;
  }
  return material;
}

/**
 * The asset as at most two meshes — its plain surfaces, then its decals —
 * each with its baked geometry and a {@link batchMaterial}. Placed exactly
 * where its meshes were, in the asset's own space.
 */
export function batchAsset(scene: THREE.Object3D, night: NightUniform): THREE.Group {
  scene.updateMatrixWorld(true);
  const toAsset = new THREE.Matrix4().copy(scene.matrixWorld).invert();
  const groups = { plain: [] as THREE.BufferGeometry[], decal: [] as THREE.BufferGeometry[] };
  scene.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const relative = new THREE.Matrix4().multiplyMatrices(toAsset, mesh.matrixWorld);
    const decal = extrasOf(mesh.material as THREE.Material).decal === true;
    groups[decal ? 'decal' : 'plain'].push(bakeMesh(mesh, relative));
  });
  const out = new THREE.Group();
  out.name = scene.name;
  for (const kind of ['plain', 'decal'] as const) {
    const parts = groups[kind];
    if (parts.length === 0) continue;
    // All indexed, or all not: what `mergeGeometries` asks.
    const indexed = parts.every((g) => g.index !== null);
    const merged = mergeGeometries(indexed ? parts : parts.map((g) => g.toNonIndexed()));
    for (const part of parts) part.dispose();
    if (!merged) continue;
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, batchMaterial(night, kind === 'decal'));
    mesh.name = `${scene.name}-${kind}`;
    out.add(mesh);
  }
  return out;
}
