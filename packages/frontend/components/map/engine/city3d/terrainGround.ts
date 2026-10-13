/**
 * Everything we draw on the ground, standing on the SAME surface MapLibre's 3D
 * terrain draws — not at sea level, and not on a coarser copy of it.
 *
 * With 3D terrain on, MapLibre's custom-layer matrix places `z` at ABSOLUTE
 * elevation — the camera rides `elevation` metres up — so a mesh built from
 * the ground (`z = 0`) is drawn at sea level: under the hillside in Barcelona's
 * Gràcia, hundreds of metres under it in Andorra. This module works out how far
 * up to lift everything: each building, each tree, each street vertex, city
 * life and the models. Pure: no renderer, no map engine; `cityEngine.ts`
 * uploads the result as one float per vertex and the materials add it
 * (`tsl/common.ts` → `terrainLift`), and the street detail reads the grids in
 * its vertex shader (`cityStreets/groundAtlas.ts`).
 *
 * ## The surface MapLibre draws, exactly
 *
 * MapLibre draws each terrain tile as a 128-cell grid whose vertices read the
 * DEM bilinearly between pixel CENTRES (`get_elevation` in its vertex prelude;
 * `Terrain.getElevationSampler` on the CPU, the same arithmetic), with the
 * exaggeration applied — and a terrain tile at zoom `z` reads the DEM tile at
 * `z − deltaZoom` (its `TerrainTileManager`, `deltaZoom` 1), clamped to the
 * source's max zoom. Everything here reproduces that surface:
 *
 * - **The same DEM tile.** The host samples at `maxzoom + deltaZoom`, which is
 *   the DEM's finest tile, the one every terrain tile at street level draws
 *   (`city3dGround.web.ts`). Asking for `maxzoom` itself — what this module was
 *   given until the Mallorca–Marina report — reads the tile ONE zoom coarser
 *   (Barcelona: 29 m pixels instead of 14 m), a different surface: up to 10 m
 *   off around the Sagrada Família, metres on any slope.
 * - **The same resolution.** Each tile's grid ({@link GroundGrid}) is sampled
 *   at the DEM's own pixel centres, plus one pixel round the edge, so a
 *   bilinear read of the grid IS MapLibre's bilinear read of the DEM, to float
 *   rounding — at every point, not only at the samples. The grid used to be
 *   33 × 33 per tile whatever the DEM (29 m cells over 14 m pixels); between
 *   its samples the drawn terrain rose up to 1.2 m above it, and 16% of a
 *   Barcelona street tile was under the terrain even with the right DEM.
 * - **The same exaggeration** (the sampler's own).
 *
 * What remains is MapLibre's mesh against its own bilinear surface: a terrain
 * tile at `z ≥ 15` has two or more vertices per DEM pixel ON the pixel centres'
 * lines, so the two differ only by the bilinear twist inside a pixel —
 * measured at most 1.4 mm on z18 terrain tiles, 9 mm on z17, 16 cm on z16 and
 * only beside the Sagrada Família's 31 m DEM spike (`docs/MAP_TERRAIN_GLOBE.md`
 * → "Everything on the drawn ground"). Far terrain tiles (z ≤ 12 terrain tiles,
 * kilometres out) are drawn from a COARSER DEM than this; nothing GoWay draws
 * on the ground is drawn there.
 *
 * ## How a building is placed — MapLibre's rule, made a little better
 *
 * MapLibre's own `fill-extrusion` on terrain lifts a whole building by the
 * ground at its CENTROID (a flat roof, as in the data), and sinks the base of
 * every ground-standing building 10 m so that a wall does not hang over a
 * slope. Same here — one elevation per building, roofs stay flat — but the sink
 * is measured rather than fixed: the drop from the centre to the lowest corner
 * of the footprint's box, plus a margin, never less than {@link GROUND.minSinkM}.
 * A building on flat ground buries 2 m of wall instead of 10; one across a
 * steep street reaches all the way down on the low side. Only vertices at the
 * building's FOOT (`z ≈ 0`) sink: a part that starts in the air
 * (`render_min_height`) keeps its gap.
 *
 * A building cut by a tile edge is two pieces, one per tile, each placed by its
 * own centre; on a slope their roofs can differ by the slope across the seam.
 */
import { latFromMercatorY, type TileId } from './tileMath';

/**
 * Ground elevation, in metres as DRAWN (terrain exaggeration included), at a
 * point: the DEM's finest tile read as MapLibre's terrain reads it.
 */
export type GroundSampler = (lng: number, lat: number) => number;

/**
 * The DEM the terrain is drawn from: its finest zoom and its tiles' side in
 * pixels. Its pixel centres are the lattice every grid is sampled on, and the
 * lines the street geometry is cut along (`cityStreets/groundLattice.ts`).
 */
export interface GroundLattice {
  zoom: number;
  tileSize: number;
  /**
   * Squares a side of MapLibre's terrain mesh on each terrain tile
   * (`Terrain.meshSize`): the facets the street detail stands on
   * (`facetAt`, `cityStreets/groundLattice.ts`).
   */
  meshCells: number;
}

/**
 * GoWay's terrain: Mapterhorn's Terrarium tiles, 512 px, to z12
 * (`lib/map/style/relief.ts` → `RELIEF_DEM`, held equal by
 * `city3dGroundLattice.test.ts`; not imported, the relief is another chunk).
 * What a street tile is cut for before any terrain is on.
 */
export const TERRAIN_LATTICE: GroundLattice = { zoom: 12, tileSize: 512, meshCells: 128 };

export const GROUND = {
  /**
   * The most DEM pixels a grid holds across one tile: GoWay's DEM at a z14
   * tile (128). A finer DEM (a foreign style's) is sampled no finer than
   * this, and then only approximately: the budget is ~17,000 samples (~7 ms
   * on the main thread) for one tile.
   */
  maxCells: 128,
  /** The least any building's foot is sunk below its centre's ground. */
  minSinkM: 2,
  /** Added to the measured centre-to-lowest-corner drop. */
  sinkMarginM: 1,
  /** A re-sample that moves no building by more than this is not uploaded. */
  epsilonM: 0.25,
  /** A vertex this close to `z = 0` is a building's foot. */
  footM: 0.01,
} as const;

/** DEM pixels across a tile — the cells of its grid — within {@link GROUND.maxCells}. */
export function latticeCells(tile: { z: number }, lattice: GroundLattice): number {
  return Math.max(1, Math.min(GROUND.maxCells, lattice.tileSize * 2 ** (lattice.zoom - tile.z)));
}

/**
 * One tile's ground: the DEM sampled at its pixel centres across the tile,
 * one pixel past each edge. Row-major from the north-west; sample `k` (column
 * or row) sits at `(k − ½) / cells` of the tile, so `size = cells + 2`.
 */
export interface GroundGrid {
  values: Float32Array;
  cells: number;
  size: number;
}

/** What the mesher records about each polygon (`TileMesh.polygonStarts`/`polygonBoxes`). */
export interface GroundTile {
  tile: TileId;
  /** The tile's side in metres (`tileSizeMetres`). */
  tileSizeM: number;
  /** Local ENU positions, 3 per vertex (the mesh's own). */
  positions?: Float32Array;
  /** First vertex of each polygon; its vertices run to the next one's. */
  polygonStarts?: Uint32Array;
  /** Each polygon's footprint box in local metres: `minX, minY, maxX, maxY`. */
  polygonBoxes: Float32Array;
  /**
   * Instead of `positions` + `polygonStarts`: lift the tile's vertices (and
   * anything else standing on it) yourself, from the placed polygons and the
   * sampled grid — what a mesh in the compact vertex format does
   * (`cityMeshes.ts` → `groundTileFor`). `out` is the last result's buffer.
   */
  lift?: (
    placed: PolygonGround,
    grid: GroundGrid,
    out?: Float32Array,
  ) => { values: Float32Array; min: number; max: number };
}

/** Sample the ground over a tile on its DEM lattice ({@link GroundGrid}). */
export function sampleGroundGrid(tile: TileId, cells: number, sample: GroundSampler): GroundGrid {
  const n = 2 ** tile.z;
  const size = cells + 2;
  const values = new Float32Array(size * size);
  const lngs = new Float64Array(size);
  for (let i = 0; i < size; i++) lngs[i] = ((tile.x + (i - 0.5) / cells) / n) * 360 - 180;
  for (let j = 0; j < size; j++) {
    const lat = latFromMercatorY((tile.y + (j - 0.5) / cells) / n);
    for (let i = 0; i < size; i++) {
      const elevation = sample(lngs[i], lat);
      values[j * size + i] = Number.isFinite(elevation) ? elevation : 0;
    }
  }
  return { values, cells, size };
}

/**
 * The ground of a tile, as buildings, trees, streets, models and city life
 * stand on it: the DRAWN terrain itself, on the DEM's own lattice.
 *
 * Not de-noised. #126 opened it (a minimum then maximum filter, ~145 m) on the
 * premise that the terrain is Copernicus GLO-30, a surface model that records
 * roofs. Measured since (`docs/MAP_TERRAIN_GLOBE.md` → "The ground is the
 * drawn terrain"): in Barcelona, Madrid and Manhattan Mapterhorn's z12 tiles
 * are the national BARE-EARTH models — no Empire State, no Cuatro Torres, no
 * Eixample — so the opening removed nothing there but real hilltops, and
 * buried the buildings on Carmel's and Collserola's knolls up to 17 m into the
 * hillside MapLibre draws. Where the terrain is GLO-30 (no national model),
 * the roads and labels drape over the same bumps; standing on what is drawn
 * keeps everything on one surface.
 */
export function groundGrid(
  tile: TileId,
  sample: GroundSampler,
  lattice: GroundLattice,
): GroundGrid {
  return sampleGroundGrid(tile, latticeCells(tile, lattice), sample);
}

/**
 * The drawn ground for everything that stands on it — buildings, trees, the
 * street detail, city life, live vehicles, models: the sampler, its lattice,
 * and each tile's grid sampled ONCE per terrain and kept (least recently used
 * past `maxTiles`). Before this the buildings' grounder and city life each
 * sampled and cached the same z15 grids, and the live layer asked MapLibre
 * per point (`docs/MAP_PERFORMANCE.md` → duplication).
 */
export interface Ground {
  /** Metres as drawn at a point (`map.terrain`'s finest DEM tile, ~0.4 µs a call). */
  readonly sample: GroundSampler;
  /** The DEM's lattice the grids are sampled on. */
  readonly lattice: GroundLattice;
  /** A tile's grid ({@link groundGrid}), sampled on first use. */
  grid(tile: TileId): GroundGrid;
  /** Whether {@link Ground.grid} would answer without sampling. */
  hasGrid(tile: TileId): boolean;
}

export function createGround(
  sample: GroundSampler,
  lattice: GroundLattice = TERRAIN_LATTICE,
  maxTiles = 256,
): Ground {
  const grids = new Map<string, GroundGrid>();
  const key = (tile: TileId) => `${tile.z}/${tile.x}/${tile.y}`;
  return {
    sample,
    lattice,
    grid(tile) {
      const k = key(tile);
      let grid = grids.get(k);
      if (grid) {
        // Most recently used last.
        grids.delete(k);
      } else {
        grid = groundGrid(tile, sample, lattice);
        if (grids.size >= maxTiles) grids.delete(grids.keys().next().value as string);
      }
      grids.set(k, grid);
      return grid;
    },
    hasGrid: (tile) => grids.has(key(tile)),
  };
}

/**
 * The ground at `u` east, `v` south across the grid's tile (both 0–1): the
 * DEM read bilinearly between the four pixel centres around the point —
 * MapLibre's `get_elevation`, on the CPU. The street detail's vertex shader
 * reads its atlas with the same arithmetic (`cityStreets/streetMaterials.ts`).
 */
export function gridAt(grid: GroundGrid, u: number, v: number): number {
  const { values, cells, size } = grid;
  // As far as the grid reaches — a pixel past each edge, where geometry owned
  // by this tile overhangs it — and held at its last sample beyond.
  const x = Math.max(0, Math.min(cells + 1, u * cells + 0.5));
  const y = Math.max(0, Math.min(cells + 1, v * cells + 0.5));
  const i = Math.min(cells, Math.floor(x));
  const j = Math.min(cells, Math.floor(y));
  const fx = x - i;
  const fy = y - j;
  const a = values[j * size + i];
  const b = values[j * size + i + 1];
  const c = values[(j + 1) * size + i];
  const d = values[(j + 1) * size + i + 1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/**
 * The ground the street detail stands on, at `u` east, `v` south across the
 * grid's tile: MapLibre's terrain mesh on THAT tile as a terrain tile — `cells`
 * squares a side (`GroundLattice.meshCells`, 128), each corner the DEM read
 * bilinearly ({@link gridAt}, `get_elevation`), each square two flat triangles
 * split from its north-west corner to its south-east one, MapLibre's own
 * split. For a z15 street tile that is exactly the mesh MapLibre draws on its
 * z15 terrain tile (`city3dTerrainSampler.test.ts`); finer terrain tiles
 * subdivide each facet toward {@link gridAt}.
 *
 * Why facets, not the bilinear surface: a GPU draws a triangle flat, and the
 * street's layers — asphalt, kerbs, paint, words — are different triangles
 * over the same ground. Over a curved ground two layers' flat pieces part (by
 * centimetres where the DEM is creased) and the asphalt rose through the
 * paint: letters missing, measured on Balmes and Margarit. Every street piece
 * is cut to one facet (`cityStreets/groundLattice.ts`), so every layer lies on
 * the same plane there. The vertex shader does the same arithmetic
 * (`cityStreets/streetMaterials.ts`).
 */
export function facetAt(grid: GroundGrid, u: number, v: number, cells: number): number {
  const x = u * cells;
  const y = v * cells;
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  const at = (di: number, dj: number) => gridAt(grid, (i + di) / cells, (j + dj) / cells);
  const tl = at(0, 0);
  const br = at(1, 1);
  if (fy >= fx) {
    const bl = at(0, 1);
    return tl + (bl - tl) * fy + (br - bl) * fx;
  }
  const tr = at(1, 0);
  return tl + (tr - tl) * fx + (br - tr) * fy;
}

/**
 * Corners past each edge of a tile that its street ground holds: a piece the
 * tile owns (a junction, a strip's last step) overhangs it by up to a DEM
 * pixel, two mesh squares.
 */
export const STREET_GROUND_MARGIN = 2;

/**
 * The ground the street detail stands on, per corner of MapLibre's terrain
 * mesh over a street tile (`cells` squares a side, {@link STREET_GROUND_MARGIN}
 * past each edge), row-major from the north-west: each corner's height on
 * the z15 mesh ({@link facetAt}), RAISED by the most the terrain can rise
 * above that mesh in the squares around the corner on any finer terrain tile.
 *
 * Inside a square the DEM is one bilinear patch (the mesh's lines run on and
 * halfway between the pixel centres), whose corners the facets meet; it
 * departs from the two facets only by its twist `d = tl + br − tr − bl`, by
 * `−d · fx · (1 − fy)` — above them where `d < 0`, by at most `−d / 4` at the
 * diagonal's middle, and finer terrain meshes interpolate that patch, so they
 * rise no higher. Each corner takes the largest such rise of the (up to four)
 * squares round it; read facet-wise ({@link streetGroundAt}), the result is
 * at or above every square's rise, so the street is never under the terrain
 * MapLibre draws at street level (z15–z18 tiles; `city3dTerrainSampler.test.ts`),
 * and still flat on each facet, so the street's layers stay one plane.
 * Measured on Barcelona street tiles: 1.6 cm at the median, 6–9 cm at p95.
 */
export interface StreetGround {
  values: Float32Array;
  /** Mesh squares across the tile. */
  cells: number;
  /** Corners across the grid: `cells + 1 + 2 · STREET_GROUND_MARGIN`. */
  size: number;
}

export function streetGround(grid: GroundGrid, cells: number): StreetGround {
  const m = STREET_GROUND_MARGIN;
  const size = cells + 1 + 2 * m;
  const heights = new Float64Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++)
      heights[j * size + i] = gridAt(grid, (i - m) / cells, (j - m) / cells);
  }
  // Each square's rise above its facets: −twist / 4 where the twist is negative.
  const rise = new Float64Array((size - 1) * (size - 1));
  for (let j = 0; j + 1 < size; j++) {
    for (let i = 0; i + 1 < size; i++) {
      const twist =
        heights[j * size + i] +
        heights[(j + 1) * size + i + 1] -
        heights[j * size + i + 1] -
        heights[(j + 1) * size + i];
      rise[j * (size - 1) + i] = Math.max(0, -twist) / 4;
    }
  }
  const values = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let most = 0;
      for (const [di, dj] of [
        [-1, -1],
        [0, -1],
        [-1, 0],
        [0, 0],
      ]) {
        const ci = i + di;
        const cj = j + dj;
        if (ci < 0 || cj < 0 || ci >= size - 1 || cj >= size - 1) continue;
        most = Math.max(most, rise[cj * (size - 1) + ci]);
      }
      values[j * size + i] = heights[j * size + i] + most;
    }
  }
  return { values, cells, size };
}

/** {@link StreetGround} at `u` east, `v` south across its tile: facet-wise, as the street's vertex shader reads it. */
export function streetGroundAt(ground: StreetGround, u: number, v: number): number {
  const { values, cells, size } = ground;
  const m = STREET_GROUND_MARGIN;
  const x = Math.max(0, Math.min(size - 1, u * cells + m));
  const y = Math.max(0, Math.min(size - 1, v * cells + m));
  const i = Math.min(size - 2, Math.floor(x));
  const j = Math.min(size - 2, Math.floor(y));
  const fx = x - i;
  const fy = y - j;
  const tl = values[j * size + i];
  const br = values[(j + 1) * size + i + 1];
  if (fy >= fx) {
    const bl = values[(j + 1) * size + i];
    return tl + (bl - tl) * fy + (br - bl) * fx;
  }
  const tr = values[j * size + i + 1];
  return tl + (tr - tl) * fx + (br - tr) * fy;
}

export interface PolygonGround {
  /** The ground at each polygon's centre: what its roof and walls stand on. */
  anchor: Float32Array;
  /** How far below `anchor` each polygon's foot reaches. */
  sink: Float32Array;
}

/** Place every polygon of a tile on a sampled grid. */
export function polygonGround(
  grid: GroundGrid,
  tileSizeM: number,
  boxes: Float32Array,
): PolygonGround {
  const count = boxes.length / 4;
  const anchor = new Float32Array(count);
  const sink = new Float32Array(count);
  // Local ENU: x east from the west edge, y NORTH from the north edge (so ≤ 0).
  const u = (x: number) => x / tileSizeM;
  const v = (y: number) => -y / tileSizeM;
  for (let p = 0; p < count; p++) {
    const minX = boxes[p * 4];
    const minY = boxes[p * 4 + 1];
    const maxX = boxes[p * 4 + 2];
    const maxY = boxes[p * 4 + 3];
    const centre = gridAt(grid, u((minX + maxX) / 2), v((minY + maxY) / 2));
    const lowest = Math.min(
      centre,
      gridAt(grid, u(minX), v(minY)),
      gridAt(grid, u(maxX), v(minY)),
      gridAt(grid, u(minX), v(maxY)),
      gridAt(grid, u(maxX), v(maxY)),
    );
    anchor[p] = centre;
    sink[p] = Math.max(GROUND.minSinkM, centre - lowest + GROUND.sinkMarginM);
  }
  return { anchor, sink };
}

/**
 * One lift per vertex: its polygon's `anchor`, less its `sink` at the foot.
 * Writes into `out` when it is the right length (an update in place of the
 * buffer already on the GPU), and returns the range of lifts for the bounds.
 */
export function vertexGround(
  positions: Float32Array,
  polygonStarts: Uint32Array,
  ground: PolygonGround,
  out?: Float32Array,
): { values: Float32Array; min: number; max: number } {
  const vertices = positions.length / 3;
  const values = out && out.length === vertices ? out : new Float32Array(vertices);
  let min = Infinity;
  let max = -Infinity;
  for (let p = 0; p < polygonStarts.length; p++) {
    const end = p + 1 < polygonStarts.length ? polygonStarts[p + 1] : vertices;
    const top = ground.anchor[p];
    const foot = top - ground.sink[p];
    if (foot < min) min = foot;
    if (top > max) max = top;
    for (let v = polygonStarts[p]; v < end; v++) {
      values[v] = positions[v * 3 + 2] <= GROUND.footM ? foot : top;
    }
  }
  if (min > max) {
    min = 0;
    max = 0;
  }
  return { values, min, max };
}

/** The largest absolute difference between two equal-length arrays. */
export function largestChange(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return Infinity;
  let largest = 0;
  for (let i = 0; i < a.length; i++) {
    const change = Math.abs(a[i] - b[i]);
    if (change > largest) largest = change;
  }
  return largest;
}

/** The largest change in a polygon's FOOT lift (`anchor − sink`) between two placements. */
export function largestFootChange(a: PolygonGround, b: PolygonGround): number {
  if (a.anchor.length !== b.anchor.length) return Infinity;
  let largest = 0;
  for (let i = 0; i < a.anchor.length; i++) {
    const change = Math.abs(a.anchor[i] - a.sink[i] - (b.anchor[i] - b.sink[i]));
    if (change > largest) largest = change;
  }
  return largest;
}

export interface GroundResult {
  /** One lift per vertex, in metres. */
  values: Float32Array;
  /** Lowest and highest lift, for the mesh's bounds. */
  min: number;
  max: number;
  /** Whether `values` differ from what was last returned for this tile. */
  changed: boolean;
}

export interface GroundStats {
  /** Terrain changes reported by the host (each one makes every tile stale). */
  refreshes: number;
  /** Tile groundings, in all. */
  tilesGrounded: number;
  /** Of those, how many moved by more than `epsilonM` and were (re-)uploaded. */
  tilesUploaded: number;
  /** Time spent sampling the last tile's grid, and placing its buildings. */
  lastSampleMs: number;
  lastPlaceMs: number;
}

interface TileState {
  version: number;
  anchor: Float32Array;
  sink: Float32Array;
  /** The sampled grid, kept when the tile lifts itself (it may lift more than polygons). */
  grid?: GroundGrid;
  result: GroundResult;
}

/**
 * Which tiles are grounded against the current terrain, and their lifts.
 *
 * The host swaps the sampler whenever the terrain changes (switched on or off,
 * a DEM tile arrived); that makes every tile stale, and the engine re-grounds
 * stale tiles a few per frame. A re-ground that moves nothing returns the old
 * buffer with `changed: false`, so a terrain refresh far from the city costs a
 * grid of samples per tile and no upload.
 */
export class TileGrounder {
  private source: Ground | null = null;
  private version = 0;
  private readonly tiles = new Map<string, TileState>();
  private stats: GroundStats = {
    refreshes: 0,
    tilesGrounded: 0,
    tilesUploaded: 0,
    lastSampleMs: 0,
    lastPlaceMs: 0,
  };

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly onStats?: (stats: GroundStats) => void,
  ) {}

  /** `null`: no terrain, buildings stand at `z = 0`. */
  setGround(ground: Ground | null): void {
    this.source = ground;
    this.version++;
    this.stats.refreshes++;
  }

  get active(): boolean {
    return this.source !== null;
  }

  /** Grounded against the CURRENT terrain. */
  isCurrent(key: string): boolean {
    return this.tiles.get(key)?.version === this.version;
  }

  /** Grounded at all — possibly against an older terrain, which is still close. */
  hasGround(key: string): boolean {
    return this.tiles.has(key);
  }

  /** The last result for a tile, current or not. */
  resultFor(key: string): GroundResult | null {
    return this.tiles.get(key)?.result ?? null;
  }

  /** Ground one tile against the current sampler. `null` with no sampler. */
  ground(key: string, tile: GroundTile): GroundResult | null {
    const ground = this.source;
    if (!ground) return null;
    const started = this.now();
    const grid = ground.grid(tile.tile);
    const sampled = this.now();
    const placed = polygonGround(grid, tile.tileSizeM, tile.polygonBoxes);
    const previous = this.tiles.get(key);
    let result: GroundResult;
    // Compare the two lifts the GPU actually draws — the roof (`anchor`) and
    // the foot (`anchor − sink`) — not their parts: a centre and a sink that
    // each move by less than epsilon in opposite directions move the foot by
    // up to twice it (PR #124 review).
    // A tile that lifts itself may stand more than its polygons on the
    // ground (trees), so the grid itself must also have held still.
    if (
      previous &&
      largestChange(previous.anchor, placed.anchor) <= GROUND.epsilonM &&
      largestFootChange(previous, placed) <= GROUND.epsilonM &&
      (!tile.lift ||
        (previous.grid !== undefined &&
          largestChange(previous.grid.values, grid.values) <= GROUND.epsilonM))
    ) {
      result = { ...previous.result, changed: false };
      this.tiles.set(key, { ...previous, version: this.version, result });
    } else {
      const lifted = tile.lift
        ? tile.lift(placed, grid, previous?.result.values)
        : vertexGround(
            tile.positions ?? new Float32Array(0),
            tile.polygonStarts ?? new Uint32Array(0),
            placed,
            previous?.result.values,
          );
      result = { ...lifted, changed: true };
      this.tiles.set(key, {
        version: this.version,
        ...placed,
        ...(tile.lift ? { grid } : {}),
        result,
      });
      this.stats.tilesUploaded++;
    }
    this.stats.tilesGrounded++;
    this.stats.lastSampleMs = sampled - started;
    this.stats.lastPlaceMs = this.now() - sampled;
    this.onStats?.({ ...this.stats });
    return result;
  }

  forget(key: string): void {
    this.tiles.delete(key);
  }

  clear(): void {
    this.tiles.clear();
  }
}
