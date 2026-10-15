/**
 * The contamination gate over one pixel window: a ground grid against the
 * footprints the map stands on it and the tree stands around them, and the
 * correction a set may ask for (`ground.ts` for the test itself;
 * `docs/MAP_TERRAIN_GLOBE.md` → "The archive" → Contamination).
 */
import { labelStands, MAX_STAND_M, WORLDCOVER_TREES } from './canopy';
import { type PixelWindow, pixelMercatorM, rowLatitude } from './grid';
import {
  dilate,
  type FootprintGround,
  footprintGround,
  membraneFill,
  type PixelRing,
  rasterizePolygons,
  type RingBand,
} from './ground';

/**
 * The heights a verdict is reported at (m above the plane of the open ground
 * around): 2 m is past a LiDAR DTM's own error (0.1–0.5 m) and a garden
 * wall; 5 m is past a storey and a terrace; 10 m is a building, nothing else.
 */
export const GATE_THRESHOLDS_M = [2, 5, 10] as const;

/**
 * A footprint FAILS — and a set that asks for the correction gets the ground
 * around it under it — above this: 5 m. Measured on clean LiDAR DTMs (ICGC,
 * the doc), what stands 2–5 m above its ring is ground: a building on a
 * summit, dug into a slope, a stadium's terraces; a kept building is a
 * storey and more.
 */
export const CONTAMINATION_THRESHOLD_M = 5;

/**
 * The ring of open ground a footprint is judged against: from one source
 * pixel out (so a kept building's own smear is not its ground — a 14 m pixel
 * spreads a spike 14 m) and at least 3 m (off the walls: OSM outlines are
 * within a metre or two), to 12 m beyond that.
 */
export const RING_FROM_M = 3;
export const RING_WIDTH_M = 12;

/** The ring band in window pixels, for a window of `windowPixelM` over a source of `sourcePixelM` (ground metres). */
export function ringBand(windowPixelM: number, sourcePixelM: number): RingBand {
  const fromPx = Math.max(1, Math.ceil(Math.max(RING_FROM_M, sourcePixelM) / windowPixelM));
  const toPx = fromPx + Math.max(2, Math.ceil(RING_WIDTH_M / windowPixelM));
  return { fromPx, toPx, minPixels: 12 };
}

/** What the gate judges on a window: footprints first, then tree stands. */
export interface GateLabels {
  labels: Int32Array;
  /** Labels 1…buildings are footprints; buildings+1…buildings+stands are tree stands. */
  buildings: number;
  stands: number;
  /** Pixels never taken as open ground: all tree cover (a forest too wide to judge is still not ground). */
  closed: Uint8Array | null;
}

/**
 * Burn footprints, then the tree stands around them (`labelStands`, only where
 * no footprint is), into one label grid.
 */
export function labelWindow(
  window: PixelWindow,
  polygons: readonly (readonly PixelRing[])[],
  classes: Uint8Array | null,
  windowPixelM: number,
): GateLabels {
  const labels = rasterizePolygons(window.width, window.height, polygons);
  const stands = classes
    ? labelStands(
        classes,
        window.width,
        window.height,
        labels,
        polygons.length + 1,
        Math.ceil(MAX_STAND_M / windowPixelM),
      )
    : 0;
  let closed: Uint8Array | null = null;
  if (classes) {
    closed = new Uint8Array(classes.length);
    for (let i = 0; i < classes.length; i++) closed[i] = classes[i] === WORLDCOVER_TREES ? 1 : 0;
  }
  return { labels, buildings: polygons.length, stands, closed };
}

export interface GateFootprint extends FootprintGround {
  /** Its area in square metres (pixels × the pixel's ground area at its row). */
  areaM2: number;
}

/** One kind's verdicts (footprints, or stands). */
export interface GateSummary {
  judged: GateFootprint[];
  /** Above {@link CONTAMINATION_THRESHOLD_M}. */
  failed: GateFootprint[];
  /** Too walled in by others to judge. */
  unjudged: number;
  /** Count and area (m²) above each of {@link GATE_THRESHOLDS_M}. */
  over: { thresholdM: number; count: number; areaM2: number }[];
  areaM2: number;
}

export interface GateResult {
  buildings: GateSummary;
  stands: GateSummary;
  labels: GateLabels;
  band: RingBand;
}

function summarise(judged: GateFootprint[], present: number, thresholdM: number): GateSummary {
  const area = (list: GateFootprint[]) => list.reduce((sum, f) => sum + f.areaM2, 0);
  return {
    judged,
    failed: judged.filter((f) => f.p90AboveM > thresholdM),
    unjudged: present - judged.length,
    over: GATE_THRESHOLDS_M.map((t) => {
      const over = judged.filter((f) => f.p90AboveM > t);
      return { thresholdM: t, count: over.length, areaM2: area(over) };
    }),
    areaM2: area(judged),
  };
}

/** Judge a ground grid on a window (`footprintGround` for every label). */
export function gateWindow(
  ground: Float32Array,
  window: PixelWindow,
  labels: GateLabels,
  band: RingBand,
  thresholdM = CONTAMINATION_THRESHOLD_M,
): GateResult {
  const { width, height } = window;
  const total = labels.buildings + labels.stands;
  const seen = new Uint8Array(total + 1);
  for (const label of labels.labels) seen[label] = 1;
  let presentBuildings = 0;
  let presentStands = 0;
  for (let k = 1; k <= total; k++) {
    if (!seen[k]) continue;
    if (k <= labels.buildings) presentBuildings++;
    else presentStands++;
  }
  const stats = footprintGround(ground, width, height, labels.labels, total, band, labels.closed);
  const res = pixelMercatorM(window.zoom);
  const judged = stats.map((s): GateFootprint => {
    const lat = rowLatitude(window, Math.floor(s.at / width));
    const side = res * Math.cos((lat * Math.PI) / 180);
    return { ...s, areaM2: s.pixels * side * side };
  });
  return {
    buildings: summarise(
      judged.filter((f) => f.label <= labels.buildings),
      presentBuildings,
      thresholdM,
    ),
    stands: summarise(
      judged.filter((f) => f.label > labels.buildings),
      presentStands,
      thresholdM,
    ),
    labels,
    band,
  };
}

/**
 * The correction (only for a set whose catalogue entry asks for it): every
 * failed footprint and stand, grown by the ring's inner distance, becomes one
 * hole, and the hole gets the membrane of the ground around it
 * (`membraneFill`); everywhere else the grid is untouched.
 */
export function correctWindow(
  ground: Float32Array,
  window: PixelWindow,
  gate: GateResult,
): { data: Float32Array; pixels: number } {
  const failed = new Set([...gate.buildings.failed, ...gate.stands.failed].map((f) => f.label));
  if (failed.size === 0) return { data: Float32Array.from(ground), pixels: 0 };
  const labels = gate.labels.labels;
  const mask = new Uint8Array(labels.length);
  for (let i = 0; i < mask.length; i++) mask[i] = failed.has(labels[i]) ? 1 : 0;
  const hole = dilate(mask, window.width, window.height, gate.band.fromPx);
  let pixels = 0;
  for (const v of hole) pixels += v;
  const { data } = membraneFill({ width: window.width, height: window.height, data: ground }, hole);
  return { data, pixels };
}
