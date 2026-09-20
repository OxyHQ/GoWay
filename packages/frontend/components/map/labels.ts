/**
 * The basemap's own labels, as GoWay-shaped things.
 *
 * The vector tiles have always carried the POIs — a name, a `class`, a
 * `subclass`, a `rank` — and GoWay's style has always drawn them
 * (`poi-dot`, `label-poi`, `label-place-city`, …). Until this module they were
 * PAINT: `map.on('click')` reported a coordinate and nothing ever asked the
 * engine what was under the finger, so every shop name on the map was dead
 * pixels while GoWay drew its own chip on top of some of them.
 *
 * This file is where a tapped tile feature stops being the engine's and becomes
 * GoWay's. Both renderer forks query their own engine (`queryRenderedFeatures`
 * on web, `MapRef.queryRenderedFeatures` on native), flatten each hit into a
 * {@link QueriedLabel}, and hand the list here; what comes back is a
 * {@link MapLabelFeature}, which is the only shape feature code ever sees.
 * AGENTS.md — "Feature code imports the GoWay abstraction, never the provider"
 * — is why the flattening happens in the forks and the RANKING happens here:
 * the rule that decides which of five overlapping labels a tap meant is
 * product behaviour, it must be identical on iOS and on the web, and it is
 * testable only if it is a pure function.
 *
 * ## What was measured, rather than assumed
 *
 * Driving headless Chromium against the real `goway.to` style and real
 * OpenFreeMap tiles over Barcelona at z17:
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
 *    contain. That is the fact the suppression rule in
 *    `lib/goway/basemapLabels.ts` is built on: a label MapLibre dropped is not
 *    reported, so GoWay does not hide its own chip behind a label that is not
 *    on screen.
 */
import { OPENMAPTILES_SOURCE_LAYERS as SL } from '@/lib/map/style/schema';

import { isDrawableCoordinate } from './shared';
import type { GeoCoordinate, MapLabelFeature, MapLabelKind } from './types';

/**
 * How far around the tap the engine is asked to look, in px (web) / dp (native).
 *
 * The measurement above says 10 px is the minimum that reaches both the dot and
 * its label. 18 is that plus finger slop, and a generous pad costs nothing
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
 * `transportation_name` is deliberately absent. A street name is a tappable
 * thing on Apple's map too, but a street is a LINE with an extent and no
 * anchor, so it wants a different interaction (and a different sheet) from a
 * point you can walk into. `water_name` is absent for the same reason plus a
 * blunter one: nothing useful happens when you open a river.
 */
export const LABEL_SOURCE_LAYERS: readonly string[] = [
  SL.poi,
  SL.place,
  SL.park,
  SL.aerodromeLabel,
  SL.mountainPeak,
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
  /** OpenMapTiles source-layer (`poi`, `place`, …). */
  sourceLayer: string;
  /** The style layer that drew this hit. Used only for diagnostics. */
  layerId?: string;
  properties: Readonly<Record<string, unknown>>;
  /**
   * The feature's own point, when it has one.
   *
   * `null` for a label placed over a polygon (a park, whose label sits at the
   * pole of inaccessibility): there is no single point in the tile to use, and
   * inventing a centroid from a clipped ring would put the pin outside the
   * park. Those fall back to where the user actually tapped, which is inside
   * the thing by construction.
   */
  coordinate?: GeoCoordinate | null;
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
 * `poi` — a thing at a point, with a door. `area` — a named region.
 *
 * Two values, because two is all the ranking below needs and all the sheet can
 * honestly act on: a POI may reconcile to a GoWay Place, an area never does
 * (GoWay Places holds businesses and venues, not the gazetteer — see
 * `packages/backend/src/search/merge.ts`).
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
 * `fallback` is where the user tapped, and it is used for two different
 * reasons that both end in the same place: a polygon-anchored label has no
 * point of its own, and a point that survived the tiles but not arithmetic is
 * not one either. Anything derived from a queried geometry goes through
 * `isDrawableCoordinate` for the reason the whole seam exists — a `NaN`
 * reaching MapLibre is a THROW out of the effect that positions things, not a
 * misplaced pin (see `shared.ts`).
 */
export function toLabelFeature(
  candidate: QueriedLabel,
  fallback: GeoCoordinate,
): MapLabelFeature | null {
  const kind = labelKindOf(candidate.sourceLayer);
  if (!kind) return null;

  const name = labelNameOf(candidate.properties);
  if (!name) return null;

  const own = candidate.coordinate;
  const coordinate = isDrawableCoordinate(own) ? own : fallback;
  if (!isDrawableCoordinate(coordinate)) return null;

  const category = stringProp(candidate.properties, 'class');
  const subcategory = stringProp(candidate.properties, 'subclass');
  const rank = numberProp(candidate.properties, 'rank');

  return {
    // The tiles' feature id where there is one, and a coordinate-derived id
    // where there is not, so a label is always keyable. It is NOT a GoWay Place
    // ID and must never be treated as one: it belongs to a planet build and
    // changes when that build does.
    id:
      candidate.featureId == null
        ? `${candidate.sourceLayer}:${coordinate.longitude.toFixed(6)},${coordinate.latitude.toFixed(6)}`
        : `${candidate.sourceLayer}:${String(candidate.featureId)}`,
    name,
    kind,
    coordinate,
    ...(category ? { category } : {}),
    ...(subcategory ? { subcategory } : {}),
    ...(rank === null ? {} : { rank }),
  };
}

/**
 * The label a tap meant, out of everything inside the padded box.
 *
 * ## The rule
 *
 * 1. **A POI beats an area.** At z16 over a café in Gràcia the box contains the
 *    café, the neighbourhood and the city; Apple and Google both open the café,
 *    and so does this. An area label is only ever the answer when nothing
 *    smaller is under the finger.
 * 2. **Within a tier, nearest wins** — distance from the tap to the label's own
 *    anchor, so two adjacent shops resolve the way the pixels look.
 * 3. **Then the tiles' own `rank`**, which is OpenMapTiles' importance ordering,
 *    so a dead heat resolves toward the more prominent thing.
 * 4. **Then the id**, so the answer is deterministic rather than dependent on
 *    the order a renderer happened to return its layers in.
 *
 * `project` converts a coordinate to screen pixels; it is the ONE thing this
 * function cannot do itself, and each fork passes its engine's own projection
 * so that distance is measured in the space the user is actually touching
 * rather than in degrees (which are a different distance at every latitude).
 */
export function pickLabelFeature(
  candidates: readonly QueriedLabel[],
  tap: { coordinate: GeoCoordinate; point: { x: number; y: number } },
  project: (coordinate: GeoCoordinate) => { x: number; y: number } | null,
): MapLabelFeature | null {
  let best: MapLabelFeature | null = null;
  let bestScore: [number, number, number, string] | null = null;

  for (const candidate of candidates) {
    const label = toLabelFeature(candidate, tap.coordinate);
    if (!label) continue;

    const projected = project(label.coordinate);
    // An unprojectable anchor is not a reason to drop the hit — it is a reason
    // to rank it last within its tier. The engine still drew it.
    const distance =
      projected && Number.isFinite(projected.x) && Number.isFinite(projected.y)
        ? Math.hypot(projected.x - tap.point.x, projected.y - tap.point.y)
        : Number.MAX_SAFE_INTEGER;

    const score: [number, number, number, string] = [
      label.kind === 'poi' ? 0 : 1,
      distance,
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

function compareScores(
  a: readonly [number, number, number, string],
  b: readonly [number, number, number, string],
): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  if (a[2] !== b[2]) return a[2] - b[2];
  return a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0;
}

/**
 * The labels currently on screen, deduplicated and capped.
 *
 * Both forks report their viewport's labels so the overlay can avoid drawing a
 * second chip over one (`lib/goway/basemapLabels.ts`). Two things make that
 * safe to do on every settled frame:
 *
 *  - **Dedup by id.** One POI is drawn by a dot layer and a label layer, and a
 *    feature that straddles a tile boundary is returned once per tile.
 *  - **A cap.** A wide, dense viewport is bounded by the collision system to
 *    tens of labels in practice (16 over central Barcelona at z16, measured),
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
