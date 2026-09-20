/**
 * What GoWay does with the basemap's own labels: describes them, resolves them,
 * and stops stacking its own text on top of them.
 *
 * # The thing that shapes this whole file: there is no id to join on
 *
 * GoWay's own reconciliation rule is one sentence, and the backend states it in
 * `packages/backend/src/search/merge.ts`: *two candidates are the same thing
 * only when they carry the same OpenStreetMap element reference, or when both
 * reconcile to the same GoWay place.* Name similarity is explicitly refused
 * there — "Farmacia" names several thousand distinct real places in Spain
 * alone — and a merge is not reversible from the outside.
 *
 * Applied here, that rule has no data to run on. A GoWay place carries its OSM
 * element in `Place.sources` (`openstreetmap:way/25336101`). The vector tile
 * carries a feature id too — and the two are unrelated, because OpenFreeMap's
 * planet is built by **Planetiler**, which assigns its own ids. Measured
 * against the live planet build:
 *
 * | thing          | GoWay `places_sources` | tile feature id |
 * | -------------- | ---------------------- | --------------- |
 * | La Boqueria    | `way/25336101`         | `62887353`      |
 * | Museu Picasso  | `way/34633854`         | `1889380012`    |
 * | Liceu (metro)  | `node/1725079123`      | `53112099541`   |
 *
 * No offset, no multiplier, no encoding: the tiles simply do not carry the
 * identity. **So identity-based de-duplication is impossible here**, and this
 * file does not fake one.
 *
 * # Where inference is allowed, and where it is not
 *
 * The line is drawn by what being WRONG costs:
 *
 *  - **Resolving a tap** may infer. The user pointed at a name; GoWay looks
 *    that name up through its own search and shows the best reconciled place
 *    near that point. If it picks the wrong branch of a chain, the user sees a
 *    plausible card, notices, and backs out. The mistake is visible and
 *    recoverable, and refusing to look anything up would make every tap dead.
 *  - **Suppressing a marker** may not. Removing a place from the map on a
 *    guess is a deletion: silent, invisible, and unrecoverable by the user,
 *    who has no way to know the pin they are looking for was withheld. So
 *    **GoWay does not suppress markers against basemap labels at all.**
 *
 * # What is done about the double-draw instead
 *
 * The complaint was real and precise: *"no entiendo porque nosotros ponemos
 * chips por encima cuando ya hay esos"*. Two copies of the same words stacked
 * on the same pixels is illegible for both.
 *
 * {@link declutterMarkerLabels} answers it without claiming any identity and
 * without deleting anything: where a GoWay chip sits on top of a name the
 * basemap actually PLACED, the chip drops its TEXT and renders as a compact
 * mark. The place is still on the map, still tappable, still named in the list
 * and to a screen reader — only the duplicated glyphs go. It needs no join,
 * because overlapping pixels are a fact about pixels, not a claim about
 * identity; and if the label underneath turns out to be a different thing, the
 * worst case is a mark whose name you read one tap away instead of zero.
 *
 * # The limit that remains, stated rather than hidden
 *
 * GoWay's markers and the basemap's labels do not share a collision system and
 * cannot while the tiles are not ours. MapLibre places type from the style
 * document; our markers are DOM/native views it positions but never collides.
 * Worse, the POI marks in GoWay's own style are `circle` layers, which have no
 * collision detection at all — so "the basemap drew a dot here" is not even
 * evidence that it drew a NAME here, which is why the viewport read that feeds
 * this file queries the SYMBOL layers only. Building GoWay's places into the
 * tiles, and placing them with everything else, is the real fix; it is a much
 * larger piece of work than this file.
 */
import type { Place, SearchResult } from '@goway.to/sdk';

import type { MapLabelFeature, MapMarker } from '@/components/map';
import { distanceMeters, projectToPixels } from '@/lib/map/geo';

/**
 * How far a reconciled search result may be from the tapped label and still be
 * the thing under the finger, in metres.
 *
 * MEASURED, not chosen. Against the real tiles over Barcelona, GoWay's own
 * record and the OSM node the basemap labels for the same thing are 128 m apart
 * for the Liceu metro station and 73 m for Jaume I — two stations, each with
 * several entrances, where "the station" is a different defensible point for
 * each source. A first cut at 75 m matched neither, which is the failure that
 * looks like the feature not working.
 *
 * This is a bound on an INFERENCE, not an identity test: it only narrows
 * candidates that GoWay's own search already returned for this name.
 */
export const LABEL_RESOLVE_RADIUS_M = 150;

/**
 * How close a basemap label has to be to a GoWay chip before the chip stops
 * drawing its own text, in screen pixels.
 *
 * Sized from the thing it is about: Bloom's marker pill is ~28 px tall, and the
 * label the basemap draws sits within ~20 px of its anchor. 24 px is "these two
 * pieces of text are on the same spot"; much more and a chip goes quiet next to
 * a name that is clearly beside it rather than under it.
 */
export const DECLUTTER_RADIUS_PX = 24;

/**
 * The place a tapped label resolves to, out of a SEARCH response — or `null`.
 *
 * This is an INFERENCE and is documented as one above. What keeps it as honest
 * as it can be is that GoWay does not decide the hard part: `SearchResult.place`
 * is populated by the backend only where a candidate reconciled to a GoWay
 * place through `places_sources`, so every candidate here is already a real
 * GoWay record. All this does is pick which of them is under the finger, by
 * distance, within {@link LABEL_RESOLVE_RADIUS_M}.
 *
 * Note what it does NOT do: compare names. The search was BY the label's name,
 * so the text matching has already happened inside the backend's own ranking.
 * A second, client-side string rule would be a competing definition of identity
 * in a codebase that already has one.
 *
 * Only a `poi` label is ever resolved. GoWay Places holds businesses and
 * venues, not the gazetteer and not the street network, so a city, a street or
 * a river has nothing to resolve TO and asking would only invite a wrong match.
 */
export function reconcileLabel(
  label: MapLabelFeature,
  results: readonly SearchResult[],
): Place | null {
  if (label.kind !== 'poi') return null;

  let best: Place | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const result of results) {
    const place = result.place;
    if (!place) continue;
    const distance = distanceMeters(label.coordinate, place.location);
    if (distance > LABEL_RESOLVE_RADIUS_M || distance >= bestDistance) continue;
    best = place;
    bestDistance = distance;
  }
  return best;
}

export interface DeclutterInput {
  markers: readonly MapMarker[];
  /** What the basemap is currently labelling, from the canvas. */
  labels: readonly MapLabelFeature[];
  /** The camera's zoom, for projecting both sides into the same pixel space. */
  zoom: number;
}

/**
 * Markers, with the text removed from any chip that is sitting on a name the
 * basemap already drew.
 *
 * ## What this is and is not
 *
 * It is not suppression and makes no claim that the two are the same thing. It
 * is the de-confliction a renderer does when two pieces of type collide, done
 * on our side of a seam where the engine cannot do it for us. **No marker is
 * removed.** A decluttered marker keeps its id, its coordinate, its selected
 * state and its `accessibilityLabel`, so it is still on the map, still
 * tappable, still announced by name, and still a row in the sheet — it renders
 * as Bloom's compact mark instead of a labelled pill (`DefaultMapMarker` uses
 * `marker.label` to choose).
 *
 * ## What never goes quiet
 *
 *  - **The selection.** The user is looking at this one; its name is the map's
 *    answer to what they just did.
 *  - **A cluster.** Its text is a COUNT, not a name, so it duplicates nothing.
 *  - **A chip with no text already.** Nothing to drop.
 *
 * ## Why pixels, and why this zoom
 *
 * Two labels 30 m apart are on top of each other at z18 and a centimetre apart
 * at z12, so the question is only answerable in screen space.
 * `projectToPixels` is the same Web Mercator projection `buildMarkers` already
 * uses for its cluster grid, so both halves of the map agree about what "near"
 * means. The result is approximate — it compares anchors rather than measured
 * text boxes, which the seam cannot see on both platforms — and approximate is
 * the right trade for something whose worst case is a name you read one tap
 * away.
 *
 * Returns the INPUT ARRAY when nothing changes, so a settled frame that
 * declutters nothing does not rebuild every marker on the map.
 */
export function declutterMarkerLabels(input: DeclutterInput): readonly MapMarker[] {
  const { markers, labels, zoom } = input;
  if (markers.length === 0 || labels.length === 0) return markers;
  if (!Number.isFinite(zoom)) return markers;

  const labelPixels = labels.map((label) => projectToPixels(label.coordinate, zoom));

  let changed = false;
  const next = markers.map((marker) => {
    if (!marker.label || marker.selected || (marker.count != null && marker.count > 1)) {
      return marker;
    }
    const at = projectToPixels(marker.coordinate, zoom);
    if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) return marker;

    for (const pixel of labelPixels) {
      if (Math.hypot(pixel.x - at.x, pixel.y - at.y) > DECLUTTER_RADIUS_PX) continue;
      changed = true;
      // `label` is dropped, not blanked: `DefaultMapMarker` renders the compact
      // mark when there is no label, and an empty string would render a pill
      // with nothing in it.
      const { label: _dropped, ...rest } = marker;
      return rest;
    }
    return marker;
  });

  return changed ? next : markers;
}

/**
 * How to describe a basemap label in one short phrase — the subtitle on its
 * card.
 *
 * The tiles' `class`/`subclass` vocabulary is OpenStreetMap's, and GoWay does
 * not translate it into its own category table on purpose: a mapping table
 * would be a claim that a tile's `subclass: 'clinic'` is GoWay's `hospital`
 * category, and this card is explicitly about what the BASEMAP knows.
 *
 * The exception is roads, where the raw token is the network tier
 * (`minor`, `trunk`, `motorway`) and rendering it verbatim would put the word
 * "Minor" under a street name. Those get the word a person uses.
 *
 * `null` when the tiles said nothing, in which case the card says nothing —
 * rather than "Place", which would be a category GoWay invented.
 */
export function describeLabel(label: MapLabelFeature): string | null {
  if (label.kind === 'road') return describeRoad(label.category);
  const token = label.subcategory ?? label.category;
  if (!token) return label.kind === 'water' ? 'Water' : null;
  const words = token.replace(/[_-]+/g, ' ').trim();
  if (!words) return null;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The OpenMapTiles road classes, in the words a person uses for them. */
function describeRoad(roadClass: string | undefined): string {
  switch (roadClass) {
    case 'motorway':
    case 'trunk':
      return 'Motorway';
    case 'primary':
    case 'secondary':
    case 'tertiary':
      return 'Road';
    case 'path':
      return 'Path';
    case 'rail':
    case 'transit':
      return 'Railway';
    case 'ferry':
      return 'Ferry route';
    default:
      return 'Street';
  }
}
