/**
 * Builds the model library (`lib/map/modelLibrary.ts`, `docs/MODEL_LIBRARY.md`):
 * GoWay's one set of generic vehicles, vessels and people, used by the
 * city-life simulation and the live layer alike.
 *
 *   bun scripts/build-model-library.ts --kits=<dir>
 *
 * `<dir>` holds the four Kenney kits as downloaded from kenney.nl and
 * unzipped, one folder each: `car-kit/`, `train-kit/`, `watercraft-kit/`,
 * `mini-characters/` (each with its `License.txt` and `Models/GLB format/`).
 * The kits are never committed; the GLBs built from them are, with every
 * asset's licence and provenance in `public/models/library/manifest.json`.
 *
 * Per model it:
 *
 *  - reads the kit's GLB (`library/kenney.ts`) — or, for the bus no kit has,
 *    builds it in the kits' style with the landmark kit (`library/bus.ts`);
 *  - scales it uniformly to its class's real width (vehicles), length
 *    (vessels) or height (people), front to +Z, standing on y = 0;
 *  - recolours it to the maquette palette: the body's main colour becomes the
 *    tintable `paint` material, glass becomes one dark tinted glass, every
 *    other colour is tempered (desaturated, lifted) into fixed vertex colours;
 *  - decimates it with meshoptimizer to the kind's budgets (`MODEL_BUDGETS`),
 *    a `near` level and a wheel-less `far` level;
 *  - for a person, bakes the kit's `walk` and `idle` clips (or the wheelchair
 *    push and sit) into morph-target frames on the `near` level;
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

import { MeshoptSimplifier } from 'meshoptimizer';

import type { AssetLicence } from '../lib/map/assetLicence';
import {
  MODEL_BUDGETS,
  MODEL_LIBRARY_PATH,
  type ModelKind,
  parseModelLibrary,
} from '../lib/map/modelLibrary';
import { linearChannel, writeModelGlb } from './landmarks/glb';
import { Builder, box, THREE } from './landmarks/kit';
import { aircraftLods } from './library/aircraft';
import { busLods } from './library/bus';
import { type KenneyMesh, readKenney, readPalette } from './library/kenney';

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
  people: {
    folder: 'mini-characters',
    name: 'Mini Characters',
    version: '1.0',
    url: 'https://kenney.nl/assets/mini-characters',
  },
};

interface Entry {
  key: string;
  kind: ModelKind;
  kit?: keyof typeof KITS;
  file?: string;
  /** Uniform scale target: `width`, `length` or `height`, metres. */
  fit: { width?: number; length?: number; height?: number };
  /** People: the clips, and a prop (the wheelchair). */
  person?: { move: string; idle: string; attach?: string };
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
  },
  { key: 'vehicle.sedan', kind: 'car', kit: 'car', file: 'sedan', fit: { width: 1.82 } },
  { key: 'vehicle.suv', kind: 'car', kit: 'car', file: 'suv', fit: { width: 1.9 } },
  { key: 'vehicle.taxi', kind: 'car', kit: 'car', file: 'taxi', fit: { width: 1.82 } },
  { key: 'vehicle.van', kind: 'van', kit: 'car', file: 'van', fit: { width: 2.0 } },
  { key: 'vehicle.truck', kind: 'truck', kit: 'car', file: 'delivery', fit: { width: 2.3 } },
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
  },
  {
    key: 'tram.classic',
    kind: 'tram',
    kit: 'train',
    file: 'train-tram-classic',
    fit: { width: 2.3 },
  },
  {
    key: 'train.commuter',
    kind: 'train',
    kit: 'train',
    file: 'train-electric-city-a',
    fit: { width: 2.9 },
  },
  {
    key: 'train.double',
    kind: 'train',
    kit: 'train',
    file: 'train-electric-double-a',
    fit: { width: 2.9 },
  },
  {
    key: 'metro.car',
    kind: 'metro',
    kit: 'train',
    file: 'train-electric-subway-a',
    fit: { width: 2.8 },
  },
  { key: 'vessel.ferry', kind: 'vessel', kit: 'water', file: 'ship-small', fit: { length: 45 } },
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
  ...['female-b', 'female-c', 'female-d', 'female-f', 'male-a', 'male-b', 'male-d', 'male-f'].map(
    (name): Entry => ({
      key: `person.${name}`,
      kind: 'person',
      kit: 'people',
      file: `character-${name}`,
      fit: { height: 1.7 },
      person: { move: 'walk', idle: 'idle' },
    }),
  ),
  {
    key: 'person.wheelchair',
    kind: 'person',
    kit: 'people',
    file: 'character-male-e',
    fit: { height: 1.7 },
    person: { move: 'wheelchair-move-forward', idle: 'wheelchair-sit', attach: 'wheelchair' },
  },
];

/** Glass, as the maquette draws it: one dark tint, so windows read as a band. */
const GLASS: [number, number, number] = [0.24, 0.29, 0.36];

const lum = ([r, g, b]: readonly number[]) => 0.299 * r + 0.587 * g + 0.114 * b;
const sat = (c: readonly number[]) => Math.max(...c) - Math.min(...c);

/** Into the maquette palette: two-fifths desaturated, a little lifted. */
function temper(c: readonly number[]): [number, number, number] {
  const l = lum(c);
  return c.map((v) => Math.min(1, (v * 0.6 + l * 0.4) * 0.88 + 0.1)) as [number, number, number];
}

const key3 = (c: readonly number[]) => c.map((v) => Math.round(v * 255)).join(',');

interface Prepared {
  positions: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  frames: Float32Array[];
}

/**
 * Uniform fit: scaled so `scaleBy` meets the class's real size, then the
 * model (`mesh`, which may hold more — a wheelchair) stands on y = 0,
 * centred on its footprint.
 */
function fitTransform(
  mesh: KenneyMesh,
  fit: Entry['fit'],
  scaleBy: KenneyMesh = mesh,
): (array: Float32Array) => Float32Array {
  const bounds = (m: KenneyMesh) => {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < m.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], m.positions[i + k]);
        max[k] = Math.max(max[k], m.positions[i + k]);
      }
    }
    return { min, max };
  };
  const sized = bounds(scaleBy);
  const scale = fit.width
    ? fit.width / (sized.max[0] - sized.min[0])
    : fit.length
      ? fit.length / (sized.max[2] - sized.min[2])
      : (fit.height ?? 1) / (sized.max[1] - sized.min[1]);
  const { min, max } = bounds(mesh);
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

/** Horizontal bands of a person's far level, bottom up, as fractions of the height. */
const PERSON_FAR_BANDS = [0, 0.18, 0.4, 0.62, 1];

/**
 * A person's far level: decimating a character to a few dozen triangles
 * shatters it, so it is drawn as a stack of boxes instead — per height band,
 * the 10th–90th percentile of the band's footprint, in the colour most of
 * the band's faces wear. Four boxes, 48 triangles, the same silhouette at
 * the dozen pixels a far person covers.
 */
function personFar(mesh: Prepared): Builder {
  const builder = new Builder(new Set(['body']));
  let height = 0;
  for (let i = 1; i < mesh.positions.length; i += 3) height = Math.max(height, mesh.positions[i]);
  const percentile = (values: number[], p: number) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  };
  for (let b = 0; b + 1 < PERSON_FAR_BANDS.length; b++) {
    const y0 = PERSON_FAR_BANDS[b] * height;
    const y1 = PERSON_FAR_BANDS[b + 1] * height;
    const xs: number[] = [];
    const zs: number[] = [];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const y = mesh.positions[i + 1];
      if (y < y0 || y > y1) continue;
      xs.push(mesh.positions[i]);
      zs.push(mesh.positions[i + 2]);
    }
    if (xs.length === 0) continue;
    // The top band shows its crown (hair, a hat) from above, not a chair's handles.
    const top = b + 2 === PERSON_FAR_BANDS.length;
    const vote0 = top ? y1 - (y1 - y0) * 0.3 : y0;
    const votes = new Map<string, { n: number; colour: number[] }>();
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const tri = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]];
      const cy = tri.reduce((sum, v) => sum + mesh.positions[v * 3 + 1], 0) / 3;
      if (cy < vote0 || cy > y1) continue;
      const colour = Array.from(mesh.colors.subarray(tri[0] * 3, tri[0] * 3 + 3));
      const vote = votes.get(key3(colour)) ?? { n: 0, colour };
      vote.n++;
      votes.set(key3(colour), vote);
    }
    const colour = [...votes.values()].sort((p, q) => q.n - p.n)[0]?.colour ?? [0.5, 0.5, 0.5];
    const g = box(
      [percentile(xs, 0.1), y0, percentile(zs, 0.1)],
      [percentile(xs, 0.9), y1, percentile(zs, 0.9)],
    );
    const flat = g.index ? g.toNonIndexed() : g;
    const linear = colour.map(linearChannel);
    const colours = new Float32Array(flat.attributes.position.count * 3);
    for (let i = 0; i < flat.attributes.position.count; i++) colours.set(linear, i * 3);
    flat.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    builder.add('body', flat);
  }
  return builder;
}

/** Decimate to `target` triangles, colours as an attribute so their borders survive. */
function decimate(input: Prepared, target: number): Prepared {
  const remap = MeshoptSimplifier.generatePositionRemap(input.positions, 3);
  const welded = Uint32Array.from(input.indices, (i) => remap[i]);
  if (welded.length / 3 <= target) return { ...input, indices: welded };
  const [indices] = MeshoptSimplifier.simplifyWithAttributes(
    welded,
    input.positions,
    3,
    input.colors,
    3,
    [2, 2, 2],
    null,
    target * 3,
    0.5,
    ['Permissive', 'Prune'],
  );
  return { ...input, indices };
}

/** The decimated triangles as library geometry: `paint` and `body`, flat colour per face. */
function toBuilder(mesh: Prepared, paint: Paint | null): Builder {
  const builder = new Builder(new Set(['paint', 'body']));
  const buckets = { paint: [] as number[], body: [] as number[] };
  const colours = { paint: [] as number[], body: [] as number[] };
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const tri = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]];
    // The face's colour: the most common of its corners' (a decimated face can
    // straddle a colour border; it takes the side most of it lies on).
    const counts = new Map<string, { n: number; colour: number[] }>();
    for (const v of tri) {
      const colour = Array.from(mesh.colors.subarray(v * 3, v * 3 + 3));
      const vote = counts.get(key3(colour)) ?? { n: 0, colour };
      vote.n++;
      counts.set(key3(colour), vote);
    }
    const [winner, { colour }] = [...counts].sort((a, b) => b[1].n - a[1].n)[0];
    const isPaint = paint?.keys.has(winner) ?? false;
    for (const v of tri) (isPaint ? buckets.paint : buckets.body).push(v);
    // A paint face carries its ramp shade as a grey the tint is multiplied by.
    const shade = paint ? Math.max(0.55, Math.min(1, lum(colour) / paint.reference)) : 1;
    const linear = (isPaint ? [shade, shade, shade] : colour).map(linearChannel);
    for (let i = 0; i < 3; i++) colours[isPaint ? 'paint' : 'body'].push(...linear);
  }
  const geometryOf = (vertices: number[], colour: number[]) => {
    const g = new THREE.BufferGeometry();
    const positions = new Float32Array(vertices.length * 3);
    vertices.forEach((v, i) => {
      positions.set(mesh.positions.subarray(v * 3, v * 3 + 3), i * 3);
    });
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(Float32Array.from(colour), 3));
    if (mesh.frames.length > 0) {
      g.morphAttributes.position = mesh.frames.map((frame) => {
        const deltas = new Float32Array(vertices.length * 3);
        vertices.forEach((v, i) => {
          for (let k = 0; k < 3; k++)
            deltas[i * 3 + k] = frame[v * 3 + k] - mesh.positions[v * 3 + k];
        });
        return new THREE.BufferAttribute(deltas, 3);
      });
    }
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
 * hue. Glass is the kits' light, blue-tinted greys above the waist (the same
 * greys lower down are hubcaps, and the kits' neutral whites are bodywork).
 */
const PAINT_HUE_DEG = 22;
function recolour(mesh: KenneyMesh, kind: ModelKind): Paint | null {
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 1; i < mesh.positions.length; i += 3) {
    minY = Math.min(minY, mesh.positions[i]);
    maxY = Math.max(maxY, mesh.positions[i]);
  }
  const colourAt = (i: number) => Array.from(mesh.colors.subarray(i, i + 3));
  let paint: Paint | null = null;
  if (kind !== 'person') {
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
    const height = (mesh.positions[i + 1] - minY) / Math.max(maxY - minY, 1e-6);
    const glass = kind !== 'person' && lum(c) > 0.68 && c[2] - c[0] > 0.1 && height > 0.4;
    mesh.colors.set(glass ? GLASS : temper(c), i);
  }
  return paint;
}

async function build(kitsDir: string): Promise<void> {
  await MeshoptSimplifier.ready;
  await mkdir(OUT, { recursive: true });
  const palettes = new Map<string, Awaited<ReturnType<typeof readPalette>>>();
  const models = [];
  for (const entry of CATALOGUE) {
    const budget = MODEL_BUDGETS[entry.kind];
    let lods: { near: Builder; far: Builder };
    let clips:
      | {
          move: { first: number; count: number; fps: number };
          idle: { first: number; count: number; fps: number };
        }
      | undefined;
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
      const person = entry.person;
      const near = await readKenney(file, palette, {
        clips: person
          ? [
              { name: person.move, frames: 8 },
              { name: person.idle, frames: 4 },
            ]
          : undefined,
        attach: person?.attach ? join(glbDir, `${person.attach}.glb`) : undefined,
      });
      // A vehicle's far level: no wheels (a person's is built from its near level).
      const far = person ? null : await readKenney(file, palette, { skipNodes: /wheel/i });
      // People: fit by the STANDING character, so a wheelchair user is to scale.
      const fitSource = person?.attach
        ? await readKenney(file, palette, { clips: [{ name: 'idle', frames: 1 }] })
        : near;
      const place = fitTransform(near, entry.fit, fitSource);
      const paint = recolour(near, entry.kind);
      if (far) recolour(far, entry.kind);
      const frames = (near.clips ?? []).flatMap((clip) => clip.frames.map(place));
      const nearPrepared = decimate(
        { positions: place(near.positions), colors: near.colors, indices: near.indices, frames },
        budget.near,
      );
      lods = {
        near: toBuilder(nearPrepared, paint),
        far: far
          ? toBuilder(
              decimate(
                {
                  positions: place(far.positions),
                  colors: far.colors,
                  indices: far.indices,
                  frames: [],
                },
                budget.far,
              ),
              paint,
            )
          : personFar(nearPrepared),
      };
      if (near.clips) {
        const [move, idle] = near.clips;
        clips = {
          move: { first: 0, count: move.frames.length, fps: Math.round(move.fps * 100) / 100 },
          idle: {
            first: move.frames.length,
            count: idle.frames.length,
            fps: Math.round(idle.fps * 100) / 100,
          },
        };
      }
      licence = {
        spdx: 'CC0-1.0' as const,
        method: 'third-party' as const,
        author: 'Kenney (www.kenney.nl)',
        source: kit.url,
        credit: null,
        derivedFrom: [],
        verifiedAt: VERIFIED,
        notes: `${kit.name} ${kit.version}, \`${entry.file}.glb\`${entry.person?.attach ? ` with \`${entry.person.attach}.glb\`` : ''}; CC0 per the kit’s License.txt and its page. Recoloured, decimated and rescaled by scripts/build-model-library.ts.`,
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
      ...(clips ? { clips } : {}),
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
  if (!kits)
    throw new Error('--kits=<dir with car-kit/, train-kit/, watercraft-kit/, mini-characters/>');
  await build(kits);
}
