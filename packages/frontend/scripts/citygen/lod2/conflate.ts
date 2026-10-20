/**
 * Conflation: which buildings an official 3D model draws, and which
 * OpenStreetMap still draws — decided per building by footprint overlap, with
 * BOTH sources kept in the tile.
 *
 * ## The rules
 *
 * OpenStreetMap is the authority for whether a building EXISTS (it is current;
 * an official model is a dated capture — NYC's is 2014), and the official
 * model for its SHAPE (measured roofs). So:
 *
 *  1. **Confirmed.** A model building is drawn only where OSM records a
 *     building: at least {@link CONFIRM_SHARE} of its footprint must lie inside
 *     OSM buildings. One OSM no longer has was most likely demolished after the
 *     capture; drawing it would put a ghost on the map.
 *  2. **Not stale.** Where OSM RECORDS a height (`height`, or
 *     `building:levels`), the model's top over each OSM building must agree
 *     with it ({@link heightsAgree}, judged per OSM surface — see
 *     {@link sampleBuilding}). An OSM building it disagrees with is in
 *     CONFLICT and stays drawn by OSM; a model building that disagrees over
 *     {@link STALE_SHARE} of its checked footprint describes a building that
 *     has since been replaced — a 2014 parking garage under a 2020 tower — and
 *     is not drawn at all.
 *  3. **Not poorer than OSM's own 3D.** Where OSM is 3D-mapped by hand —
 *     at least {@link OSM_3D_SHARE} of the overlap is `building:part`s or
 *     tagged non-flat roof shapes — and the model building is only stepped
 *     flat blocks (less than {@link MIN_SLOPED_M2} of sloped roof: NYC's
 *     model is LOD1.5 except for ~100 landmarks), OSM keeps drawing it: the
 *     first Lower Manhattan render swapped mappers' pyramid crowns for flat
 *     boxes. A model building with real sloped roofs (the Empire State
 *     Building's 55 sloped surfaces) wins.
 *  4. **Covered.** An OSM building at least {@link COVER_SHARE} inside drawn
 *     model buildings, and not in conflict with them, is drawn BY THE MODEL:
 *     the compiler sets `drawn_by` on it (`lib/map/cityOfficial.ts`) and the
 *     client skips it. Everything else is drawn from OSM, exactly as before.
 *  5. **Heights: official > OSM tags > the 5 m default.** An OSM feature at
 *     least {@link HEIGHT_SHARE} inside drawn model buildings, and not in
 *     conflict, takes the median model height over its footprint as its
 *     RESOLVED `render_height`, with `height_source` saying which kind of
 *     official data set it (`lod2`, `cadastre`) and, for a cadastre, the
 *     storeys as `official_levels`. Its tagged `height`/`levels` stay.
 *
 * Each source's policy (`sources.ts`) can turn rule 2 off (a cadastre kept
 * current by law) and narrow rule 3 to tagged roof shapes (where OSM's parts
 * are an import of that very source).
 *
 * Nothing is overwritten except the resolved height (rule 5): the OSM feature keeps every property and its id and
 * stays in the `building` layer (a native `fill-extrusion` can still draw it);
 * the model's surfaces go to their own layer with the model's id
 * (`source_id`) and the OSM feature they matched best (`osm_id`). Which one
 * the city layer drew is the `drawn_by` property, so both the decision and
 * both facts survive into the archive.
 *
 * ## Overlap by sampling
 *
 * Overlaps are estimated on a regular grid over the model footprint, spaced
 * so the smallest footprint involved gets ~{@link SAMPLES} points (between
 * {@link MIN_SPACING_M} and {@link MAX_SPACING_M} apart, and never more than
 * {@link MAX_SAMPLES} per building): a few per cent of error, deterministic,
 * and no polygon-clipping dependency. The thresholds are all ≥ 0.3, far from
 * where that error matters.
 */
import type { CityTileFeature, TilePolygon } from '../mvtEncode';
import { CITY_PROPS, CITY_TILE_EXTENT } from '../../../lib/map/cityTiles';
import { heightForStoreys, STOREY_MODELS, storeysForHeight } from '../storeys';
import { CITY_LOD2_PROPS, CITY_OFFICIAL_PROPS } from '../../../lib/map/cityOfficial';
import { insideRing } from '../rings';
import { fitPlane, metresPerMercator, type PreparedBuilding, type RoofSurface } from './prepare';
import { LOD2_SOURCES, type Lod2SourceInfo } from './sources';

export const CONFIRM_SHARE = 0.5;
export const COVER_SHARE = 0.5;
export const STALE_SHARE = 0.3;
export const OSM_3D_SHARE = 0.5;
/** An OSM feature this much inside drawn model buildings takes its height from them. */
export const HEIGHT_SHARE = 0.3;
export const MIN_SLOPED_M2 = 20;
const SAMPLES = 120;
const MAX_SAMPLES = 3000;
const MIN_SPACING_M = 0.5;
const MAX_SPACING_M = 4;

/** An OSM feature as conflation sees it: where it is, and what it records about its height. */
export interface OsmEntry {
  feature: CityTileFeature;
  /** The tile the feature is in. */
  tile: [number, number];
  rings: { outer: Float64Array; holes: Float64Array[] }[];
  bbox: [number, number, number, number];
  areaM2: number;
  /** Top of the feature in metres, when OSM RECORDS it (tagged height or storeys). */
  recordedTop?: number;
  /** Whether {@link recordedTop} is a storey count (wider tolerance) rather than a height. */
  fromLevels: boolean;
  covered: number;
  conflict: boolean;
  /** Model heights at samples inside this feature, from model buildings that are drawn. */
  modelHeights: number[];
  /** A `building:part`, and a tagged non-flat roof: OSM modelled this in 3D. */
  part: boolean;
  shapedRoof: boolean;
}

export interface Lod2TileFeature {
  polygons: TilePolygon[];
  properties: Record<string, string | number>;
}

export interface ConflateStats {
  modelBuildings: number;
  drawn: number;
  unconfirmed: number;
  stale: number;
  /** Not drawn: OSM's hand-made 3D (parts, roof shapes) is richer than the model there. */
  osmRicher: number;
  osmFeatures: number;
  /** OSM features whose resolved height the model set (`height_source`). */
  osmHeightsSet: number;
  /** …of which OSM recorded no height at all: the 5 m default boxes fixed. */
  osmHeightsFromDefault: number;
  /** OSM features whose `building:levels` were resolved with the region's storey model. */
  osmLevelsRemodelled: number;
  osmDrawnByModel: number;
  osmConflicts: number;
  roofFeatures: number;
  slopedRoofFeatures: number;
}

export interface ConflateResult {
  tiles: Map<string, Lod2TileFeature[]>;
  stats: ConflateStats;
}

/**
 * Whether the model's height over the part of an OSM footprint where that OSM
 * feature is the highest thing OSM records (`modelTop`, the MEDIAN of the
 * model's roof heights there — a 90th percentile let one tower edge inside a
 * setback part outvote the setback) agrees with the top OSM records. The
 * test exists to catch a REPLACED building — a 2014 garage under a 2020
 * tower, or the reverse — so the tolerance is generous: max(10 m, 30%) for a
 * tagged height (measured on Midtown's single-roof buildings, NYC model minus
 * OSM is +0.4 m at the median and within ±2.2 m for 90% of them, but 3D
 * mappers' part heights are rougher: the Empire State Building's podium is
 * 17 m in OSM and 25.4 m in the model, which an 8 m tolerance called a
 * replaced building), and for a storey count a storey height between 2.2 m
 * and 6.5 m (the bounds `facades.ts` uses) or within 10 m of `levels × 3.66`.
 * A replacement that changes a building's height by less than that (two
 * storeys added to a walk-up) is not caught; the model draws the old shape.
 */
export function heightsAgree(modelTop: number, recordedTop: number, fromLevels: boolean): boolean {
  const near = Math.abs(modelTop - recordedTop) <= Math.max(10, 0.3 * recordedTop);
  if (!fromLevels) return near;
  const storey = modelTop / Math.max(1, recordedTop / 3.66);
  return near || (storey >= 2.2 && storey <= 6.5);
}

function boxesOverlap(a: readonly number[], b: readonly number[]): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

function insidePolygonSet(
  rings: { outer: Float64Array; holes: Float64Array[] }[],
  x: number,
  y: number,
): boolean {
  for (const { outer, holes } of rings) {
    if (insideRing(outer, x, y) && !holes.some((hole) => insideRing(hole, x, y))) return true;
  }
  return false;
}

/** Highest roof over a point (metres above ground), or `null` when no roof covers it. */
function roofHeightAt(roofs: readonly RoofSurface[], x: number, y: number): number | null {
  let best: number | null = null;
  for (const roof of roofs) {
    const outer = roof.rings[0];
    if (!insideRing(outer, x, y)) continue;
    if (roof.rings.slice(1).some((hole) => insideRing(hole, x, y))) continue;
    const h = roof.heights[0];
    // A flat roof (every cadastral part, 95% of NYC's) is its height.
    if (h[0] === h[h.length - 1] && h.every((v) => v === h[0])) {
      if (best === null || h[0] > best) best = h[0];
      continue;
    }
    // Inverse-distance blend of the vertices is enough for a height check.
    let sum = 0;
    let weight = 0;
    for (let i = 0; i < h.length; i++) {
      const d = Math.hypot(outer[i * 2] - x, outer[i * 2 + 1] - y) + 1e-12;
      sum += h[i] / d;
      weight += 1 / d;
    }
    const value = sum / weight;
    if (best === null || value > best) best = value;
  }
  return best;
}

/** The OSM features of compiled tiles, back in mercator. */
export function osmEntries(tiles: Map<string, CityTileFeature[]>): OsmEntry[] {
  const entries: OsmEntry[] = [];
  for (const [key, features] of tiles) {
    const [z, tx, ty] = key.split('/').map(Number);
    const span = 2 ** z;
    const toMerc = (ring: readonly (readonly [number, number])[]) => {
      const out = new Float64Array(ring.length * 2);
      ring.forEach(([x, y], i) => {
        out[i * 2] = (tx + x / CITY_TILE_EXTENT) / span;
        out[i * 2 + 1] = (ty + y / CITY_TILE_EXTENT) / span;
      });
      return out;
    };
    for (const feature of features) {
      const rings = feature.polygons.map((p) => ({
        outer: toMerc(p.outer),
        holes: p.holes.map(toMerc),
      }));
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let area = 0;
      for (const { outer, holes } of rings) {
        for (let i = 0; i < outer.length; i += 2) {
          minX = Math.min(minX, outer[i]);
          maxX = Math.max(maxX, outer[i]);
          minY = Math.min(minY, outer[i + 1]);
          maxY = Math.max(maxY, outer[i + 1]);
        }
        area += Math.abs(ringAreaMerc(outer));
        for (const hole of holes) area -= Math.abs(ringAreaMerc(hole));
      }
      if (!(area > 0)) continue;
      const unit = metresPerMercator((minY + maxY) / 2);
      const props = feature.properties;
      const tagged = typeof props[CITY_PROPS.height] === 'number';
      const levels = typeof props[CITY_PROPS.levels] === 'number';
      const top = props[CITY_PROPS.renderHeight];
      entries.push({
        feature,
        tile: [tx, ty],
        rings,
        bbox: [minX, minY, maxX, maxY],
        areaM2: area * unit * unit,
        recordedTop: (tagged || levels) && typeof top === 'number' ? top : undefined,
        fromLevels: !tagged && levels,
        covered: 0,
        conflict: false,
        modelHeights: [],
        part: props[CITY_PROPS.part] === true,
        shapedRoof:
          typeof props[CITY_PROPS.roofShape] === 'string' && props[CITY_PROPS.roofShape] !== 'flat',
      });
    }
  }
  return entries;
}

function ringAreaMerc(ring: Float64Array): number {
  const ox = ring[0];
  const oy = ring[1];
  let sum = 0;
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sum +=
      (ring[i * 2] - ox) * (ring[j * 2 + 1] - oy) - (ring[j * 2] - ox) * (ring[i * 2 + 1] - oy);
  }
  return sum / 2;
}

interface Overlap {
  entry: OsmEntry;
  areaM2: number;
  /** The model's roof heights at the samples inside this OSM feature. */
  heights: number[];
}

export interface Sampled {
  /** Samples inside the model footprint, and how many of them OSM also has a building at. */
  inside: number;
  inOsm: number;
  /** Samples where OSM records a height and the model has a roof, and how many disagreed. */
  checked: number;
  disagreeing: number;
  overlaps: Overlap[];
}

/** The `p`-quantile of an unsorted list (sorted in place). */
function quantile(values: number[], p: number): number {
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.floor(p * values.length))];
}

/**
 * Sample one model building's footprint against the OSM features near it.
 *
 * At each sample the OSM SURFACE is the feature with the highest recorded top
 * among those covering the point, and the model's height there is its
 * highest roof over the point. Each OSM feature is then judged on the samples
 * where it is the surface: the model's height there ({@link heightsAgree}, the
 * median) against the feature's recorded top. Judging per surface, not
 * per sample, is what lets a DETAILED model agree with a coarse OSM building
 * (one 66 m outline over a model block that steps down to 7 m courtyards) and
 * OSM's stacked `building:part`s be compared as the shape they describe
 * together (a podium part is judged only where no tower part stands on it) —
 * the first two versions of this test called 7,483 Manhattan buildings stale
 * by getting exactly those two wrong.
 */
export function sampleBuilding(
  building: PreparedBuilding,
  candidates: readonly OsmEntry[],
  /** Judge the model against OSM's recorded heights (`Lod2SourceInfo.policy.staleCheck`). */
  checkHeights = true,
): Sampled {
  const unit = metresPerMercator((building.bbox[1] + building.bbox[3]) / 2);
  const smallest = Math.min(building.areaM2, ...candidates.map((c) => c.areaM2));
  const spacingM = Math.min(
    MAX_SPACING_M,
    Math.max(
      MIN_SPACING_M,
      Math.sqrt(smallest / SAMPLES),
      // Never more than ~MAX_SAMPLES over one footprint.
      Math.sqrt(building.areaM2 / MAX_SAMPLES),
    ),
  );
  const step = spacingM / unit;
  const cell = spacingM * spacingM;
  const modelRings = building.footprint.map((outer) => ({ outer, holes: [] as Float64Array[] }));
  const perEntry = new Map<OsmEntry, { samples: number; heights: number[]; all: number[] }>();
  const result: Sampled = { inside: 0, inOsm: 0, checked: 0, disagreeing: 0, overlaps: [] };
  const [x0, y0, x1, y1] = building.bbox;
  const covering: OsmEntry[] = [];
  for (let y = y0 + step / 2; y < y1; y += step) {
    for (let x = x0 + step / 2; x < x1; x += step) {
      if (!insidePolygonSet(modelRings, x, y)) continue;
      result.inside++;
      let any = false;
      let surface: OsmEntry | null = null;
      covering.length = 0;
      for (const entry of candidates) {
        const box = entry.bbox;
        if (x < box[0] || x > box[2] || y < box[1] || y > box[3]) continue;
        if (!insidePolygonSet(entry.rings, x, y)) continue;
        any = true;
        covering.push(entry);
        let counts = perEntry.get(entry);
        if (!counts) {
          counts = { samples: 0, heights: [], all: [] };
          perEntry.set(entry, counts);
        }
        counts.samples++;
        if (
          entry.recordedTop !== undefined &&
          (!surface || entry.recordedTop > (surface.recordedTop ?? 0))
        ) {
          surface = entry;
        }
      }
      if (!any) continue;
      result.inOsm++;
      const h = roofHeightAt(building.roofs, x, y);
      if (h === null) continue;
      for (const entry of covering) perEntry.get(entry)?.all.push(h);
      if (surface) perEntry.get(surface)?.heights.push(h);
    }
  }
  for (const [entry, counts] of perEntry) {
    result.overlaps.push({ entry, areaM2: counts.samples * cell, heights: counts.all });
    if (!checkHeights || counts.heights.length < 4 || entry.recordedTop === undefined) continue;
    result.checked += counts.heights.length;
    if (!heightsAgree(quantile(counts.heights, 0.5), entry.recordedTop, entry.fromLevels)) {
      // An OSM building the model disagrees with is one that changed since
      // the capture: OSM keeps drawing it.
      entry.conflict = true;
      result.disagreeing += counts.heights.length;
    }
  }
  return result;
}

/**
 * Decide, for every model building and every OSM feature, which source draws
 * it; mark the OSM features the model draws; and return the model's roof
 * surfaces as tile features, each building whole and unclipped (the rule the
 * OSM features follow) in the tile of the OSM feature it matched best.
 */
export function conflate(
  osmTiles: Map<string, CityTileFeature[]>,
  buildings: readonly PreparedBuilding[],
  options: {
    source: string;
    zoom: number;
    /** Defaults to the NYC model's (`sources.ts`). */
    policy?: Lod2SourceInfo['policy'];
  },
): ConflateResult {
  const policy = options.policy ?? LOD2_SOURCES['nyc-3dbm'].policy;
  const stats: ConflateStats = {
    modelBuildings: buildings.length,
    drawn: 0,
    unconfirmed: 0,
    stale: 0,
    osmRicher: 0,
    osmFeatures: 0,
    osmHeightsSet: 0,
    osmHeightsFromDefault: 0,
    osmLevelsRemodelled: 0,
    osmDrawnByModel: 0,
    osmConflicts: 0,
    roofFeatures: 0,
    slopedRoofFeatures: 0,
  };
  const entries = osmEntries(osmTiles);
  stats.osmFeatures = entries.length;

  // A grid of OSM features by bounding box, cells of ~150 m.
  const CELL = 2 ** 18;
  const grid = new Map<number, OsmEntry[]>();
  for (const entry of entries) {
    for (let cx = Math.floor(entry.bbox[0] * CELL); cx <= Math.floor(entry.bbox[2] * CELL); cx++) {
      for (
        let cy = Math.floor(entry.bbox[1] * CELL);
        cy <= Math.floor(entry.bbox[3] * CELL);
        cy++
      ) {
        const key = cx * CELL + cy;
        const cell = grid.get(key);
        if (cell) cell.push(entry);
        else grid.set(key, [entry]);
      }
    }
  }

  // Pass 1: overlaps, and which model buildings are confirmed and current.
  const drawn: { building: PreparedBuilding; overlaps: Overlap[] }[] = [];
  for (const building of buildings) {
    const candidates = new Set<OsmEntry>();
    for (
      let cx = Math.floor(building.bbox[0] * CELL);
      cx <= Math.floor(building.bbox[2] * CELL);
      cx++
    ) {
      for (
        let cy = Math.floor(building.bbox[1] * CELL);
        cy <= Math.floor(building.bbox[3] * CELL);
        cy++
      ) {
        for (const entry of grid.get(cx * CELL + cy) ?? []) {
          if (boxesOverlap(entry.bbox, building.bbox)) candidates.add(entry);
        }
      }
    }
    const sampled = sampleBuilding(building, [...candidates], policy.staleCheck);
    if (sampled.inside === 0 || sampled.inOsm < CONFIRM_SHARE * sampled.inside) {
      stats.unconfirmed++;
      continue;
    }
    if (sampled.checked >= 4 && sampled.disagreeing >= STALE_SHARE * sampled.checked) {
      stats.stale++;
      continue;
    }
    const overlaps = sampled.overlaps;
    // This format stores roof surfaces and raises walls to the ground. It
    // cannot represent a recorded open space under an elevated building part,
    // even when its roof is richer. Keep that building's volumetric OSM parts.
    if (
      overlaps.some(
        ({ entry, heights }) =>
          entry.part &&
          Number(entry.feature.properties[CITY_PROPS.renderMinHeight]) > 0 &&
          heights.length >= 4,
      )
    ) {
      stats.osmRicher++;
      continue;
    }
    if (building.slopedAreaM2 < MIN_SLOPED_M2) {
      let mapped = 0;
      let total = 0;
      for (const o of overlaps) {
        total += o.areaM2;
        const handMade =
          o.entry.shapedRoof || (policy.osmRicher === 'parts-or-roofs' && o.entry.part);
        if (handMade) mapped += o.areaM2;
      }
      if (total > 0 && mapped >= OSM_3D_SHARE * total) {
        stats.osmRicher++;
        continue;
      }
    }
    drawn.push({ building, overlaps });
  }

  // Pass 2: what each OSM feature is covered by, among the drawn.
  for (const { overlaps } of drawn) {
    for (const o of overlaps) {
      o.entry.covered += o.areaM2;
      for (const h of o.heights) o.entry.modelHeights.push(h);
    }
  }
  for (const entry of entries) {
    if (entry.conflict) {
      stats.osmConflicts++;
      continue;
    }
    const props = entry.feature.properties;
    if (entry.covered >= COVER_SHARE * entry.areaM2) {
      props[CITY_OFFICIAL_PROPS.drawnBy] = options.source;
      stats.osmDrawnByModel++;
    }
    // Heights: official > OSM's tags > the 5 m default. The RESOLVED height
    // moves; OSM's own `height`/`levels` stay as tagged beside it.
    if (entry.covered < HEIGHT_SHARE * entry.areaM2 || entry.modelHeights.length < 4) continue;
    const top = round(quantile(entry.modelHeights, 0.5), 1);
    const base = props[CITY_PROPS.renderMinHeight];
    if (!(top > (typeof base === 'number' ? base : 0) + 0.5)) continue;
    if (entry.recordedTop === undefined) stats.osmHeightsFromDefault++;
    props[CITY_PROPS.renderHeight] = top;
    props[CITY_PROPS.heightSource] = policy.heightSource;
    if (policy.storeys) {
      props[CITY_OFFICIAL_PROPS.officialLevels] = storeysForHeight(
        top,
        STOREY_MODELS[policy.storeys],
      );
    }
    stats.osmHeightsSet++;
  }

  // OSM's own storeys in the same region stand as tall as the source's: in
  // Spain `building:levels` is overwhelmingly the cadastre's count, imported,
  // and one count must not stand two heights side by side.
  if (policy.storeys) {
    const model = STOREY_MODELS[policy.storeys];
    for (const entry of entries) {
      const props = entry.feature.properties;
      if (
        props[CITY_PROPS.heightSource] !== 'osm' &&
        props[CITY_PROPS.heightSource] !== undefined
      ) {
        continue;
      }
      const levels = props[CITY_PROPS.levels];
      if (typeof levels !== 'number' || levels < 1) continue;
      if (props[CITY_PROPS.height] !== undefined || props[CITY_PROPS.minLevel] !== undefined)
        continue;
      if (props[CITY_PROPS.roofShape] !== undefined && props[CITY_PROPS.roofShape] !== 'flat')
        continue;
      if (
        props[CITY_PROPS.renderMinHeight] !== 0 &&
        props[CITY_PROPS.renderMinHeight] !== undefined
      ) {
        continue;
      }
      props[CITY_PROPS.renderHeight] = heightForStoreys(levels, model);
      stats.osmLevelsRemodelled++;
    }
  }

  // Emit the drawn model buildings' roofs, each building whole in the tile of
  // the OSM feature it matched best — not of its own representative point —
  // so the feature it replaces and the facts that dress it (`lod2Mesher.ts`)
  // are always in the same tile as its surfaces.
  const tiles = new Map<string, Lod2TileFeature[]>();
  const span = 2 ** options.zoom;
  for (const { building, overlaps } of drawn) {
    stats.drawn++;
    const best = overlaps.reduce((a, b) => (b.areaM2 > a.areaM2 ? b : a));
    const [tx, ty] = best.entry.tile;
    const key = `${options.zoom}/${tx}/${ty}`;
    let list = tiles.get(key);
    if (!list) {
      list = [];
      tiles.set(key, list);
    }
    for (const roof of building.roofs) {
      const feature = roofFeature(roof, tx, ty, span);
      if (!feature) continue;
      feature.properties[CITY_LOD2_PROPS.source] = options.source;
      feature.properties[CITY_LOD2_PROPS.sourceId] = building.sourceId;
      feature.properties[CITY_LOD2_PROPS.osmId] = best.entry.feature.id;
      if (roof.levels !== undefined) feature.properties[CITY_LOD2_PROPS.levels] = roof.levels;
      if (feature.properties[CITY_LOD2_PROPS.roofDx] !== undefined) stats.slopedRoofFeatures++;
      list.push(feature);
      stats.roofFeatures++;
    }
  }
  return { tiles, stats };
}

const round = (value: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

/**
 * One roof surface → a tile feature: its rings in tile units (relative to the
 * tile `tx, ty`) and its plane. A flat roof is just `render_height`; a sloped
 * one adds `roof_h`, metres at the exterior ring's minimum corner AFTER
 * quantisation (the decoder can recompute that corner exactly from what it
 * reads, whatever order the encoder wrote the ring in), and
 * `roof_dx`/`roof_dy`, metres per tile unit.
 */
export function roofFeature(
  roof: RoofSurface,
  tx: number,
  ty: number,
  span: number,
): Lod2TileFeature | null {
  const xs: number[] = [];
  const ys: number[] = [];
  const hs: number[] = [];
  const rings = roof.rings.map((ring, r) => {
    const points: [number, number][] = [];
    const h = roof.heights[r];
    for (let i = 0; i < h.length; i++) {
      const x = (ring[i * 2] * span - tx) * CITY_TILE_EXTENT;
      const y = (ring[i * 2 + 1] * span - ty) * CITY_TILE_EXTENT;
      points.push([x, y]);
      xs.push(x);
      ys.push(y);
      hs.push(h[i]);
    }
    return points;
  });
  const plane = fitPlane(xs, ys, hs);
  if (!plane) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  for (const [x, y] of rings[0]) {
    x0 = Math.min(x0, Math.round(x));
    y0 = Math.min(y0, Math.round(y));
  }
  // Flat to within 1 cm across a 100 m roof: stored as flat, and then its
  // height IS `render_height` — one property, not two (95% of NYC's roofs).
  const flat = Math.hypot(plane.a, plane.b) * (100 / metresPerTileUnit(ty, span)) < 0.01;
  if (flat) {
    const h = round(Math.max(plane.c + plane.a * x0 + plane.b * y0, 0.1), 2);
    return {
      polygons: [{ outer: rings[0], holes: rings.slice(1) }],
      properties: { [CITY_PROPS.renderHeight]: h },
    };
  }
  const properties: Record<string, string | number> = {
    [CITY_PROPS.renderHeight]: round(Math.max(...hs, 0.1), 2),
    [CITY_LOD2_PROPS.roofH]: round(plane.c + plane.a * x0 + plane.b * y0, 2),
    [CITY_LOD2_PROPS.roofDx]: round(plane.a, 6),
    [CITY_LOD2_PROPS.roofDy]: round(plane.b, 6),
  };
  return { polygons: [{ outer: rings[0], holes: rings.slice(1) }], properties };
}

function metresPerTileUnit(ty: number, span: number): number {
  return metresPerMercator((ty + 0.5) / span) / span / CITY_TILE_EXTENT;
}
