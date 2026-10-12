/**
 * Keeps the city-3D buildings standing on MapLibre's 3D terrain: tells the
 * engine what the drawn ground is ({@link groundOf}) whenever the
 * terrain is switched on or off, or a DEM tile arrives that may have changed
 * it. The engine does the placing (`engine/city3d/terrainGround.ts`); this is
 * only the MapLibre side of it, so the engine stays host-neutral.
 *
 * Generic on purpose: it follows whatever terrain the map has
 * (`map.getTerrain()`), not the relief prototype's — so it imports nothing
 * from that lazy chunk, and the two chunks share no module (a shared one is
 * hoisted into the first-paint bundle; see `engine3d/lazyChunk.ts`). Its
 * engine import is type-only for the same reason.
 */
import type { Map as MapLibreMap, MapSourceDataEvent } from 'maplibre-gl';

import type { GroundLattice, GroundSampler } from './engine/city3d/terrainGround';

/**
 * A burst of DEM tiles (a zoom, a pan) re-grounds once, this long after the
 * first of them, rather than once per tile. Each re-ground resamples every
 * visible tile's grid; most find nothing moved and upload nothing.
 */
const REFRESH_AFTER_MS = 250;

/**
 * The drawn ground, as a sampler: MapLibre's terrain read from the DEM's
 * FINEST tile, the one its terrain tiles at street level are drawn from.
 *
 * The zoom is the DEM source's max zoom PLUS the terrain's `deltaZoom`.
 * `getElevationForLngLatZoom` takes a TERRAIN tile's zoom, and a terrain tile
 * at zoom `z` reads the DEM tile at `z − deltaZoom` (`TerrainTileManager`,
 * `deltaZoom` 1). Asking at the max zoom itself — what this did until the
 * Mallorca–Marina report — read the DEM tile one zoom coarser than the one
 * drawn under every street (Barcelona: 29 m pixels for 14 m): measured on
 * that view, up to 10 m off by the Sagrada Família, and the terrain over 22%
 * of the street detail (`docs/MAP_TERRAIN_GLOBE.md` → "Everything on the
 * drawn ground").
 *
 * Not `map.queryTerrainElevation`, measured: it reads the rendered terrain
 * tiles, and for a point outside them — which a z14 building tile's grid
 * always partly is, behind or under a pitched camera — it falls back to
 * computing the covering tiles PER CALL. One grid then took 166 ms instead of
 * ~1 ms. `Terrain.getElevationForLngLatZoom` (typed API) samples the same DEM
 * pixels with the same arithmetic as the drawn mesh (`get_elevation`: bilinear
 * between pixel centres, exaggeration included), at a constant ~0.4 µs. It
 * takes MapLibre's own `LngLat`, so one from `getCenter()` is reused rather
 * than importing maplibre-gl here.
 */
function groundOf(
  map: MapLibreMap,
  source: string,
): { sample: GroundSampler; lattice: GroundLattice } {
  const terrain = map.terrain;
  // A `raster-dem` source always has both (MapLibre's defaults: 22 and 512).
  const dem = map.getSource(source) as { maxzoom: number; tileSize: number } | undefined;
  const lattice: GroundLattice = { zoom: dem?.maxzoom ?? 22, tileSize: dem?.tileSize ?? 512 };
  const zoom = lattice.zoom + (terrain?.tileManager.deltaZoom ?? 1);
  const at = map.getCenter();
  return {
    lattice,
    sample: (lng, lat) => {
      if (!terrain) return 0;
      at.lng = lng;
      at.lat = lat;
      return terrain.getElevationForLngLatZoom(at, zoom);
    },
  };
}

export function followTerrain(
  map: MapLibreMap,
  engine: { setGround(sample: GroundSampler | null, lattice?: GroundLattice): void },
): () => void {
  let source: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const refresh = () => {
    timer = null;
    source = map.getTerrain()?.source ?? null;
    if (!source) {
      engine.setGround(null);
      return;
    }
    const { sample, lattice } = groundOf(map, source);
    engine.setGround(sample, lattice);
  };

  const onSourceData = (event: MapSourceDataEvent) => {
    if (!source || event.sourceId !== source || !event.tile || timer) return;
    timer = setTimeout(refresh, REFRESH_AFTER_MS);
  };

  map.on('terrain', refresh);
  map.on('sourcedata', onSourceData);
  refresh();

  return () => {
    map.off('terrain', refresh);
    map.off('sourcedata', onSourceData);
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
