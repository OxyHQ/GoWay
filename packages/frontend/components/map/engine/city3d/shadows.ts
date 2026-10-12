/**
 * Where the sun's shadow map looks, and when it must be redrawn — pure
 * arithmetic, no renderer, pinned by `__tests__/city3dShadows.test.ts`.
 *
 * ## One orthographic map, fitted to a box that does not follow every pan
 *
 * The buildings cast into ONE shadow map rendered from the sun with an
 * orthographic camera (`sky.ts` draws it). The textbook fit — re-fit the light
 * to the view frustum every frame — re-renders every building every frame and
 * makes shadow edges crawl as the camera moves (the texel grid slides under
 * them). A map pans constantly, so this does the opposite:
 *
 *  - **The receivers are a square box round the map centre**, with a radius
 *    from the view ({@link shadowRadiusForView}), rounded UP to a step of √2
 *    ({@link shadowFrame}). Small zoom changes keep the same box.
 *  - **The box centre snaps to a grid** of an eighth of its radius, in
 *    absolute mercator. Panning less than that changes nothing — same
 *    {@link ShadowFrame.key}, same matrix — so the cached map is reused and
 *    the engine does not redraw it (`sky.ts`). The box is grown by the grid
 *    step so the snapped box still covers the true one.
 *  - **The box is turned to face the sun**, so in the light's view it is an
 *    axis-aligned rectangle: its width is the box's, and its height is the box's
 *    depth foreshortened by the sun's altitude plus the tallest building's
 *    projection. Nothing is wasted on the √2 corners of a rotated square, and a
 *    low sun — the long, beautiful shadows — gets MORE resolution, not less.
 *  - **The window is snapped to whole texels in absolute light space**, so when
 *    the box does move, every shadow edge lands on the same sub-texel position
 *    it had before: no shimmer at the snap.
 *
 * Everything is float64 and in ABSOLUTE mercator; {@link shadowMatrixForCentre}
 * composes it with the camera centre each frame, so what reaches the GPU is
 * the same small, centre-relative numbers `tileMath.ts` uses (and for the same
 * float32 reason).
 *
 * ## Frames
 *
 * Mercator is `tileMath.ts`'s: x east, y SOUTH, z up, conformal (one unit up
 * is one unit across at that latitude). The sun comes in as compass azimuth
 * and altitude, and is turned into mercator by flipping its north component.
 */
import { QUALITY_PRESETS } from '@/lib/map/quality/profile';

import type { CitySun } from './atmosphere';
import {
  type LngLatBox,
  mercatorPerMetre,
  mercatorXFromLng,
  mercatorYFromLat,
  type TileId,
  tileCenterLatitude,
} from './tileMath';

/**
 * Shadow map side, in texels, at the high quality preset (2048² of 24-bit
 * depth is 16 MB); the active preset's is `engine/quality.ts`'s.
 */
export const SHADOW_MAP_SIZE: number = QUALITY_PRESETS.high.sky.shadowMapSize;

/** No shadows below this sun altitude: the map would be a few texels of streak. */
export const SHADOW_MIN_ALTITUDE_DEG = 0.5;

/** The tallest caster the light's depth range is sized for, in metres. */
export const SHADOW_MAX_HEIGHT_M = 600;

/** The box's ground elevation is rounded to this, metres (see `shadowFrame` → `groundM`). */
export const SHADOW_GROUND_STEP_M = 10;

/** How far the terrain may rise or fall across the box from its centre, metres. */
export const SHADOW_SLOPE_M = 150;

/**
 * The latitude the box's metres are measured at is the centre's, rounded to
 * this, degrees (≈ 28 km). Mercator's scale runs with latitude, and the box's
 * snap grid is anchored at mercator 0: measured at the LIVE latitude, a pan
 * north or south rescaled the grid — and moved every snapped coordinate by
 * about 2.5 m per metre panned (the grid index is ~10⁵) — while the key stayed
 * the same, so the cached map was read through a matrix it was not drawn
 * with: shadows slid off their casters, or lit and unlit wholesale, until
 * the next redraw snapped them back (the flicker on a pan, and the ground's
 * missing shadows). Rounded, equal keys mean identical matrices again; the
 * scale error it leaves (≤ 0.4 % at 60°) only sizes the box.
 */
export const SHADOW_LATITUDE_STEP_DEG = 0.25;

/** The receiver box's radius is clamped to this, in metres. */
export const SHADOW_RADIUS_RANGE_M: readonly [number, number] = [300, 1400];

const DEG = Math.PI / 180;

export interface ShadowFrame {
  /** Equal keys ⇒ identical matrices: the cached shadow map is still valid. */
  key: string;
  /** Column-major 4×4: ABSOLUTE mercator → shadow clip (`[-1, 1]³`). float64. */
  lightFromMercator: number[];
  /** The box's radius in metres, after rounding (the box is this plus the grid step). */
  radiusM: number;
  /** Metres per shadow-map texel across the light's view. */
  texelM: number;
  /** How much stored depth (`0…1`) one metre along the light is: sizes the bias. */
  depthPerMetre: number;
}

/**
 * How large a receiver box the view needs: the distance from the map centre
 * to its farthest visible corner, clamped to {@link SHADOW_RADIUS_RANGE_M}.
 * Under a steep pitch the bounds run to the horizon and this is the clamp;
 * shadows fade out at the box's edge (`skyShaders.ts`).
 */
export function shadowRadiusForView(
  bounds: LngLatBox,
  center: { lng: number; lat: number },
): number {
  const k = mercatorPerMetre(center.lat);
  const cx = mercatorXFromLng(center.lng);
  const cy = mercatorYFromLat(center.lat);
  let farthest = 0;
  for (const lng of [bounds.west, bounds.east]) {
    for (const lat of [bounds.south, bounds.north]) {
      const dx = mercatorXFromLng(lng) - cx;
      const dy = mercatorYFromLat(lat) - cy;
      farthest = Math.max(farthest, Math.hypot(dx, dy) / k);
    }
  }
  if (!Number.isFinite(farthest)) return SHADOW_RADIUS_RANGE_M[1];
  return Math.max(SHADOW_RADIUS_RANGE_M[0], Math.min(SHADOW_RADIUS_RANGE_M[1], farthest));
}

/** The sun's direction in mercator (x east, y south, z up), unit length. */
export function sunMercatorDirection(sun: CitySun): [number, number, number] {
  const az = sun.azimuthDeg * DEG;
  const alt = sun.altitudeDeg * DEG;
  return [Math.sin(az) * Math.cos(alt), -Math.cos(az) * Math.cos(alt), Math.sin(alt)];
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(v: number[]): number[] {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

function cross(a: readonly number[], b: readonly number[]): number[] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * The shadow camera for a sun, a map centre and a wanted receiver radius, or
 * `null` when the sun is too low to cast anything worth a map.
 *
 * `sun` is the REAL sun (`lib/map/sun.ts`), not the shaped light `building-3d`
 * is lit by: a shadow is geometry, and its length is the fact a reader takes
 * from it.
 */
export function shadowFrame(input: {
  sun: CitySun;
  center: { lng: number; lat: number };
  radiusM: number;
  mapSize?: number;
  /**
   * The ground's elevation near the centre, metres (3D terrain; 0 without):
   * the box runs from a slope's worth below it to the tallest caster above.
   * Rounded to {@link SHADOW_GROUND_STEP_M}, so a terrain sample's jitter does
   * not redraw the map.
   */
  groundM?: number;
}): ShadowFrame | null {
  const { sun, center } = input;
  if (!(sun.altitudeDeg >= SHADOW_MIN_ALTITUDE_DEG)) return null;
  if (!Number.isFinite(sun.azimuthDeg) || !Number.isFinite(center.lat)) return null;
  const size = input.mapSize ?? SHADOW_MAP_SIZE;
  // Everything below scales with `k`: it must not move while the key stands.
  const latStep = Math.round(center.lat / SHADOW_LATITUDE_STEP_DEG);
  const k = mercatorPerMetre(latStep * SHADOW_LATITUDE_STEP_DEG);

  // Radius rounded up to a power of √2 metres: stable across small zooms.
  const wanted = Math.max(1, input.radiusM);
  const step = Math.ceil(Math.log2(wanted) * 2);
  const radiusM = 2 ** (step / 2);
  const gridM = radiusM / 8;
  const halfM = radiusM + gridM;

  // Snapped centre, in absolute mercator.
  const gridMerc = gridM * k;
  const ix = Math.round(mercatorXFromLng(center.lng) / gridMerc);
  const iy = Math.round(mercatorYFromLat(center.lat) / gridMerc);
  const origin = [ix * gridMerc, iy * gridMerc, 0];

  // The light's basis, in mercator: `f` looks from the sun, `r` is horizontal
  // and square to the sun's azimuth, `u` completes it (towards the sun's side
  // of the sky). A sun at the zenith has no azimuth; any horizontal `r` will
  // do, and east is chosen.
  const s = sunMercatorDirection(sun);
  const f = [-s[0], -s[1], -s[2]];
  const horizontal = Math.hypot(s[0], s[1]);
  const r = horizontal > 1e-6 ? normalize([s[1], -s[0], 0]) : [1, 0, 0];
  const u = normalize(cross(r, f));

  // The receiver box, turned to the sun: `along` points at the sun's azimuth
  // on the ground, `across` is `r`. Its corners at the ground and at the
  // tallest caster's height.
  const along = horizontal > 1e-6 ? [s[0] / horizontal, s[1] / horizontal, 0] : [0, -1, 0];
  const halfMerc = halfM * k;
  const groundM =
    Math.round((Number.isFinite(input.groundM) ? (input.groundM ?? 0) : 0) / SHADOW_GROUND_STEP_M) *
    SHADOW_GROUND_STEP_M;
  const bottom = (groundM - SHADOW_SLOPE_M) * k;
  const top = (groundM + SHADOW_SLOPE_M + SHADOW_MAX_HEIGHT_M) * k;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const a of [-1, 1]) {
    for (const b of [-1, 1]) {
      for (const h of [bottom, top]) {
        const p = [(a * along[0] + b * r[0]) * halfMerc, (a * along[1] + b * r[1]) * halfMerc, h];
        const x = dot(p, r);
        const y = dot(p, u);
        const z = dot(p, f);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
      }
    }
  }
  // Half-extents of the window, padded by a texel for the PCF footprint.
  const halfX = ((maxX - minX) / 2) * (1 + 2 / size);
  const halfY = ((maxY - minY) / 2) * (1 + 2 / size);
  const texelX = (2 * halfX) / size;
  const texelY = (2 * halfY) / size;

  // The window's centre, in ABSOLUTE light coordinates, snapped to whole
  // texels so a moved box keeps every edge on the same sub-texel offset.
  const cx = Math.round((dot(origin, r) + (minX + maxX) / 2) / texelX) * texelX;
  const cy = Math.round((dot(origin, u) + (minY + maxY) / 2) / texelY) * texelY;
  // Depth: a margin both ways so nothing at the box's rim is clipped.
  const margin = (maxZ - minZ) * 0.02 + 1e-12;
  const near = dot(origin, f) + minZ - margin;
  const far = dot(origin, f) + maxZ + margin;
  const depthScale = 2 / (far - near);

  // Rows: clip = (p·r − cx)/halfX, (p·u − cy)/halfY, 2(p·f − near)/(far − near) − 1.
  const m = new Array<number>(16).fill(0);
  m[0] = r[0] / halfX;
  m[4] = r[1] / halfX;
  m[8] = r[2] / halfX;
  m[12] = -cx / halfX;
  m[1] = u[0] / halfY;
  m[5] = u[1] / halfY;
  m[9] = u[2] / halfY;
  m[13] = -cy / halfY;
  m[2] = f[0] * depthScale;
  m[6] = f[1] * depthScale;
  m[10] = f[2] * depthScale;
  m[14] = -near * depthScale - 1;
  m[15] = 1;

  const sunKey = `${sun.azimuthDeg.toFixed(2)},${sun.altitudeDeg.toFixed(2)}`;
  return {
    key: `${step}:${latStep}:${ix}:${iy}:${sunKey}:${size}:${groundM}`,
    lightFromMercator: m,
    radiusM,
    texelM: Math.max(texelX, texelY) / k,
    depthPerMetre: k / (far - near),
  };
}

/**
 * {@link ShadowFrame.lightFromMercator} for positions RELATIVE to `center`
 * (mercator) — what the GPU gets, because the meshes' model matrices are
 * centre-relative (`tileModelMatrix`). Composed in float64: the absolute
 * translation cancels here, not in float32 on the GPU.
 */
export function shadowMatrixForCentre(
  frame: ShadowFrame,
  center: { x: number; y: number },
): number[] {
  const m = frame.lightFromMercator.slice();
  for (let row = 0; row < 3; row++) {
    m[12 + row] += m[row] * center.x + m[4 + row] * center.y;
  }
  return m;
}

/**
 * The same matrix for positions in ENU METRES relative to `center` (what the
 * ground pass reconstructs per pixel): mercator = (x·k, −y·k, z·k).
 */
export function shadowMatrixForEnu(
  frame: ShadowFrame,
  center: { x: number; y: number },
  mercatorPerMetreAtCentre: number,
): number[] {
  const m = shadowMatrixForCentre(frame, center);
  const k = mercatorPerMetreAtCentre;
  for (let row = 0; row < 3; row++) {
    m[row] *= k;
    m[4 + row] *= -k;
    m[8 + row] *= k;
  }
  return m;
}

/**
 * Whether anything in `tile` (drawn in world copy `wrap`) can cast into the
 * shadow map of `frame`: its box — the tile square from a slope below the
 * box's ground to the tallest caster above it — overlaps the light's window.
 * Conservative (a box, not the buildings), and what the shadow map's cache key
 * is made of: a tile that comes into view beyond the shadow box does not make
 * the map stale (`frameSelection.ts` → `castersKey`).
 */
export function castsInto(
  frame: ShadowFrame,
  tile: TileId,
  wrap: number,
  groundM: number,
): boolean {
  const n = 2 ** tile.z;
  const k = mercatorPerMetre(tileCenterLatitude(tile));
  const xs = [tile.x / n + wrap, (tile.x + 1) / n + wrap];
  const ys = [tile.y / n, (tile.y + 1) / n];
  const zs = [(groundM - SHADOW_SLOPE_M) * k, (groundM + SHADOW_SLOPE_M + SHADOW_MAX_HEIGHT_M) * k];
  const m = frame.lightFromMercator;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const x of xs) {
    for (const y of ys) {
      for (const z of zs) {
        const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
        const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
        minX = Math.min(minX, cx);
        maxX = Math.max(maxX, cx);
        minY = Math.min(minY, cy);
        maxY = Math.max(maxY, cy);
      }
    }
  }
  return maxX >= -1 && minX <= 1 && maxY >= -1 && minY <= 1;
}
