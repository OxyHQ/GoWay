/**
 * Places → markers: the zoom and selection rules in one pure function.
 *
 * 1. **Category gate.** A bakery is not information at zoom 11
 *    (`categories.ts` carries the per-category `minZoom`). The SELECTED place
 *    is exempt: hiding what the user is looking at, because they zoomed out one
 *    step, breaks the spatial continuity the whole screen is built around.
 * 2. **Clustering is the map's.** Every place may cluster (`clustered: true`);
 *    `@goway.to/maps` gathers close ones into a bubble by Mapbox's own rules
 *    (`<Markers cluster>`), and never the selected place.
 */
import { placeDisplayName } from '@goway.to/sdk';
import type { CategoryTaxonomy, Place } from '@goway.to/sdk';

import type { MapMarker } from '@/components/map';

import { capabilitySummary } from './capabilities';
import { isVisibleAtZoom, resolveCategory } from './categories';
import { markerLabel } from './format';

export interface MarkerBuild {
  markers: MapMarker[];
  /** How many places the zoom rules hid. Drives the "zoom in to see more" hint. */
  hiddenByZoom: number;
}

export interface BuildMarkersOptions {
  places: readonly Place[];
  zoom: number;
  selectedPlaceId?: string | null;
  /** The category taxonomy, or `undefined` while it loads: every place is then a generic pin. */
  taxonomy: CategoryTaxonomy | undefined;
}

export function buildMarkers({
  places,
  zoom,
  selectedPlaceId = null,
  taxonomy,
}: BuildMarkersOptions): MarkerBuild {
  const markers: MapMarker[] = [];
  const seen = new Set<string>();
  let hiddenByZoom = 0;
  for (const place of places) {
    // The same place twice — a duplicate row, a refetch merged onto a stale
    // page — is one marker: an id is drawn once.
    if (seen.has(place.id)) continue;
    seen.add(place.id);
    if (place.id === selectedPlaceId || isVisibleAtZoom(place.categories, zoom, taxonomy)) {
      markers.push(placeMarker(place, place.id === selectedPlaceId, taxonomy));
    } else {
      hiddenByZoom += 1;
    }
  }
  return { markers, hiddenByZoom };
}

function placeMarker(
  place: Place,
  selected: boolean,
  taxonomy: CategoryTaxonomy | undefined,
): MapMarker {
  const category = resolveCategory(place.categories, taxonomy);
  const capabilities = capabilitySummary(place.capabilities);

  const parts = [placeDisplayName(place), category.label];
  if (place.status === 'closed') parts.push('permanently closed');
  if (capabilities) parts.push(capabilities);
  if (selected) parts.push('selected');

  return {
    id: place.id,
    coordinate: place.location,
    kind: category.key,
    label: markerLabel(place),
    selected,
    clustered: true,
    accessibilityLabel: parts.join(', '),
  };
}
