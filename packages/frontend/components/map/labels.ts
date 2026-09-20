/**
 * The basemap's own labels, as GoWay-shaped things.
 *
 * The vector tiles have always carried the names — POIs, streets, rivers,
 * districts, cities — and GoWay's style has always drawn them. Until this
 * module they were PAINT: `map.on('click')` reported a coordinate and nothing
 * ever asked the engine what was under the finger. Every name on the map was
 * dead pixels, while GoWay drew its own chips on top of some of them.
 *
 * This file is where a tapped tile feature stops being the engine's and becomes
 * GoWay's. Both renderer forks query their own engine (`queryRenderedFeatures`
 * on web, `MapRef.queryRenderedFeatures` on native), flatten each hit into a
 * {@link QueriedLabel}, and hand the list here; what comes back is a
 * {@link MapLabelFeature}, the only shape feature code ever sees. AGENTS.md —
 * "Feature code imports the GoWay abstraction, never the provider" — is why the
 * flattening happens in the forks and the RANKING happens here: the rule that
 * decides which of five overlapping labels a tap meant is product behaviour, it
 * must be identical on iOS and on the web, and it is testable only if it is a
 * pure function.
 *
 * ## Every text on the map, not just the shop pins
 *
 * {@link LABEL_SOURCE_LAYERS} covers all six source-layers GoWay's style draws
 * a name from: POIs, places (city → neighbourhood), parks, aerodromes, peaks,
 * street names, water bodies and waterways. A tappable shop beside a dead
 * street name is the inconsistency a user notices first.
 *
 * ## What was measured, rather than assumed
 *
 * Driving headless Chromium against the real GoWay style and real OpenFreeMap
 * tiles over Barcelona:
 *
 *  - A query at the EXACT pixel of a POI's anchor returns the dot and nothing
 *    else; six pixels away it returns nothing at all. A label glyph is a few
 *    pixels tall and `text-anchor: top` puts the text BELOW the anchor, so the
 *    thing a user aims at and the point the engine indexes are 12–20 px apart.
 *    That is why {@link LABEL_HIT_PAD_PX} exists and why it is not 2.
 *  - A padded box of 10 px catches both the dot and its label across the whole
 *    band; a tap on empty ground still returns `[]`, so a generous pad does not
 *    manufacture hits.
 *  - `queryRenderedFeatures` on the symbol layers returned 16 labels where the
 *    loaded source held 3185 POI features in the same view. It answers with
 *    what the collision system actually PLACED, not with what the tiles
 *    contain.
 */
import { OPENMAPTILES_SOURCE_LAYERS as SL } from '@/lib/map/style/schema';

import { isDrawableCoordinate } from './shared';
import type { GeoCoordinate, MapLabelFeature, MapLabelKind } from './types';

/**
 * How far around the tap the engine is asked to look, in px (web) / dp (native).
 *
 * The measurement above says 10 px is the minimum that reaches both a POI's dot
 * and its label. 18 is that plus finger slop, and a generous pad costs nothing
 * because {@link pickLabelFeature} resolves a crowded box by distance — the
 * nearest label still wins, so widening the net changes what a sloppy tap hits
 * and never what an accurate one hits.
 *
 * One number for mouse and touch on purpose. Sniffing the pointer type is
 * unreliable (a browser-synthesised click from a touch is an ordinary
 * `MouseEvent`), and a click 14 px from a label is a click that meant the
 * label: a tap on genuinely empty ground was measured to return nothing at any
 * pad, so the failure this could cause — "I clicked nothing and got something"
 * — has nothing to be caused by.
 */
export const LABEL_HIT_PAD_PX = 18;

/**
 * Source-layers a tap may resolve against, in the OpenMapTiles v3 vocabulary.
 *
 * Read from `lib/map/style/schema.ts` rather than spelled here: a wrong
 * source-layer name is the failure mode that logs nothing and throws nothing,
 * and the schema module is the one place those names are recorded.
 *
 * This is every layer GoWay's style puts a NAME on. `transportation` is absent
 * although the style draws a symbol from it — that symbol is `road-oneway`, an
 * arrow, and an arrow is not a label. `building` and `housenumber` are absent
 * because a house number is an address fragment, not a thing with a name.
 */
export const LABEL_SOURCE_LAYERS: readonly string[] = [
  SL.poi,
  SL.place,
  SL.park,
  SL.aerodromeLabel,
  SL.mountainPeak,
  SL.transportationName,
  SL.waterName,
  SL.waterway,
];

const LABEL_SOURCE_LAYER_SET = new Set(LABEL_SOURCE_LAYERS);

/**
 * One hit, as a fork hands it over: the engine's feature with the engine
 * removed.
 *
 * `properties` stays an opaque bag rather than a parsed shape because it is the
 * TILES' vocabulary, not GoWay's — `class`, `subclass`, `rank` and the whole
 * `name:*` family arrive exactly as OpenMapTiles wrote them, and
 * {@link toLabelFeature} is the single place that decides which of them GoWay
 * is willing to speak.
 */
export interface QueriedLabel {
  /** The tiles' own feature id, where they carry one. */
  featureId?: string | number | null;
  /** OpenMapTiles source-layer (`poi`, `transportation_name`, …). */
  sourceLayer: string;
  /** The style layer that drew it. Diagnostics only. */
  layerId?: string;
  properties: Readonly<Record<string, unknown>>;
  /** The feature's own point, for a Point geometry. */
  coordinate?: GeoCoordinate | null;
  /**
   * The feature's vertices, for a line geometry — a street, a river.
   *
   * A street name has no point: it is drawn ALONG the way, and the way runs off
   * both edges of the tile. So the anchor for a line is the nearest point on
   * the line to the tap ({@link pickLabelFeature}), which is both a real place
   * on the street and the closest thing there is to "where the user pointed".
   */
  path?: readonly GeoCoordinate[] | null;
}

/**
 * The name the basemap is DRAWING, or `null`.
 *
 * Exactly `coalesce(name:latin, name)` — the `text-field` expression in
 * `lib/map/style/layers.ts`. Not `name_en`, not `name_int`: a label that says
 * one thing on screen and another in the sheet is a worse bug than no sheet,
 * and the user tapped what they could read.
 */
export function labelNameOf(properties: Readonly<Record<string, unknown>>): string | null {
  const latin = properties['name:latin'];
  if (typeof latin === 'string' && latin.trim()) return latin.trim();
  const name = properties.name;
  if (typeof name === 'string' && name.trim()) return name.trim();
  return null;
}

/**
 * What kind of named thing this is, decided by SOURCE-LAYER rather than by
 * guesswork over the name.
 *
 * Four kinds, because four is what the product acts on differently — see
 * `MapLabelKind` in `types.ts` for what each one means and what a tap on it
 * does.
 */
export function labelKindOf(sourceLayer: string): MapLabelKind | null {
  switch (sourceLayer) {
    case SL.poi:
    case SL.aerodromeLabel:
      return 'poi';
    case SL.place:
    case SL.park:
    case SL.mountainPeak:
      return 'area';
    case SL.transportationName:
      return 'road';
    case SL.waterName:
    case SL.waterway:
      return 'water';
    default:
      return null;
  }
}

/** Whether a source-layer can answer a tap at all. */
export function isLabelSourceLayer(sourceLayer: string): boolean {
  return LABEL_SOURCE_LAYER_SET.has(sourceLayer);
}

/**
 * One queried hit as a GoWay label, or `null` when it is not one.
 *
 * `fallback` is where the user tapped. It is used when the feature has no
 * anchor of its own — a label placed over a POLYGON, such as a park, whose name
 * sits at the pole of inaccessibility that exists only inside MapLibre's
 * placement and not in the tile. The tap is inside the polygon by construction,
 * so it is a truthful point for that thing.
 *
 * Anything derived from a queried geometry goes through `isDrawableCoordinate`
 * for the reason the whole seam exists — a `NaN` reaching MapLibre is a THROW
 * out of the effect that positions things, not a misplaced pin (see
 * `shared.ts`).
 */
export function toLabelFeature(
  candidate: QueriedLabel,
  fallback: GeoCoordinate,
  anchor?: GeoCoordinate | null,
): MapLabelFeature | null {
  const kind = labelKindOf(candidate.sourceLayer);
  if (!kind) return null;

  const name = labelNameOf(candidate.properties);
  if (!name) return null;

  const own = anchor ?? candidate.coordinate;
  const anchored = isDrawableCoordinate(own);
  const coordinate = anchored ? own : fallback;
  if (!isDrawableCoordinate(coordinate)) return null;

  const category = stringProp(candidate.properties, 'class');
  const subcategory = stringProp(candidate.properties, 'subclass');
  const rank = numberProp(candidate.properties, 'rank');

  return {
    // The tiles' feature id where there is one, and a coordinate-derived id
    // where there is not, so a label is always keyable. It is NOT a GoWay Place
    // ID and cannot be joined to one — see the note in `types.ts`.
    id:
      candidate.featureId == null
        ? `${candidate.sourceLayer}:${coordinate.longitude.toFixed(6)},${coordinate.latitude.toFixed(6)}`
        : `${candidate.sourceLayer}:${String(candidate.featureId)}`,
    name,
    kind,
    coordinate,
    anchored,
    ...(category ? { category } : {}),
    ...(subcategory ? { subcategory } : {}),
    ...(rank === null ? {} : { rank }),
  };
}

/**
 * Every hit in the box, as GoWay labels, each anchored where it really is.
 *
 * Split from the ranking below because the two halves need different things and
 * one platform cannot do them together. Anchoring is PURE GEOMETRY — no
 * projection — which is what lets the native fork do it synchronously for every
 * candidate and then pay for exactly one projection each, instead of one bridge
 * call per vertex of every street in the box.
 */
export function labelCandidatesOf(
  candidates: readonly QueriedLabel[],
  tapCoordinate: GeoCoordinate,
): MapLabelFeature[] {
  const out: MapLabelFeature[] = [];
  for (const candidate of candidates) {
    const label = toLabelFeature(candidate, tapCoordinate, anchorFor(candidate, tapCoordinate));
    if (label) out.push(label);
  }
  return out;
}

/**
 * The label a tap meant, out of everything inside the padded box.
 *
 * ## The rule, written down rather than left to the renderer's return order
 *
 * 1. **Nearest wins.** Distance in SCREEN PIXELS from the tap to the label's
 *    own anchor — a point for a POI or a city, and for a street or a river the
 *    nearest point on the line, which is a real place on that way rather than a
 *    vertex that may be half a tile away. Pixels, not degrees: a degree is a
 *    different distance at every latitude, and the user is pointing at pixels.
 * 2. **A label with no anchor of its own is ranked as if it were at the edge of
 *    the pad.** A park's name is placed by MapLibre at a pole of inaccessibility
 *    that does not exist in the tile, so its only honest position is "somewhere
 *    in this box". Scoring it at zero would make it beat everything; scoring it
 *    at {@link LABEL_HIT_PAD_PX} makes it lose to anything genuinely nearer and
 *    win over nothing.
 * 3. **Then the kind**, most specific first: a POI you can walk into, then the
 *    street it is on, then water, then the district or city containing all of
 *    them. A city label spans the screen and is never what a tap meant while
 *    something smaller is under the finger.
 * 4. **Then the tiles' own `rank`**, OpenMapTiles' importance ordering.
 * 5. **Then the id**, so the answer is deterministic rather than dependent on
 *    the order a renderer happened to return its layers in.
 */
export function pickLabelFeature(
  labels: readonly MapLabelFeature[],
  point: { x: number; y: number },
  project: (coordinate: GeoCoordinate) => { x: number; y: number } | null,
): MapLabelFeature | null {
  let best: MapLabelFeature | null = null;
  let bestScore: Score | null = null;

  for (const label of labels) {
    const projected = label.anchored ? project(label.coordinate) : null;
    const distance =
      projected && Number.isFinite(projected.x) && Number.isFinite(projected.y)
        ? Math.hypot(projected.x - point.x, projected.y - point.y)
        : // Rule 2: no anchor of its own, so "somewhere in the box".
          LABEL_HIT_PAD_PX;

    const score: Score = [
      distance,
      KIND_ORDER[label.kind],
      label.rank ?? Number.MAX_SAFE_INTEGER,
      label.id,
    ];

    if (bestScore === null || compareScores(score, bestScore) < 0) {
      best = label;
      bestScore = score;
    }
  }

  return best;
}

/** Most specific first. See rule 3. */
const KIND_ORDER: Record<MapLabelKind, number> = { poi: 0, road: 1, water: 2, area: 3 };

type Score = [distance: number, kind: number, rank: number, id: string];

function compareScores(a: Score, b: Score): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  if (a[2] !== b[2]) return a[2] - b[2];
  return a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0;
}

/**
 * Where a line-drawn label should be considered to BE: the point on the way
 * nearest the tap.
 *
 * Not the nearest VERTEX, which on a long straight avenue can be far from a tap
 * that landed squarely on the street. The result is a real point on the way,
 * which is what a pin should sit on and what "directions to this street" needs.
 *
 * ## Why this is flat geometry rather than a projection
 *
 * The search runs in a local planar frame — longitude scaled by `cos(latitude)`
 * — instead of in screen pixels. Over one tile at label zooms the difference is
 * immaterial, and it buys the thing that matters: no projection, so this is
 * pure, testable, and cheap enough for the NATIVE fork, where every projection
 * is a bridge call and projecting every vertex of every street in the box would
 * not be affordable. Both forks therefore anchor identically.
 *
 * Returns `null` for anything that is not a usable line, so the caller falls
 * back to the feature's own point and then to the tap.
 */
export function anchorFor(
  candidate: QueriedLabel,
  tap: GeoCoordinate,
): GeoCoordinate | null {
  const path = candidate.path;
  if (!path || path.length === 0) return null;

  // One scale for the whole search, taken at the tap: using each vertex's own
  // latitude would make the metric inconsistent between segments.
  const scale = Math.cos((tap.latitude * Math.PI) / 180) || 1;
  const flat = (at: GeoCoordinate) => ({ x: at.longitude * scale, y: at.latitude });
  const here = flat(tap);

  let best: GeoCoordinate | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let previous: GeoCoordinate | null = null;

  for (const vertex of path) {
    if (!isDrawableCoordinate(vertex)) {
      previous = null;
      continue;
    }
    if (previous) {
      const hit = nearestOnSegment(previous, vertex, here, flat);
      if (hit.distance < bestDistance) {
        bestDistance = hit.distance;
        best = hit.at;
      }
    } else {
      const at = flat(vertex);
      const distance = Math.hypot(at.x - here.x, at.y - here.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = vertex;
      }
    }
    previous = vertex;
  }

  return best;
}

/** The point on one segment nearest the tap, in the local planar frame. */
function nearestOnSegment(
  a: GeoCoordinate,
  b: GeoCoordinate,
  here: { x: number; y: number },
  flat: (at: GeoCoordinate) => { x: number; y: number },
): { at: GeoCoordinate; distance: number } {
  const pa = flat(a);
  const pb = flat(b);
  const dx = pb.x - pa.x;
  const dy = pb.y - pa.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return { at: a, distance: Math.hypot(pa.x - here.x, pa.y - here.y) };
  }
  const raw = ((here.x - pa.x) * dx + (here.y - pa.y) * dy) / lengthSquared;
  const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
  return {
    at: {
      latitude: a.latitude + t * (b.latitude - a.latitude),
      longitude: a.longitude + t * (b.longitude - a.longitude),
    },
    distance: Math.hypot(pa.x + t * dx - here.x, pa.y + t * dy - here.y),
  };
}

/**
 * The labels currently on screen, deduplicated and capped.
 *
 * Both forks report their viewport's labels so the overlay can avoid stacking
 * its own text on top of one (`lib/goway/basemapLabels.ts`). Two things make
 * that safe to do on every settled frame:
 *
 *  - **Dedup by id.** One POI is drawn by a dot layer and a label layer, and a
 *    feature that straddles a tile boundary is returned once per tile.
 *  - **A cap.** A wide, dense viewport is bounded by the collision system to
 *    tens of labels in practice (44 over central Barcelona at z16, measured),
 *    but "in practice" is not a bound, and this list crosses into React state.
 */
export function collectLabelFeatures(
  candidates: readonly QueriedLabel[],
  fallback: GeoCoordinate,
  limit = 400,
): readonly MapLabelFeature[] {
  const byId = new Map<string, MapLabelFeature>();
  for (const candidate of candidates) {
    if (byId.size >= limit) break;
    const label = toLabelFeature(candidate, fallback);
    if (!label || byId.has(label.id)) continue;
    byId.set(label.id, label);
  }
  return [...byId.values()];
}

/**
 * Whether two reported label sets are the same set.
 *
 * The canvas re-reports on every settled frame, and a fresh array of equal
 * labels would rebuild every marker on the map for no reason. Ids only: a
 * label's name and class come from the same tile feature, so an id that has
 * not changed describes a label that has not changed.
 */
export function sameLabelSet(
  a: readonly MapLabelFeature[],
  b: readonly MapLabelFeature[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index].id !== b[index].id) return false;
  }
  return true;
}

function stringProp(
  properties: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = properties[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberProp(properties: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = properties[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
