/**
 * The styling fill of mapped WOODS — off unless asked for — and the packing
 * of every tree (mapped or fill) for the GPU.
 *
 * GoWay's basemap tiles carry no individual trees; GoWay's city tiles carry
 * the `natural=tree` points OSM records (`workerTrees.ts`, drawn by default).
 * This fill is the 3D equivalent of the tree pattern a paper map prints over
 * a forest: switched on only by the person (the registry's `city3dTreeFill`,
 * Labs) or `?city3dTreeFill=1` (development), it stands trees in areas mapped as
 * wood (`landcover` `class=wood`) and NEVER in a park or garden (owner review:
 * "trees at random everywhere"), clear of everything mapped as something else
 * and of mapped trees. None of it is data; see `docs/MAP_3D_CITY.md` →
 * "Trees". The park and lawn classes are still rasterised: they decide
 * nothing now but keep the raster's precedence rules in one place.
 *
 * ## How
 *
 *  1. Rasterise, at {@link TREES.cellM}, the bounding box of the tile's wood
 *     and park areas: park → `PARK`, lawns inside a park → `LAWN`, wood →
 *     `WOOD` (in that order, so wood wins), then everything that cannot hold a
 *     tree → `NONE` (water, buildings, pitches, open grass, paths with a
 *     buffer by class).
 *  2. Walk a lattice at {@link TREES.spacingM}, jitter each point by a hash of
 *     the tile and the lattice cell (so the same tile always grows the same
 *     trees, and no point leaves its cell — tiles cannot double up at a seam),
 *     and keep it with the probability its class's density gives, if it and
 *     its four neighbours one cell away all hold a tree class.
 *  3. Thin to {@link TREES.maxPerTile} by seed if a tile is all forest.
 *
 * Pure; runs in the mesh worker; tested in `__tests__/city3dTrees.test.ts`.
 */
import type { Point2 } from './mesher';
import { CROWN_FRAMES } from './treeGeometry';

export const TREES = {
  /** Raster cell, metres. */
  cellM: 2,
  /** Lattice step, metres: the densest spacing (wood). */
  spacingM: 7,
  /** Mean spacing in a wood, metres: the share of lattice points kept. */
  woodSpacingM: 7,
  /** Most trees one tile stands (`docs/MAP_3D_CITY.md` → "Budgets"). */
  maxPerTile: 24_000,
  /** Heights, metres (styling, not data). */
  woodHeightM: [9, 19] as const,
  parkHeightM: [7, 15] as const,
  coniferHeightM: [10, 20] as const,
  /**
   * Share drawn as conifers, by area. Styling like everything here: the tiles
   * say nothing of leaf type (`leaf_type` is not in the `landcover` layer), so
   * this is a mix for the eye, not a census of species.
   */
  coniferShareWood: 0.3,
  /** How far the fill keeps from a tree OpenStreetMap records, metres. */
  mappedClearanceM: 9,
} as const;

/** `kind` bits in a tree's fourth word (see {@link TreeInstances}). */
export const KIND_WOOD = 1;
export const KIND_CONIFER = 2;
export const KIND_PALM = 4;
/** A tree OpenStreetMap records (`natural=tree`), not the fill's styling. */
export const KIND_MAPPED = 8;
/**
 * A STREET tree (`treeContext.ts` → `settleTrees`): beside a carriageway or a
 * sidewalk, recorded in a row or avenue, or in urban landuse — drawn with
 * {@link STREET_TREE}'s proportions. Without it a tree is a park, wood or
 * rural tree, drawn as it always was.
 */
export const KIND_STREET = 16;

/**
 * The instance ranges, in order: three broadleaf canopy variants, conifers,
 * palms. Each is one instanced draw (`cityMeshes.ts`).
 */
export const TREE_SHAPES = ['broadleaf0', 'broadleaf1', 'broadleaf2', 'conifer', 'palm'] as const;

/** One tree before packing: metres from the tile's north-west corner, y SOUTH. */
export interface TreePoint {
  x: number;
  y: number;
  /** In [0, 1): turn, width, tint and canopy variant all come from it. */
  seed: number;
  kind: number;
  heightM: number;
  /**
   * The crown's diameter when the data gives one (`diameter_crown`, or an
   * estimate from a recorded `circumference`); absent: {@link treeForm}'s
   * default for the tree's setting.
   */
  crownDiameterM?: number;
}

/** How a tree is drawn: its height, where its crown starts, and how wide it is. */
export interface TreeForm {
  heightM: number;
  /** The clear trunk: from the ground to the crown's lowest point. */
  crownBaseM: number;
  crownDiameterM: number;
}

/**
 * A street tree's proportions where OSM records no size — the Apple Maps
 * "Detailed City" street tree: a modest lollipop on a clear trunk, its crown
 * above a bus (`docs/MAP_3D_CITY.md` → "Trees"). Styling, not measurement:
 * the tree's POSITION is data, an unrecorded size is not.
 */
export const STREET_TREE = {
  /** Unrecorded height, metres, picked per tree by its seed. */
  heightM: [8.5, 11.5] as const,
  /** Clear trunk: this share of the height, kept within `[min, max]` metres. */
  clearTrunkShare: 0.45,
  clearTrunkM: [2.5, 6] as const,
  /** Unrecorded crown diameter: the crown's own height × this (per seed), at most `maxCrownM`. */
  crownPerHeight: [0.9, 1.1] as const,
  maxCrownM: 6.5,
  /** A street tree's trunk is slimmer than a park tree's of the same height. */
  trunkScale: 0.6,
} as const;

/** Recorded crown diameters are drawn between these, metres (a guard against typos, not a style). */
export const CROWN_DIAMETER_RANGE_M = [1, 40] as const;

/**
 * A crown diameter estimated from a recorded trunk `circumference` (metres,
 * measured at breast height): the diameter at breast height in centimetres,
 * through a broad urban-forestry rule of thumb (crown ≈ 1.5 m + 0.2 m per cm
 * of trunk), clamped to 2–20 m. An estimate from a fact, said as one.
 */
export function crownFromCircumferenceM(circumferenceM: number): number {
  const dbhCm = (circumferenceM * 100) / Math.PI;
  return Math.max(2, Math.min(20, 1.5 + 0.2 * dbhCm));
}

/** The seed as the GPU reads it (16 bits), so the CPU and the shader agree. */
const gpuSeed = (seed: number) => Math.floor(seed * 65_536) / 65_536;
const fract = (v: number) => v - Math.floor(v);

/** Which {@link CROWN_FRAMES} entry a tree's shape uses. */
function frameOf(kind: number) {
  if (kind & KIND_PALM) return CROWN_FRAMES.palm;
  if (kind & KIND_CONIFER) return CROWN_FRAMES.conifer;
  return CROWN_FRAMES.broadleaf;
}

/**
 * How a tree is drawn. A recorded size wins; otherwise:
 *
 *  - a park, wood or rural tree (and every palm) keeps the proportions it has
 *    always had: the unit tree scaled by its height, its canopy 0.86–1.16
 *    times as wide by its seed;
 *  - a street tree ({@link KIND_STREET}) gets {@link STREET_TREE}'s: a clear
 *    trunk of 45% of its height (2.5–6 m), a crown about as wide as it is
 *    tall, at most 6.5 m unless recorded.
 */
export function treeForm(tree: TreePoint): TreeForm {
  const heightM = tree.heightM;
  const frame = frameOf(tree.kind);
  const seed = gpuSeed(tree.seed);
  const recorded =
    tree.crownDiameterM === undefined
      ? undefined
      : Math.max(
          CROWN_DIAMETER_RANGE_M[0],
          Math.min(CROWN_DIAMETER_RANGE_M[1], tree.crownDiameterM),
        );
  if (!(tree.kind & KIND_STREET) || tree.kind & KIND_PALM) {
    // The canopy's width variant, as the shader used to draw it.
    const width = 0.86 + fract(seed * 7.31) * 0.3;
    return {
      heightM,
      crownBaseM: frame.base * heightM,
      crownDiameterM: recorded ?? 2 * frame.radius * heightM * width,
    };
  }
  const [lo, hi] = STREET_TREE.clearTrunkM;
  const crownBaseM = Math.min(
    Math.max(lo, Math.min(hi, STREET_TREE.clearTrunkShare * heightM)),
    heightM * 0.7,
  );
  const [c0, c1] = STREET_TREE.crownPerHeight;
  const share = c0 + (c1 - c0) * fract(seed * 5.77);
  return {
    heightM,
    crownBaseM,
    crownDiameterM:
      recorded ?? Math.max(2, Math.min(STREET_TREE.maxCrownM, (heightM - crownBaseM) * share)),
  };
}

/** Which of {@link TREE_SHAPES} a tree is drawn with. */
export function shapeOf(tree: TreePoint): number {
  if (tree.kind & KIND_PALM) return 4;
  if (tree.kind & KIND_CONIFER) return 3;
  return Math.floor(hash32(Math.floor(tree.seed * 4_294_967_296) ^ 0x51ed270b) / 1_431_655_766);
}

/**
 * Pack trees for the GPU, sorted into {@link TREE_SHAPES} order so each shape
 * is one contiguous instance range. `null` when there are none.
 */
export function packTrees(
  trees: readonly TreePoint[],
  tileSizeMetres: number,
): TreeInstances | null {
  if (trees.length === 0) return null;
  const unitM = tileSizeMetres / 65_535;
  const shapes = trees.map(shapeOf);
  const ranges = TREE_SHAPES.map(() => 0);
  for (const shape of shapes) ranges[shape]++;
  const starts = ranges.map((_, i) => ranges.slice(0, i).reduce((a, b) => a + b, 0));
  const data = new Uint16Array(trees.length * 4);
  const form = new Uint16Array(trees.length * 2);
  trees.forEach((tree, k) => {
    const slot = starts[shapes[k]]++;
    const p = slot * 4;
    // Height in half metres, as the shader reads it; the form from the same.
    const halfMetres = Math.max(1, Math.min(255, Math.round(tree.heightM * 2)));
    data[p] = Math.max(0, Math.min(65_535, Math.round(tree.x / unitM)));
    data[p + 1] = Math.max(0, Math.min(65_535, Math.round(tree.y / unitM)));
    data[p + 2] = Math.floor(tree.seed * 65_536);
    data[p + 3] = ((tree.kind & 255) << 8) | halfMetres;
    const shaped = treeForm({ ...tree, heightM: halfMetres / 2 });
    form[slot * 2] = Math.round(shaped.crownBaseM * 10);
    form[slot * 2 + 1] = Math.max(1, Math.round(shaped.crownDiameterM * 10));
  });
  return { data, form, count: trees.length, ranges, unitM };
}

/** Raster classes. */
export const NONE = 0;
export const LAWN = 1;
export const PARK = 2;
export const WOOD = 3;

/** What a `landcover` feature means for trees. */
export type AreaRole = 'wood' | 'park' | 'lawn' | 'blocked' | null;

/**
 * `landcover` `class` / `subclass` → role. Wood is wood; the park-like grass
 * subclasses take sparse trees; a lawn inside a park takes fewer; open grass
 * (meadows, heath, scrub, allotments, flowerbeds) and bare ground take none.
 */
export function landcoverRole(cls: unknown, subclass: unknown): AreaRole {
  if (cls === 'wood') return 'wood';
  if (cls === 'grass') {
    switch (subclass) {
      case 'park':
      case 'garden':
      case 'recreation_ground':
      case 'village_green':
        return 'park';
      case 'grass':
        return 'lawn';
      default:
        return 'blocked';
    }
  }
  // farmland, ice, rock, sand, wetland: no trees stood on them.
  return cls === undefined || cls === null ? null : 'blocked';
}

/** `landuse` `class` → role: `park` holds trees, sports grounds never do. */
export function landuseRole(cls: unknown): AreaRole {
  switch (cls) {
    case 'park':
      return 'park';
    case 'pitch':
    case 'playground':
    case 'track':
    case 'stadium':
    case 'railway':
    case 'racetrack':
      return 'blocked';
    default:
      return null;
  }
}

/**
 * `landuse` `class` values that are the built city: a mapped tree standing in
 * one is a street tree (`treeContext.ts`). The fill does not read this.
 */
const URBAN_LANDUSE = new Set([
  'residential',
  'commercial',
  'retail',
  'industrial',
  'garages',
  'neighbourhood',
  'quarter',
  'suburb',
]);

export function isUrbanLanduse(cls: unknown): boolean {
  return typeof cls === 'string' && URBAN_LANDUSE.has(cls);
}

/**
 * Half the cleared width along a `transportation` line, metres, by class —
 * the carriageway or path plus a verge, so no crown sits on it.
 */
export function pathHalfWidthM(cls: unknown): number {
  switch (cls) {
    case 'motorway':
    case 'trunk':
    case 'primary':
      return 10;
    case 'secondary':
    case 'tertiary':
      return 8;
    case 'minor':
    case 'raceway':
      return 6;
    case 'service':
    case 'track':
    case 'busway':
      return 4;
    case 'rail':
    case 'transit':
      return 4;
    case 'path':
      return 2.5;
    default:
      return 3;
  }
}

/** A polygon feature: rings in TILE UNITS, filled even-odd. */
export type AreaRings = readonly (readonly Point2[])[];

/** What the worker decodes from a tile for trees. */
export interface TreeSources {
  extent: number;
  wood: AreaRings[];
  park: AreaRings[];
  lawn: AreaRings[];
  blocked: AreaRings[];
  paths: { points: readonly Point2[]; halfWidthM: number }[];
}

/** Placed trees, packed for the GPU: `uint16 ×4` per tree. */
export interface TreeInstances {
  /**
   * x, y (tile units of `unitM`, y southward), seed, `kind << 8 | heightHalfMetres`
   * (`kind`: {@link KIND_WOOD} | {@link KIND_CONIFER} | {@link KIND_PALM} |
   * {@link KIND_MAPPED} | {@link KIND_STREET}), sorted by shape
   * ({@link TreeInstances.ranges}).
   */
  data: Uint16Array;
  /**
   * Per tree, in `data`'s order: crown base and crown diameter, decimetres
   * ({@link treeForm}). The shader stretches the unit tree to them.
   */
  form: Uint16Array;
  count: number;
  /** Trees per {@link TREE_SHAPES} entry, in that order along `data`. */
  ranges: number[];
  /** Metres per x/y unit (the tile's side / 65,535; same as the building mesh). */
  unitM: number;
}

/** A 32-bit integer hash (lowbias32), for repeatable jitter. */
export function hash32(value: number): number {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Four uniform numbers in [0, 1) for one lattice cell of one tile. */
function cellRandom(
  tileX: number,
  tileY: number,
  i: number,
  j: number,
): [number, number, number, number] {
  let h = hash32(tileX * 73_856_093 + tileY * 19_349_663);
  h = hash32(h ^ (i * 83_492_791));
  h = hash32(h ^ (j * 2_654_435_761));
  const a = h;
  const b = hash32(a + 1);
  const c = hash32(a + 2);
  const d = hash32(a + 3);
  return [a / 4_294_967_296, b / 4_294_967_296, c / 4_294_967_296, d / 4_294_967_296];
}

/** A raster over part of a tile, in tile units. */
export class TreeGrid {
  readonly cells: Uint8Array;

  constructor(
    /** Origin (north-west corner) in tile units. */
    readonly x0: number,
    readonly y0: number,
    /** Cell size in tile units. */
    readonly cell: number,
    readonly cols: number,
    readonly rows: number,
  ) {
    this.cells = new Uint8Array(cols * rows);
  }

  at(x: number, y: number): number {
    const i = Math.floor((x - this.x0) / this.cell);
    const j = Math.floor((y - this.y0) / this.cell);
    if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) return NONE;
    return this.cells[j * this.cols + i];
  }

  /**
   * Fill a feature's rings even-odd, rewriting each covered cell with
   * `paint(old)`. Scanline at cell centres, edges bucketed by row.
   */
  fill(rings: AreaRings, paint: (old: number) => number): void {
    const rows = new Map<number, number[]>();
    for (const ring of rings) {
      const n = ring.length;
      for (let k = 0; k < n; k++) {
        const a = ring[k];
        const b = ring[(k + 1) % n];
        if (a[1] === b[1]) continue;
        const lo = Math.min(a[1], b[1]);
        const hi = Math.max(a[1], b[1]);
        // Rows whose centre y is in [lo, hi).
        const first = Math.max(0, Math.ceil((lo - this.y0) / this.cell - 0.5));
        const last = Math.min(this.rows - 1, Math.ceil((hi - this.y0) / this.cell - 0.5) - 1);
        for (let j = first; j <= last; j++) {
          const y = this.y0 + (j + 0.5) * this.cell;
          const x = a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
          let list = rows.get(j);
          if (!list) {
            list = [];
            rows.set(j, list);
          }
          list.push(x);
        }
      }
    }
    for (const [j, xs] of rows) {
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(0, Math.ceil((xs[k] - this.x0) / this.cell - 0.5));
        const to = Math.min(this.cols - 1, Math.ceil((xs[k + 1] - this.x0) / this.cell - 0.5) - 1);
        const row = j * this.cols;
        for (let i = from; i <= to; i++) this.cells[row + i] = paint(this.cells[row + i]);
      }
    }
  }

  /** Clear every cell within `halfWidth` tile units of the polyline. */
  clearLine(points: readonly Point2[], halfWidth: number): void {
    const reach = Math.ceil(halfWidth / this.cell);
    const step = this.cell / 2;
    for (let k = 0; k + 1 < points.length; k++) {
      const a = points[k];
      const b = points[k + 1];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.max(1, Math.ceil(length / step));
      for (let s = 0; s <= steps; s++) {
        const x = a[0] + ((b[0] - a[0]) * s) / steps;
        const y = a[1] + ((b[1] - a[1]) * s) / steps;
        const ci = Math.floor((x - this.x0) / this.cell);
        const cj = Math.floor((y - this.y0) / this.cell);
        for (let dj = -reach; dj <= reach; dj++) {
          const j = cj + dj;
          if (j < 0 || j >= this.rows) continue;
          for (let di = -reach; di <= reach; di++) {
            const i = ci + di;
            if (i < 0 || i >= this.cols) continue;
            const cx = this.x0 + (i + 0.5) * this.cell - x;
            const cy = this.y0 + (j + 0.5) * this.cell - y;
            if (cx * cx + cy * cy <= halfWidth * halfWidth) this.cells[j * this.cols + i] = NONE;
          }
        }
      }
    }
  }
}

/** The bounding box, in tile units, of some areas, clipped to the tile. */
function areaBounds(
  areas: readonly AreaRings[],
  extent: number,
): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const rings of areas) {
    for (const ring of rings) {
      for (const [x, y] of ring) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(extent, x1);
  y1 = Math.min(extent, y1);
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}

/** The tile's tree raster, or `null` when it has no wood or park. Exported for tests. */
export function rasterizeTreeAreas(
  sources: TreeSources,
  tileSizeMetres: number,
  window?: { x0: number; y0: number; x1: number; y1: number },
): TreeGrid | null {
  const areas = areaBounds([...sources.wood, ...sources.park], sources.extent);
  const bounds =
    areas && window
      ? {
          x0: Math.max(areas.x0, window.x0),
          y0: Math.max(areas.y0, window.y0),
          x1: Math.min(areas.x1, window.x1),
          y1: Math.min(areas.y1, window.y1),
        }
      : areas;
  if (!bounds || bounds.x1 <= bounds.x0 || bounds.y1 <= bounds.y0) return null;
  const unitsPerMetre = sources.extent / tileSizeMetres;
  const cell = TREES.cellM * unitsPerMetre;
  const cols = Math.ceil((bounds.x1 - bounds.x0) / cell);
  const rows = Math.ceil((bounds.y1 - bounds.y0) / cell);
  const grid = new TreeGrid(bounds.x0, bounds.y0, cell, cols, rows);

  for (const rings of sources.park) grid.fill(rings, () => PARK);
  // A lawn only thins a park; a lawn outside a park stays treeless.
  for (const rings of sources.lawn) grid.fill(rings, (old) => (old === PARK ? LAWN : old));
  for (const rings of sources.wood) grid.fill(rings, () => WOOD);
  for (const rings of sources.blocked) grid.fill(rings, () => NONE);
  for (const path of sources.paths) grid.clearLine(path.points, path.halfWidthM * unitsPerMetre);
  return grid;
}

/** Where to stand trees, beyond the tile's own areas. */
export interface StandOptions {
  /** Only this part of the tile, in tile units (a z15 quarter of a z14 tile). */
  window?: { x0: number; y0: number; x1: number; y1: number };
  /**
   * Trees OpenStreetMap records, in tile units: the fill keeps
   * {@link TREES.mappedClearanceM} away from each, so where a park's trees are
   * mapped the map shows those and the fill only covers what is not mapped.
   */
  mapped?: readonly Point2[];
}

/**
 * Stand the fill's trees for one tile, as {@link TreePoint}s. Empty when there
 * are none.
 *
 * @param tile - the tile's x/y, the seed of every jitter.
 */
export function standTrees(
  sources: TreeSources,
  tile: { x: number; y: number },
  tileSizeMetres: number,
  options: StandOptions = {},
): TreePoint[] {
  const grid = rasterizeTreeAreas(sources, tileSizeMetres, options.window);
  if (!grid) return [];
  const unitsPerMetre = sources.extent / tileSizeMetres;
  for (const [x, y] of options.mapped ?? []) {
    grid.clearLine(
      [
        [x, y],
        [x, y],
      ],
      TREES.mappedClearanceM * unitsPerMetre,
    );
  }
  const step = TREES.spacingM * unitsPerMetre;
  // Woods only. Parks and lawns get no fill: a park's trees are what OSM
  // maps there, or none (owner report: "árboles al tuntún por todos lados").
  const keep = [0, 0, 0, (TREES.spacingM / TREES.woodSpacingM) ** 2];
  const clearance = grid.cell;

  // Lattice cells are anchored to the TILE, not the raster box, so a tile's
  // trees do not move when its areas (or the window) change.
  const i0 = Math.floor(grid.x0 / step);
  const j0 = Math.floor(grid.y0 / step);
  const i1 = Math.ceil((grid.x0 + grid.cols * grid.cell) / step);
  const j1 = Math.ceil((grid.y0 + grid.rows * grid.cell) / step);
  const window = options.window ?? { x0: 0, y0: 0, x1: sources.extent, y1: sources.extent };

  const found: { x: number; y: number; seed: number; wood: boolean }[] = [];
  for (let j = j0; j < j1; j++) {
    for (let i = i0; i < i1; i++) {
      const [jx, jy, pick, seed] = cellRandom(tile.x, tile.y, i, j);
      const x = (i + jx) * step;
      const y = (j + jy) * step;
      if (x < window.x0 || y < window.y0 || x >= window.x1 || y >= window.y1) continue;
      const cls = grid.at(x, y);
      if (cls === NONE || pick >= keep[cls]) continue;
      if (
        grid.at(x - clearance, y) === NONE ||
        grid.at(x + clearance, y) === NONE ||
        grid.at(x, y - clearance) === NONE ||
        grid.at(x, y + clearance) === NONE
      ) {
        continue;
      }
      found.push({ x, y, seed, wood: cls === WOOD });
    }
  }

  // Thin by seed, so an all-forest tile keeps an even spread, not a corner.
  const share = Math.min(1, TREES.maxPerTile / Math.max(1, found.length));
  const out: TreePoint[] = [];
  for (const tree of found) {
    if (tree.seed >= share || out.length >= TREES.maxPerTile) continue;
    // Two more draws from the same seed, decorrelated from the thinning:
    // species and size.
    const bits = Math.floor(tree.seed * 4_294_967_296);
    const conifer =
      hash32(bits ^ 0x9e3779b9) / 4_294_967_296 < (tree.wood ? TREES.coniferShareWood : 0);
    const range = conifer
      ? TREES.coniferHeightM
      : tree.wood
        ? TREES.woodHeightM
        : TREES.parkHeightM;
    const size = hash32(bits) / 4_294_967_296;
    out.push({
      x: tree.x / unitsPerMetre,
      y: tree.y / unitsPerMetre,
      seed: tree.seed,
      kind: (tree.wood ? KIND_WOOD : 0) | (conifer ? KIND_CONIFER : 0),
      heightM: range[0] + (range[1] - range[0]) * size,
    });
  }
  return out;
}

/** {@link standTrees}, packed for the GPU. `null` when there are none. */
export function placeTrees(
  sources: TreeSources,
  tile: { x: number; y: number },
  tileSizeMetres: number,
  options: StandOptions = {},
): TreeInstances | null {
  return packTrees(standTrees(sources, tile, tileSizeMetres, options), tileSizeMetres);
}

/**
 * Typical heights for a park, wood or rural tree whose `height` OSM does not
 * record, metres, by crown. A size for the eye, not a measurement: the tree's
 * POSITION and crown are data, an unrecorded height is not. A street tree's
 * is {@link STREET_TREE}'s.
 */
export const MAPPED_TREE_HEIGHT_M = {
  broadleaf: [8, 14],
  conifer: [10, 18],
  palm: [8, 14],
} as const;

/** One tree OpenStreetMap records, as {@link mappedTreePoints} reads it (tile units, y down). */
export interface MappedTreeInput {
  id: number;
  x: number;
  y: number;
  crown?: string;
  /** Recorded `height`, metres. */
  heightM?: number;
  /** Recorded `diameter_crown`, metres. */
  crownDiameterM?: number;
  /** Recorded trunk `circumference`, metres. */
  circumferenceM?: number;
  /** A street tree (`treeContext.ts` → `settleTrees`). */
  street?: boolean;
}

/**
 * Mapped trees (a GoWay city tile's `tree` layer) as {@link TreePoint}s, in
 * metres from the tile's north-west corner. Each tree's seed is its OSM id,
 * so it keeps its turn and canopy variant across sessions and tiles. What
 * OSM records about its size is kept; what it does not is its setting's
 * default ({@link treeForm}). A palm stays a palm on a street.
 */
export function mappedTreePoints(
  trees: readonly MappedTreeInput[],
  extent: number,
  tileSizeMetres: number,
): TreePoint[] {
  const metresPerUnit = tileSizeMetres / extent;
  return trees.map((tree) => {
    const seed = hash32(tree.id ^ Math.floor(tree.id / 4_294_967_296)) / 4_294_967_296;
    const crown = tree.crown === 'conifer' || tree.crown === 'palm' ? tree.crown : 'broadleaf';
    const street = tree.street === true && crown !== 'palm';
    const [lo, hi] = street ? STREET_TREE.heightM : MAPPED_TREE_HEIGHT_M[crown];
    const pick = lo + (hi - lo) * (hash32(Math.floor(seed * 4_294_967_296)) / 4_294_967_296);
    const crownDiameterM =
      tree.crownDiameterM ??
      (tree.circumferenceM === undefined
        ? undefined
        : crownFromCircumferenceM(tree.circumferenceM));
    // A street tree whose crown the data sizes, but not its height, is drawn
    // tall enough to carry that crown over its clear trunk.
    const typical =
      street && crownDiameterM !== undefined ? Math.max(pick, 3 + 0.8 * crownDiameterM) : pick;
    return {
      x: tree.x * metresPerUnit,
      y: tree.y * metresPerUnit,
      seed,
      kind:
        KIND_MAPPED |
        (crown === 'conifer' ? KIND_CONIFER : 0) |
        (crown === 'palm' ? KIND_PALM : 0) |
        (street ? KIND_STREET : 0),
      heightM: tree.heightM ?? typical,
      ...(crownDiameterM === undefined ? {} : { crownDiameterM }),
    };
  });
}
