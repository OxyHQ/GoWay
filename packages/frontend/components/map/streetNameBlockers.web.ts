/**
 * A street painted with its name on the asphalt (`docs/MAP_STREETS.md`) should
 * not also carry the map's flat label for the same stretch: one name, not two.
 *
 * Done with MapLibre's OWN collision, segment by segment: an invisible symbol
 * layer of blockers — points every few metres along each painted name, from
 * the street renderer — sits directly ABOVE the road-label layers. MapLibre
 * places symbols from the top layer down, so the blockers are placed first
 * (always: `icon-allow-overlap`) and take their room in the collision index;
 * a road label that would land on a painted name then finds no room there and
 * is placed further along its line, or not at all — while the same street
 * keeps its label wherever its name is not painted, and every label above the
 * blockers (POIs, places) is untouched.
 *
 * Why not a filter: MapLibre's `within` needs a label's whole line inside one
 * polygon, and OpenMapTiles merges a street's name line across its tile, so
 * it would almost never match; a name filter would hide the street's label
 * everywhere at once.
 *
 * `maplibre-gl` is imported for types only (`MapCanvas.web.tsx` owns the map).
 */
import type { Map as MapLibreMap } from 'maplibre-gl';

import { GOWAY_LAYER_PREFIX } from '@/lib/map/provider';
import { OPENMAPTILES_SOURCE_LAYERS } from '@/lib/map/style/schema';

export const STREET_NAME_BLOCKER_SOURCE = `${GOWAY_LAYER_PREFIX}street-name-blockers`;
export const STREET_NAME_BLOCKER_LAYER = `${GOWAY_LAYER_PREFIX}street-name-blockers`;
const BLANK_IMAGE = `${GOWAY_LAYER_PREFIX}blank`;

/**
 * The layer the blockers go before: the one right after the LAST symbol
 * layer of road names (`transportation_name`), so they sit directly above the
 * road labels and below everything else; `null` when the style has no road
 * labels (a style GoWay does not own) — then nothing is added. Exported for the tests.
 */
export function blockerAnchor(
  layers: readonly { id: string; type: string; 'source-layer'?: string }[],
): { before: string | undefined } | null {
  let last = -1;
  layers.forEach((layer, i) => {
    if (
      layer.type === 'symbol' &&
      layer['source-layer'] === OPENMAPTILES_SOURCE_LAYERS.transportationName
    ) {
      last = i;
    }
  });
  if (last < 0) return null;
  return { before: layers[last + 1]?.id };
}

/** The blockers as GeoJSON points. Exported for the tests. */
export function blockerFeatures(points: readonly (readonly [number, number])[]) {
  return {
    type: 'FeatureCollection' as const,
    features: points.map(([lng, lat]) => ({
      type: 'Feature' as const,
      properties: {},
      geometry: { type: 'Point' as const, coordinates: [lng, lat] },
    })),
  };
}

export interface StreetNameBlockers {
  set(points: readonly (readonly [number, number])[]): void;
  remove(): void;
}

export function mountStreetNameBlockers(map: MapLibreMap): StreetNameBlockers {
  let mounted = false;
  const mount = (): boolean => {
    if (mounted) return true;
    const anchor = blockerAnchor(map.getStyle()?.layers ?? []);
    if (!anchor) return false;
    if (!map.hasImage(BLANK_IMAGE)) {
      map.addImage(BLANK_IMAGE, { width: 1, height: 1, data: new Uint8Array(4) });
    }
    map.addSource(STREET_NAME_BLOCKER_SOURCE, { type: 'geojson', data: blockerFeatures([]) });
    map.addLayer(
      {
        id: STREET_NAME_BLOCKER_LAYER,
        type: 'symbol',
        source: STREET_NAME_BLOCKER_SOURCE,
        layout: {
          'icon-image': BLANK_IMAGE,
          // A painted name is ~2–3 m tall: its room on screen grows with zoom.
          'icon-size': ['interpolate', ['exponential', 2], ['zoom'], 16, 4, 20, 64],
          'icon-allow-overlap': true,
          'icon-ignore-placement': false,
        },
        paint: { 'icon-opacity': 0 },
      },
      anchor.before,
    );
    mounted = true;
    return true;
  };
  return {
    set(points) {
      try {
        if (!mount()) return;
        const source = map.getSource(STREET_NAME_BLOCKER_SOURCE) as
          | { setData(data: unknown): void }
          | undefined;
        source?.setData(blockerFeatures(points));
      } catch {
        // A style being swapped: the next change tries again.
        mounted = false;
      }
    },
    remove() {
      try {
        if (map.getLayer(STREET_NAME_BLOCKER_LAYER)) map.removeLayer(STREET_NAME_BLOCKER_LAYER);
        if (map.getSource(STREET_NAME_BLOCKER_SOURCE)) map.removeSource(STREET_NAME_BLOCKER_SOURCE);
        if (map.hasImage(BLANK_IMAGE)) map.removeImage(BLANK_IMAGE);
      } catch {
        // The map is gone with them.
      }
      mounted = false;
    },
  };
}
