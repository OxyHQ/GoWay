/**
 * Builds `public/models/goway-car.glb`, the vehicle that drives a route
 * flyover (`docs/MAP_CAMERA_STUDIO.md`) and the first asset of the stubbed
 * model catalogue (`lib/map/modelCatalogue.ts` → `vehicle.car`).
 *
 *   bun scripts/build-flyover-model.ts           write it
 *   bun scripts/build-flyover-model.ts --check   fail if the committed file differs
 *
 * ## Why procedural
 *
 * `docs/SDK_MAP_MODELS.md` lets GoWay ship only assets whose licence it has
 * checked, model by model. The cleanest licence is one GoWay wrote: this
 * script is the asset's source, the GLB is generated from it byte for byte,
 * and both are GoWay's own work, dedicated to the public domain (CC0-1.0,
 * recorded in `public/models/LICENSE.md`). It is also small enough to read:
 * ~1 kB of geometry, ~600 triangles, a few kilobytes on the wire.
 *
 * ## What it follows (the note's asset profile)
 *
 *  - glTF 2.0 binary, one file, no extensions, no textures.
 *  - Metres, +Y up, front facing +Z, origin at the base centre (the wheels'
 *    contact patch is y = 0) — so `heading: 0` faces north and the anchor is
 *    where the car touches the road.
 *  - The body materials are named `paint…`, so `MapModel.tint` recolours them
 *    (munim-maps' convention); glass, tyres, trim and lamps keep their colour.
 *  - Faces wind counter-clockwise seen from outside, with flat normals: every
 *    face is oriented against its solid's centroid here, so a mistyped corner
 *    order cannot produce an inside-out panel.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Vec3 = [number, number, number];

interface Material {
  name: string;
  color: [number, number, number, number];
  metallic: number;
  roughness: number;
  emissive?: Vec3;
}

/** Linear-light RGB from an sRGB hex, as glTF's `baseColorFactor` wants. */
function linear(hex: string): [number, number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const round = (x: number) => Math.round(x * 10000) / 10000;
  return [
    round(channel((value >> 16) & 255)),
    round(channel((value >> 8) & 255)),
    round(channel(value & 255)),
    1,
  ];
}

const MATERIALS: Material[] = [
  { name: 'paintBody', color: linear('#e9ebee'), metallic: 0, roughness: 0.5 },
  { name: 'paintRoof', color: linear('#e9ebee'), metallic: 0, roughness: 0.5 },
  { name: 'glass', color: linear('#1c2530'), metallic: 0.3, roughness: 0.18 },
  { name: 'trim', color: linear('#2a2e35'), metallic: 0, roughness: 0.8 },
  { name: 'tyre', color: linear('#151515'), metallic: 0, roughness: 0.95 },
  {
    name: 'headlight',
    color: linear('#fff6d8'),
    metallic: 0,
    roughness: 0.3,
    emissive: [1, 0.92, 0.7],
  },
  {
    name: 'taillight',
    color: linear('#c8141c'),
    metallic: 0,
    roughness: 0.3,
    emissive: [0.75, 0.02, 0.02],
  },
];

/** Triangles per material, accumulated: positions and flat normals. */
const buckets = new Map<string, { positions: number[]; normals: number[] }>();

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function centroid(points: readonly Vec3[]): Vec3 {
  const c: Vec3 = [0, 0, 0];
  for (const p of points) for (let i = 0; i < 3; i++) c[i] += p[i] / points.length;
  return c;
}

/** One planar convex face (≥ 3 corners), oriented to face away from `inside`. */
function face(material: string, corners: Vec3[], inside: Vec3): void {
  let ring = corners;
  let normal = normalize(cross(sub(ring[1], ring[0]), sub(ring[2], ring[0])));
  if (dot(normal, sub(centroid(ring), inside)) < 0) {
    ring = [...ring].reverse();
    normal = [-normal[0], -normal[1], -normal[2]];
  }
  const bucket = buckets.get(material) ?? { positions: [], normals: [] };
  buckets.set(material, bucket);
  for (let i = 1; i < ring.length - 1; i++) {
    for (const p of [ring[0], ring[i], ring[i + 1]]) {
      bucket.positions.push(...p);
      bucket.normals.push(...normal);
    }
  }
}

/**
 * A hexahedron from a bottom and a top rectangle, each `[xMin, xMax, zMin, zMax]`
 * at its own height — boxes, wedges and the tapered cabin.
 */
function hexahedron(
  material: string,
  bottom: { y: number; x: [number, number]; z: [number, number] },
  top: { y: number; x: [number, number]; z: [number, number] },
  only?: { faces: Array<'top' | 'bottom' | 'front' | 'back' | 'left' | 'right'>; material: string },
): void {
  const b: Vec3[] = [
    [bottom.x[0], bottom.y, bottom.z[0]],
    [bottom.x[1], bottom.y, bottom.z[0]],
    [bottom.x[1], bottom.y, bottom.z[1]],
    [bottom.x[0], bottom.y, bottom.z[1]],
  ];
  const t: Vec3[] = [
    [top.x[0], top.y, top.z[0]],
    [top.x[1], top.y, top.z[0]],
    [top.x[1], top.y, top.z[1]],
    [top.x[0], top.y, top.z[1]],
  ];
  const inside = centroid([...b, ...t]);
  const faces: Record<string, Vec3[]> = {
    bottom: b,
    top: t,
    back: [b[0], b[1], t[1], t[0]],
    right: [b[0], b[3], t[3], t[0]], // −X is the model's right
    front: [b[3], b[2], t[2], t[3]],
    left: [b[1], b[2], t[2], t[1]],
  };
  for (const [name, corners] of Object.entries(faces)) {
    const use = only?.faces.includes(name as never) ? only.material : material;
    face(use, corners, inside);
  }
}

function box(
  material: string,
  x: [number, number],
  y: [number, number],
  z: [number, number],
): void {
  hexahedron(material, { y: y[0], x, z }, { y: y[1], x, z });
}

/** A wheel: a prism along X, `segments` sides. */
function wheel(cx: number, cz: number, radius: number, width: number, segments = 14): void {
  const xa = cx - width / 2;
  const xb = cx + width / 2;
  const ring = (x: number) =>
    Array.from({ length: segments }, (_, i): Vec3 => {
      const a = (i / segments) * Math.PI * 2;
      return [x, radius + Math.sin(a) * radius, cz + Math.cos(a) * radius];
    });
  const ra = ring(xa);
  const rb = ring(xb);
  const inside: Vec3 = [cx, radius, cz];
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    face('tyre', [ra[i], ra[j], rb[j], rb[i]], inside);
  }
  face('trim', ra, inside);
  face('trim', rb, inside);
}

function buildGeometry(): void {
  buckets.clear();
  // Lower body: a slab with a sloped nose and tail.
  hexahedron(
    'paintBody',
    { y: 0.3, x: [-0.9, 0.9], z: [-2.2, 2.2] },
    { y: 0.86, x: [-0.88, 0.88], z: [-2.08, 2.0] },
  );
  // Bumpers and skirt.
  box('trim', [-0.92, 0.92], [0.24, 0.42], [2.12, 2.26]);
  box('trim', [-0.92, 0.92], [0.24, 0.42], [-2.26, -2.12]);
  box('trim', [-0.86, 0.86], [0.18, 0.3], [-1.9, 1.9]);
  // Cabin: glass sides, tapered toward the roof; windscreen raked forward.
  hexahedron(
    'glass',
    { y: 0.86, x: [-0.8, 0.8], z: [-1.25, 0.82] },
    { y: 1.38, x: [-0.68, 0.68], z: [-0.98, 0.18] },
  );
  // Roof panel over the glass.
  box('paintRoof', [-0.66, 0.66], [1.38, 1.44], [-0.95, 0.15]);
  // Wheels: contact patch at y = 0.
  for (const x of [-0.8, 0.8]) for (const z of [-1.36, 1.36]) wheel(x, z, 0.33, 0.24);
  // Lamps: front (+Z) white, rear red.
  for (const x of [-0.78, 0.5]) box('headlight', [x, x + 0.28], [0.64, 0.76], [2.0, 2.05]);
  for (const x of [-0.82, 0.56]) box('taillight', [x, x + 0.26], [0.66, 0.78], [-2.12, -2.07]);
}

/** The GLB bytes. Deterministic: same source, same bytes. */
export function buildCarGlb(): Uint8Array {
  buildGeometry();
  const binParts: Uint8Array[] = [];
  let binLength = 0;
  const bufferViews: object[] = [];
  const accessors: object[] = [];
  const primitives: object[] = [];

  const pushView = (data: Float32Array, target: number) => {
    const bytes = new Uint8Array(data.buffer.slice(0));
    bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: bytes.byteLength, target });
    binParts.push(bytes);
    binLength += bytes.byteLength;
    return bufferViews.length - 1;
  };

  MATERIALS.forEach((material, index) => {
    const bucket = buckets.get(material.name);
    if (!bucket) return;
    const positions = new Float32Array(bucket.positions);
    const normals = new Float32Array(bucket.normals);
    const min: Vec3 = [
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    ];
    const max: Vec3 = [
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];
    for (let i = 0; i < positions.length; i += 3) {
      for (let c = 0; c < 3; c++) {
        min[c] = Math.min(min[c], positions[i + c]);
        max[c] = Math.max(max[c], positions[i + c]);
      }
    }
    const count = positions.length / 3;
    const ARRAY_BUFFER = 34962;
    accessors.push({
      bufferView: pushView(positions, ARRAY_BUFFER),
      componentType: 5126,
      count,
      type: 'VEC3',
      min,
      max,
    });
    const position = accessors.length - 1;
    accessors.push({
      bufferView: pushView(normals, ARRAY_BUFFER),
      componentType: 5126,
      count,
      type: 'VEC3',
    });
    const normal = accessors.length - 1;
    primitives.push({ attributes: { POSITION: position, NORMAL: normal }, material: index });
  });

  const json = {
    asset: {
      version: '2.0',
      generator: 'GoWay scripts/build-flyover-model.ts',
      copyright: 'CC0-1.0 GoWay',
    },
    scene: 0,
    scenes: [{ name: 'goway-car', nodes: [0] }],
    nodes: [{ name: 'car', mesh: 0 }],
    meshes: [{ name: 'car', primitives }],
    materials: MATERIALS.map((m) => ({
      name: m.name,
      pbrMetallicRoughness: {
        baseColorFactor: m.color,
        metallicFactor: m.metallic,
        roughnessFactor: m.roughness,
      },
      ...(m.emissive ? { emissiveFactor: m.emissive } : {}),
    })),
    accessors,
    bufferViews,
    buffers: [{ byteLength: binLength }],
  };

  const encoder = new TextEncoder();
  let jsonBytes = encoder.encode(JSON.stringify(json));
  const jsonPadded = Math.ceil(jsonBytes.length / 4) * 4;
  if (jsonPadded !== jsonBytes.length) {
    const padded = new Uint8Array(jsonPadded).fill(0x20);
    padded.set(jsonBytes);
    jsonBytes = padded;
  }
  const binPadded = Math.ceil(binLength / 4) * 4;
  const total = 12 + 8 + jsonBytes.length + 8 + binPadded;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(jsonBytes, 20);
  const binStart = 20 + jsonBytes.length;
  view.setUint32(binStart, binPadded, true);
  view.setUint32(binStart + 4, 0x004e4942, true); // 'BIN\0'
  let offset = binStart + 8;
  for (const part of binParts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export const CAR_GLB_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
  'models',
  'goway-car.glb',
);

if (import.meta.main) {
  const bytes = buildCarGlb();
  if (process.argv.includes('--check')) {
    const committed = new Uint8Array(await readFile(CAR_GLB_PATH));
    const same = committed.length === bytes.length && committed.every((b, i) => b === bytes[i]);
    if (!same) {
      console.error(
        'public/models/goway-car.glb is stale: run `bun scripts/build-flyover-model.ts`.',
      );
      process.exit(1);
    }
    console.log(`goway-car.glb up to date (${bytes.length} bytes).`);
  } else {
    await writeFile(CAR_GLB_PATH, bytes);
    console.log(`wrote ${CAR_GLB_PATH} (${bytes.length} bytes).`);
  }
}
