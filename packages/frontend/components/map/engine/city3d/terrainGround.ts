/**
 * City-3D buildings standing ON the terrain, not at sea level.
 *
 * With 3D terrain on, MapLibre's custom-layer matrix places `z` at ABSOLUTE
 * elevation — the camera rides `elevation` metres up — so a mesh built from
 * the ground (`z = 0`) is drawn at sea level: under the hillside in Barcelona's
 * Gràcia, hundreds of metres under it in Andorra. This module works out, per
 * building, how far up to lift it, so that it sits where MapLibre draws the
 * ground. Pure: no renderer, no map engine; `cityEngine.ts` uploads the result
 * as one float per vertex and the vertex shader adds it (`shaders.ts`).
 *
 * ## What is sampled, and why a grid
 *
 * The host hands over a sampler of the RENDERED surface — on MapLibre,
 * `map.queryTerrainElevation`, which reads the DEM tiles the terrain is drawing
 * with, so a building agrees with the ground under it rather than with some
 * finer model of it. Asking it once per building is the obvious design and the
 * wrong one: a dense Barcelona tile has ~15,500 polygons, and every one needs
 * its centre and its corners. Instead each tile asks {@link GROUND.grid}² points
 * (1,089) and every building reads that grid bilinearly — the same order of
 * resolution as the terrain mesh itself (MapLibre draws each terrain tile as a
 * 128-cell grid, ≈ 9–15 m at these zooms, from DEM pixels of ≈ 15 m), at a
 * cost that does not grow with the number of buildings. Measured costs are in
 * `docs/MAP_TERRAIN_GLOBE.md`.
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

/** Ground elevation, in metres as DRAWN (terrain exaggeration included), at a point. */
export type GroundSampler = (lng: number, lat: number) => number;

export const GROUND = {
  /** Samples per tile side. 65 → cells of 1/64 of a tile: ~29 m at z14 in Barcelona. */
  grid: 65,
  /**
   * The ground is the sampled surface OPENED (minimum then maximum filter)
   * over a window of `2·radius + 1` cells — ~145 m at z14 in Barcelona; see
   * {@link openGrid} for why.
   */
  openRadius: 2,
  /** The least any building's foot is sunk below its centre's ground. */
  minSinkM: 2,
  /** Added to the measured centre-to-lowest-corner drop. */
  sinkMarginM: 1,
  /** A re-sample that moves no building by more than this is not uploaded. */
  epsilonM: 0.25,
  /** A vertex this close to `z = 0` is a building's foot. */
  footM: 0.01,
} as const;

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
    grid: Float32Array,
    out?: Float32Array,
  ) => { values: Float32Array; min: number; max: number };
}

/** Sample the ground over a tile, row-major from its north-west corner. */
export function sampleGroundGrid(tile: TileId, size: number, sample: GroundSampler): Float32Array {
  const n = 2 ** tile.z;
  const grid = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    const lat = latFromMercatorY((tile.y + j / (size - 1)) / n);
    for (let i = 0; i < size; i++) {
      const lng = ((tile.x + i / (size - 1)) / n) * 360 - 180;
      const elevation = sample(lng, lat);
      grid[j * size + i] = Number.isFinite(elevation) ? elevation : 0;
    }
  }
  return grid;
}

/**
 * The GROUND under a sampled surface: a morphological opening of the grid —
 * the minimum over a `(2·radius + 1)²` window, then the maximum of that over
 * the same window.
 *
 * Why: the terrain GoWay draws comes from a SURFACE model (Copernicus GLO-30
 * on Mapterhorn records the tops of buildings and canopy, not the bare
 * ground), so a sample that lands on a block reads its roof. Placing things on
 * those samples stood Eixample's street trees at roof height and lifted
 * buildings by their neighbours' roofs (owner report). An opening removes
 * every bump narrower than its window — a building, a block, a stand of trees
 * — and reproduces any planar slope exactly (a plain minimum would sink a
 * slope's every point by `radius` cells' worth of fall), so hills keep their
 * shape. Buildings and trees both read this grid, so they share one ground.
 * Wider structures (a stadium roof) survive it; at ~145 m that is rare in the
 * dense cities where the surface model differs from the ground at all.
 */
export function openGrid(grid: Float32Array, size: number, radius: number): Float32Array {
  if (radius <= 0) return grid;
  const pass = (input: Float32Array, pick: (a: number, b: number) => number, rows: boolean) => {
    const out = new Float32Array(input.length);
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        let value = input[j * size + i];
        for (let d = -radius; d <= radius; d++) {
          const ii = rows ? i + d : i;
          const jj = rows ? j : j + d;
          if (ii < 0 || jj < 0 || ii >= size || jj >= size) continue;
          value = pick(value, input[jj * size + ii]);
        }
        out[j * size + i] = value;
      }
    }
    return out;
  };
  // A square window is separable: rows then columns, for each filter.
  const eroded = pass(pass(grid, Math.min, true), Math.min, false);
  return pass(pass(eroded, Math.max, true), Math.max, false);
}

/**
 * The ground grid of a tile: the surface sampled on the tile's grid AND
 * twice {@link GROUND.openRadius} cells beyond each edge (the minimum filter
 * needs `radius`, the maximum filter after it `radius` more), opened, then
 * cropped to the tile — so the opening's window is never clipped inside the
 * tile, where a block touching its edge would otherwise keep its roof.
 */
export function groundGrid(tile: TileId, sample: GroundSampler): Float32Array {
  const size = GROUND.grid;
  const margin = 2 * GROUND.openRadius;
  const wide = size + 2 * margin;
  const n = 2 ** tile.z;
  const step = 1 / (size - 1);
  const grid = new Float32Array(wide * wide);
  for (let j = 0; j < wide; j++) {
    const lat = latFromMercatorY((tile.y + (j - margin) * step) / n);
    for (let i = 0; i < wide; i++) {
      const lng = ((tile.x + (i - margin) * step) / n) * 360 - 180;
      const elevation = sample(lng, lat);
      grid[j * wide + i] = Number.isFinite(elevation) ? elevation : 0;
    }
  }
  const opened = openGrid(grid, wide, GROUND.openRadius);
  const out = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    out.set(
      opened.subarray((j + margin) * wide + margin, (j + margin) * wide + margin + size),
      j * size,
    );
  }
  return out;
}

/** Bilinear read of a {@link sampleGroundGrid} grid at `u` east, `v` south, both 0–1. */
export function gridAt(grid: Float32Array, size: number, u: number, v: number): number {
  const x = Math.max(0, Math.min(1, u)) * (size - 1);
  const y = Math.max(0, Math.min(1, v)) * (size - 1);
  const i = Math.min(size - 2, Math.floor(x));
  const j = Math.min(size - 2, Math.floor(y));
  const fx = x - i;
  const fy = y - j;
  const a = grid[j * size + i];
  const b = grid[j * size + i + 1];
  const c = grid[(j + 1) * size + i];
  const d = grid[(j + 1) * size + i + 1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

export interface PolygonGround {
  /** The ground at each polygon's centre: what its roof and walls stand on. */
  anchor: Float32Array;
  /** How far below `anchor` each polygon's foot reaches. */
  sink: Float32Array;
}

/** Place every polygon of a tile on a sampled grid. */
export function polygonGround(
  grid: Float32Array,
  size: number,
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
    const centre = gridAt(grid, size, u((minX + maxX) / 2), v((minY + maxY) / 2));
    const lowest = Math.min(
      centre,
      gridAt(grid, size, u(minX), v(minY)),
      gridAt(grid, size, u(maxX), v(minY)),
      gridAt(grid, size, u(minX), v(maxY)),
      gridAt(grid, size, u(maxX), v(maxY)),
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
  grid?: Float32Array;
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
  private sampler: GroundSampler | null = null;
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
  setSampler(sampler: GroundSampler | null): void {
    this.sampler = sampler;
    this.version++;
    this.stats.refreshes++;
  }

  get active(): boolean {
    return this.sampler !== null;
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
    const sample = this.sampler;
    if (!sample) return null;
    const started = this.now();
    const grid = groundGrid(tile.tile, sample);
    const sampled = this.now();
    const placed = polygonGround(grid, GROUND.grid, tile.tileSizeM, tile.polygonBoxes);
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
        (previous.grid !== undefined && largestChange(previous.grid, grid) <= GROUND.epsilonM))
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
