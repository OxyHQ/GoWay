/**
 * Tile ⇄ Web Mercator ⇄ metres, for the city-3D prototype.
 *
 * Pure arithmetic, no renderer and no map engine: the mesher (in a Web Worker)
 * and the three.js engine (on the main thread) both need the same answers, and
 * the answers are exactly the kind of thing that is wrong by a sign or a power
 * of two without anyone noticing until a building lands in the sea. So they
 * live in one place and `__tests__/city3dTileMath.test.ts` pins them.
 *
 * ## The three frames
 *
 *  - **Tile units.** What a vector tile carries: integers in `[0, extent]`
 *    (4096 in GoWay's tiles), origin at the tile's NORTH-WEST corner, `y`
 *    growing SOUTH. Geometry may spill a little past the edges (the tile
 *    buffer); the mesher clips it back.
 *  - **Local metres (ENU).** What a mesh is built in: `x` east and `y` NORTH
 *    from the tile's north-west corner, `z` up from the ground, all in metres.
 *    Right-handed, so a normal computed with a cross product means what it
 *    says, and bevel widths and occlusion reach are real distances rather than
 *    fractions of a tile. Every `y` inside a tile is therefore `<= 0`.
 *  - **Mercator.** MapLibre's world: `[0, 1]` across and down the whole map,
 *    `y` growing SOUTH, and `z` CONFORMAL — one mercator unit up is as long as
 *    one across, at that latitude. This is the frame
 *    `defaultProjectionData.mainMatrix` projects from.
 *
 * ## Why the model matrix is relative to a centre
 *
 * A mercator coordinate near the middle of the map is ~0.5, and float32 (what
 * the GPU gets) has 24 bits of mantissa: its spacing at 0.5 is ~6e-8 of the
 * world, which is **~2.4 m** on the ground. Uploading absolute mercator
 * positions, or a model matrix whose translation is an absolute mercator
 * position, makes buildings swim by metres as the camera moves. So
 * {@link tileModelMatrix} translates by `tileOrigin - centre`, computed here
 * in float64, and the engine folds `+ centre` into the projection side, also
 * in float64 (see `cameraMatrix`). Both matrices the GPU then sees carry only
 * small, well-conditioned numbers. This is the same "relative to centre" trick
 * MapLibre uses for its own tiles.
 */

// The Earth's circumference as MAPLIBRE measures it — `2π × 6,371,008.8 m`,
// the mean radius, not WGS 84's equatorial 6,378,137 m — and the projection's
// arithmetic are `@goway.to/sdk/geo`'s, the one copy (re-exported here under the
// engine's names). Only heights depend on the radius: a mesh is built in
// metres from tile units and turned back into mercator with the same factor,
// so the horizontal scale cancels whatever the radius. Height does not
// cancel, and MapLibre converts a `fill-extrusion` height with this radius
// (`mercatorZfromAltitude`). Using the equatorial one made every building
// 0.11% taller than the extrusion it replaces — caught by
// `city3dTileMath.test.ts`, which compares against MapLibre's own
// `MercatorCoordinate`.
import {
  EARTH_CIRCUMFERENCE_M,
  latitudeFromMercatorY as latFromMercatorY,
  mercatorX as mercatorXFromLng,
  mercatorY as mercatorYFromLat,
} from '@goway.to/sdk/geo';

export { EARTH_CIRCUMFERENCE_M, latFromMercatorY, mercatorXFromLng, mercatorYFromLat };

/** A vector tile address. `x`/`y` are the XYZ scheme (row 0 is the north). */
export interface TileId {
  z: number;
  x: number;
  y: number;
}

/** A point in mercator `[0, 1]` space. */
export interface MercatorPoint {
  x: number;
  y: number;
}

/** A geographic box, in degrees. */
export interface LngLatBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** A stable cache key for a tile. */
export function tileKey(tile: TileId): string {
  return `${tile.z}/${tile.x}/${tile.y}`;
}

/** The tile's north-west corner in mercator. */
export function tileOrigin(tile: TileId): MercatorPoint {
  const n = 2 ** tile.z;
  return { x: tile.x / n, y: tile.y / n };
}

/** The latitude through the middle of a tile — where its metre scale is taken. */
export function tileCenterLatitude(tile: TileId): number {
  return latFromMercatorY((tile.y + 0.5) / 2 ** tile.z);
}

/**
 * How many mercator units one metre is, at a latitude.
 *
 * Mercator stretches by `1 / cos(lat)`, so a metre covers more of the map the
 * further it is from the equator. The same factor applies to height — the
 * frame is conformal — which is why one number is enough for all three axes.
 */
export function mercatorPerMetre(lat: number): number {
  return 1 / (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180));
}

/**
 * A tile's side in metres, measured at its middle latitude.
 *
 * A z14 tile at the equator is ~2.4 km; at Barcelona's 41° it is ~1.85 km.
 * The tile is not quite square on the ground (its north edge is shorter than
 * its south), but across one z14 tile the difference is a few parts in ten
 * thousand, well under anything a building mesh can show.
 */
export function tileSizeMetres(tile: TileId): number {
  return 1 / (2 ** tile.z * mercatorPerMetre(tileCenterLatitude(tile)));
}

/**
 * Column-major 4×4 taking a tile's LOCAL METRES (ENU, see the header) to
 * mercator RELATIVE TO `center`, in the world copy `tile.wrap` (0 when absent;
 * see {@link ViewTile}).
 *
 * `x` scales by `k` (mercator per metre) and moves by the origin's offset from
 * the centre; `y` scales by `-k`, because local `y` is north and mercator `y`
 * is south; `z` scales by `k`, because mercator height is conformal.
 *
 * The `-k` makes the determinant negative — the matrix is a mirror. That is
 * deliberate and correct (it is converting a right-handed frame into
 * MapLibre's left-handed one), and the engine accounts for it when it picks
 * which triangle faces to cull.
 */
export function tileModelMatrix(tile: TileId & { wrap?: number }, center: MercatorPoint): number[] {
  const origin = tileOrigin(tile);
  // A tile drawn in another world copy sits whole worlds (mercator units) away.
  origin.x += tile.wrap ?? 0;
  const k = mercatorPerMetre(tileCenterLatitude(tile));
  // biome-ignore format: a 4×4 matrix reads as four columns.
  return [
    k, 0, 0, 0,
    0, -k, 0, 0,
    0, 0, k, 0,
    origin.x - center.x, origin.y - center.y, 0, 1,
  ];
}

/** `a × b` for column-major 4×4 matrices, in float64. */
export function multiplyMat4(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const out = new Array<number>(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/**
 * The projection the engine's camera uses: the host's mercator → clip matrix
 * with `+ center` folded in, so that it accepts centre-relative mercator (what
 * {@link tileModelMatrix} produces).
 *
 * Done in float64 BEFORE anything reaches the GPU; that ordering is the whole
 * precision fix described in the header.
 */
export function centeredProjection(
  mercatorToClip: ArrayLike<number>,
  center: MercatorPoint,
): number[] {
  // biome-ignore format: a 4×4 matrix reads as four columns.
  const translate = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    center.x, center.y, 0, 1,
  ];
  return multiplyMat4(mercatorToClip, translate);
}

/**
 * A tile in view: the canonical tile to FETCH (`x` in `[0, 2^z)`) plus the
 * world copy it is drawn in. `wrap` is how many whole worlds east (+) or west
 * (−) of the canonical one the camera sees it: a view straddling the
 * antimeridian sees tile x = 0 one world east of tile x = 2^z − 1.
 */
export interface ViewTile extends TileId {
  wrap: number;
}

/**
 * The tiles to keep loaded for a view, nearest first.
 *
 * "Load near view" — the default both reference projects (Valdrada, Procedural
 * Tokyo) chose — rather than "load the viewport". A pitched camera's viewport
 * runs to the horizon, which at z16 and 60° is kilometres of tiles nobody can
 * see as buildings. So the candidates are the tiles the visible box touches
 * within a few tiles of the centre, ordered by distance from the centre and
 * cut at `maxTiles`. The far field is simply not drawn by this prototype; a
 * real LOD would draw it coarsely (see `docs/MAP_3D_CITY.md`).
 *
 * ## Across the antimeridian
 *
 * MapLibre reports a view that straddles ±180° with UNWRAPPED bounds (e.g.
 * west 179.9, east 180.2). The first version clamped x into the canonical
 * world, so the tiles east of the line were never loaded (PR #119 review).
 * Now x runs unwrapped, each tile is fetched as its canonical `x mod 2^z` and
 * drawn with its world offset (`wrap`, see {@link tileModelMatrix}). Bounds
 * given the other way round (east < west) are read as crossing the line, and
 * the centre is moved into the bounds' own world copy before distances are
 * measured. One canonical tile is drawn once — in the nearest copy — since a
 * mesh has one placement; two copies of the same tile cannot both be near the
 * camera at the zooms this layer draws.
 */
export function tilesForView(
  bounds: LngLatBox,
  center: { lng: number; lat: number },
  zoom: number,
  maxTiles: number,
): ViewTile[] {
  const n = 2 ** zoom;
  const west = bounds.west;
  const east = bounds.east < bounds.west ? bounds.east + 360 : bounds.east;
  const mid = (west + east) / 2;
  const lng = center.lng + 360 * Math.round((mid - center.lng) / 360);
  const cx = mercatorXFromLng(lng) * n;
  const cy = mercatorYFromLat(center.lat) * n;

  // Never walk further from the centre than the nearest `maxTiles` can reach:
  // a pitched or zoomed-out view's box can span thousands of tiles.
  const reach = Math.ceil(Math.sqrt(Math.max(1, maxTiles))) + 1;
  const clampY = (value: number) => Math.max(0, Math.min(n - 1, Math.floor(value)));
  const minX = Math.max(Math.floor(mercatorXFromLng(west) * n), Math.floor(cx) - reach);
  const maxX = Math.min(Math.floor(mercatorXFromLng(east) * n), Math.floor(cx) + reach);
  const minY = Math.max(clampY(mercatorYFromLat(bounds.north) * n), Math.floor(cy) - reach);
  const maxY = Math.min(clampY(mercatorYFromLat(bounds.south) * n), Math.floor(cy) + reach);

  const nearest = new Map<string, { tile: ViewTile; distance: number }>();
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      // Distance from the centre to the tile's nearest point, in tiles: the
      // tile the camera stands in is 0, whatever corner it is near.
      const dx = Math.max(x - cx, 0, cx - (x + 1));
      const dy = Math.max(y - cy, 0, cy - (y + 1));
      const distance = Math.hypot(dx, dy);
      const tile: ViewTile = { z: zoom, x: ((x % n) + n) % n, y, wrap: Math.floor(x / n) };
      const key = tileKey(tile);
      const seen = nearest.get(key);
      if (!seen || distance < seen.distance) nearest.set(key, { tile, distance });
    }
  }
  const tiles = [...nearest.values()];
  tiles.sort(
    (a, b) =>
      a.distance - b.distance ||
      a.tile.y - b.tile.y ||
      a.tile.wrap - b.tile.wrap ||
      a.tile.x - b.tile.x,
  );
  return tiles.slice(0, Math.max(0, maxTiles)).map((entry) => entry.tile);
}
