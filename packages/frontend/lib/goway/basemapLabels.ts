/**
 * Where a GoWay Place and a name the basemap is already drawing meet.
 *
 * Two questions, one matcher:
 *
 *  1. **"Do not draw this twice."** The user's complaint, verbatim: *"no
 *     entiendo porque nosotros ponemos chips por encima cuando ya hay esos"*.
 *     A GoWay chip stacked on a label the map has already placed is pure
 *     duplication, and it is duplication the basemap cannot see.
 *  2. **"What did they just tap?"** A tap on a basemap label now resolves, and
 *     the first thing to try is the places already on screen — they are the
 *     same answer, for free, with no request.
 *
 * ## Which side yields, and why
 *
 * **GoWay's chip yields to the basemap's label.** Three reasons, in order of
 * how much they matter:
 *
 *  - The label is already placed, already collision-managed against the rest of
 *    the type, and already legible. Our chip is the *second* thing drawn over
 *    the same point, so removing it removes the redundancy and leaves the map
 *    strictly cleaner.
 *  - Nothing is lost in REACH, which is the only reason yielding was not an
 *    option before: the basemap label is now tappable, and
 *    {@link findPlaceForLabel} sends that tap back to the very place whose chip
 *    was suppressed. The user gets the same card from the same pixel.
 *  - A chip carries no information the label does not — unless it does, and
 *    the exemptions inside {@link suppressLabelledPlaces} are the three cases
 *    where it does.
 *
 * ## The honest limit
 *
 * **This is overlay-side suppression, and it is imperfect, because the tiles
 * are not ours.** MapLibre has one collision system and it runs over the style
 * document's own symbol layers; GoWay's markers are DOM/native views the engine
 * places but does not collide. There is no API that lets our places join the
 * basemap's label placement, so we cannot say "draw this one, drop that one" —
 * we can only look at what was drawn and then not draw over it. Concretely,
 * still wrong today:
 *
 *  - **Matching is by name and distance**, and OSM's name is frequently not
 *    GoWay's. "Mercat de Sant Josep - La Boqueria" in the tiles versus "Mercat
 *    de la Boqueria" in GoWay is one real example: it does not match, and both
 *    are drawn. Loosening the rule to substring matching trades that for
 *    suppressing the wrong place, which is worse — a chip that is missing is a
 *    map with less on it, a chip suppressed by the wrong label is a place the
 *    user cannot find.
 *  - **It lags by a frame.** The report arrives on the settled frame, so a
 *    label that appears as the last tiles decode suppresses its chip one frame
 *    later, and a chip can flicker out. Nothing can fix that from outside the
 *    engine.
 *  - **It is zoom-shaped.** The basemap draws POI labels from z14–z15 up. Below
 *    that nothing is suppressed because nothing is duplicated, which is correct
 *    but means the behaviour changes as you zoom, and the reason is invisible.
 *
 * Owning the tile pipeline — GoWay places built INTO the vector tiles, placed
 * by the same collision system as everything else — is the real fix, and it is
 * a much larger piece of work than this file.
 */
import type { Place, SearchResult } from '@goway.to/sdk';

import type { MapLabelFeature } from '@/components/map';
import { distanceMeters } from '@/lib/map/geo';

/**
 * How far apart a GoWay place and the basemap's label for it may be, in metres.
 *
 * MEASURED, not chosen. Against the real tiles over Barcelona, the distance
 * between GoWay's own record and the OSM node the basemap labels for the same
 * thing runs to 128 m for the Liceu metro station and 73 m for Jaume I — two
 * stations, each with several entrances, where "the station" is a different
 * defensible point for each source. A first cut at 75 m would have matched
 * neither, which is the failure that looks like the feature not working.
 *
 * It is safe to be this generous only because the NAME rule is strict: two
 * POIs within 150 m whose names are equal (or one a word-boundary prefix of the
 * other) are, in practice, one POI. The failure this radius guards against is
 * two branches of a chain on adjacent blocks collapsing into each other, and
 * 150 m is still well inside a city block's worth of separation for that.
 */
export const LABEL_MATCH_RADIUS_M = 150;

/** The shortest name worth matching on a prefix. Under this, prefixes collide. */
const MIN_PREFIX_LENGTH = 6;

/**
 * Two names, compared the way a human would.
 *
 * Accents are stripped because OSM and GoWay disagree about them constantly
 * ("Gracia"/"Gràcia"); punctuation and case go for the same reason. What is NOT
 * done is substring matching anywhere in the string: "Sants" appears inside
 * "Sants-Montjuïc", which is a different, containing place, and a match there
 * would suppress a neighbourhood's chip against its district's label.
 *
 * A PREFIX relation is allowed, because it is the shape a real disagreement
 * takes — "Hospital Clínic" and "Hospital Clínic de Barcelona" are one
 * hospital — and only above {@link MIN_PREFIX_LENGTH}, below which a prefix is
 * a coincidence.
 */
export function namesMatch(a: string, b: string): boolean {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  if (shorter.length < MIN_PREFIX_LENGTH) return false;
  // A word boundary at the join, so "Bar" does not prefix-match "Barcelona"
  // once the length gate is cleared by a longer example of the same mistake.
  return longer.startsWith(`${shorter} `);
}

/** Lowercase, unaccented, punctuation-free, single-spaced. */
export function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();
}

/** Whether a label and a place are, as far as this can tell, the same thing. */
export function labelMatchesPlace(label: MapLabelFeature, place: Place): boolean {
  // An area label is never a GoWay place: GoWay Places holds businesses and
  // venues, not the gazetteer (see `packages/backend/src/search/merge.ts`), so
  // "Barcelona" the city label can never suppress a chip or answer a tap with a
  // place record — even where a place happens to share the name.
  if (label.kind !== 'poi') return false;
  if (!namesMatch(label.name, place.name)) return false;
  return distanceMeters(label.coordinate, place.location) <= LABEL_MATCH_RADIUS_M;
}

/**
 * The place a tapped basemap label already IS, out of the ones on screen.
 *
 * This is the cheap half of resolution and the one that matters most: when the
 * chip for this place was suppressed a moment ago, the place is right here in
 * the same list, and the tap opens its real card with no request at all.
 * Nearest wins, so two same-named places in range resolve to the one the finger
 * was actually on.
 */
export function findPlaceForLabel(
  label: MapLabelFeature,
  places: readonly Place[],
): Place | null {
  let best: Place | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const place of places) {
    if (!labelMatchesPlace(label, place)) continue;
    const distance = distanceMeters(label.coordinate, place.location);
    if (distance < bestDistance) {
      best = place;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The place a tapped label reconciles to, out of a SEARCH response.
 *
 * The expensive half, and deliberately not a second reconciliation: a
 * `SearchResult` carries `place` only when the backend matched it through
 * `places_sources` — the `(source, sourceId)` binding that is GoWay's one rule
 * for "these are the same record". This function does not decide whether a
 * candidate is a GoWay place; it only decides which of the candidates the
 * backend already reconciled is the one under the finger.
 */
export function reconcileLabel(
  label: MapLabelFeature,
  results: readonly SearchResult[],
): Place | null {
  const places: Place[] = [];
  for (const result of results) {
    if (result.place) places.push(result.place);
  }
  return findPlaceForLabel(label, places);
}

export interface SuppressionInput {
  places: readonly Place[];
  /** What the basemap is currently labelling, from the canvas. */
  labels: readonly MapLabelFeature[];
  /** Never suppressed — the user is looking at it. */
  selectedPlaceId?: string | null;
  /** Place ids asserting a live ecosystem capability. Never suppressed. */
  enrichedPlaceIds?: ReadonlySet<string>;
}

export interface SuppressionResult {
  /** The places that still earn a GoWay chip. */
  places: readonly Place[];
  /** Place id → the basemap label that is standing in for it. */
  suppressed: ReadonlyMap<string, MapLabelFeature>;
}

/**
 * Places, minus the ones the basemap is already labelling.
 *
 * Returns the INPUT ARRAY when nothing is suppressed — the common case at low
 * zoom, where the basemap draws no POI labels at all — so the marker build
 * downstream does not see a new array identity on every settled frame.
 *
 * Note what this does NOT touch: the sheet's list. A suppressed place is still
 * in `explore.places`, still rows in the panel, still searchable. Only the
 * second chip over an existing label goes away.
 */
export function suppressLabelledPlaces(input: SuppressionInput): SuppressionResult {
  const { places, labels, selectedPlaceId = null, enrichedPlaceIds } = input;
  if (places.length === 0 || labels.length === 0) {
    return { places, suppressed: EMPTY_SUPPRESSED };
  }

  const suppressed = new Map<string, MapLabelFeature>();
  const kept: Place[] = [];

  for (const place of places) {
    /**
     * The three kinds of place whose chip NEVER yields, and why each earns it.
     *
     * This is the whole of "decide which side yields": the basemap label wins
     * by default, and loses in exactly these cases, because in each of them the
     * chip says something the tiles cannot.
     *
     *  - **The selection.** The user is looking at this place; its pin is the
     *    map's answer to what they just did. A selection you cannot see is not
     *    one.
     *  - **A live ecosystem capability.** The enriched marker state is GoWay's
     *    actual product claim — that this place is reachable through Oxy — and
     *    it exists nowhere in OpenStreetMap.
     *  - **`status: 'closed'`.** OSM will go on labelling a business for years
     *    after it shuts. Yielding there would let the basemap assert something
     *    GoWay knows to be false.
     */
    const exempt =
      place.id === selectedPlaceId ||
      place.status === 'closed' ||
      (enrichedPlaceIds?.has(place.id) ?? false);

    if (exempt) {
      kept.push(place);
      continue;
    }

    const label = labels.find((candidate) => labelMatchesPlace(candidate, place));
    if (label) suppressed.set(place.id, label);
    else kept.push(place);
  }

  if (suppressed.size === 0) return { places, suppressed: EMPTY_SUPPRESSED };
  return { places: kept, suppressed };
}

const EMPTY_SUPPRESSED: ReadonlyMap<string, MapLabelFeature> = new Map();

/**
 * How to describe a basemap label in one short phrase.
 *
 * The tiles' `class`/`subclass` vocabulary is OpenStreetMap's, and GoWay does
 * not translate it into its own category table on purpose: a mapping table
 * would be a claim that the tile's `subclass: 'clinic'` is GoWay's `hospital`
 * category, and the card is explicitly about what the BASEMAP knows. So the raw
 * token is tidied into words and nothing more is asserted.
 *
 * `null` when the tiles said nothing, in which case the card says nothing —
 * rather than "Place", which would be a category GoWay invented.
 */
export function describeLabel(label: MapLabelFeature): string | null {
  const token = label.subcategory ?? label.category;
  if (!token) return null;
  const words = token.replace(/[_-]+/g, ' ').trim();
  if (!words) return null;
  return words.charAt(0).toUpperCase() + words.slice(1);
}
