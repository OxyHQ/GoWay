/**
 * Builds the model library (`lib/map/modelLibrary.ts`, `docs/MODEL_LIBRARY.md`):
 * GoWay's one set of generic vehicles and vessels, used by the city-life
 * simulation and the live layer alike.
 *
 *   bun scripts/build-model-library.ts --kits=<dir>
 *
 * `<dir>` holds the three Kenney kits as downloaded from kenney.nl and
 * unzipped, one folder each: `car-kit/`, `train-kit/`, `watercraft-kit/`
 * (each with its `License.txt` and `Models/GLB format/`).
 * The kits are never committed; the GLBs built from them are, with every
 * asset's licence and provenance in `public/models/library/manifest.json`.
 *
 * Per model it:
 *
 *  - reads the kit's GLB (`library/kenney.ts`) — or, for the bus no kit has,
 *    builds it in the kits' style with the landmark kit (`library/bus.ts`);
 *  - scales it uniformly to its class's real width (vehicles) or length
 *    (vessels), front to +Z, standing on y = 0;
 *  - recolours it to the maquette palette: the body's main colour becomes the
 *    tintable `paint` material, the windows are deepened so they read against
 *    pastel paint, every other colour is tempered — desaturated, lifted —
 *    into fixed vertex colours;
 *  - keeps the BODY exactly as the kit drew it for the `near` level — never
 *    decimated: a simplifier squeezing a 2,000-triangle car into 800 spends
 *    the budget on the wheels (two-thirds of a kit car's triangles) and
 *    crushes the body, its windows and its silhouette — and redraws the
 *    wheels low-poly in the kit's own colours ({@link lowPolyWheels});
 *  - builds the `far` level as three boxes in the body's colours
 *    ({@link bandedFar}), never a torn simplification;
 *  - writes the GLB with the landmarks' writer (`landmarks/glb.ts` →
 *    `writeModelGlb`: quantised, meshopt-compressed, deterministic).
 *
 * Nothing that looks like lettering, a logo, a livery or an emergency
 * service is selected: the catalogue below names every file used.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AssetLicence } from '../lib/map/assetLicence';
import {
  MODEL_BUDGETS,
  MODEL_LIBRARY_PATH,
  type ModelKind,
  parseModelLibrary,
} from '../lib/map/modelLibrary';
import { linearChannel, writeModelGlb } from './landmarks/glb';
import { Builder, box, cylinder, THREE } from './landmarks/kit';
import { aircraftLods } from './library/aircraft';
import { busLods } from './library/bus';
import { type KenneyMesh, meshNodeNames, readKenney, readPalette } from './library/kenney';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', MODEL_LIBRARY_PATH);
const VERIFIED = '2026-10-11';

interface Kit {
  folder: string;
  name: string;
  version: string;
  url: string;
}
const KITS: Record<string, Kit> = {
  car: {
    folder: 'car-kit',
    name: 'Car Kit',
    version: '3.1',
    url: 'https://kenney.nl/assets/car-kit',
  },
  train: {
    folder: 'train-kit',
    name: 'Train Kit',
    version: '1.1',
    url: 'https://kenney.nl/assets/train-kit',
  },
  water: {
    folder: 'watercraft-kit',
    name: 'Watercraft Kit',
    version: '2.1',
    url: 'https://kenney.nl/assets/watercraft-kit',
  },
};

interface Entry {
  key: string;
  kind: ModelKind;
  kit?: keyof typeof KITS;
  file?: string;
  /** Uniform scale target: `width`, `length` or `height`, metres. */
  fit: { width?: number; length?: number; height?: number };
  /** How the kit model's `wheel*` nodes are redrawn: as wheels (a car's) or as a bogie block (a train's). */
  wheels?: 'wheel' | 'bogie';
  /** A model no kit has, built here in the kits' style: its levels and the file that draws it. */
  procedural?: { build: () => { near: Builder; far: Builder }; source: string };
}

/** Every model, and the file it comes from. */
const CATALOGUE: Entry[] = [
  {
    key: 'vehicle.hatchback',
    kind: 'car',
    kit: 'car',
    file: 'hatchback-sports',
    fit: { width: 1.78 },
    wheels: 'wheel',
  },
  {
    key: 'vehicle.sedan',
    kind: 'car',
    kit: 'car',
    file: 'sedan',
    fit: { width: 1.82 },
    wheels: 'wheel',
  },
  {
    key: 'vehicle.suv',
    kind: 'car',
    kit: 'car',
    file: 'suv',
    fit: { width: 1.9 },
    wheels: 'wheel',
  },
  {
    key: 'vehicle.taxi',
    kind: 'car',
    kit: 'car',
    file: 'taxi',
    fit: { width: 1.82 },
    wheels: 'wheel',
  },
  {
    key: 'vehicle.van',
    kind: 'van',
    kit: 'car',
    file: 'van',
    fit: { width: 2.0 },
    wheels: 'wheel',
  },
  {
    key: 'vehicle.truck',
    kind: 'truck',
    kit: 'car',
    file: 'delivery',
    fit: { width: 2.3 },
    wheels: 'wheel',
  },
  {
    key: 'vehicle.bus',
    kind: 'bus',
    fit: {},
    procedural: { build: () => busLods(1), source: 'packages/frontend/scripts/library/bus.ts' },
  },
  {
    key: 'vehicle.bus-double',
    kind: 'bus',
    fit: {},
    procedural: { build: () => busLods(2), source: 'packages/frontend/scripts/library/bus.ts' },
  },
  {
    key: 'aircraft.airliner',
    kind: 'aircraft',
    fit: {},
    procedural: { build: aircraftLods, source: 'packages/frontend/scripts/library/aircraft.ts' },
  },
  {
    key: 'tram.modern',
    kind: 'tram',
    kit: 'train',
    file: 'train-tram-modern',
    fit: { width: 2.4 },
    wheels: 'bogie',
  },
  {
    key: 'tram.classic',
    kind: 'tram',
    kit: 'train',
    file: 'train-tram-classic',
    fit: { width: 2.3 },
    wheels: 'bogie',
  },
  {
    key: 'train.commuter',
    kind: 'train',
    kit: 'train',
    file: 'train-electric-city-a',
    fit: { width: 2.9 },
    wheels: 'bogie',
  },
  {
    key: 'train.double',
    kind: 'train',
    kit: 'train',
    file: 'train-electric-double-a',
    fit: { width: 2.9 },
    wheels: 'bogie',
  },
  {
    key: 'metro.car',
    kind: 'metro',
    kit: 'train',
    file: 'train-electric-subway-a',
    fit: { width: 2.8 },
    wheels: 'bogie',
  },
  {
    key: 'vessel.tallship',
    kind: 'vessel',
    kit: 'water',
    file: 'ship-small',
    fit: { length: 45 },
  },
  { key: 'vessel.cargo', kind: 'vessel', kit: 'water', file: 'ship-cargo-a', fit: { length: 120 } },
  {
    key: 'vessel.liner',
    kind: 'vessel',
    kit: 'water',
    file: 'ship-ocean-liner-small',
    fit: { length: 150 },
  },
  { key: 'vessel.tug', kind: 'vessel', kit: 'water', file: 'boat-tug-a', fit: { length: 25 } },
  {
    key: 'vessel.fishing',
    kind: 'vessel',
    kit: 'water',
    file: 'boat-fishing-small',
    fit: { length: 12 },
  },
  {
    key: 'vessel.sailboat',
    kind: 'vessel',
    kit: 'water',
    file: 'boat-sail-a',
    fit: { length: 10 },
  },
  {
    key: 'vessel.motorboat',
    kind: 'vessel',
    kit: 'water',
    file: 'boat-speed-a',
    fit: { length: 7 },
  },
];

const lum = ([r, g, b]: readonly number[]) => 0.299 * r + 0.587 * g + 0.114 * b;
const sat = (c: readonly number[]) => Math.max(...c) - Math.min(...c);

/** Into the maquette palette: two-fifths desaturated, a little lifted. */
function temper(c: readonly number[]): [number, number, number] {
  const l = lum(c);
  return c.map((v) => Math.min(1, (v * 0.6 + l * 0.4) * 0.88 + 0.1)) as [number, number, number];
}

/** A window: the kit's tint, darkened towards slate. */
function deepen(c: readonly number[]): [number, number, number] {
  return c.map((v, k) => v * 0.42 + [0.05, 0.08, 0.13][k]) as [number, number, number];
}

const key3 = (c: readonly number[]) => c.map((v) => Math.round(v * 255)).join(',');

interface Prepared {
  positions: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

/** Uniform fit: scaled to the class's real size, standing on y = 0, centred on its footprint. */
function fitTransform(mesh: KenneyMesh, fit: Entry['fit']): (array: Float32Array) => Float32Array {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], mesh.positions[i + k]);
      max[k] = Math.max(max[k], mesh.positions[i + k]);
    }
  }
  const scale = fit.width ? fit.width / (max[0] - min[0]) : (fit.length ?? 1) / (max[2] - min[2]);
  const cx = (min[0] + max[0]) / 2;
  const cz = (min[2] + max[2]) / 2;
  return (array) => {
    const out = new Float32Array(array.length);
    for (let i = 0; i < array.length; i += 3) {
      out[i] = (array[i] - cx) * scale;
      out[i + 1] = (array[i + 1] - min[1]) * scale;
      out[i + 2] = (array[i + 2] - cz) * scale;
    }
    return out;
  };
}

/** A wheel's tyre and hub colours, from the kit's own wheel: its darkest and lightest. */
function wheelColours(mesh: KenneyMesh): { tyre: number[]; hub: number[] } {
  let tyre = [0.2, 0.2, 0.22];
  let hub = [0.6, 0.62, 0.68];
  let dark = Infinity;
  let light = -Infinity;
  for (let i = 0; i < mesh.colors.length; i += 3) {
    const c = Array.from(mesh.colors.subarray(i, i + 3));
    if (lum(c) < dark) [dark, tyre] = [lum(c), c];
    if (lum(c) > light) [light, hub] = [lum(c), c];
  }
  return { tyre: temper(tyre), hub: temper(hub) };
}

function coloured(geometry: THREE.BufferGeometry, srgb: readonly number[]): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const linear = srgb.map(linearChannel);
  const colours = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < g.attributes.position.count; i++) colours.set(linear, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  return g;
}

/**
 * The kit's wheels, redrawn low-poly where they stand (its `wheel*` nodes,
 * already fitted): a car wheel as a ten-sided tyre with an eight-sided hub
 * on its outer face, a train's bogie as one block — in the kit wheel's own
 * tyre and hub colours. A kit car wheel is ~330 triangles; this one is 48.
 */
function lowPolyWheels(wheels: KenneyMesh[], kind: 'wheel' | 'bogie', builder: Builder): void {
  for (const wheel of wheels) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < wheel.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], wheel.positions[i + k]);
        max[k] = Math.max(max[k], wheel.positions[i + k]);
      }
    }
    if (!Number.isFinite(min[0])) continue;
    const { tyre, hub } = wheelColours(wheel);
    if (kind === 'bogie') {
      builder.add(
        'body',
        coloured(box(min as [number, number, number], max as [number, number, number]), tyre),
      );
      continue;
    }
    const radius = (max[1] - min[1]) / 2;
    const cy = (min[1] + max[1]) / 2;
    const cz = (min[2] + max[2]) / 2;
    // The kit's cylinder stands along y; a wheel's axle is x.
    const tyreGeometry = cylinder(radius, radius, min[0], max[0], 10);
    tyreGeometry.rotateZ(-Math.PI / 2);
    tyreGeometry.translate(0, cy, cz);
    builder.add('body', coloured(tyreGeometry, tyre));
    // The hub, on the side facing out (away from the car's centre line).
    const out = Math.sign(min[0] + max[0]) || 1;
    const face = out > 0 ? max[0] : min[0];
    // A disc just proud of the tyre's face, facing out.
    const hubGeometry = new THREE.CircleGeometry(radius * 0.55, 8);
    hubGeometry.rotateY((out * Math.PI) / 2);
    hubGeometry.translate(face + out * 0.01, cy, cz);
    builder.add('body', coloured(hubGeometry, hub));
  }
}

/** Horizontal bands of a far level, bottom up, as fractions of the model's height. */
const FAR_BANDS = [0, 0.3, 0.62, 1];

/**
 * A far level: the body as a stack of boxes, one per height band — the 10th
 * to 90th percentile of the band's footprint, in the colour most of the
 * band's UPWARD faces wear (what a tilted map camera sees: a car's roof, not
 * its sills), tintable where that colour is the paint. Twelve triangles a
 * band. Simplifying a kit body this far either tears it (holes, flipped
 * faces: the first library's broken cars) or stops at ~700 triangles; a
 * far vehicle is under 22 px long, where three boxes and the body read the
 * same.
 */
function bandedFar(mesh: Prepared, paint: Paint | null): Builder {
  const builder = new Builder(new Set(['paint', 'body']));
  let height = 0;
  for (let i = 1; i < mesh.positions.length; i += 3) height = Math.max(height, mesh.positions[i]);
  const percentile = (values: number[], p: number) => {
    const sorted = [...values].sort((x, y) => x - y);
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  };
  const p = (v: number) => [
    mesh.positions[v * 3],
    mesh.positions[v * 3 + 1],
    mesh.positions[v * 3 + 2],
  ];
  for (let band = 0; band + 1 < FAR_BANDS.length; band++) {
    const y0 = FAR_BANDS[band] * height;
    const y1 = FAR_BANDS[band + 1] * height;
    const xs: number[] = [];
    const zs: number[] = [];
    const votes = new Map<string, { area: number; colour: number[] }>();
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [a, b, c] = [p(mesh.indices[t]), p(mesh.indices[t + 1]), p(mesh.indices[t + 2])];
      const cy = (a[1] + b[1] + c[1]) / 3;
      if (cy < y0 || cy > y1) continue;
      for (const q of [a, b, c]) {
        xs.push(q[0]);
        zs.push(q[2]);
      }
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const area = Math.hypot(n[0], n[1], n[2]) / 2;
      // Upward faces count most; walls a little, so a band with no top still votes.
      const weight = area * (n[1] > 0 ? 0.2 + n[1] / (2 * area || 1) : 0.2);
      const colour = Array.from(mesh.colors.subarray(mesh.indices[t] * 3, mesh.indices[t] * 3 + 3));
      const vote = votes.get(key3(colour)) ?? { area: 0, colour };
      vote.area += weight;
      votes.set(key3(colour), vote);
    }
    if (xs.length === 0) continue;
    const colour = [...votes.values()].sort((m, n) => n.area - m.area)[0]?.colour ?? [
      0.5, 0.5, 0.5,
    ];
    const isPaint = paint?.keys.has(key3(colour)) ?? false;
    const g = box(
      [percentile(xs, 0.1), y0, percentile(zs, 0.05)],
      [percentile(xs, 0.9), y1, percentile(zs, 0.95)],
    );
    builder.add(isPaint ? 'paint' : 'body', coloured(g, isPaint ? [1, 1, 1] : colour));
  }
  return builder;
}

/** Triangles as library geometry, into `builder`: `paint` and `body`, flat colour per face. */
function toBuilder(
  mesh: Prepared,
  paint: Paint | null,
  builder = new Builder(new Set(['paint', 'body'])),
): Builder {
  const buckets = { paint: [] as number[], body: [] as number[] };
  const colours = { paint: [] as number[], body: [] as number[] };
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const tri = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]];
    // Paint or not: what most of the face's corners are (a face can straddle
    // a colour border).
    const counts = new Map<string, { n: number; colour: number[] }>();
    for (const v of tri) {
      const colour = Array.from(mesh.colors.subarray(v * 3, v * 3 + 3));
      const vote = counts.get(key3(colour)) ?? { n: 0, colour };
      vote.n++;
      counts.set(key3(colour), vote);
    }
    const [winner] = [...counts].sort((a, b) => b[1].n - a[1].n)[0];
    const isPaint = paint?.keys.has(winner) ?? false;
    for (const v of tri) {
      (isPaint ? buckets.paint : buckets.body).push(v);
      // Each corner keeps its own colour, so the kit's gradients survive; on
      // paint, as the grey shade the tint is multiplied by.
      const colour = Array.from(mesh.colors.subarray(v * 3, v * 3 + 3));
      const shade = paint ? Math.max(0.55, Math.min(1, lum(colour) / paint.reference)) : 1;
      const linear = (isPaint ? [shade, shade, shade] : colour).map(linearChannel);
      colours[isPaint ? 'paint' : 'body'].push(...linear);
    }
  }
  const geometryOf = (vertices: number[], colour: number[]) => {
    const g = new THREE.BufferGeometry();
    const positions = new Float32Array(vertices.length * 3);
    vertices.forEach((v, i) => {
      positions.set(mesh.positions.subarray(v * 3, v * 3 + 3), i * 3);
    });
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(Float32Array.from(colour), 3));
    return g;
  };
  if (buckets.paint.length > 0) builder.add('paint', geometryOf(buckets.paint, colours.paint));
  if (buckets.body.length > 0) builder.add('body', geometryOf(buckets.body, colours.body));
  return builder;
}

/** Hue in degrees, for grouping a palette ramp's shades. */
function hue([r, g, b]: readonly number[]): number {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/** The colours that became `paint`, and the shade a face of each is drawn at. */
interface Paint {
  keys: Set<string>;
  /** Luminance of the ramp's most common shade: the paint itself. */
  reference: number;
}

/**
 * Recolour per the module header. The kits shade with palette RAMPS (one hue
 * at several lightnesses), so the body's paint is a whole ramp: every
 * saturated colour within {@link PAINT_HUE_DEG} of the most common saturated
 * hue. The windows (light sky-blues) are deepened corner by corner;
 * every other colour is tempered. Never one flat glass colour per face: that
 * misread a white cab as glass and split windscreens in two.
 */
const PAINT_HUE_DEG = 22;
function recolour(mesh: KenneyMesh): Paint | null {
  const colourAt = (i: number) => Array.from(mesh.colors.subarray(i, i + 3));
  let paint: Paint | null = null;
  {
    const bins = new Map<number, number>();
    for (let i = 0; i < mesh.colors.length; i += 3) {
      const c = colourAt(i);
      if (sat(c) <= 0.2) continue;
      const bin = Math.round(hue(c) / 15);
      bins.set(bin, (bins.get(bin) ?? 0) + 1);
    }
    const top = [...bins].sort((a, b) => b[1] - a[1])[0];
    if (top) {
      const centre = top[0] * 15;
      const shades = new Map<string, number>();
      for (let i = 0; i < mesh.colors.length; i += 3) {
        const c = colourAt(i);
        const off = Math.abs(((hue(c) - centre + 540) % 360) - 180);
        if (sat(c) > 0.2 && off <= PAINT_HUE_DEG)
          shades.set(key3(c), (shades.get(key3(c)) ?? 0) + 1);
      }
      const common = [...shades]
        .sort((a, b) => b[1] - a[1])[0][0]
        .split(',')
        .map((v) => Number(v) / 255);
      paint = { keys: new Set(shades.keys()), reference: lum(common) };
    }
  }
  for (let i = 0; i < mesh.colors.length; i += 3) {
    const c = colourAt(i);
    if (paint?.keys.has(key3(c))) continue;
    // The kits' windows are light sky-blues; against pastel paint they vanish,
    // so they are deepened — per corner, so a windscreen's gradient to white
    // survives as a highlight. The kits' lavender whites (a delivery truck's
    // cab: red and green equal) are bodywork and stay.
    const window = lum(c) > 0.6 && c[2] - c[0] > 0.1 && c[1] - c[0] > 0.04;
    mesh.colors.set(window ? deepen(c) : temper(c), i);
  }
  return paint;
}

async function build(kitsDir: string): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const palettes = new Map<string, Awaited<ReturnType<typeof readPalette>>>();
  const models = [];
  for (const entry of CATALOGUE) {
    const budget = MODEL_BUDGETS[entry.kind];
    let lods: { near: Builder; far: Builder };
    let licence: AssetLicence;
    if (entry.procedural) {
      lods = entry.procedural.build();
      licence = {
        spdx: 'CC0-1.0' as const,
        method: 'procedural' as const,
        author: 'GoWay',
        source: entry.procedural.source,
        credit: null,
        derivedFrom: [],
        verifiedAt: VERIFIED,
        notes:
          'GoWay’s own geometry, drawn in the Kenney kits’ style so the fleet reads as one family.',
      };
    } else {
      if (!entry.kit || !entry.file)
        throw new Error(`${entry.key}: neither a kit file nor procedural`);
      const kit = KITS[entry.kit];
      const glbDir = join(kitsDir, kit.folder, 'Models', 'GLB format');
      const licenceText = await readFile(join(kitsDir, kit.folder, 'License.txt'), 'utf8');
      if (!/Creative Commons Zero, CC0/.test(licenceText)) throw new Error(`${kit.name}: not CC0`);
      let palette = palettes.get(kit.folder);
      if (!palette) {
        palette = await readPalette(join(glbDir, 'Textures', 'colormap.png'));
        palettes.set(kit.folder, palette);
      }
      const file = join(glbDir, `${entry.file}.glb`);
      const wheelNodes = entry.wheels
        ? (await meshNodeNames(file)).filter((name) => /wheel/i.test(name))
        : [];
      // Fitted on the whole model (its wheels are what it stands on).
      const place = fitTransform(await readKenney(file, palette), entry.fit);
      const body = await readKenney(file, palette, { nodes: (name) => !/wheel/i.test(name) });
      const paint = recolour(body);
      const prepared = {
        positions: place(body.positions),
        colors: body.colors,
        indices: body.indices,
      };
      const near = toBuilder(prepared, paint);
      if (entry.wheels) {
        const wheels = [];
        for (const name of wheelNodes) {
          const wheel = await readKenney(file, palette, { nodes: (node) => node === name });
          wheels.push({ ...wheel, positions: place(wheel.positions) });
        }
        lowPolyWheels(wheels, entry.wheels, near);
      }
      if (near.triangles() > budget.near) {
        throw new Error(`${entry.key}: ${near.triangles()} near triangles, over ${budget.near}`);
      }
      lods = { near, far: bandedFar(prepared, paint) };
      licence = {
        spdx: 'CC0-1.0' as const,
        method: 'third-party' as const,
        author: 'Kenney (www.kenney.nl)',
        source: kit.url,
        credit: null,
        derivedFrom: [],
        verifiedAt: VERIFIED,
        notes: `${kit.name} ${kit.version}, \`${entry.file}.glb\`; CC0 per the kit’s License.txt and its page. Recoloured and rescaled, wheels redrawn low-poly and a simplified far level added by scripts/build-model-library.ts.`,
      };
    }
    const fileName = `${entry.key}.glb`;
    const stats = await writeModelGlb(
      [
        { name: 'near', builder: lods.near },
        { name: 'far', builder: lods.far },
      ],
      {
        paint: { color: '#ffffff', roughness: 0.7 },
        body: { color: '#ffffff', roughness: 0.8 },
      },
      {
        id: entry.key,
        source: licence.source,
        licence: licence.spdx,
        generator: 'GoWay scripts/build-model-library.ts',
        extras: { model: entry.key, licence: licence.spdx, source: licence.source },
      },
    );
    await writeFile(join(OUT, fileName), stats.bytes);
    const nearTris = lods.near.triangles();
    models.push({
      key: entry.key,
      kind: entry.kind,
      file: fileName,
      bytes: stats.bytes.length,
      sha256: createHash('sha256').update(stats.bytes).digest('hex'),
      triangles: { near: nearTris, far: lods.far.triangles() },
      size: [0, 1, 2].map(
        (k) => Math.round((stats.bounds.max[k] - stats.bounds.min[k]) * 100) / 100,
      ) as [number, number, number],
      licence,
    });
    console.log(
      `  ${entry.key.padEnd(20)} ${String(nearTris).padStart(4)} / ${String(lods.far.triangles()).padStart(3)} tris  ${(stats.bytes.length / 1024).toFixed(1)} kB`,
    );
  }
  const manifest = parseModelLibrary({ version: 1, models });
  await writeFile(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const total = models.reduce((sum, m) => sum + m.bytes, 0);
  console.log(`\n${models.length} models, ${(total / 1024).toFixed(0)} kB → ${OUT}`);
}

const kits = process.argv.find((a) => a.startsWith('--kits='))?.slice('--kits='.length);
if (import.meta.main) {
  if (!kits) throw new Error('--kits=<dir with car-kit/, train-kit/, watercraft-kit/>');
  await build(kits);
}
