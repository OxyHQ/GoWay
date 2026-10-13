/**
 * Conflation of an official 3D model with OSM (`lod2/conflate.ts`), and the
 * second tile layer it writes, through the encoder and back through the
 * CLIENT's decoders (`lod2Tiles.ts`, `osmTiles.ts`): which source draws each
 * building, that OSM's facts are kept, and that a roof plane survives the
 * trip to within a couple of centimetres.
 */
import { describe, expect, test } from 'bun:test';

import { decodeLod2Tile, planeHeight } from '../../components/map/engine/city3d/lod2Tiles';
import { decodeCityTile } from '../../components/map/engine/city3d/osmTiles';
import { CITY_PROPS, CITY_TILE_EXTENT } from '../../lib/map/cityTiles';
import {
  CITY_LOD2_PROPS,
  CITY_OFFICIAL_PROPS,
  CITY_TILE_LOD2_LAYER,
} from '../../lib/map/cityOfficial';
import { conflate, heightsAgree, roofFeature } from '../citygen/lod2/conflate';
import {
  metresPerMercator,
  type PreparedBuilding,
  type RoofSurface,
} from '../citygen/lod2/prepare';
import { type CityTileFeature, encodeCityTile, type TilePoint } from '../citygen/mvtEncode';

const Z = 15;
const SPAN = 2 ** Z;
// Mid-tile in Midtown, so every test building stays inside one z15 tile.
const TX = 9650;
const TY = 12315;
const ORIGIN = { x: (TX + 0.5) / SPAN, y: (TY + 0.5) / SPAN };
const M = metresPerMercator(ORIGIN.y);
const KEY = `${Z}/${TX}/${TY}`;

/** Local metres (x east, y north) → mercator. */
const merc = (x: number, y: number): [number, number] => [ORIGIN.x + x / M, ORIGIN.y - y / M];
/** Local metres → this tile's units. */
const tilePoint = (x: number, y: number): TilePoint => {
  const [mx, my] = merc(x, y);
  return [(mx * SPAN - TX) * CITY_TILE_EXTENT, (my * SPAN - TY) * CITY_TILE_EXTENT];
};

function rect(x: number, y: number, w: number, h: number): [number, number][] {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
}

function osm(
  id: number,
  corners: [number, number][],
  properties: Record<string, string | number | boolean>,
): CityTileFeature {
  return {
    id,
    polygons: [{ outer: corners.map(([x, y]) => tilePoint(x, y)), holes: [] }],
    properties: { [CITY_PROPS.renderMinHeight]: 0, ...properties },
  };
}

function roof(corners: [number, number][], heights: number[]): RoofSurface {
  const ring = new Float64Array(corners.length * 2);
  corners.forEach(([x, y], i) => {
    const [mx, my] = merc(x, y);
    ring[i * 2] = mx;
    ring[i * 2 + 1] = my;
  });
  return { rings: [ring], heights: [Float64Array.from(heights)] };
}

function model(
  sourceId: string,
  corners: [number, number][],
  roofs: RoofSurface[],
  slopedAreaM2 = 0,
): PreparedBuilding {
  const outer = roof(
    corners,
    corners.map(() => 0),
  ).rings[0];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < outer.length; i += 2) {
    minX = Math.min(minX, outer[i]);
    maxX = Math.max(maxX, outer[i]);
    minY = Math.min(minY, outer[i + 1]);
    maxY = Math.max(maxY, outer[i + 1]);
  }
  const area = Math.abs(
    corners.reduce((sum, [x, y], i) => {
      const [x2, y2] = corners[(i + 1) % corners.length];
      return sum + x * y2 - x2 * y;
    }, 0) / 2,
  );
  return {
    sourceId,
    roofs,
    footprint: [outer],
    point: [(minX + maxX) / 2, (minY + maxY) / 2],
    bbox: [minX, minY, maxX, maxY],
    areaM2: area,
    height: Math.max(...roofs.flatMap((r) => Array.from(r.heights[0]))),
    slopedAreaM2,
  };
}

const flatModel = (id: string, corners: [number, number][], h: number) =>
  model(id, corners, [
    roof(
      corners,
      corners.map(() => h),
    ),
  ]);

function run(features: CityTileFeature[], buildings: PreparedBuilding[]) {
  const tiles = new Map([[KEY, features]]);
  return conflate(tiles, buildings, { source: 'nyc-3dbm', zoom: Z });
}

describe('conflate', () => {
  test('roof-only sources preserve an elevated part even under the cadastre policy', () => {
    const part = osm(12, rect(0, 0, 20, 10), {
      render_height: 30,
      render_min_height: 11,
      levels: 10,
      min_level: 3,
      part: true,
    });
    const result = conflate(new Map([[KEY, [part]]]), [flatModel('B1', rect(0, 0, 20, 10), 20)], {
      source: 'es-catastro',
      zoom: Z,
      policy: { staleCheck: false, osmRicher: 'roofs', heightSource: 'cadastre', storeys: 'es' },
    });
    expect(result.stats.osmRicher).toBe(1);
    expect(result.stats.drawn).toBe(0);
    expect(part.properties.render_height).toBe(30);
    expect(part.properties.render_min_height).toBe(11);
    expect(part.properties.drawn_by).toBeUndefined();
  });
  test('a model building OSM confirms draws it; the OSM feature keeps every fact and says so', () => {
    const feature = osm(12, rect(0, 0, 20, 10), {
      [CITY_PROPS.renderHeight]: 30,
      [CITY_PROPS.height]: 30,
    });
    const result = run([feature], [flatModel('B1', rect(0, 0, 20, 10), 31)]);
    expect(result.stats).toMatchObject({
      drawn: 1,
      unconfirmed: 0,
      stale: 0,
      osmDrawnByModel: 1,
      osmHeightsSet: 1,
      osmHeightsFromDefault: 0,
    });
    // The tag stays; the RESOLVED height is the model's, and says so.
    expect(feature.properties).toMatchObject({
      [CITY_PROPS.height]: 30,
      [CITY_PROPS.renderHeight]: 31,
      [CITY_PROPS.heightSource]: 'lod2',
      [CITY_OFFICIAL_PROPS.drawnBy]: 'nyc-3dbm',
    });
    expect(feature.properties).not.toHaveProperty(CITY_OFFICIAL_PROPS.officialLevels);
    const [surface] = result.tiles.get(KEY) ?? [];
    expect(surface.properties).toEqual({
      [CITY_PROPS.renderHeight]: 31,
      [CITY_LOD2_PROPS.source]: 'nyc-3dbm',
      [CITY_LOD2_PROPS.sourceId]: 'B1',
      [CITY_LOD2_PROPS.osmId]: 12,
    });
  });

  test('not in OSM (demolished since the capture): not drawn', () => {
    const result = run(
      [osm(12, rect(100, 0, 10, 10), {})],
      [flatModel('B1', rect(0, 0, 20, 10), 12)],
    );
    expect(result.stats).toMatchObject({ drawn: 0, unconfirmed: 1 });
    expect(result.tiles.size).toBe(0);
  });

  test('replaced since the capture (OSM records a tower, the model a garage): OSM draws it', () => {
    const feature = osm(12, rect(0, 0, 20, 10), {
      [CITY_PROPS.renderHeight]: 150,
      [CITY_PROPS.height]: 150,
    });
    const result = run([feature], [flatModel('B1', rect(0, 0, 20, 10), 12)]);
    expect(result.stats).toMatchObject({ drawn: 0, stale: 1, osmConflicts: 1, osmDrawnByModel: 0 });
    expect(feature.properties[CITY_OFFICIAL_PROPS.drawnBy]).toBeUndefined();
  });

  test('stacked OSM parts are compared as the shape they make, not part by part', () => {
    // A 20 m podium part under a 120 m tower part; the model has both heights.
    const podium = osm(22, rect(0, 0, 40, 20), {
      [CITY_PROPS.renderHeight]: 20,
      [CITY_PROPS.height]: 20,
    });
    const tower = osm(32, rect(0, 0, 20, 20), {
      [CITY_PROPS.renderHeight]: 120,
      [CITY_PROPS.height]: 120,
    });
    const building = model(
      'B9',
      rect(0, 0, 40, 20),
      [roof(rect(0, 0, 20, 20), [121, 121, 121, 121]), roof(rect(20, 0, 20, 20), [21, 21, 21, 21])],
      0,
    );
    const result = run([podium, tower], [building]);
    expect(result.stats).toMatchObject({ drawn: 1, stale: 0, osmConflicts: 0, osmDrawnByModel: 2 });
  });

  test('OSM’s hand-made 3D wins over stepped flat blocks, but not over a sloped LOD2 roof', () => {
    const parts = () => [
      osm(42, rect(0, 0, 20, 10), { [CITY_PROPS.renderHeight]: 30, [CITY_PROPS.part]: true }),
    ];
    const flat = run(parts(), [flatModel('B1', rect(0, 0, 20, 10), 30)]);
    expect(flat.stats).toMatchObject({ drawn: 0, osmRicher: 1, osmDrawnByModel: 0 });
    const sloped = run(parts(), [
      model('B1', rect(0, 0, 20, 10), [roof(rect(0, 0, 20, 10), [20, 20, 30, 30])], 200),
    ]);
    expect(sloped.stats).toMatchObject({ drawn: 1, osmRicher: 0, osmDrawnByModel: 1 });
  });

  test('an OSM building mostly outside the model keeps drawing itself', () => {
    const feature = osm(12, rect(0, 0, 40, 10), { [CITY_PROPS.renderHeight]: 12 });
    const neighbour = osm(13, rect(0, 10, 10, 10), { [CITY_PROPS.renderHeight]: 12 });
    // The model covers 30% of feature 12 (but is itself fully inside OSM buildings).
    const result = run([feature, neighbour], [flatModel('B1', rect(0, 5, 10, 10), 12)]);
    expect(result.stats.drawn).toBe(1);
    expect(feature.properties[CITY_OFFICIAL_PROPS.drawnBy]).toBeUndefined();
  });

  test('a model building goes to the tile of its best OSM match, not of its own point', () => {
    // OSM feature in the tile to the west; the model's centre is just east of the tile edge.
    const west = `${Z}/${TX - 1}/${TY}`;
    const edge = -(ORIGIN.x - TX / SPAN) * M; // metres from the origin to the tile's west edge
    const toWest = (x: number, y: number): TilePoint => {
      const [mx, my] = merc(x, y);
      return [(mx * SPAN - (TX - 1)) * CITY_TILE_EXTENT, (my * SPAN - TY) * CITY_TILE_EXTENT];
    };
    const corners = rect(edge - 15, 0, 20, 10);
    const feature: CityTileFeature = {
      id: 77,
      polygons: [{ outer: corners.map(([x, y]) => toWest(x, y)), holes: [] }],
      properties: { [CITY_PROPS.renderHeight]: 12 },
    };
    const result = conflate(
      new Map([[west, [feature]]]),
      [flatModel('B7', rect(edge - 4, 0, 10, 10), 12)],
      {
        source: 'nyc-3dbm',
        zoom: Z,
      },
    );
    expect([...result.tiles.keys()]).toEqual([west]);
  });

  test('heightsAgree: generous for tags, storey-shaped for levels', () => {
    expect(heightsAgree(25.4, 17, false)).toBe(true); // the Empire State podium
    expect(heightsAgree(14, 92, false)).toBe(false);
    expect(heightsAgree(300, 450, false)).toBe(false);
    expect(heightsAgree(16, 5 * 3.66, true)).toBe(true);
    expect(heightsAgree(60, 3 * 3.66, true)).toBe(false);
  });
});

describe('the building_lod2 layer through the client decoder', () => {
  test('a sloped plane survives encoding to within 2 cm at every vertex; a flat one is just render_height', () => {
    const sloped = roof(
      [
        [0, 0],
        [12, 0],
        [12, 5],
        [0, 5],
      ],
      [6, 6, 9.5, 9.5],
    );
    const flat = roof(rect(20, 0, 8, 8), [14.237, 14.237, 14.237, 14.237]);
    const features = [sloped, flat].map((r) => {
      const feature = roofFeature(r, TX, TY, SPAN);
      if (!feature) throw new Error('no feature');
      feature.properties[CITY_LOD2_PROPS.source] = 'nyc-3dbm';
      feature.properties[CITY_LOD2_PROPS.sourceId] = 'B1';
      feature.properties[CITY_LOD2_PROPS.osmId] = 12;
      return feature;
    });
    expect(features[1].properties).not.toHaveProperty(CITY_LOD2_PROPS.roofH);
    const osmFeature = osm(12, rect(0, 0, 30, 10), {
      [CITY_PROPS.renderHeight]: 10,
      [CITY_OFFICIAL_PROPS.drawnBy]: 'nyc-3dbm',
    });
    const bytes = encodeCityTile([osmFeature], [{ name: CITY_TILE_LOD2_LAYER, features }]);

    const surfaces = decodeLod2Tile(bytes);
    expect(surfaces).toHaveLength(2);
    const expected = [
      [6, 6, 9.5, 9.5],
      [14.237, 14.237, 14.237, 14.237],
    ];
    surfaces.forEach((surface, s) => {
      expect(surface).toMatchObject({ source: 'nyc-3dbm', sourceId: 'B1', osmId: 12 });
      // The decoder's rings are closed; the source's four corners are the first four points.
      const corners = surface.rings[0].slice(0, 4);
      const heights = corners
        .map(([x, y]) => planeHeight(surface.plane, x, y))
        .sort((a, b) => a - b);
      const want = [...expected[s]].sort((a, b) => a - b);
      for (const [i, h] of heights.entries()) expect(Math.abs(h - want[i])).toBeLessThan(0.02);
    });
    expect(surfaces[0].top).toBeCloseTo(9.5, 1);

    // The OSM feature is still there, with its own height, marked as drawn by the model.
    const decoded = decodeCityTile(bytes);
    expect(decoded?.buildings).toHaveLength(1);
    expect(decoded?.buildings[0]).toMatchObject({ id: 12, top: 10, drawnBy: 'nyc-3dbm' });
  });

  test('a tile with no model surfaces has no second layer', () => {
    const bytes = encodeCityTile([osm(12, rect(0, 0, 10, 10), { [CITY_PROPS.renderHeight]: 10 })]);
    expect(decodeLod2Tile(bytes)).toEqual([]);
  });
});
