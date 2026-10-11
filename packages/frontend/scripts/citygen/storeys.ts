/**
 * Storeys → metres, per region: how tall a building of `n` recorded storeys
 * stands. The compiler's only place for that conversion where official data
 * sets a region's convention.
 *
 * ## Why not 3.66 m a storey everywhere
 *
 * 3.66 m is OpenMapTiles' worldwide guess (`lib/map/cityTiles.ts` →
 * `METRES_PER_LEVEL`), kept for OSM's `building:levels` where nothing better
 * is known, so the city tiles and the basemap's extrusion agree. Where a
 * region's building rules are known it is wrong, and wrong uniformly: Spanish
 * residential storeys are ~3 m floor to floor, so 3.66 m drew every Spanish
 * building ~15–20% too tall.
 *
 * ## Spain
 *
 * {@link STOREY_MODELS}.es: a 4.0 m ground floor, 3.05 m for every storey
 * above it, and a 0.9 m parapet on top:
 *
 *  - **3.05 m an upper storey**, floor to floor: the metropolitan Pla General
 *    Metropolità that governs Barcelona and its neighbours raises its maximum
 *    heights by exactly 3.05 m a storey in every zone table, and states it
 *    outright for clau 13a — "alçada mínima de 3,05 m" per storey,
 *    "inclòs el forjat", on streets wider than 15 m (Santa Coloma de
 *    Gramenet's PGM summary for clau 13a, `gramenet.cat/…/13arv.pdf`; the
 *    same increment in clau 20a/8, `stcugat.net/…/20080929_PGM_NNUU_zones-allades.pdf`).
 *    Madrid's plans set minimum floor-to-floor heights of 2.90 m upper and
 *    3.10 m ground (e.g. BOCM 2015-02-06, núm. 31, art. 9, under the PGOUM
 *    1997): ~3.0–3.1 m built.
 *  - **4.0 m on the ground floor**: the PGM tables put the ground floor at up
 *    to 4.50 m (clau 20a/8: PB+1 = 7.55 m) or 5.50 m (clau 13a: PB+1 =
 *    8.55 m) under their maxima, and Madrid's minimum is 3.10 m; 4.0 m sits
 *    between, for shops and portals that are taller than the flats above.
 *  - **0.9 m parapet**: Spain's building code requires a barrier at least
 *    0.90 m high where the fall is under 6 m and 1.10 m above it (Código
 *    Técnico de la Edificación, DB-SUA 1 §3.2.1); a Spanish flat roof (the
 *    terrat or azotea) is walled at its edge. 0.9 m is the floor of that
 *    range — a roof's edge is not always a guarded terrace.
 *
 * So `h(n) = 4.0 + 3.05·(n − 1) + 0.9`: 4.9 m for one storey, 20.2 m for six
 * (the PGM's maximum for PB+5 on a 20–30 m street, clau 13a, is 20.75 m to the
 * cornice), 26.3 m for eight (Madrid's example plan: 8 storeys, ≤ 30 m).
 * These are typical values from the rules, not measurements of each building:
 * the storey count is the recorded fact, the metres are a model, and the doc
 * (`docs/MAP_3D_SOURCES.md`) says so.
 */

export interface StoreyModel {
  /** Floor to floor of the ground storey, metres. */
  ground: number;
  /** Floor to floor of every storey above it, metres. */
  upper: number;
  /** Above the top floor's ceiling: parapet or roof edge, metres. */
  parapet: number;
}

export const STOREY_MODELS = {
  /** OpenMapTiles' 3.66 m a storey, for anywhere without a better rule. */
  default: { ground: 3.66, upper: 3.66, parapet: 0 },
  /** Spain; see the module header for the sources. */
  es: { ground: 4.0, upper: 3.05, parapet: 0.9 },
} as const satisfies Record<string, StoreyModel>;

export type StoreyRegion = keyof typeof STOREY_MODELS;

/** Metres to the top of a building of `storeys` storeys above ground (≥ 1). */
export function heightForStoreys(storeys: number, model: StoreyModel): number {
  if (!(storeys >= 1)) return 0;
  return Math.round((model.ground + model.upper * (storeys - 1) + model.parapet) * 100) / 100;
}

/** The storey count whose modelled height is nearest `height` metres (≥ 1). */
export function storeysForHeight(height: number, model: StoreyModel): number {
  return Math.max(1, Math.round((height - model.parapet - model.ground) / model.upper) + 1);
}
