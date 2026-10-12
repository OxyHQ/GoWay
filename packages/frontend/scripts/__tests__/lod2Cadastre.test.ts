/**
 * The Spanish Catastro's building parts as an official height source: the
 * INSPIRE reader on a hand-made fixture, a cadastral building as flat-roofed
 * parts at the Spanish storey model's heights, and conflation with its own policy — no
 * staleness test (the cadastre is kept current), OSM's parts do not outrank
 * it (they are an import of it), and the RESOLVED height of the OSM features
 * it covers becomes the cadastre's (`height_source: cadastre`) while OSM's own
 * tags stay. Then the tile through the client's decoders, and the feed
 * parsing `catastro-municipalities.ts` selects downloads with.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { decodeLod2Tile } from '../../components/map/engine/city3d/lod2Tiles';
import { decodeCityTile } from '../../components/map/engine/city3d/osmTiles';
import { CITY_PROPS, CITY_TILE_EXTENT } from '../../lib/map/cityTiles';
import {
  CITY_LOD2_PROPS,
  CITY_OFFICIAL_PROPS,
  CITY_TILE_LOD2_LAYER,
} from '../../lib/map/cityOfficial';
import { feedEntries, georssBox } from '../catastro-municipalities';
import { conflate } from '../citygen/lod2/conflate';
import { ingest } from '../citygen/lod2/ingest';
import { parseInspirePart, readInspireBuildingParts } from '../citygen/lod2/inspireBuildings';
import {
  emptyPrepareStats,
  implausibleStoreys,
  mercX,
  mercY,
  prepareInspireBuilding,
} from '../citygen/lod2/prepare';
import type { InspirePart } from '../citygen/lod2/inspireBuildings';
import { LOD2_SOURCES } from '../citygen/lod2/sources';
import { heightForStoreys, STOREY_MODELS, storeysForHeight } from '../citygen/storeys';
import { type CityTileFeature, encodeCityTile, type TilePoint } from '../citygen/mvtEncode';
import { crsFromEpsg } from '../citygen/lod2/crs';

const FIXTURE = join(import.meta.dir, 'fixtures', 'lod2', 'tiny.buildingpart.gml');
const Z = 15;
const SPAN = 2 ** Z;
const CRS = crsFromEpsg(25831);
if (!CRS) throw new Error('unsupported');

/** EPSG:25831 metres → mercator. */
function merc(x: number, y: number): [number, number] {
  const [lon, lat] = CRS?.toLonLat(x, y) ?? [0, 0];
  return [mercX(lon), mercY(lat)];
}
const [ox, oy] = merc(431010, 4582010);
const TX = Math.floor(ox * SPAN);
const TY = Math.floor(oy * SPAN);
const KEY = `${Z}/${TX}/${TY}`;
const tilePoint = (x: number, y: number): TilePoint => {
  const [mx, my] = merc(x, y);
  return [(mx * SPAN - TX) * CITY_TILE_EXTENT, (my * SPAN - TY) * CITY_TILE_EXTENT];
};

function osm(
  id: number,
  [x0, y0, x1, y1]: [number, number, number, number],
  properties: Record<string, string | number | boolean>,
): CityTileFeature {
  return {
    id,
    polygons: [
      {
        outer: [tilePoint(x0, y0), tilePoint(x1, y0), tilePoint(x1, y1), tilePoint(x0, y1)],
        holes: [],
      },
    ],
    properties: { [CITY_PROPS.renderMinHeight]: 0, ...properties },
  };
}

const catastro = LOD2_SOURCES['es-catastro'];

function run(features: CityTileFeature[]) {
  const { buildings } = ingest(catastro, [FIXTURE], undefined);
  return conflate(new Map([[KEY, features]]), buildings, {
    source: 'es-catastro',
    zoom: Z,
    policy: catastro.policy,
  });
}

describe('readInspireBuildingParts', () => {
  test('parts, references, storeys, holes; junk floor counts refused', () => {
    const parts: ReturnType<typeof parseInspirePart>[] = [];
    const stats = readInspireBuildingParts(FIXTURE, (part) => parts.push(part));
    expect(stats).toMatchObject({ parts: 4, noFloors: 1, srsName: 'urn:ogc:def:crs:EPSG::25831' });
    expect(parts.map((p) => [p?.id, p?.reference, p?.floorsAbove, p?.floorsBelow])).toEqual([
      ['TEST001_part1', 'TEST001', 7, 1],
      ['TEST001_part2', 'TEST001', 1, 0],
      ['TEST001_part3', 'TEST001', 0, null],
      ['TEST002_part1', 'TEST002', null, null],
    ]);
    expect(parts[0]?.polygons[0]).toHaveLength(2);
    expect(parts[0]?.polygons[0][0].length).toBe(4 * 3);
  });

  test('a part with no readable geometry is dropped', () => {
    const stats = { parts: 0, rejectedRings: 0, noFloors: 0 };
    const part = parseInspirePart(
      '<bu-ext2d:BuildingPart gml:id="ES.SDGC.BU.X_part1"><gml:PolygonPatch><gml:exterior><gml:LinearRing><gml:posList srsDimension="2">1 2 3</gml:posList></gml:LinearRing></gml:exterior></gml:PolygonPatch>',
      stats,
    );
    expect(part).toBeNull();
    expect(stats.rejectedRings).toBe(1);
  });
});

describe('a cadastral building', () => {
  test('flat roofs per part at the Spanish storey model height; parts with no storeys left out', () => {
    const { buildings, prepare } = ingest(catastro, [FIXTURE], undefined);
    // TEST002 records no usable storeys: nothing to draw.
    expect(buildings.map((b) => b.sourceId)).toEqual(['TEST001']);
    expect(prepare).toMatchObject({ kept: 1, noRoof: 1 });
    const [building] = buildings;
    expect(building.roofs.map((r) => r.levels)).toEqual([7, 1]);
    // 4.0 m ground floor + 6 × 3.05 m + 0.9 m parapet.
    expect(building.height).toBeCloseTo(23.2, 6);
    expect(Array.from(building.roofs[1].heights[0])).toEqual([4.9, 4.9, 4.9, 4.9]);
    expect(building.slopedAreaM2).toBe(0);
  });
});

describe('conflation under the cadastre policy', () => {
  test('a 5 m OSM box gets the cadastre’s height, storeys and provenance; the model draws it', () => {
    const block = osm(12, [431000, 4582000, 431020, 4582020], { [CITY_PROPS.renderHeight]: 5 });
    const result = run([block]);
    expect(result.stats).toMatchObject({ drawn: 1, osmHeightsSet: 1, osmHeightsFromDefault: 1 });
    // Most of the footprint is the 7-storey block (232 m² against 160 m²).
    expect(block.properties).toMatchObject({
      [CITY_PROPS.renderHeight]: 23.2,
      [CITY_PROPS.heightSource]: 'cadastre',
      [CITY_OFFICIAL_PROPS.officialLevels]: 7,
      [CITY_OFFICIAL_PROPS.drawnBy]: 'es-catastro',
    });
    const surfaces = result.tiles.get(KEY) ?? [];
    expect(surfaces.map((s) => s.properties[CITY_LOD2_PROPS.levels])).toEqual([7, 1]);
  });

  test('official > OSM tags: a disagreeing tagged height is replaced in the render, kept as a fact', () => {
    const block = osm(12, [431000, 4582000, 431020, 4582020], {
      [CITY_PROPS.renderHeight]: 10,
      [CITY_PROPS.height]: 10,
    });
    const result = run([block]);
    expect(result.stats).toMatchObject({ stale: 0, osmConflicts: 0, osmHeightsFromDefault: 0 });
    expect(block.properties[CITY_PROPS.height]).toBe(10);
    expect(block.properties[CITY_PROPS.renderHeight]).toBe(23.2);
  });

  test('OSM parts do not outrank it (they are its import); a tagged roof shape does', () => {
    const part = osm(22, [431000, 4582000, 431020, 4582020], {
      [CITY_PROPS.renderHeight]: 25,
      [CITY_PROPS.part]: true,
    });
    expect(run([part]).stats).toMatchObject({ drawn: 1, osmRicher: 0 });
    const roofed = osm(32, [431000, 4582000, 431020, 4582020], {
      [CITY_PROPS.renderHeight]: 25,
      [CITY_PROPS.roofShape]: 'gabled',
    });
    const result = run([roofed]);
    expect(result.stats).toMatchObject({ drawn: 0, osmRicher: 1 });
    expect(roofed.properties[CITY_PROPS.heightSource]).toBeUndefined();
  });

  test('through the client decoders: heights, provenance and storeys survive', () => {
    const block = osm(12, [431000, 4582000, 431020, 4582020], { [CITY_PROPS.renderHeight]: 5 });
    const result = run([block]);
    const bytes = encodeCityTile(
      [block],
      [{ name: CITY_TILE_LOD2_LAYER, features: result.tiles.get(KEY) ?? [] }],
    );
    const [building] = decodeCityTile(bytes)?.buildings ?? [];
    expect(building).toMatchObject({
      top: 23.2,
      levels: 7,
      heightSource: 'cadastre',
      drawnBy: 'es-catastro',
    });
    const surfaces = decodeLod2Tile(bytes);
    expect(surfaces.map((s) => [s.levels, Math.round(s.top * 100) / 100])).toEqual([
      [7, 23.2],
      [1, 4.9],
    ]);
  });
});

describe('the Spanish storey model', () => {
  test('ground 4.0 m, upper 3.05 m, parapet 0.9 m; inverts to the storey count', () => {
    expect(heightForStoreys(1, STOREY_MODELS.es)).toBe(4.9);
    expect(heightForStoreys(6, STOREY_MODELS.es)).toBe(20.15);
    expect(heightForStoreys(0, STOREY_MODELS.es)).toBe(0);
    expect(heightForStoreys(5, STOREY_MODELS.default)).toBe(18.3);
    for (const n of [1, 2, 6, 12, 30]) {
      expect(storeysForHeight(heightForStoreys(n, STOREY_MODELS.es), STOREY_MODELS.es)).toBe(n);
    }
  });

  test('OSM storeys in the same area stand as tall as the cadastre’s; tagged heights untouched', () => {
    const neighbour = osm(42, [431100, 4582000, 431120, 4582020], {
      [CITY_PROPS.renderHeight]: 6 * 3.66,
      [CITY_PROPS.levels]: 6,
      [CITY_PROPS.heightSource]: 'osm',
    });
    const tagged = osm(43, [431200, 4582000, 431220, 4582020], {
      [CITY_PROPS.renderHeight]: 30,
      [CITY_PROPS.height]: 30,
      [CITY_PROPS.levels]: 6,
      [CITY_PROPS.heightSource]: 'osm',
    });
    const result = run([osm(12, [431000, 4582000, 431020, 4582020], {}), neighbour, tagged]);
    expect(result.stats.osmLevelsRemodelled).toBe(1);
    expect(neighbour.properties).toMatchObject({
      [CITY_PROPS.renderHeight]: 20.15,
      [CITY_PROPS.levels]: 6,
      [CITY_PROPS.heightSource]: 'osm',
    });
    expect(tagged.properties[CITY_PROPS.renderHeight]).toBe(30);
  });
});

/** A rectangular cadastral part of `w` × `h` metres at `x, y` (EPSG:25831). */
function part(
  id: string,
  floors: number,
  [x, y, w, h]: [number, number, number, number],
): InspirePart {
  const ring = new Float64Array([x, y, 0, x + w, y, 0, x + w, y + h, 0, x, y + h, 0]);
  return {
    id,
    reference: id.replace(/_part\d+$/, ''),
    floorsAbove: floors,
    floorsBelow: 0,
    srsName: 'urn:ogc:def:crs:EPSG::25831',
    polygons: [[ring]],
  };
}

describe('implausible storeys (the Pla d’en Coll needle)', () => {
  test('a 111-storey part of 2 m² beside 5-storey parts is left out; the rest of the building stands', () => {
    // As published 2026-10-12 at Montcada i Reixac (2239707DF3923G): 43 parts
    // of 1–5 storeys and part3, recorded as 111 storeys on ~2 m², which the
    // storey model drew as a 340 m needle.
    const stats = emptyPrepareStats();
    const building = prepareInspireBuilding(
      'NEEDLE01',
      [
        part('NEEDLE01_part1', 5, [431000, 4582000, 30, 20]),
        part('NEEDLE01_part2', 2, [431000, 4582020, 30, 10]),
        part('NEEDLE01_part3', 111, [431010, 4582010, 1.4, 1.4]),
      ],
      CRS,
      stats,
    );
    expect(building?.roofs.map((r) => r.levels)).toEqual([5, 2]);
    expect(building?.height).toBe(heightForStoreys(5, STOREY_MODELS.es));
    expect(stats.implausibleStoreys).toEqual({
      aboveCeiling: 1,
      spike: 0,
      parts: ['NEEDLE01_part3:111:ceiling'],
    });
  });

  test('a lone spike below the ceiling: 45 storeys on 24 m² over 5-storey parts', () => {
    const stats = emptyPrepareStats();
    const building = prepareInspireBuilding(
      'SPIKE01',
      [
        part('SPIKE01_part1', 5, [431000, 4582000, 20, 20]),
        part('SPIKE01_part2', 45, [431020, 4582000, 4, 6]),
      ],
      CRS,
      stats,
    );
    expect(building?.roofs.map((r) => r.levels)).toEqual([5]);
    expect(stats.implausibleStoreys).toMatchObject({ aboveCeiling: 0, spike: 1 });
  });

  test('a single-part building recorded as 50 storeys on 193 m² is not drawn at all', () => {
    const stats = emptyPrepareStats();
    const building = prepareInspireBuilding(
      'SHED01',
      [part('SHED01_part1', 50, [431000, 4582000, 13.9, 13.9])],
      CRS,
      stats,
    );
    expect(building).toBeNull();
    expect(stats).toMatchObject({ noRoof: 1, implausibleStoreys: { spike: 1 } });
  });

  test('real towers stand: parts that rise together, and a wide slab on a podium', () => {
    // Madrid's Cuatro Torres: every part of a tower at 50–59, some of them slender.
    const tower = implausibleStoreys(
      [
        { floors: 59, areaM2: 73 },
        { floors: 58, areaM2: 54 },
        { floors: 57, areaM2: 805 },
        { floors: 56, areaM2: 30 },
      ],
      STOREY_MODELS.es,
    );
    expect(tower.size).toBe(0);
    // Barcelona's Hotel Arts: 44 storeys on 1,324 m² beside a 3-storey podium.
    expect(
      implausibleStoreys(
        [
          { floors: 44, areaM2: 1324 },
          { floors: 3, areaM2: 4000 },
        ],
        STOREY_MODELS.es,
      ).size,
    ).toBe(0);
    // A single-part 24-storey block on 884 m².
    expect(implausibleStoreys([{ floors: 24, areaM2: 884 }], STOREY_MODELS.es).size).toBe(0);
  });

  test('a sentinel does not lend its storeys to support another', () => {
    const verdicts = implausibleStoreys(
      [
        { floors: 100, areaM2: 50 },
        { floors: 40, areaM2: 20 },
        { floors: 4, areaM2: 400 },
      ],
      STOREY_MODELS.es,
    );
    expect([...verdicts]).toEqual([
      [0, 'ceiling'],
      [1, 'spike'],
    ]);
  });

  test('conflation: the OSM building under a rejected single-part shed keeps OSM’s own height', () => {
    const { buildings } = ingest(catastro, [FIXTURE], undefined);
    const stats = emptyPrepareStats();
    const shed = prepareInspireBuilding(
      'SHED02',
      [part('SHED02_part1', 100, [431100, 4582000, 16.5, 16.6])],
      CRS,
      stats,
    );
    expect(shed).toBeNull();
    const underShed = osm(77, [431100, 4582000, 431116.5, 4582016.6], {
      [CITY_PROPS.renderHeight]: 12,
      [CITY_PROPS.height]: 12,
      [CITY_PROPS.heightSource]: 'osm',
    });
    const result = conflate(new Map([[KEY, [underShed]]]), buildings, {
      source: 'es-catastro',
      zoom: Z,
      policy: catastro.policy,
    });
    expect(result.stats.osmDrawnByModel).toBe(0);
    expect(underShed.properties).toMatchObject({
      [CITY_PROPS.renderHeight]: 12,
      [CITY_PROPS.heightSource]: 'osm',
    });
    expect(underShed.properties[CITY_OFFICIAL_PROPS.drawnBy]).toBeUndefined();
  });
});

describe('catastro-municipalities', () => {
  test('GeoRSS polygons are lat-lon; entries give their enclosure and box', () => {
    expect(georssBox('41.49 1.86 41.49 1.94 41.53 1.94 41.53 1.86 41.49 1.86')).toEqual([
      1.86, 41.49, 1.94, 41.53,
    ]);
    expect(georssBox('41.49 x 41.49')).toBeNull();
    const xml = `<feed><entry><title> 08900-BARCELONA buildings</title>
      <link rel="enclosure" href="https://www.catastro.hacienda.gob.es/INSPIRE/Buildings/08/08900-BARCELONA/A.ES.SDGC.BU.08900.zip" type="application/atom+xml"/>
      <georss:polygon>41.3 2.0 41.3 2.3 41.5 2.3 41.5 2.0 41.3 2.0</georss:polygon></entry></feed>`;
    expect(feedEntries(xml)).toEqual([
      {
        href: 'https://www.catastro.hacienda.gob.es/INSPIRE/Buildings/08/08900-BARCELONA/A.ES.SDGC.BU.08900.zip',
        box: [2.0, 41.3, 2.3, 41.5],
        title: '08900-BARCELONA buildings',
      },
    ]);
  });
});
