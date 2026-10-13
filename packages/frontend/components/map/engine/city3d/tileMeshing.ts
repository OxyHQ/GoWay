/**
 * Tile bytes → a packed building mesh: the one function every host of the
 * city engine calls, whatever thread it runs on.
 *
 * On the web that host is the mesh Web Worker (`meshWorker.ts`); on native it
 * is whatever off-thread runtime the native renderer uses
 * (`docs/MAP_NATIVE_3D.md`). So this module is pure: no `self`, no `fetch`,
 * no three.js, no DOM — bytes in, typed arrays out.
 */
import { CITY_TILE_EXTENT } from '@/lib/map/cityTiles';

import { meshVolumes, UNLIMITED_VOLUMES, type VolumeLimits } from '../camera/volumes';
import { decodeBuildings } from './decode';
import { withoutHidden } from './landmarkTiles';
import { concatTileMeshes, meshLod2Surfaces } from './lod2Mesher';
import { decodeLod2Tile } from './lod2Tiles';
import type { Lod } from './lod';
import { meshBuildingsLod } from './lodMesher';
import { meshBuildings } from './mesher';
import { meshOsmBuildings } from './osmMesher';
import { decodeCityTile } from './osmTiles';
import { type PackedMesh, packMesh } from './packing';
import type { Footprint } from './workerTrees';

/**
 * A packed mesh with its units as prisms for the camera (`camera/volumes.ts`),
 * built here, off the main thread, from the vertices just packed.
 */
function withVolumes(mesh: PackedMesh | null, limits: VolumeLimits): PackedMesh | null {
  if (mesh) mesh.volumes = meshVolumes(mesh, limits);
  return mesh;
}

/** Nothing to draw: a fresh value, so no caller can share (or mutate) another's. */
const nothing = (): Meshed => ({ mesh: null, footprints: { list: [], extent: 4096 }, sources: [] });

/** A mesh, the footprints trees must not stand in, and the official datasets it draws. */
export interface Meshed {
  mesh: PackedMesh | null;
  footprints: { list: readonly Footprint[]; extent: number };
  sources: string[];
}

/** OpenMapTiles' `building` layer, at the level of detail asked for. */
export function meshOpenMapTiles(
  bytes: ArrayBuffer,
  request: { sourceLayer: string; lod: Lod; volumes?: VolumeLimits },
  size: number,
): Meshed {
  const decoded = decodeBuildings(bytes, request.sourceLayer);
  if (!decoded) return nothing();
  const footprints = { list: decoded.features, extent: decoded.extent };
  const options = { extent: decoded.extent, tileSizeMetres: size };
  if (request.lod !== 0) {
    return {
      mesh: withVolumes(
        meshBuildingsLod(decoded.features, options, request.lod),
        request.volumes ?? UNLIMITED_VOLUMES,
      ),
      footprints,
      sources: [],
    };
  }
  const full = meshBuildings(decoded.features, options);
  return {
    mesh: withVolumes(full ? packMesh(full, size) : null, request.volumes ?? UNLIMITED_VOLUMES),
    footprints,
    sources: [],
  };
}

/**
 * GoWay city tiles: per-building, with roofs, colours and recorded storeys.
 * Full detail only (`osmMesher.ts` has no far levels yet); packed with its
 * colour and facade lanes.
 */
export function meshCityTile(
  bytes: ArrayBuffer,
  size: number,
  hidden: readonly number[] | undefined,
  /** What the camera's volumes may hold (the profile's `camera`); absent: no limit. */
  limits: VolumeLimits = UNLIMITED_VOLUMES,
): Meshed {
  const decoded = decodeCityTile(bytes);
  // Where the compiler merged official building data: its surfaces, in place
  // of the OSM buildings it covers (`drawn_by`), in the same mesh.
  const surfaces = decodeLod2Tile(bytes);
  const extent = decoded?.extent ?? CITY_TILE_EXTENT;
  // A drawn landmark's buildings are not meshed (`landmarkTiles.ts`) — nor the
  // official surfaces standing in for them; their footprints still keep the
  // trees off the ground the landmark stands on.
  const footprints = { list: decoded?.buildings ?? [], extent };
  const options = { extent, tileSizeMetres: size };
  const buildings = withoutHidden(
    surfaces.length > 0
      ? (decoded?.buildings ?? []).filter((b) => !b.drawnBy)
      : (decoded?.buildings ?? []),
    hidden,
  );
  const hiddenIds = new Set(hidden ?? []);
  const shown =
    hiddenIds.size > 0
      ? surfaces.filter((s) => s.osmId === undefined || !hiddenIds.has(s.osmId))
      : surfaces;
  const osm = buildings.length > 0 ? meshOsmBuildings(buildings, options) : null;
  const lod2 = shown.length > 0 ? meshLod2Surfaces(shown, options, decoded?.buildings) : null;
  const mesh = concatTileMeshes(osm, lod2);
  return {
    mesh: withVolumes(mesh ? packMesh(mesh, size) : null, limits),
    footprints,
    sources: lod2 ? [...new Set(shown.map((s) => s.source))] : [],
  };
}
