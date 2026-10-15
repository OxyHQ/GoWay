/**
 * Building footprints for the contamination gate, from GoWay's own city tiles
 * (`/map/city/15/{x}/{y}.pbf`, OpenStreetMap's buildings, `docs/MAP_3D_CITY.md`)
 * — the buildings the map draws on this ground — as rings in a pixel window.
 *
 * Only footprints that STAND on the ground: a part that starts above it
 * (`render_min_height > 0`: a skyway, an overhang, a roof on columns) has the
 * street under it, and is left out.
 */
import { decodeBuildings } from '../../components/map/engine/city3d/decode';
import { OPENMAPTILES_SOURCE_LAYERS } from '../../lib/map/style/schema';
import { TERRAIN_TILE_SIZE, type PixelWindow } from './grid';
import type { PixelRing } from './ground';

/** The zoom city tiles are published at. */
export const CITY_TILE_ZOOM = 15;

export interface WindowFootprints {
  /** Each footprint's rings in window pixels (exteriors and holes, even–odd). */
  polygons: PixelRing[][];
  /** City tiles read, and how many held buildings. */
  tiles: number;
  tilesWithBuildings: number;
}

/** The city tiles under a window, decoded, their standing footprints in window pixels. */
export async function footprintsInWindow(
  cityOrigin: string,
  window: PixelWindow,
  userAgent: string,
  concurrency = 8,
): Promise<WindowFootprints> {
  if (window.zoom < CITY_TILE_ZOOM - 3) throw new Error('footprints need a window of zoom ≥ 12');
  const perTile = TERRAIN_TILE_SIZE * 2 ** (window.zoom - CITY_TILE_ZOOM);
  const tx0 = Math.floor(window.x0 / perTile);
  const ty0 = Math.floor(window.y0 / perTile);
  const tx1 = Math.floor((window.x0 + window.width - 1) / perTile);
  const ty1 = Math.floor((window.y0 + window.height - 1) / perTile);
  const tiles: [number, number][] = [];
  for (let y = ty0; y <= ty1; y++) for (let x = tx0; x <= tx1; x++) tiles.push([x, y]);

  // Per tile, then flattened in tile order: the labels are the same on every run.
  const perTileFootprints: PixelRing[][][] = tiles.map(() => []);
  let withBuildings = 0;
  let next = 0;
  const layer = OPENMAPTILES_SOURCE_LAYERS.building;
  const worker = async () => {
    while (next < tiles.length) {
      const index = next++;
      const [tx, ty] = tiles[index];
      const url = `${cityOrigin}/map/city/${CITY_TILE_ZOOM}/${tx}/${ty}.pbf`;
      let bytes: Uint8Array | null = null;
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await fetch(url, { headers: { 'User-Agent': userAgent } });
          if (response.status === 404 || response.status === 204) break;
          if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
          bytes = new Uint8Array(await response.arrayBuffer());
          break;
        } catch (error) {
          if (attempt >= 5) throw error;
          await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        }
      }
      if (!bytes) continue;
      const decoded = decodeBuildings(bytes, layer);
      if (!decoded || decoded.features.length === 0) continue;
      withBuildings++;
      const k = perTile / decoded.extent;
      const ox = tx * perTile - window.x0;
      const oy = ty * perTile - window.y0;
      for (const feature of decoded.features) {
        const min = Number(feature.properties.render_min_height ?? 0);
        if (Number.isFinite(min) && min > 0) continue;
        perTileFootprints[index].push(
          feature.rings.map((ring) => ring.map(([x, y]) => [ox + x * k, oy + y * k] as const)),
        );
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return {
    polygons: perTileFootprints.flat(),
    tiles: tiles.length,
    tilesWithBuildings: withBuildings,
  };
}
