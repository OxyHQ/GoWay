/**
 * Places → markers: the zoom, clustering and selection rules in one pure
 * function.
 *
 * Issue #7 → Map markers wants four things that are easy to state and easy to
 * get wrong incrementally: zoom-dependent visibility, clustering, a selected
 * state, and an enriched/ecosystem state. Doing them inside a component means
 * they are re-derived on every camera frame and testable only by looking at a
 * screen, so they live here as `places → MapMarker[]` with no React and no map
 * engine in sight.
 *
 * ## The rules, in order
 *
 * 1. **Category gate.** A bakery is not information at zoom 11
 *    (`categories.ts` carries the per-category `minZoom`). The SELECTED place
 *    is exempt: hiding what the user is looking at, because they zoomed out one
 *    step, breaks the spatial continuity the whole screen is built around.
 * 2. **Cluster.** Survivors are bucketed into a screen-space grid, so the
 *    threshold is a finger's width rather than a number of degrees that means
 *    something different at every latitude.
 * 3. **Cap.** A bucket grid still leaves one marker per bucket, and a very wide
 *    viewport has a lot of buckets. The list is truncated by category rank so
 *    the survivors are the most orienting ones, not the first ones in the
 *    array.
 */
import type { Place } from '@goway.to/sdk';

import type { MapMarker } from '@/components/map';
import { projectToPixels } from '@/lib/map/geo';

import { capabilitySummary } from './capabilities';
import { isVisibleAtZoom, resolveCategory } from './categories';
import { markerLabel } from './format';

/**
 * Grid cell in screen pixels.
 *
 * Bloom's marker pill is ~28 px tall and considerably wider; 72 px is roughly
 * "two pills cannot overlap", which is the point at which collapsing them is a
 * help rather than a loss of detail.
 */
const CLUSTER_CELL_PX = 72;

/** Above this the map is a POI browser, not a map. */
const MAX_MARKERS = 60;

export interface MarkerBuild {
  markers: MapMarker[];
  /** Cluster id → the places it collapsed, so a press can frame them. */
  clusters: Map<string, Place[]>;
  /** How many places the zoom rules hid. Drives the "zoom in to see more" hint. */
  hiddenByZoom: number;
}

export interface BuildMarkersOptions {
  places: readonly Place[];
  zoom: number;
  selectedPlaceId?: string | null;
}

export function buildMarkers({
  places,
  zoom,
  selectedPlaceId = null,
}: BuildMarkersOptions): MarkerBuild {
  const visible: Place[] = [];
  let hiddenByZoom = 0;

  for (const place of places) {
    if (place.id === selectedPlaceId || isVisibleAtZoom(place.categories, zoom)) {
      visible.push(place);
    } else {
      hiddenByZoom += 1;
    }
  }

  // Bucket by screen-space grid cell.
  const buckets = new Map<string, Place[]>();
  for (const place of visible) {
    const { x, y } = projectToPixels(place.location, zoom);
    const key = `${Math.floor(x / CLUSTER_CELL_PX)}:${Math.floor(y / CLUSTER_CELL_PX)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(place);
    else buckets.set(key, [place]);
  }

  const entries = [...buckets.entries()].sort((a, b) => {
    // Biggest clusters first, then the most orienting categories, so the cap
    // below removes street-level detail rather than landmarks.
    if (b[1].length !== a[1].length) return b[1].length - a[1].length;
    return resolveCategory(a[1][0]?.categories).minZoom - resolveCategory(b[1][0]?.categories).minZoom;
  });

  const markers: MapMarker[] = [];
  const clusters = new Map<string, Place[]>();

  for (const [key, bucketPlaces] of entries) {
    if (markers.length >= MAX_MARKERS) {
      hiddenByZoom += bucketPlaces.length;
      continue;
    }

    // A bucket containing the selection is always drawn expanded around it, so
    // the selected pin never disappears inside a bubble.
    const selectedMember = selectedPlaceId
      ? bucketPlaces.find((place) => place.id === selectedPlaceId)
      : undefined;

    if (bucketPlaces.length === 1 || selectedMember) {
      const shown = selectedMember ?? bucketPlaces[0];
      if (!shown) continue;
      markers.push(placeMarker(shown, shown.id === selectedPlaceId));
      if (selectedMember && bucketPlaces.length > 1) {
        // The rest of the bucket collapses into a bubble beside the selection.
        const rest = bucketPlaces.filter((place) => place.id !== selectedMember.id);
        const clusterId = `cluster:${key}`;
        clusters.set(clusterId, rest);
        markers.push(clusterMarker(clusterId, rest));
      }
      continue;
    }

    const clusterId = `cluster:${key}`;
    clusters.set(clusterId, bucketPlaces);
    markers.push(clusterMarker(clusterId, bucketPlaces));
  }

  return { markers, clusters, hiddenByZoom };
}

function placeMarker(place: Place, selected: boolean): MapMarker {
  const category = resolveCategory(place.categories);
  const capabilities = capabilitySummary(place.capabilities);

  // The accessible name carries everything the pill's shape and colour imply:
  // what it is, what it offers, and whether it is the current selection. Colour
  // is never the only indicator (issue #7 → Accessibility).
  const parts = [place.name, category.label];
  if (place.status === 'closed') parts.push('permanently closed');
  if (capabilities) parts.push(capabilities);
  if (selected) parts.push('selected');

  return {
    id: place.id,
    coordinate: place.location,
    kind: category.key,
    label: markerLabel(place),
    selected,
    accessibilityLabel: parts.join(', '),
  };
}

function clusterMarker(id: string, places: readonly Place[]): MapMarker {
  const centre = centroid(places);
  return {
    id,
    coordinate: centre,
    kind: 'cluster',
    count: places.length,
    accessibilityLabel: `${places.length} places in this area. Activate to zoom in.`,
  };
}

/** The mean of a bucket's coordinates. A bucket is ~72 px wide; a mean is fine. */
function centroid(places: readonly Place[]): { latitude: number; longitude: number } {
  let latitude = 0;
  let longitude = 0;
  for (const place of places) {
    latitude += place.location.latitude;
    longitude += place.location.longitude;
  }
  return { latitude: latitude / places.length, longitude: longitude / places.length };
}
