/**
 * Blending several providers' result lists into one order.
 *
 * ## Provider scores are not comparable, so the blend ranks by POSITION
 *
 * `SearchResult.relevance` says so in the contract: "Not comparable across
 * providers." Photon publishes no score at all; Nominatim publishes
 * `importance`, which is derived from Wikipedia links and says nothing about
 * how well a result matched the text. Averaging or thresholding across the two
 * would be arithmetic on incomparable units.
 *
 * So the blend is reciprocal rank fusion: each list contributes `1 / (K + rank)`
 * for the position it put a candidate in, and a candidate several lists agree on
 * accumulates. It needs no calibration between providers, which is exactly the
 * property wanted when a provider can be swapped out by configuration.
 *
 * ## Biasing RE-RANKS; it never filters
 *
 * The contract is explicit ("neither is a filter — both only re-rank"), and a
 * filter would be the wrong product: searching for "Berlin" while looking at
 * Madrid must still find Berlin, below the nearer matches. Both biases are
 * therefore MULTIPLIERS on the fused score, bounded so a strongly-biased
 * mid-list result can overtake a far-away top hit while a bottom-of-list one
 * cannot.
 */

import type { GeoBoundingBox, GeoCoordinate } from '@goway/shared-types';

/**
 * Reciprocal-rank-fusion damping. 60 is the value from the original TREC work
 * and the one every implementation since has used; what it buys is that the gap
 * between rank 1 and rank 2 does not dwarf every other signal.
 */
const RRF_K = 60;

/** How much a perfect proximity match may multiply a fused score. */
const PROXIMITY_BIAS = 0.5;

/**
 * How much reconciling to a GoWay-owned place may multiply a fused score.
 *
 * Small on purpose. An enriched result is more USEFUL — it carries capabilities,
 * verification and a stable deep link — but it is not more RELEVANT to what was
 * typed, and a large boost would float GoWay's own records above better matches.
 */
const ENRICHMENT_BIAS = 0.2;

/** The distance at which a `near` bias has decayed to 1/e of its strength. */
const NEAR_DECAY_METERS = 2_000;

/** Mean Earth radius (IUGG), metres. */
const EARTH_RADIUS_METERS = 6_371_008.8;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Great-circle distance in metres.
 *
 * Haversine rather than an equirectangular approximation: the approximation is
 * cheaper and wrong by kilometres at high latitude, and this number decides
 * ordering the user sees.
 */
export function distanceMeters(from: GeoCoordinate, to: GeoCoordinate): number {
  const dLat = toRadians(to.latitude - from.latitude);
  const dLon = toRadians(to.longitude - from.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(from.latitude)) * Math.cos(toRadians(to.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The centre of a viewport, folding an antimeridian crossing back into range. */
export function centerOf(viewport: GeoBoundingBox): GeoCoordinate {
  const span = viewport.east >= viewport.west ? viewport.east - viewport.west : 360 - viewport.west + viewport.east;
  const longitude = viewport.west + span / 2;
  return {
    latitude: (viewport.south + viewport.north) / 2,
    longitude: longitude > 180 ? longitude - 360 : longitude,
  };
}

/** Where the ranking pulls results toward, and how sharply. */
export interface SpatialBias {
  center: GeoCoordinate;
  decayMeters: number;
}

/**
 * The bias for a query, strongest first: an explicit `near` beats the viewport,
 * which is the contract's own precedence.
 *
 * A viewport decays over its own half-diagonal, so everything actually on
 * screen scores comparably and the falloff begins where the map ends — a fixed
 * distance would treat a city-block viewport and a continental one alike.
 */
export function spatialBiasFor(query: {
  near?: GeoCoordinate;
  viewport?: GeoBoundingBox;
}): SpatialBias | undefined {
  if (query.near) return { center: query.near, decayMeters: NEAR_DECAY_METERS };
  if (query.viewport) {
    const center = centerOf(query.viewport);
    const corner = { latitude: query.viewport.north, longitude: query.viewport.east };
    return { center, decayMeters: Math.max(NEAR_DECAY_METERS, distanceMeters(center, corner)) };
  }
  return undefined;
}

/** A candidate's position in one provider's list, zero-based. */
export interface FusionInput {
  ranks: readonly number[];
  coordinate: GeoCoordinate;
  enriched: boolean;
}

/** The blended score. Higher is better; comparable only within one response. */
export function fusedScore(input: FusionInput, bias: SpatialBias | undefined): number {
  const base = input.ranks.reduce((total, rank) => total + 1 / (RRF_K + rank + 1), 0);
  const proximity =
    bias === undefined ? 0 : Math.exp(-distanceMeters(bias.center, input.coordinate) / bias.decayMeters);
  return base * (1 + PROXIMITY_BIAS * proximity) * (1 + (input.enriched ? ENRICHMENT_BIAS : 0));
}
