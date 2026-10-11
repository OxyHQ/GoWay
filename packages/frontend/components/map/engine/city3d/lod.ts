/**
 * Which tiles the city-3D engine draws, and at which level of detail.
 *
 * The prototype drew the nearest six z14 tiles and nothing else, so a tilted
 * camera showed flat footprints past them (`docs/MAP_3D_CITY.md` → "LOD and
 * loading"). This draws EVERY tile the camera can see, out to a distance limit,
 * each at the level its distance affords (`lodMesher.ts`):
 *
 *  1. **Where the camera is.** The eye is recovered from the host's mercator →
 *     clip matrix (it is the point the projection sends to infinity), so the
 *     engine stays host-neutral: no MapLibre camera API is read.
 *  2. **What it sees.** The six frustum planes come from the same matrix
 *     (Gribb–Hartmann). A tile is a candidate when its box — the tile square,
 *     from the ground to {@link LodPolicy.boxHeightM} — is not wholly outside
 *     any plane. MapLibre's own far plane ends at the top of the screen, so
 *     the horizon bounds the set at the pitches GoWay allows.
 *  3. **How far it is.** Distance is measured from the eye to the nearest
 *     point of the tile's square, in units of the eye's distance to the point
 *     under the screen centre (`r`). Measured that way the thresholds do not
 *     depend on latitude: at `r` the screen shows `r` times fewer pixels per
 *     metre than at the centre. Each level's thresholds come from its
 *     geometric error ({@link LodPolicy.levelErrorM}) and the screen scale,
 *     so the error is never more than {@link LodPolicy.pixelTolerance} pixels
 *     ({@link lodThresholds}); zoomed in, full detail reaches further.
 *  4. **Budgets.** At most {@link LodPolicy.maxFullTiles} tiles at full
 *     detail (the nearest), at most {@link LodPolicy.maxTiles} in all (the
 *     farthest dropped first), nothing beyond {@link LodPolicy.drawWithin}.
 *  5. **No flicker.** A tile keeps its previous level until it is
 *     {@link LodPolicy.hysteresis} past the threshold, so a camera resting on
 *     a boundary does not swap meshes back and forth.
 *
 * At GoWay's 60° maximum pitch the visible ground spans roughly `r` 0.65 → 2.5
 * (bottom edge → top edge). At zoom 16 in Barcelona (0.9 m/px) full detail
 * reaches `r` 1.7 and level 1 `r` 6.7, so a 60° view is levels 0 and 1; a
 * steeper camera (a flyover, a free camera) sees level 2 toward the horizon.
 *
 * Pure arithmetic, tested in `__tests__/city3dLod.test.ts`.
 */
import { QUALITY_PRESETS } from '@/lib/map/quality/profile';

import {
  EARTH_CIRCUMFERENCE_M,
  latFromMercatorY,
  type LngLatBox,
  mercatorPerMetre,
  mercatorXFromLng,
  mercatorYFromLat,
  type ViewTile,
  tileKey,
} from './tileMath';

/** A building level of detail: 0 full, 1 simple, 2 coarse (`lodMesher.ts`). */
export type Lod = 0 | 1 | 2;

export interface LodPolicy {
  /** Most tiles drawn at full detail; the nearest win. */
  maxFullTiles: number;
  /** Most tiles drawn at all; the farthest are dropped first. */
  maxTiles: number;
  /**
   * How far levels 1 and 2 may stray from level 0, metres: level 1 drops the
   * 0.7 m bevel and moves an edge up to 1 m; level 2 up to 4 m and fills small
   * courtyards (`lodMesher.ts`). Rounded up for the bevel's highlight.
   */
  levelErrorM: readonly [number, number];
  /** The most a level's error may cover on screen, pixels. */
  pixelTolerance: number;
  /** Floors on the level thresholds, in `r`: full detail always reaches this far … */
  minFullWithin: number;
  /** … and level 1 this far, whatever the zoom. */
  minSimpleWithin: number;
  /** Nothing is drawn beyond this `r`. */
  drawWithin: number;
  /** Fraction past a threshold a tile must go before it changes level. */
  hysteresis: number;
  /** Height of a tile's culling box, metres: tall buildings just off-screen still show. */
  boxHeightM: number;
}

/**
 * The engine's policy at the HIGH quality preset. The three budget fields
 * (`maxFullTiles`, `maxTiles`, `pixelTolerance`) are the quality profile's
 * (`lib/map/quality/profile.ts`), never restated here; the engine takes the
 * active preset's through `engine/quality.ts` → `cityQuality`. Budgets
 * measured against them: `docs/MAP_3D_CITY.md` → "Budgets",
 * `docs/MAP_PERFORMANCE.md`.
 */
export const LOD_POLICY: LodPolicy = {
  maxFullTiles: QUALITY_PRESETS.high.city.maxFullTiles,
  maxTiles: QUALITY_PRESETS.high.city.maxTiles,
  levelErrorM: [1.5, 6],
  pixelTolerance: QUALITY_PRESETS.high.city.pixelTolerance,
  minFullWithin: 1,
  minSimpleWithin: 2,
  drawWithin: 12,
  hysteresis: 0.1,
  boxHeightM: 250,
};

/**
 * Metres per pixel at the screen centre, in MapLibre's convention (512-pixel
 * tiles at zoom 0). Exported for the tests.
 */
export function metresPerPixel(zoom: number, lat: number): number {
  return (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);
}

/**
 * The level thresholds `[full, simple, draw]` in `r`, at a view's scale.
 *
 * An error of `e` metres at `r` covers `e / (r · metresPerPixel)` pixels (the
 * camera is one focal length, in pixels, from the centre — MapLibre's own
 * construction), so a level whose error is `e` may be drawn from
 * `r = e / (tolerance · metresPerPixel)` on. The floors keep the street in
 * front of the camera at full detail even zoomed out.
 */
export function lodThresholds(policy: LodPolicy, metresPerPx: number): [number, number, number] {
  const scale = policy.pixelTolerance * metresPerPx;
  const full = Math.max(policy.minFullWithin, policy.levelErrorM[0] / scale);
  const simple = Math.max(policy.minSimpleWithin, full, policy.levelErrorM[1] / scale);
  return [full, simple, Math.max(simple, policy.drawWithin)];
}

/** A tile to draw: where (`ViewTile`), at what level, and how far (`r`). */
export interface LodTile extends ViewTile {
  lod: Lod;
  r: number;
}

/** What the selection needs from the host's camera. */
export interface LodView {
  /** Column-major mercator `[0,1]` (conformal z) → clip, float64. */
  mercatorToClip: ArrayLike<number>;
  bounds: LngLatBox;
  /** The host's zoom and centre, for the screen scale ({@link metresPerPixel}). */
  zoom: number;
  center: { lat: number };
  /**
   * On 3D terrain: the ground under the screen centre, and a conservative
   * range of the ground the tiles stand on, metres as drawn. The host's matrix
   * then places `z` at absolute elevation, so the ground is NOT at `z = 0`:
   * distances are measured to the centre's ground, and each tile's culling box
   * spans the range plus the tallest building — a city on a 1,500 m plateau
   * otherwise culled itself against a box at sea level (PR #126 review).
   */
  terrain?: { centreM: number; minM: number; maxM: number };
}

/** A point in mercator space, `z` conformal (up). */
export interface MercatorPoint3 {
  x: number;
  y: number;
  z: number;
}

/** Inverse of a column-major 4×4, or `null` when singular. */
export function invertMat4(m: ArrayLike<number>): number[] | null {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] =
    Array.from(m);
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det || !Number.isFinite(det)) return null;
  const d = 1 / det;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * d,
    (a02 * b10 - a01 * b11 - a03 * b09) * d,
    (a31 * b05 - a32 * b04 + a33 * b03) * d,
    (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d,
    (a00 * b11 - a02 * b08 + a03 * b07) * d,
    (a32 * b02 - a30 * b05 - a33 * b01) * d,
    (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d,
    (a01 * b08 - a00 * b10 - a03 * b06) * d,
    (a30 * b04 - a31 * b02 + a33 * b00) * d,
    (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d,
    (a00 * b09 - a01 * b07 + a02 * b06) * d,
    (a31 * b01 - a30 * b03 - a32 * b00) * d,
    (a20 * b03 - a21 * b01 + a22 * b00) * d,
  ];
}

function transform(m: ArrayLike<number>, x: number, y: number, z: number, w: number): number[] {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12] * w,
    m[1] * x + m[5] * y + m[9] * z + m[13] * w,
    m[2] * x + m[6] * y + m[10] * z + m[14] * w,
    m[3] * x + m[7] * y + m[11] * z + m[15] * w,
  ];
}

/**
 * The camera's position in mercator, from its projection alone.
 *
 * A perspective projection maps the eye to clip `(0, 0, c, 0)` — the one
 * point with `w = 0` that is not at infinity in world space — so the eye is
 * `M⁻¹ · (0, 0, 1, 0)`, dehomogenised. `null` for a singular or affine
 * (orthographic) matrix.
 */
export function eyeFromProjection(mercatorToClip: ArrayLike<number>): MercatorPoint3 | null {
  const inverse = invertMat4(mercatorToClip);
  if (!inverse) return null;
  const [x, y, z, w] = transform(inverse, 0, 0, 1, 0);
  if (Math.abs(w) < 1e-30) return null;
  return { x: x / w, y: y / w, z: z / w };
}

/**
 * Where the ray through the screen centre meets the ground (`z = groundZ`,
 * mercator units; 0 without terrain), or `null` when it does not (looking at
 * or above the horizon).
 */
export function groundUnderCentre(
  mercatorToClip: ArrayLike<number>,
  groundZ = 0,
): MercatorPoint3 | null {
  const inverse = invertMat4(mercatorToClip);
  if (!inverse) return null;
  const near = transform(inverse, 0, 0, -1, 1);
  const far = transform(inverse, 0, 0, 1, 1);
  const a = { x: near[0] / near[3], y: near[1] / near[3], z: near[2] / near[3] };
  const b = { x: far[0] / far[3], y: far[1] / far[3], z: far[2] / far[3] };
  const dz = b.z - a.z;
  if (Math.abs(dz) < 1e-30) return null;
  const t = (groundZ - a.z) / dz;
  if (t < 0) return null;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: groundZ };
}

/** The six clip planes `[a, b, c, d]` (inside: `a·x + b·y + c·z + d >= 0`). */
export function frustumPlanes(m: ArrayLike<number>): number[][] {
  const row = (i: number) => [m[i], m[4 + i], m[8 + i], m[12 + i]];
  const r0 = row(0);
  const r1 = row(1);
  const r2 = row(2);
  const r3 = row(3);
  const add = (a: number[], b: number[], sign: number) => a.map((v, i) => v + sign * b[i]);
  return [
    add(r3, r0, 1),
    add(r3, r0, -1),
    add(r3, r1, 1),
    add(r3, r1, -1),
    add(r3, r2, 1),
    add(r3, r2, -1),
  ];
}

/** Whether an axis-aligned box lies wholly outside one of the planes. */
export function boxOutsideFrustum(
  planes: readonly number[][],
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): boolean {
  for (const [a, b, c, d] of planes) {
    // The box corner farthest along the plane's normal.
    const x = a >= 0 ? max[0] : min[0];
    const y = b >= 0 ? max[1] : min[1];
    const z = c >= 0 ? max[2] : min[2];
    if (a * x + b * y + c * z + d < 0) return true;
  }
  return false;
}

/**
 * The level `r` calls for, before budgets; `null` beyond the draw limit.
 * `limits` is {@link lodThresholds}' answer.
 */
export function lodForDistance(
  r: number,
  limits: readonly [number, number, number],
  hysteresis: number,
  previous?: Lod | null,
): Lod | null {
  let lod: Lod | null = r < limits[0] ? 0 : r < limits[1] ? 1 : r < limits[2] ? 2 : null;
  if (previous === undefined || previous === null) return lod;
  // Hold a finer previous level until `r` is past its limit by the margin,
  // and a coarser one until `r` is inside the finer limit by the margin.
  if (lod === null || previous < lod) {
    if (r < limits[previous] * (1 + hysteresis)) lod = previous;
  } else if (previous > lod) {
    if (r > limits[lod] * (1 - hysteresis)) lod = previous;
  }
  return lod;
}

/**
 * The tiles to draw for a view, nearest first, each with its level.
 *
 * @param previous - the levels drawn last frame, by `tileKey` (hysteresis).
 */
export function selectLodTiles(
  view: LodView,
  tileZoom: number,
  policy: LodPolicy = LOD_POLICY,
  previous?: ReadonlyMap<string, Lod>,
): LodTile[] {
  const eye = eyeFromProjection(view.mercatorToClip);
  const toZ = mercatorPerMetre(view.center.lat);
  const groundZ = (view.terrain?.centreM ?? 0) * toZ;
  if (!eye || eye.z <= groundZ) return [];
  const ground = groundUnderCentre(view.mercatorToClip, groundZ);
  // Looking at the horizon there is no ground under the centre: measure from
  // the eye's height instead (the distance it would be looking straight down).
  const height = eye.z - groundZ;
  const unit = ground ? Math.hypot(eye.x - ground.x, eye.y - ground.y, eye.z - ground.z) : height;
  if (!(unit > 0)) return [];

  const limits = lodThresholds(policy, metresPerPixel(view.zoom, view.center.lat));
  const n = 2 ** tileZoom;
  const planes = frustumPlanes(view.mercatorToClip);

  // Candidates: the bounds' tiles, within the draw limit of the eye.
  const west = view.bounds.west;
  const east = view.bounds.east < view.bounds.west ? view.bounds.east + 360 : view.bounds.east;
  // Keep the bounds in the eye's world copy.
  const shift = Math.round(eye.x - (mercatorXFromLng(west) + mercatorXFromLng(east)) / 2);
  const reach = limits[2] * unit * n;
  const ex = eye.x * n;
  const ey = eye.y * n;
  const minX = Math.max(Math.floor((mercatorXFromLng(west) + shift) * n), Math.floor(ex - reach));
  const maxX = Math.min(Math.floor((mercatorXFromLng(east) + shift) * n), Math.floor(ex + reach));
  const yOf = (lat: number) => mercatorYFromLat(lat) * n;
  const minY = Math.max(0, Math.floor(yOf(view.bounds.north)), Math.floor(ey - reach));
  const maxY = Math.min(n - 1, Math.floor(yOf(view.bounds.south)), Math.floor(ey + reach));

  const candidates: { tile: ViewTile; r: number; key: string }[] = [];
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      const x0 = x / n;
      const y0 = y / n;
      const x1 = (x + 1) / n;
      const y1 = (y + 1) / n;
      const lat = latFromMercatorY((y + 0.5) / n);
      const perMetre = mercatorPerMetre(lat);
      const bottom = (view.terrain?.minM ?? 0) * perMetre;
      const top = ((view.terrain?.maxM ?? 0) + policy.boxHeightM) * perMetre;
      if (boxOutsideFrustum(planes, [x0, y0, bottom], [x1, y1, top])) continue;
      const dx = Math.max(x0 - eye.x, 0, eye.x - x1);
      const dy = Math.max(y0 - eye.y, 0, eye.y - y1);
      const r = Math.hypot(dx, dy, height) / unit;
      if (r >= limits[2] * (1 + policy.hysteresis)) continue;
      const tile: ViewTile = { z: tileZoom, x: ((x % n) + n) % n, y, wrap: Math.floor(x / n) };
      candidates.push({ tile, r, key: tileKey(tile) });
    }
  }
  candidates.sort((a, b) => a.r - b.r || a.tile.y - b.tile.y || a.tile.x - b.tile.x);

  const out: LodTile[] = [];
  const seen = new Set<string>();
  let full = 0;
  for (const { tile, r, key } of candidates) {
    // One canonical tile is drawn once, in its nearest world copy.
    if (seen.has(key)) continue;
    let lod = lodForDistance(r, limits, policy.hysteresis, previous?.get(key));
    if (lod === null) continue;
    if (lod === 0) {
      if (full >= policy.maxFullTiles) lod = 1;
      else full++;
    }
    seen.add(key);
    out.push({ ...tile, lod, r });
    if (out.length >= policy.maxTiles) break;
  }
  return out;
}

/** The cache key of a tile's mesh at a level. */
export function lodKey(key: string, lod: Lod): string {
  return `${key}@${lod}`;
}

/** What a drawn set may cost. */
export interface DrawBudget {
  /** GPU bytes of the meshes drawn. */
  bytes: number;
  /** Vertices drawn (buildings; trees are counted separately). */
  vertices: number;
}

/** What one tile costs at one level: measured once loaded, estimated before. */
export interface TileCost {
  bytes: number;
  vertices: number;
}

/**
 * Coarsen the selection until it fits `budget`: the FARTHEST tile goes down
 * to level 2, then the next farthest, and so on; when every tile is at level
 * 2 the farthest are dropped. Near tiles are the last to give anything up, so a
 * budget squeezes the horizon, never the street in front of the camera.
 *
 * `cost` is the engine's: the measured size of a tile's mesh at a level when
 * it has one, an estimate from its other levels (or the running mean) when it
 * has not. Returns a new array, nearest first.
 */
export function fitBudget(
  tiles: readonly LodTile[],
  cost: (tile: LodTile, lod: Lod) => TileCost,
  budget: DrawBudget,
): LodTile[] {
  const out = tiles.map((tile) => ({ ...tile }));
  const costs = out.map((tile) => cost(tile, tile.lod));
  let bytes = costs.reduce((sum, c) => sum + c.bytes, 0);
  let vertices = costs.reduce((sum, c) => sum + c.vertices, 0);
  const over = () => bytes > budget.bytes || vertices > budget.vertices;
  // Farthest first.
  const order = out.map((_, i) => i).sort((a, b) => out[b].r - out[a].r);
  for (const i of order) {
    const tile = out[i];
    while (over() && tile.lod < 2) {
      const next = (tile.lod + 1) as Lod;
      const coarser = cost(tile, next);
      bytes += coarser.bytes - costs[i].bytes;
      vertices += coarser.vertices - costs[i].vertices;
      costs[i] = coarser;
      tile.lod = next;
    }
    if (!over()) break;
  }
  const dropped = new Set<number>();
  for (const i of order) {
    if (!over() || out.length - dropped.size <= 1) break;
    dropped.add(i);
    bytes -= costs[i].bytes;
    vertices -= costs[i].vertices;
  }
  return out.filter((_, i) => !dropped.has(i));
}
