/**
 * What `<Markers>` draws at a zoom: each marker, or the cluster that holds it.
 *
 * Mapbox clusters by SOURCE OPTIONS — `cluster`, `clusterRadius` (50),
 * `clusterMaxZoom` (14) — and draws the result as GL layers. `<Markers>` takes
 * the same options with the same defaults, but its markers are Bloom
 * components (buttons with a name and a pressed state), which neither engine
 * can draw: the GL layer's clustered features never come back to JS in time to
 * become React views. So the clustering runs here, with Supercluster —
 * Mapbox's own clustering library, the one Mapbox GL's `cluster: true` uses —
 * over the same 512 px tile grid MapLibre's zoom levels are defined against,
 * which is what makes `clusterRadius` mean the same pixels it means there.
 *
 * Pure, and derived in render from the data and the integer zoom: a cluster is
 * a function of what is shown and how far in, never a piece of state.
 *
 * ## A pin sits where its data put it
 *
 * A point is drawn at the coordinate it arrived with, looked up by id — never
 * at a position recomputed from an index — so a published coordinate is drawn
 * at exactly the precision it was published with. A cluster has no position of
 * its own, so its centroid is the only place it can be drawn.
 */
import Supercluster from 'supercluster';

import type { GeoCoordinate, MapMarkerCluster, MapMarkerData, MapMarkerItem } from './types';

export interface ClusterOptions {
  radius: number;
  maxZoom: number;
  minPoints: number;
}

/** Mapbox's defaults (`clusterRadius` 50, `clusterMaxZoom` 14), and two points make a cluster. */
export const DEFAULT_CLUSTER_OPTIONS: ClusterOptions = { radius: 50, maxZoom: 14, minPoints: 2 };

/** One thing to draw, keyed stably for React and for the engine's marker. */
export interface MarkerSlot {
  key: string;
  coordinate: GeoCoordinate;
  item: MapMarkerItem;
  /** For a cluster: the zoom at which it splits. */
  expansionZoom?: number;
}

type PointProperties = { id: string };

export interface MarkerIndex {
  /** Every marker by id. */
  byId: ReadonlyMap<string, MapMarkerData>;
  /** `null` when clustering is off. */
  clusters: Supercluster<PointProperties, Supercluster.AnyProps> | null;
}

/** Build the index once per data set and option set. */
export function indexMarkers(
  data: readonly MapMarkerData[],
  options: ClusterOptions | null,
): MarkerIndex {
  const byId = new Map<string, MapMarkerData>();
  for (const marker of data) byId.set(marker.id, marker);
  if (!options) return { byId, clusters: null };
  const clusters = new Supercluster<PointProperties, Supercluster.AnyProps>({
    radius: options.radius,
    maxZoom: options.maxZoom,
    minPoints: options.minPoints,
    // MapLibre's zoom is defined on 512 px tiles: a radius in this extent is
    // the same number of pixels on screen.
    extent: 512,
  });
  clusters.load(
    data.map((marker) => ({
      type: 'Feature' as const,
      geometry: {
        type: 'Point' as const,
        coordinates: [marker.coordinate.longitude, marker.coordinate.latitude],
      },
      properties: { id: marker.id },
    })),
  );
  return { byId, clusters };
}

const WORLD: [number, number, number, number] = [-180, -85.051129, 180, 85.051129];

/**
 * What to draw at `zoom`, with Bloom's states: the selected marker (and the
 * cluster holding it) `active`, markers pressed before `visited`.
 */
export function markerSlotsAt(
  index: MarkerIndex,
  zoom: number,
  selectedId: string | null | undefined,
  visited: ReadonlySet<string>,
): MarkerSlot[] {
  const pointState = (id: string): 'default' | 'active' | 'visited' =>
    id === selectedId ? 'active' : visited.has(id) ? 'visited' : 'default';

  if (!index.clusters) {
    return [...index.byId.values()].map((marker) => ({
      key: `point:${marker.id}`,
      coordinate: marker.coordinate,
      item: { kind: 'point', marker, state: pointState(marker.id) },
    }));
  }

  const slots: MarkerSlot[] = [];
  for (const feature of index.clusters.getClusters(WORLD, Math.floor(zoom))) {
    const properties = feature.properties as Partial<Supercluster.ClusterProperties> &
      Partial<PointProperties>;
    if (properties.cluster && typeof properties.cluster_id === 'number') {
      const clusterId = properties.cluster_id;
      const leaves = index.clusters.getLeaves(clusterId, Number.POSITIVE_INFINITY);
      const markerIds = leaves.map((leaf) => String(leaf.properties.id));
      const [longitude, latitude] = feature.geometry.coordinates as [number, number];
      const cluster: MapMarkerCluster = {
        id: `cluster:${clusterId}`,
        coordinate: { latitude, longitude },
        count: properties.point_count ?? markerIds.length,
        markerIds,
      };
      slots.push({
        key: cluster.id,
        coordinate: cluster.coordinate,
        item: {
          kind: 'cluster',
          cluster,
          state: selectedId != null && markerIds.includes(selectedId) ? 'active' : 'default',
        },
        expansionZoom: index.clusters.getClusterExpansionZoom(clusterId),
      });
      continue;
    }
    const marker = properties.id !== undefined ? index.byId.get(properties.id) : undefined;
    if (!marker) continue;
    slots.push({
      key: `point:${marker.id}`,
      coordinate: marker.coordinate,
      item: { kind: 'point', marker, state: pointState(marker.id) },
    });
  }
  return slots;
}
