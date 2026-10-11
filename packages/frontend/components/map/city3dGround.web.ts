/**
 * Keeps the city-3D buildings standing on MapLibre's 3D terrain: tells the
 * engine what the drawn ground is (`map.queryTerrainElevation`) whenever the
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

export function followTerrain(
  map: MapLibreMap,
  engine: { setGround(sample: GroundSampler | null): void },
): () => void {
  let source: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // `queryTerrainElevation` reads the surface MapLibre is DRAWING (its loaded
  // DEM tiles, exaggeration included), so a building lands on the ground the
  // user sees — not on a finer or coarser model of it.
  const sample: GroundSampler = (lng, lat) => map.queryTerrainElevation([lng, lat]) ?? 0;

  const refresh = () => {
    timer = null;
    source = map.getTerrain()?.source ?? null;
    engine.setGround(source ? sample : null);
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
