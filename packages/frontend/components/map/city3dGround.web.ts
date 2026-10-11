/**
 * Keeps the city-3D buildings standing on MapLibre's 3D terrain: tells the
 * engine what the drawn ground is ({@link groundSampler}) whenever the
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

import type { GroundSampler } from './engine/city3d/terrainGround';

/**
 * A burst of DEM tiles (a zoom, a pan) re-grounds once, this long after the
 * first of them, rather than once per tile. Each re-ground resamples every
 * visible tile's grid; most find nothing moved and upload nothing.
 */
const REFRESH_AFTER_MS = 250;

/**
 * The drawn ground, as a sampler: MapLibre's terrain read at the DEM source's
 * own max zoom.
 *
 * Not `map.queryTerrainElevation`, measured: it reads the rendered terrain
 * tiles, and for a point outside them — which a z14 building tile's grid
 * always partly is, behind or under a pitched camera — it falls back to
 * computing the covering tiles PER CALL. One grid then took 166 ms instead of
 * ~1 ms. Reading the DEM at its max zoom (`Terrain.getElevationForLngLatZoom`,
 * part of MapLibre's typed API) is the same surface at every zoom the city
 * layer draws (≥ z15.5 the terrain is over-zoomed from that DEM), with the same
 * bilinear sampling and exaggeration, at a constant cost. It takes MapLibre's
 * own `LngLat`, so one from `getCenter()` is reused rather than importing
 * maplibre-gl here.
 */
function groundSampler(map: MapLibreMap, source: string): GroundSampler {
  const terrain = map.terrain;
  const zoom = map.getSource(source)?.maxzoom ?? 12;
  const at = map.getCenter();
  return (lng, lat) => {
    if (!terrain) return 0;
    at.lng = lng;
    at.lat = lat;
    return terrain.getElevationForLngLatZoom(at, zoom);
  };
}

export function followTerrain(
  map: MapLibreMap,
  engine: { setGround(sample: GroundSampler | null): void },
): () => void {
  let source: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const refresh = () => {
    timer = null;
    source = map.getTerrain()?.source ?? null;
    engine.setGround(source ? groundSampler(map, source) : null);
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
