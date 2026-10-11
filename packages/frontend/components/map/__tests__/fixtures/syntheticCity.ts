/**
 * A synthetic city for the CI budget gate (`frameBudget.test.ts`): an
 * Eixample-like grid — 113 m blocks with chamfered corners and a courtyard,
 * twenty buildings each, street trees every 9 m — generated per tile, the same
 * every run, and served over HTTP in BOTH tile formats the engine reads:
 * GoWay city tiles (z15, per building, with storeys) and OpenMapTiles z14
 * (one footprint per block, `render_height`). Made up on purpose: no
 * OpenStreetMap data is committed or fetched, and nothing is random.
 *
 * Encoded with the city-tile compiler's own encoder (`scripts/citygen/mvtEncode.ts`)
 * and decoded by the engine's own worker, so the gate exercises the real
 * decode, mesh, LOD, tree and upload paths.
 */
import {
  type CityTileFeature,
  encodeCityTile,
  encodeTileLayers,
  encodePolygons,
  encodeTreeLayer,
  type TilePoint,
  type TilePolygon,
} from '@/scripts/citygen/mvtEncode';
import { CITY_TILE_EXTENT, type CityTileTree } from '@/lib/map/cityTiles';
import {
  mercatorPerMetre,
  mercatorXFromLng,
  mercatorYFromLat,
} from '@/components/map/engine/city3d/tileMath';

/** The grid's origin: Barcelona's Eixample, where the real city is densest. */
export const SYNTHETIC_CENTRE = { lng: 2.164, lat: 41.3925 };
/** How far the city reaches from the centre, metres (beyond it: open ground). */
export const SYNTHETIC_RADIUS_M = 3500;

const PITCH_M = 133.3;
const BLOCK_M = 113.3;
const CHAMFER_M = 15;
const DEPTH_M = 22;
const TREE_STEP_M = 9;

const originX = mercatorXFromLng(SYNTHETIC_CENTRE.lng);
const originY = mercatorYFromLat(SYNTHETIC_CENTRE.lat);
const k = mercatorPerMetre(SYNTHETIC_CENTRE.lat);

/** A stable hash in [0, 1) from integers. */
function hash(a: number, b: number, c = 0): number {
  let h =
    Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^
    Math.imul(b + 0x7f4a7c15, 0xc2b2ae35) ^
    Math.imul(c + 1, 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

type Metres = [number, number];

/** Block (i, j)'s south-west corner, metres east/south of the origin (y grows south, as mercator). */
function blockOrigin(i: number, j: number): Metres {
  return [i * PITCH_M, j * PITCH_M];
}

/** A building: its footprint (metres, closed implicitly), height and storeys. */
interface Building {
  id: number;
  ring: Metres[];
  height: number;
  levels: number;
}

function blockBuildings(i: number, j: number): Building[] {
  const [x0, y0] = blockOrigin(i, j);
  const b = BLOCK_M;
  const d = DEPTH_M;
  const c = CHAMFER_M;
  const out: Building[] = [];
  let n = 0;
  const add = (ring: Metres[]) => {
    const h = 12 + Math.floor(hash(i, j, n) * 6) * 3.66;
    out.push({
      // Planetiler's way encoding (osmId × 10 + 2), unique per block and part.
      id: ((i + 1000) * 10_000 + (j + 1000) * 40 + n) * 10 + 2,
      ring: ring.map(([x, y]) => [x0 + x, y0 + y] as Metres),
      height: h,
      levels: Math.round(h / 3.66),
    });
    n++;
  };
  // Four sides, four parcels each, between the chamfered corners.
  const span = b - 2 * (c + d);
  for (let p = 0; p < 4; p++) {
    const a = c + d + (span * p) / 4;
    const e = c + d + (span * (p + 1)) / 4;
    add([
      [a, 0],
      [e, 0],
      [e, d],
      [a, d],
    ]); // north side
    add([
      [a, b - d],
      [e, b - d],
      [e, b],
      [a, b],
    ]); // south side
    add([
      [0, a],
      [d, a],
      [d, e],
      [0, e],
    ]); // west side
    add([
      [b - d, a],
      [b, a],
      [b, e],
      [b - d, e],
    ]); // east side
  }
  // Four chamfered corners.
  add([
    [c, 0],
    [c + d, 0],
    [c + d, d],
    [d, c + d],
    [0, c + d],
    [0, c],
  ]);
  add([
    [b - c - d, 0],
    [b - c, 0],
    [b, c],
    [b, c + d],
    [b - d, c + d],
    [b - c - d, d],
  ]);
  add([
    [0, b - c - d],
    [d, b - c - d],
    [c + d, b - d],
    [c + d, b],
    [c, b],
    [0, b - c],
  ]);
  add([
    [b - d, b - c - d],
    [b, b - c - d],
    [b, b - c],
    [b - c, b],
    [b - c - d, b],
    [b - c - d, b - d],
  ]);
  return out;
}

/** The blocks (i, j) whose south-west corner lies in a mercator box, within the city's radius. */
function blocksIn(minX: number, minY: number, maxX: number, maxY: number): Array<[number, number]> {
  const toM = (v: number, o: number) => (v - o) / k;
  const i0 = Math.floor(toM(minX, originX) / PITCH_M) - 1;
  const i1 = Math.ceil(toM(maxX, originX) / PITCH_M);
  const j0 = Math.floor(toM(minY, originY) / PITCH_M) - 1;
  const j1 = Math.ceil(toM(maxY, originY) / PITCH_M);
  const out: Array<[number, number]> = [];
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const [x, y] = blockOrigin(i, j);
      if (Math.hypot(x + BLOCK_M / 2, y + BLOCK_M / 2) > SYNTHETIC_RADIUS_M) continue;
      out.push([i, j]);
    }
  }
  return out;
}

function tileBox(z: number, x: number, y: number) {
  const n = 2 ** z;
  return { minX: x / n, minY: y / n, maxX: (x + 1) / n, maxY: (y + 1) / n, n };
}

/** Metres from the origin → this tile's units. */
function toTile(box: ReturnType<typeof tileBox>, [mx, my]: Metres): TilePoint {
  const X = originX + mx * k;
  const Y = originY + my * k;
  return [
    (X * box.n - box.minX * box.n) * CITY_TILE_EXTENT,
    (Y * box.n - box.minY * box.n) * CITY_TILE_EXTENT,
  ];
}

const centroid = (ring: Metres[]): Metres => [
  ring.reduce((s, p) => s + p[0], 0) / ring.length,
  ring.reduce((s, p) => s + p[1], 0) / ring.length,
];

/** Rings in tile y-down order are wound so the encoder sees positive exteriors. */
function polygon(
  box: ReturnType<typeof tileBox>,
  ring: Metres[],
  holes: Metres[][] = [],
): TilePolygon {
  return {
    outer: ring.map((p) => toTile(box, p)),
    holes: holes.map((h) => h.map((p) => toTile(box, p))),
  };
}

/** A z15 GoWay city tile: every building whose centroid is in it, whole; and its street trees. */
export function cityTile(z: number, x: number, y: number): Uint8Array {
  const box = tileBox(z, x, y);
  const inTile = (m: Metres) => {
    const X = originX + m[0] * k;
    const Y = originY + m[1] * k;
    return X >= box.minX && X < box.maxX && Y >= box.minY && Y < box.maxY;
  };
  const features: CityTileFeature[] = [];
  const trees: CityTileTree[] = [];
  for (const [i, j] of blocksIn(box.minX, box.minY, box.maxX, box.maxY)) {
    for (const building of blockBuildings(i, j)) {
      if (!inTile(centroid(building.ring))) continue;
      features.push({
        id: building.id,
        polygons: [polygon(box, building.ring)],
        properties: {
          render_height: building.height,
          render_min_height: 0,
          levels: building.levels,
          height_source: 'osm',
        },
      });
    }
    // Street trees along the block's north and west kerbs, 4 m out.
    const [x0, y0] = blockOrigin(i, j);
    for (let s = TREE_STEP_M; s < BLOCK_M; s += TREE_STEP_M) {
      for (const [tx, ty, side] of [
        [x0 + s, y0 - 4, 0],
        [x0 - 4, y0 + s, 1],
      ] as const) {
        if (!inTile([tx, ty])) continue;
        const [px, py] = toTile(box, [tx, ty]);
        trees.push({
          id: ((i + 1000) * 10_000 + (j + 1000) * 40) * 100 + Math.round(s) * 2 + side,
          point: [Math.round(px), Math.round(py)],
          properties: {},
        });
      }
    }
  }
  const buildings = encodeCityTile(features);
  const treeBytes = encodeTreeLayer(trees);
  const out = new Uint8Array(buildings.length + treeBytes.length);
  out.set(buildings, 0);
  out.set(treeBytes, buildings.length);
  return out;
}

/** A z14 OpenMapTiles tile: one footprint per block (a courtyard hole), at its tallest building. */
export function openMapTilesTile(z: number, x: number, y: number): Uint8Array {
  const box = tileBox(z, x, y);
  const features = blocksIn(box.minX, box.minY, box.maxX, box.maxY).map(([i, j]) => {
    const [x0, y0] = blockOrigin(i, j);
    const b = BLOCK_M;
    const c = CHAMFER_M;
    const d = DEPTH_M;
    const outer: Metres[] = [
      [c, 0],
      [b - c, 0],
      [b, c],
      [b, b - c],
      [b - c, b],
      [c, b],
      [0, b - c],
      [0, c],
    ].map(([px, py]) => [x0 + px, y0 + py] as Metres);
    const hole: Metres[] = [
      [d, d],
      [d, b - d],
      [b - d, b - d],
      [b - d, d],
    ].map(([px, py]) => [x0 + px, y0 + py] as Metres);
    const height = Math.max(...blockBuildings(i, j).map((building) => building.height));
    return {
      id: 0,
      type: 3 as const,
      geometry: encodePolygons([polygon(box, outer, [hole])]),
      properties: { render_height: height, render_min_height: 0 },
    };
  });
  return encodeTileLayers([{ name: 'building', features }]);
}

/** The coverage box the engine's city source needs: the whole synthetic city. */
export function syntheticCoverage(): Array<[number, number, number, number]> {
  const dLat = (SYNTHETIC_RADIUS_M + 500) / 111_320;
  const dLng = dLat / Math.cos((SYNTHETIC_CENTRE.lat * Math.PI) / 180);
  return [
    [
      SYNTHETIC_CENTRE.lng - dLng,
      SYNTHETIC_CENTRE.lat - dLat,
      SYNTHETIC_CENTRE.lng + dLng,
      SYNTHETIC_CENTRE.lat + dLat,
    ],
  ];
}

/** Serve both formats on a local port: `/city/{z}/{x}/{y}.pbf`, `/omt/{z}/{x}/{y}.pbf`. */
export function serveSyntheticCity(): { origin: string; requests: string[]; stop(): void } {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const url = new URL(request.url);
      const match = /^\/(city|omt)\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(url.pathname);
      if (!match) return new Response(null, { status: 404 });
      requests.push(url.pathname);
      const [z, x, y] = [Number(match[2]), Number(match[3]), Number(match[4])];
      const bytes = match[1] === 'city' ? cityTile(z, x, y) : openMapTilesTile(z, x, y);
      if (bytes.length === 0) return new Response(null, { status: 204 });
      return new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]), {
        headers: { 'content-type': 'application/x-protobuf' },
      });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}
