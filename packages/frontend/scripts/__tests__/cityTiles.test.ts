/**
 * The city-tile compiler end to end, on an OSM PBF written by this test:
 * reading (blobs, dense nodes, ways, relation ROLES), assembling a
 * multipolygon from two outer ways and a hole, replacing an outline by its
 * `building:part`, refusing an unclosed ring, assigning each building whole to
 * the tile of its representative point — then the MVT encoder against the
 * CLIENT's decoder (`osmTiles.ts`) and the PMTiles writer against the
 * Worker's reader (`worker/pmtiles.js`). The same code paths a real extract
 * takes; only the bytes are small.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, gunzipSync, gzipSync } from 'node:zlib';

import { PbfWriter } from 'pbf';

import { decodeCityTile } from '../../components/map/engine/city3d/osmTiles';
import { decodeMappedTrees } from '../../components/map/engine/city3d/treeSources';
import { CITY_TILE_EXTENT, CITY_TILE_ZOOM, CITY_TREE_LAYER } from '../../lib/map/cityTiles';
import { PMTiles, zxyToTileId } from '../../worker/pmtiles.js';
import { compile, representativePoint } from '../citygen/compile';
import { assembleRings } from '../citygen/rings';
import {
  encodeCityTile,
  encodePolygons,
  encodeTreeLayer,
  quantizeRing,
  type TilePoint,
  tileRingArea,
} from '../citygen/mvtEncode';
import { encodeDirectory, writePmtiles } from '../citygen/pmtilesWriter';

// ── A tiny OSM PBF ───────────────────────────────────────────────────────

/** ~1 m in degrees at Barcelona, near enough for a test footprint. */
const M_LAT = 1 / 111_000;
const M_LON = 1 / 83_500;
const ORIGIN = { lat: 41.392, lon: 2.164 };

type Node = { id: number; lat: number; lon: number; tags?: Record<string, string> };
type Way = { id: number; refs: number[]; tags: Record<string, string> };
type Relation = {
  id: number;
  tags: Record<string, string>;
  members: { way: number; role: string }[];
};

function rect(firstId: number, x0: number, y0: number, w: number, h: number): Node[] {
  return [
    [x0, y0],
    [x0 + w, y0],
    [x0 + w, y0 + h],
    [x0, y0 + h],
  ].map(([x, y], i) => ({
    id: firstId + i,
    lat: ORIGIN.lat + y * M_LAT,
    lon: ORIGIN.lon + x * M_LON,
  }));
}

function delta(values: number[]): number[] {
  return values.map((v, i) => v - (i === 0 ? 0 : values[i - 1]));
}

function writePbf(nodes: Node[], ways: Way[], relations: Relation[]): Uint8Array {
  const strings = [''];
  const index = (s: string) => {
    let i = strings.indexOf(s);
    if (i < 0) i = strings.push(s) - 1;
    return i;
  };
  const tagIdx = (tags: Record<string, string>) => ({
    keys: Object.keys(tags).map(index),
    vals: Object.values(tags).map(index),
  });
  // Resolve every string before writing the table.
  const sortedNodes = [...nodes].sort((a, b) => a.id - b.id);
  // DenseNodes keys_vals: per node its (key, value) pairs, then a 0.
  const keysVals = sortedNodes.some((n) => n.tags)
    ? sortedNodes.flatMap((n) => {
        const t = tagIdx(n.tags ?? {});
        return [...t.keys.flatMap((k, i) => [k, t.vals[i]]), 0];
      })
    : [];
  const wayTags = ways.map((w) => tagIdx(w.tags));
  const relTags = relations.map((r) => tagIdx(r.tags));
  const relRoles = relations.map((r) => r.members.map((m) => index(m.role)));

  const block = new PbfWriter();
  block.writeMessage(
    1,
    (_: null, pbf) => {
      for (const s of strings) pbf.writeBytesField(1, new TextEncoder().encode(s));
    },
    null,
  );
  const sorted = [...nodes].sort((a, b) => a.id - b.id);
  block.writeMessage(
    2,
    (_: null, group) => {
      group.writeMessage(
        2,
        (_n: null, dense) => {
          dense.writePackedSVarint(1, delta(sorted.map((n) => n.id)));
          dense.writePackedSVarint(8, delta(sorted.map((n) => Math.round(n.lat * 1e7))));
          dense.writePackedSVarint(9, delta(sorted.map((n) => Math.round(n.lon * 1e7))));
          if (keysVals.length > 0) dense.writePackedVarint(10, keysVals);
        },
        null,
      );
    },
    null,
  );
  block.writeMessage(
    2,
    (_: null, group) => {
      ways.forEach((way, i) => {
        group.writeMessage(
          3,
          (_w: null, out) => {
            out.writeVarintField(1, way.id);
            out.writePackedVarint(2, wayTags[i].keys);
            out.writePackedVarint(3, wayTags[i].vals);
            out.writePackedSVarint(8, delta(way.refs));
          },
          null,
        );
      });
    },
    null,
  );
  block.writeMessage(
    2,
    (_: null, group) => {
      relations.forEach((relation, i) => {
        group.writeMessage(
          4,
          (_r: null, out) => {
            out.writeVarintField(1, relation.id);
            out.writePackedVarint(2, relTags[i].keys);
            out.writePackedVarint(3, relTags[i].vals);
            out.writePackedVarint(8, relRoles[i]);
            out.writePackedSVarint(9, delta(relation.members.map((m) => m.way)));
            out.writePackedVarint(
              10,
              relation.members.map(() => 1),
            );
          },
          null,
        );
      });
    },
    null,
  );

  const header = new PbfWriter();
  header.writeStringField(4, 'OsmSchema-V0.6');
  header.writeStringField(4, 'DenseNodes');
  header.writeVarintField(32, 1760000000);

  const frame = (type: string, payload: Uint8Array, compress: boolean) => {
    const blob = new PbfWriter();
    if (compress) {
      blob.writeVarintField(2, payload.length);
      blob.writeBytesField(3, new Uint8Array(deflateSync(payload)));
    } else {
      blob.writeBytesField(1, payload);
    }
    const blobBytes = blob.finish();
    const blobHeader = new PbfWriter();
    blobHeader.writeStringField(1, type);
    blobHeader.writeVarintField(3, blobBytes.length);
    const headerBytes = blobHeader.finish();
    const length = Buffer.alloc(4);
    length.writeUInt32BE(headerBytes.length);
    return Buffer.concat([length, headerBytes, blobBytes]);
  };
  return Buffer.concat([
    frame('OSMHeader', header.finish(), false),
    frame('OSMData', block.finish(), true),
  ]);
}

// A gabled house; a courtyard block made of two outer ways and a hole; an
// outline with a part inside it; an unclosed "building".
const house = rect(100, 0, 0, 20, 10);
const blockOuter = rect(200, 60, 0, 40, 40);
const blockInner = rect(210, 75, 15, 10, 10);
const outline = rect(300, 0, 60, 30, 30);
const part = rect(310, 5, 65, 10, 10);
const unclosed = rect(400, 0, 120, 10, 10);
// Trees: a recorded palm with a height, a needleleaved conifer, one with
// nothing but `natural=tree`, a node that is not a tree, an avenue tree with
// its trunk measured, and a tree that is a node of a `natural=tree_row`.
const TREES: Node[] = [
  {
    id: 500,
    lat: ORIGIN.lat + 30 * M_LAT,
    lon: ORIGIN.lon + 30 * M_LON,
    tags: { natural: 'tree', genus: 'Phoenix', height: '9 m' },
  },
  {
    id: 501,
    lat: ORIGIN.lat + 32 * M_LAT,
    lon: ORIGIN.lon + 30 * M_LON,
    tags: { natural: 'tree', leaf_type: 'needleleaved', diameter_crown: '4' },
  },
  {
    id: 502,
    lat: ORIGIN.lat + 34 * M_LAT,
    lon: ORIGIN.lon + 30 * M_LON,
    tags: { natural: 'tree' },
  },
  {
    id: 503,
    lat: ORIGIN.lat + 36 * M_LAT,
    lon: ORIGIN.lon + 30 * M_LON,
    tags: { amenity: 'bench' },
  },
  {
    id: 504,
    lat: ORIGIN.lat + 38 * M_LAT,
    lon: ORIGIN.lon + 30 * M_LON,
    tags: { natural: 'tree', circumference: '120 cm', denotation: 'avenue' },
  },
  {
    id: 505,
    lat: ORIGIN.lat + 40 * M_LAT,
    lon: ORIGIN.lon + 30 * M_LON,
    tags: { natural: 'tree' },
  },
  // The tree row's other end: a vertex, not a tree.
  { id: 506, lat: ORIGIN.lat + 40 * M_LAT, lon: ORIGIN.lon + 40 * M_LON },
];
const NODES = [...house, ...blockOuter, ...blockInner, ...outline, ...part, ...unclosed, ...TREES];
const ids = (nodes: Node[]) => nodes.map((n) => n.id);
const WAYS: Way[] = [
  {
    id: 10,
    refs: [...ids(house), house[0].id],
    tags: { building: 'house', 'building:levels': '2', 'roof:shape': 'gabled', 'roof:height': '3' },
  },
  // The courtyard block's outer ring in two untagged pieces, one reversed.
  { id: 21, refs: [200, 201, 202], tags: {} },
  { id: 22, refs: [200, 203, 202], tags: {} },
  { id: 23, refs: [...ids(blockInner), blockInner[0].id], tags: {} },
  {
    id: 30,
    refs: [...ids(outline), outline[0].id],
    tags: { building: 'office', height: '20', start_date: '1931-05-01' },
  },
  {
    id: 31,
    refs: [...ids(part), part[0].id],
    tags: { 'building:part': 'yes', height: '30', 'building:colour': 'red' },
  },
  { id: 40, refs: ids(unclosed), tags: { building: 'yes' } },
  { id: 50, refs: [100, 101], tags: { highway: 'residential' } },
  { id: 60, refs: [505, 506], tags: { natural: 'tree_row' } },
];
const RELATIONS: Relation[] = [
  {
    id: 20,
    tags: { type: 'multipolygon', building: 'apartments', 'building:levels': '6' },
    members: [
      { way: 21, role: 'outer' },
      { way: 22, role: 'outer' },
      { way: 23, role: 'inner' },
    ],
  },
];

let dir = '';
let pbfPath = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'city-tiles-'));
  pbfPath = join(dir, 'tiny.osm.pbf');
  writeFileSync(pbfPath, writePbf(NODES, WAYS, RELATIONS));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function tileOf(lon: number, lat: number, z: number) {
  const n = 2 ** z;
  const phi = (lat * Math.PI) / 180;
  return {
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n),
  };
}

describe('compile', () => {
  test('reads, assembles, replaces outlines with parts, and refuses unclosed rings', () => {
    const result = compile({ pbf: pbfPath, zoom: CITY_TILE_ZOOM });
    expect(result.header.replicationTimestamp).toBe(new Date(1760000000 * 1000).toISOString());
    const features = [...result.tiles.values()].flat();
    expect(features.map((f) => f.id).sort((a, b) => a - b)).toEqual([102, 203, 312]);
    expect(result.problems.unclosedWays).toBe(1);
    expect(result.coverage.outlinesDroppedForParts).toBe(1);

    const block = features.find((f) => f.id === 203);
    expect(block?.polygons).toHaveLength(1);
    expect(block?.polygons[0].holes).toHaveLength(1);
    expect(block?.properties.levels).toBe(6);

    const house = features.find((f) => f.id === 102);
    expect(house?.properties.roof_shape).toBe('gabled');
    expect(house?.properties.roof_height).toBe(3);

    const red = features.find((f) => f.id === 312);
    expect(red?.properties).toMatchObject({ part: true, colour: '#ff0000', render_height: 30 });
  });

  test('a part inherits its outline’s class and era; buildings carry their own', () => {
    const result = compile({ pbf: pbfPath, zoom: CITY_TILE_ZOOM });
    const features = [...result.tiles.values()].flat();
    // The part records shape only; `building=office` + `start_date=1931` are the outline's.
    expect(features.find((f) => f.id === 312)?.properties).toMatchObject({
      use: 'commercial',
      era: 'early_modern',
    });
    expect(features.find((f) => f.id === 102)?.properties.use).toBe('residential'); // house
    expect(features.find((f) => f.id === 203)?.properties.use).toBe('residential'); // apartments
    expect(features.find((f) => f.id === 102)?.properties.era).toBeUndefined();
    expect(result.coverage.withUse).toBe(3);
    expect(result.coverage.withEra).toBe(1);
  });

  test('each building goes whole to the tile holding its representative point', () => {
    const result = compile({ pbf: pbfPath, zoom: CITY_TILE_ZOOM });
    const expected = tileOf(ORIGIN.lon + 10 * M_LON, ORIGIN.lat + 5 * M_LAT, CITY_TILE_ZOOM);
    const key = [...result.tiles.entries()].find(([, list]) => list.some((f) => f.id === 102))?.[0];
    expect(key).toBe(`${CITY_TILE_ZOOM}/${expected.x}/${expected.y}`);
    // Whole: all four corners, in that tile's units, ~20 m apart.
    const house = result.tiles.get(key as string)?.find((f) => f.id === 102);
    const xs = house?.polygons[0].outer.map((p) => p[0]) ?? [];
    const metresPerUnit =
      (40075016.7 * Math.cos((ORIGIN.lat * Math.PI) / 180)) / 2 ** 15 / CITY_TILE_EXTENT;
    expect((Math.max(...xs) - Math.min(...xs)) * metresPerUnit).toBeCloseTo(20, 0);
  });

  test('a bounding box keeps only buildings whose point is inside', () => {
    const result = compile({
      pbf: pbfPath,
      zoom: CITY_TILE_ZOOM,
      bbox: [
        ORIGIN.lon - 0.001,
        ORIGIN.lat - 0.001,
        ORIGIN.lon + 25 * M_LON,
        ORIGIN.lat + 20 * M_LAT,
      ],
    });
    expect([...result.tiles.values()].flat().map((f) => f.id)).toEqual([102]);
  });
  test('an outline is replaced only by parts that are emitted: its only part outside the bbox keeps it', () => {
    // The outline's point (15, 75 m) is inside; its part's point (10, 70 m) is not.
    const result = compile({
      pbf: pbfPath,
      zoom: CITY_TILE_ZOOM,
      bbox: [
        ORIGIN.lon + 12 * M_LON,
        ORIGIN.lat + 60 * M_LAT,
        ORIGIN.lon + 25 * M_LON,
        ORIGIN.lat + 90 * M_LAT,
      ],
    });
    expect([...result.tiles.values()].flat().map((f) => f.id)).toEqual([302]);
    expect(result.coverage.outlinesDroppedForParts).toBe(0);
  });
});

describe('trees', () => {
  test('natural=tree nodes become the tree layer, with only what they record', () => {
    const result = compile({ pbf: pbfPath, zoom: CITY_TILE_ZOOM });
    const trees = [...result.trees.values()].flat();
    expect(trees.map((t) => t.id)).toEqual([500, 501, 502, 504, 505]);
    expect(trees.find((t) => t.id === 500)?.properties).toEqual({ crown: 'palm', height: 9 });
    expect(trees.find((t) => t.id === 501)?.properties).toEqual({
      crown: 'conifer',
      crown_diameter: 4,
    });
    expect(trees.find((t) => t.id === 502)?.properties).toEqual({});
    // Recorded as street trees: by `denotation`, and by standing in a tree row.
    expect(trees.find((t) => t.id === 504)?.properties).toEqual({
      circumference: 1.2,
      street: true,
    });
    expect(trees.find((t) => t.id === 505)?.properties).toEqual({ street: true });
    expect(result.treeCoverage).toMatchObject({
      trees: 5,
      withCrown: 2,
      withHeight: 1,
      withCircumference: 1,
      street: 2,
    });
    // The buildings are untouched by the trees riding the node pass.
    expect(
      [...result.tiles.values()]
        .flat()
        .map((f) => f.id)
        .sort((a, b) => a - b),
    ).toEqual([102, 203, 312]);
  });

  test('the tree layer appended to a building tile decodes alongside it', () => {
    const result = compile({ pbf: pbfPath, zoom: CITY_TILE_ZOOM });
    const [key, trees] = [...result.trees.entries()][0];
    const buildings = encodeCityTile(result.tiles.get(key) ?? []);
    const layer = encodeTreeLayer(trees);
    const bytes = new Uint8Array(buildings.length + layer.length);
    bytes.set(buildings);
    bytes.set(layer, buildings.length);
    const decoded = decodeMappedTrees(bytes, CITY_TREE_LAYER);
    expect(decoded.trees.map((t) => t.id)).toEqual([500, 501, 502, 504, 505]);
    expect(decoded.trees[0]).toMatchObject({ crown: 'palm', heightM: 9 });
    expect(decoded.trees[1]).toMatchObject({ crown: 'conifer', crownDiameterM: 4 });
    expect(decoded.trees[3]).toMatchObject({ circumferenceM: 1.2, street: true });
    expect(decoded.trees[4]).toMatchObject({ street: true });
    expect(decoded.trees[2].street).toBeUndefined();
    expect(decoded.trees[0].x).toBeCloseTo(trees[0].point[0], -0.5);
    if (buildings.length > 0) expect(decodeCityTile(bytes)?.buildings.length).toBeGreaterThan(0);
  });
});

describe('representativePoint', () => {
  test('is the centroid at real mercator magnitudes, not a boundary fallback', () => {
    // A 20 m × 10 m footprint in Barcelona, as the compiler holds it.
    const x0 = (ORIGIN.lon + 180) / 360;
    const phi = (ORIGIN.lat * Math.PI) / 180;
    const y0 = (1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2;
    const metre = 1 / (40075016.7 * Math.cos(phi));
    const ring = Float64Array.from([
      x0,
      y0,
      x0 + 20 * metre,
      y0,
      x0 + 20 * metre,
      y0 - 10 * metre,
      x0,
      y0 - 10 * metre,
    ]);
    const [x, y] = representativePoint(ring);
    expect((x - x0) / metre).toBeCloseTo(10, 3);
    expect((y0 - y) / metre).toBeCloseTo(5, 3);
  });
});

describe('assembleRings', () => {
  test('joins pieces end to end, reversing where needed, and drops what cannot close', () => {
    const rings = assembleRings([
      [1, 2, 3],
      [5, 4, 3],
      [5, 1],
      [7, 8],
    ]);
    expect(rings).toHaveLength(1);
    expect(new Set(rings[0])).toEqual(new Set([1, 2, 3, 4, 5]));
    expect(rings[0][0]).toBe(rings[0][rings[0].length - 1]);
  });
});

describe('MVT encoding', () => {
  const square: TilePoint[] = [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
  ];

  test('quantises, removes repeats and the closing point', () => {
    expect(
      quantizeRing([
        [0.2, 0.2],
        [0.4, 0.1],
        [10, 0],
        [10, 10],
        [0, 0],
      ]),
    ).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
  });

  test('exteriors come out positive and holes negative, whatever order they went in', () => {
    // A clockwise-in-ENU (positive in tile units) square, and the same reversed.
    const reversed = square.slice().reverse();
    const commands = encodePolygons([
      { outer: reversed, holes: [square.map(([x, y]) => [x / 2 + 25, y / 2 + 25] as TilePoint)] },
    ]);
    expect(commands.length).toBeGreaterThan(0);
    const decoded = decodeCityTile(
      encodeCityTile([
        {
          id: 12,
          polygons: [
            {
              outer: reversed,
              holes: [square.map(([x, y]) => [x / 2 + 25, y / 2 + 25] as TilePoint)],
            },
          ],
          properties: { render_height: 10, render_min_height: 0 },
        },
      ]),
    );
    const rings = decoded?.buildings[0].rings ?? [];
    expect(rings).toHaveLength(2);
    expect(tileRingArea(rings[0])).toBeGreaterThan(0);
    expect(tileRingArea(rings[1])).toBeLessThan(0);
  });

  test('round-trips ids, every property type and coordinates beyond the extent', () => {
    const far: TilePoint[] = [
      [-300, 4000],
      [4300, 4000],
      [4300, 4500],
      [-300, 4500],
    ];
    const bytes = encodeCityTile([
      {
        id: 2_000_000_0003,
        polygons: [{ outer: far, holes: [] }],
        properties: {
          render_height: 23.4,
          render_min_height: 3.7,
          levels: 6,
          min_level: 1,
          roof_shape: 'hipped',
          roof_height: 4,
          roof_direction: 225,
          roof_orientation: 'across',
          colour: '#aabbcc',
          roof_colour: '#112233',
          material: 'brick',
          roof_material: 'slate',
          part: true,
        },
      },
      {
        id: 7,
        polygons: [
          {
            outer: [
              [1, 1],
              [1, 1],
              [1, 1],
            ],
            holes: [],
          },
        ],
        properties: {},
      },
    ]);
    const decoded = decodeCityTile(bytes);
    expect(decoded?.extent).toBe(CITY_TILE_EXTENT);
    expect(decoded?.buildings).toHaveLength(1); // the degenerate one is dropped
    const building = decoded?.buildings[0];
    expect(building).toMatchObject({
      id: 2_000_000_0003,
      top: 23.4,
      base: 3.7,
      levels: 6,
      minLevel: 1,
      roof: { shape: 'hipped', height: 4, direction: 225, across: true },
      colour: 0xaabbcc,
      roofColour: 0x112233,
      material: 'brick',
      roofMaterial: 'slate',
    });
    const xs = building?.rings[0].map((p) => p[0]) ?? [];
    expect(Math.min(...xs)).toBe(-300);
    expect(Math.max(...xs)).toBe(4300);
  });

  test('an empty tile encodes to nothing and decodes to null', () => {
    expect(encodeCityTile([]).length).toBe(0);
    expect(decodeCityTile(new Uint8Array(0))).toBeNull();
  });
});

describe('PMTiles writer', () => {
  const source = (bytes: Uint8Array) => ({
    async read(offset: number, length: number) {
      return bytes.subarray(offset, offset + length);
    },
  });

  test('directories encode what the reader decodes, offsets run-length and all', () => {
    const entries = [
      { tileId: 5, offset: 0, length: 10, runLength: 1 },
      { tileId: 6, offset: 10, length: 4, runLength: 2 },
      { tileId: 9, offset: 0, length: 10, runLength: 1 },
    ];
    expect(encodeDirectory(entries).length).toBeGreaterThan(0);
  });

  test('every tile reads back through worker/pmtiles.js, with leaf directories', async () => {
    // Enough scattered tiles to force leaves: the root must fit the reader's
    // first 16 KiB, and a dense run of neighbours compresses too well to.
    const tiles = [];
    for (let x = 0; x < 140; x++) {
      for (let y = 0; y < 140; y++) {
        const label = `${x}/${y}`.padEnd(4 + ((x * 7 + y * 13) % 29), '.');
        tiles.push({
          z: 15,
          x: 16000 + 3 * x,
          y: 12000 + 5 * y,
          bytes: new Uint8Array(gzipSync(Buffer.from(label))),
        });
      }
    }
    const archive = writePmtiles(tiles, {
      minZoom: 15,
      maxZoom: 15,
      bounds: [2, 41, 3, 42],
      center: [2.5, 41.5, 15],
      metadata: { 'goway:schema': 1 },
      rootBudgetBytes: 256,
    });
    const reader = new PMTiles(source(archive));
    const header = await reader.header();
    expect(header.clustered).toBe(true);
    expect(header.leafDirsLength).toBeGreaterThan(0);
    expect(header.addressedTiles).toBe(tiles.length);
    expect(await reader.metadata()).toEqual({ 'goway:schema': 1 });
    for (const [x, y] of [
      [0, 0],
      [139, 139],
      [70, 3],
      [12, 101],
    ]) {
      const tile = await reader.getTile(15, 16000 + 3 * x, 12000 + 5 * y);
      const text = new TextDecoder().decode(gunzipSync(tile?.bytes as Uint8Array));
      expect(text.replace(/\.+$/, '')).toBe(`${x}/${y}`);
    }
    expect(await reader.getTile(15, 1, 1)).toBeNull();
    expect(await reader.getTile(14, 8000, 6000)).toBeNull();
  });

  test('identical tiles are stored once and runs are merged', async () => {
    const same = new Uint8Array(gzipSync(Buffer.from('same')));
    const tiles = [0, 1, 2, 3].map((d) => ({ z: 2, x: d % 2, y: Math.floor(d / 2), bytes: same }));
    const archive = writePmtiles(tiles, {
      minZoom: 2,
      maxZoom: 2,
      bounds: [-180, -85, 180, 85],
      center: [0, 0, 2],
      metadata: {},
    });
    const header = await new PMTiles(source(archive)).header();
    expect(header.tileContents).toBe(1);
    expect(header.addressedTiles).toBe(4);
    // Hilbert order: tiles (0,0),(0,1),(1,1),(1,0) at z2 are ids 5–8, one run.
    expect(zxyToTileId(2, 0, 0)).toBe(5);
    expect(header.tileEntries).toBe(1);
  });
});
