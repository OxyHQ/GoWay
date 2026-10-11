/**
 * Writes a landmark's geometry as one GLB in the asset profile
 * `docs/SDK_MAP_MODELS.md` allows: `KHR_mesh_quantization` +
 * `EXT_meshopt_compression`, no textures, PBR factors only, one mesh with one
 * primitive per material.
 *
 * ## What it does to the bytes
 *
 *  - **Quantises** positions to int16 and normals to int8 (normalised). One
 *    UNIFORM scale per model is folded into the node transform: a non-uniform
 *    one would bend the normals, which three transforms by the node's normal
 *    matrix. At Empire State's 443 m that is a 1.4 cm grid — below anything a
 *    map camera resolves.
 *  - **Compresses** every buffer view with meshoptimizer (lossless on the
 *    quantised data), decoded in the browser by three's `MeshoptDecoder`.
 *  - **Is deterministic**: same source, same bytes, so
 *    `bun scripts/build-landmarks.ts --check` can hold the committed GLBs to
 *    their generator.
 *
 * Night lighting rides in material `extras` (`goway.night`, `goway.uplight`),
 * read by the model layer at runtime (`components/map/engine/city3d/models.ts`
 * → night). glTF's own `emissiveFactor` is reserved for light that is on by
 * day as well (none of the landmarks use it).
 */
import { Document, type Material, NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { MeshoptEncoder } from 'meshoptimizer';

import type { Builder, THREE } from './kit';

/** A landmark material: PBR factors in sRGB hex, plus its night behaviour. */
export interface LandmarkMaterial {
  color: string;
  metallic?: number;
  roughness?: number;
  /** Lit at night with this sRGB colour × strength (windows, lanterns, the torch). */
  night?: { color: string; strength: number };
  /** Takes the landmark's uplight wash at night (facade stone). */
  uplight?: boolean;
  /** Translucent glass. */
  opacity?: number;
  /** Draw both sides (thin shells: the Biosphère-like lattices, sails). */
  doubleSided?: boolean;
  /**
   * Geometry laid a few centimetres proud of a wall (window panes, mosaic
   * panels). Drawn with a depth bias so it never z-fights the wall under the
   * map's depth buffer, whose resolution at a kilometre is decimetres.
   * Default: true for anything that glows at night (it is nearly always a
   * pane), else false.
   */
  decal?: boolean;
}

export interface Uplight {
  /** sRGB hex. */
  color: string;
  /** Metres above the base where the wash has faded to ~5%. */
  reach: number;
  strength: number;
}

/** One sRGB channel (0–1) → linear light, as glTF factors and `COLOR_0` want. */
export function linearChannel(s: number): number {
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** sRGB hex → linear-light RGB, as glTF factors want. */
export function linear(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (c: number) => linearChannel(c / 255);
  const round = (x: number) => Math.round(x * 10000) / 10000;
  return [
    round(channel((value >> 16) & 255)),
    round(channel((value >> 8) & 255)),
    round(channel(value & 255)),
  ];
}

export interface GlbStats {
  bytes: Uint8Array;
  triangles: number;
  /** Axis-aligned bounds in the asset's metres. */
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

export async function writeLandmarkGlb(
  builder: Builder,
  materials: Readonly<Record<string, LandmarkMaterial>>,
  meta: { id: string; source: string; licence: string; uplight?: Uplight },
): Promise<GlbStats> {
  return writeModelGlb([{ name: meta.id, builder }], materials, {
    ...meta,
    generator: `GoWay scripts/build-landmarks.ts (${meta.source})`,
    extras: { landmark: meta.id, source: meta.source, licence: meta.licence },
  });
}

/** One level of detail: its node and mesh name, and its geometry per material. */
export interface ModelLod {
  name: string;
  builder: Builder;
}

/**
 * The general writer behind {@link writeLandmarkGlb}, also used by the model
 * library (`scripts/build-model-library.ts`): one node and mesh per level of
 * detail, all quantised with ONE scale (so the LODs line up exactly), and per
 * primitive a `color` attribute where the geometry has one (written as
 * `COLOR_0`, unsigned bytes). With one LOD and no colours, the bytes are
 * exactly the landmark writer's.
 */
export async function writeModelGlb(
  lods: readonly ModelLod[],
  materials: Readonly<Record<string, LandmarkMaterial>>,
  meta: {
    id: string;
    source: string;
    licence: string;
    uplight?: Uplight;
    generator: string;
    /** Written as the scene's `extras.goway`. */
    extras: Record<string, unknown>;
  },
): Promise<GlbStats> {
  const merged = lods.map((lod) => ({ name: lod.name, geometries: lod.builder.merged() }));
  // Bounds of everything, for one uniform quantisation scale.
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const lod of merged) {
    for (const g of lod.geometries.values()) {
      g.computeBoundingBox();
      const box = g.boundingBox as THREE.Box3;
      min[0] = Math.min(min[0], box.min.x);
      min[1] = Math.min(min[1], box.min.y);
      min[2] = Math.min(min[2], box.min.z);
      max[0] = Math.max(max[0], box.max.x);
      max[1] = Math.max(max[1], box.max.y);
      max[2] = Math.max(max[2], box.max.z);
    }
  }
  const centre: [number, number, number] = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ];
  const half = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2 || 1;

  const doc = new Document();
  doc.createExtension(KHRMeshQuantization).setRequired(true);
  doc
    .createExtension(EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  doc.getRoot().getAsset().generator = meta.generator;
  doc.getRoot().getAsset().copyright = `${meta.licence} GoWay`;
  const buffer = doc.createBuffer();
  let triangles = 0;
  const quantise = (array: ArrayLike<number>, offset: (c: number) => number) => {
    const out = new Int16Array(array.length);
    for (let i = 0; i < array.length; i++) {
      const p = (array[i] - offset(i % 3)) / half;
      out[i] = Math.round(Math.max(-1, Math.min(1, p)) * 32767);
    }
    return out;
  };

  const gltfMaterials = new Map<string, Material>();
  const scene = doc.createScene(meta.id);
  for (const lod of merged) {
    const mesh = doc.createMesh(lod.name);
    for (const [name, geometry] of lod.geometries) {
      const spec = materials[name];
      if (!spec) throw new Error(`material "${name}" has no spec`);
      let material = gltfMaterials.get(name);
      if (!material) {
        const [r, g, b] = linear(spec.color);
        material = doc
          .createMaterial(name)
          .setBaseColorFactor([r, g, b, spec.opacity ?? 1])
          .setMetallicFactor(spec.metallic ?? 0)
          .setRoughnessFactor(spec.roughness ?? 0.85)
          .setDoubleSided(spec.doubleSided ?? false)
          .setAlphaMode(spec.opacity !== undefined && spec.opacity < 1 ? 'BLEND' : 'OPAQUE');
        const goway: Record<string, unknown> = {};
        if (spec.night) {
          goway.night = { color: linear(spec.night.color), strength: spec.night.strength };
        }
        if (spec.uplight && meta.uplight) {
          goway.uplight = {
            color: linear(meta.uplight.color),
            reach: meta.uplight.reach,
            strength: meta.uplight.strength,
          };
        }
        if (spec.decal ?? Boolean(spec.night)) goway.decal = true;
        if (Object.keys(goway).length > 0) material.setExtras({ goway });
        gltfMaterials.set(name, material);
      }

      const position = geometry.attributes.position.array as Float32Array;
      const normal = geometry.attributes.normal.array as Float32Array;
      const count = position.length / 3;
      // Plain VEC3 arrays: the writer interleaves a primitive's attributes and
      // pads each vertex to 4-byte alignment, as KHR_mesh_quantization requires.
      const qPosition = quantise(position, (c) => centre[c]);
      const qNormal = new Int8Array(count * 3);
      for (let i = 0; i < count * 3; i++) {
        qNormal[i] = Math.round(Math.max(-1, Math.min(1, normal[i])) * 127);
      }
      const indexSource = geometry.index?.array ?? Uint32Array.from({ length: count }, (_, i) => i);
      const indices = count < 65536 ? Uint16Array.from(indexSource) : Uint32Array.from(indexSource);
      triangles += indices.length / 3;

      const primitive = doc
        .createPrimitive()
        .setMaterial(material)
        .setIndices(doc.createAccessor().setArray(indices).setType('SCALAR').setBuffer(buffer))
        .setAttribute(
          'POSITION',
          doc
            .createAccessor()
            .setArray(qPosition)
            .setType('VEC3')
            .setNormalized(true)
            .setBuffer(buffer),
        )
        .setAttribute(
          'NORMAL',
          doc
            .createAccessor()
            .setArray(qNormal)
            .setType('VEC3')
            .setNormalized(true)
            .setBuffer(buffer),
        );
      const color = geometry.attributes.color;
      if (color) {
        const bytes = new Uint8Array(count * 4);
        for (let i = 0; i < count; i++) {
          for (let c = 0; c < 3; c++) {
            bytes[i * 4 + c] = Math.round(Math.max(0, Math.min(1, color.getComponent(i, c))) * 255);
          }
          bytes[i * 4 + 3] = 255;
        }
        primitive.setAttribute(
          'COLOR_0',
          doc
            .createAccessor()
            .setArray(bytes)
            .setType('VEC4')
            .setNormalized(true)
            .setBuffer(buffer),
        );
      }
      mesh.addPrimitive(primitive);
    }
    const node = doc
      .createNode(lod.name)
      .setMesh(mesh)
      .setTranslation(centre)
      .setScale([half, half, half]);
    scene.addChild(node);
  }
  scene.setExtras({ goway: meta.extras });
  doc.getRoot().setDefaultScene(scene);

  await MeshoptEncoder.ready;
  const io = new NodeIO()
    .registerExtensions([KHRMeshQuantization, EXTMeshoptCompression])
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  const bytes = await io.writeBinary(doc);
  return { bytes, triangles, bounds: { min, max } };
}
