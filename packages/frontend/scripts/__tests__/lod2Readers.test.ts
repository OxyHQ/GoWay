/**
 * Official 3D building data in: the projections (`lod2/crs.ts`) against PROJ,
 * the streaming CityGML reader and the CityJSON reader on hand-made fixtures
 * (`fixtures/lod2/`), and `prepare.ts` turning a building into planar roof
 * surfaces in mercator with heights above its own ground.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { readCityGml, parseRing, type RawBuilding } from '../citygen/lod2/cityGml';
import { readCityJson } from '../citygen/lod2/cityJson';
import { crsFromEpsg, crsFromName, epsgCode } from '../citygen/lod2/crs';
import { ingest } from '../citygen/lod2/ingest';
import {
  emptyPrepareStats,
  fitPlane,
  latFromMercY,
  metresPerMercator,
  prepareBuilding,
} from '../citygen/lod2/prepare';
import { LOD2_SOURCES } from '../citygen/lod2/sources';

const FIXTURES = join(import.meta.dir, 'fixtures', 'lod2');

function readAll(path: string, chunkBytes?: number): RawBuilding[] {
  const out: RawBuilding[] = [];
  if (path.endsWith('.gml')) readCityGml(path, (b) => out.push(b), { chunkBytes });
  else readCityJson(path, (b) => out.push(b));
  return out;
}

describe('crs', () => {
  // Reference values from PROJ 9 (`cs2cs -f %.9f EPSG:xxxx EPSG:4326`).
  const cases: [number, number, number, number, number][] = [
    [2263, 987997.388490751, 219279.394168153, -73.986471313, 40.768546834],
    [2263, 1002759.79, 220148.67, -73.933174241, 40.770914185],
    [25831, 430000, 4581000, 2.162882399, 41.377476986],
    [25831, 700000, 4400000, 5.333620684, 39.726445844],
    [32633, 300000, 5000000, 12.45687651, 45.125153848],
    [32735, 600000, 6000000, 28.111478032, -36.13956045],
  ];
  for (const [code, x, y, lon, lat] of cases) {
    test(`EPSG:${code} (${x}, ${y}) inverts to within 1e-7° of PROJ`, () => {
      const crs = crsFromEpsg(code);
      if (!crs) throw new Error('unsupported');
      const [l, p] = crs.toLonLat(x, y);
      expect(Math.abs(l - lon)).toBeLessThan(1e-7);
      expect(Math.abs(p - lat)).toBeLessThan(1e-7);
    });
  }

  test('reads the srsName spellings sources use; refuses what it cannot invert', () => {
    expect(epsgCode('EPSG:2263')).toBe(2263);
    expect(epsgCode('urn:ogc:def:crs:EPSG::25831')).toBe(25831);
    expect(epsgCode('urn:ogc:def:crs,crs:EPSG::25831,crs:EPSG::5783')).toBe(25831);
    expect(epsgCode('https://www.opengis.net/def/crs/EPSG/0/7415')).toBe(7415);
    expect(crsFromName('EPSG:2263')?.verticalMetres).toBeCloseTo(0.3048006096, 9);
    // RD New / NAP (3DBAG) is not implemented: refused, never guessed.
    expect(crsFromName('https://www.opengis.net/def/crs/EPSG/0/7415')).toBeNull();
    // EPSG geographic codes are latitude-first in GML.
    expect(crsFromEpsg(4326)?.toLonLat(41.4, 2.17)).toEqual([2.17, 41.4]);
  });
});

describe('readCityGml', () => {
  const buildings = readAll(join(FIXTURES, 'tiny.gml'));

  test('three buildings, parts folded into their building', () => {
    expect(buildings.map((b) => b.id)).toEqual(['house', 'tower', 'box']);
    expect(buildings[1].polygons.filter((p) => p.kind === 'roof')).toHaveLength(2);
  });

  test('surface kinds, LODs, posList and pos runs, holes, closing points dropped', () => {
    const house = buildings[0];
    expect(house.polygons.map((p) => p.kind)).toEqual(['roof', 'roof', 'wall', 'ground']);
    expect(house.polygons.every((p) => p.lod === 2)).toBe(true);
    // The <gml:pos> ring reads like the posList one: 4 points, closing one dropped.
    expect(Array.from(house.polygons[1].rings[0])).toEqual([
      431000, 4582004, 19, 431010, 4582004, 19, 431010, 4582008, 16, 431000, 4582008, 16,
    ]);
    const podium = buildings[1].polygons[0];
    expect(podium.rings).toHaveLength(2);
    expect(podium.rings[1].length / 3).toBe(4);
  });

  test('building attributes, not a surface’s; the appearance subtree is skipped', () => {
    const house = buildings[0];
    expect(house.attributes).toEqual({ name: 'Test house', BIN: 'B1', measuredHeight: '9' });
    expect(house.srsName).toBe('urn:ogc:def:crs,crs:EPSG::25831,crs:EPSG::5783');
    // Texture coordinates never become geometry.
    expect(house.polygons).toHaveLength(4);
  });

  test('untyped solid geometry is kept as `none`; an xlink reference is not followed', () => {
    const box = buildings[2];
    expect(box.polygons.map((p) => p.kind)).toEqual(['none', 'none', 'none']);
  });

  test('the same buildings whatever the read chunk size (tags and numbers split across reads)', () => {
    for (const chunk of [7, 64, 1000]) {
      expect(readAll(join(FIXTURES, 'tiny.gml'), chunk)).toEqual(buildings);
    }
  });

  test('a ring that cannot be read is refused, not coerced', () => {
    expect(parseRing('1 2 3 4 5 6 7 8 9', 3)).not.toBeNull();
    expect(parseRing('1 2 3 4 5 6 7 8', 3)).toBeNull(); // ragged
    expect(parseRing('1 2 3 4 5 x 7 8 9', 3)).toBeNull(); // not a number
    expect(parseRing('1 2 3 1 2 3', 3)).toBeNull(); // too few points
    expect(parseRing('0 0 1 0 1 1 0 0', 2)).toEqual(new Float64Array([0, 0, 0, 1, 0, 0, 1, 1, 0]));
  });
});

describe('readCityJson', () => {
  test('a whole file and a CityJSONSeq read the same building, parts folded in', () => {
    const whole = readAll(join(FIXTURES, 'tiny.city.json'));
    const seq = readAll(join(FIXTURES, 'tiny.city.jsonl'));
    // "bad" has a vertex index out of range: no polygon survives.
    expect(whole.map((b) => b.id)).toEqual(['house', 'bad']);
    expect(whole[1].polygons).toHaveLength(0);
    expect(seq.map((b) => b.id)).toEqual(['house']);
    expect(seq[0].polygons).toEqual(whole[0].polygons);
    const house = whole[0];
    expect(house.attributes).toEqual({ BIN: 'B1' });
    expect(house.srsName).toBe('https://www.opengis.net/def/crs/EPSG/0/25831');
    // The transform is applied; semantics are read through the Solid's nesting.
    const roofs = house.polygons.filter((p) => p.kind === 'roof' && p.lod === 2.2);
    expect(roofs).toHaveLength(2);
    expect(Array.from(roofs[0].rings[0]).map((v) => Math.round(v * 1000) / 1000)).toEqual([
      431000, 4582000, 16, 431010, 4582000, 16, 431010, 4582004, 19, 431000, 4582004, 19,
    ]);
    // The LOD 1.2 solid has no semantics: kept untyped.
    expect(house.polygons.filter((p) => p.lod === 1.2).every((p) => p.kind === 'none')).toBe(true);
  });
});

describe('prepareBuilding', () => {
  const crs = crsFromEpsg(25831);
  if (!crs) throw new Error('unsupported');
  const prepare = (raw: RawBuilding) => {
    const stats = emptyPrepareStats();
    return { prepared: prepareBuilding(raw, { crs, idAttributes: ['BIN'] }, stats), stats };
  };

  test('a gabled house: two sloped planar roofs, heights above its own ground', () => {
    const [house] = readAll(join(FIXTURES, 'tiny.gml'));
    const { prepared, stats } = prepare(house);
    if (!prepared) throw new Error('dropped');
    expect(prepared.sourceId).toBe('B1');
    expect(prepared.roofs).toHaveLength(2);
    expect(stats).toMatchObject({ kept: 1, roofs: 2, sloped: 2, triangulated: 0 });
    // Ground at 10 m: eaves 6 m, ridge 9 m above it.
    expect(prepared.height).toBeCloseTo(9, 6);
    expect(Array.from(prepared.roofs[0].heights[0])).toEqual([6, 6, 9, 9]);
    // Footprint from the ground surface, 10 × 8 m.
    expect(prepared.areaM2).toBeCloseTo(80, 0);
    expect(prepared.slopedAreaM2).toBeCloseTo(80, 0);
    // The point is inside, at the footprint's centre.
    const [px, py] = prepared.point;
    expect(px * 360 - 180).toBeCloseTo(2.1747855, 6);
    expect(latFromMercY(py)).toBeCloseTo(41.3866067, 6);
  });

  test('parts: one building whose ground is the lowest ground', () => {
    const [, tower] = readAll(join(FIXTURES, 'tiny.gml'));
    const { prepared } = prepare(tower);
    expect(prepared?.height).toBeCloseTo(30, 6);
    expect(prepared?.roofs.map((r) => r.rings.length)).toEqual([2, 1]);
  });

  test('untyped geometry is classified by its normals: up is roof, down is ground', () => {
    const [, , box] = readAll(join(FIXTURES, 'tiny.gml'));
    const { prepared, stats } = prepare(box);
    expect(stats.untypedClassified).toBe(3);
    expect(prepared?.roofs).toHaveLength(1);
    expect(prepared?.height).toBeCloseTo(12, 6);
  });

  test('a non-planar roof polygon becomes exactly planar triangles; a wall filed as roof is dropped', () => {
    const raw: RawBuilding = {
      id: 'warped',
      attributes: {},
      polygons: [
        {
          kind: 'roof',
          lod: 2,
          // A square whose corners do not lie in one plane (a 2 m twist: ±0.5 m off any plane).
          rings: [new Float64Array([0, 0, 10, 10, 0, 10, 10, 10, 12, 0, 10, 10])],
        },
        { kind: 'roof', lod: 2, rings: [new Float64Array([0, 0, 0, 10, 0, 0, 10, 0, 5])] },
        { kind: 'ground', lod: 2, rings: [new Float64Array([0, 0, 0, 10, 0, 0, 10, 10, 0])] },
      ],
    };
    const { prepared, stats } = prepare({
      ...raw,
      polygons: raw.polygons.map((p) => ({ ...p, rings: p.rings.map((r) => offset(r)) })),
    });
    expect(stats.triangulated).toBe(1);
    expect(stats.droppedSteep).toBe(1);
    expect(prepared?.roofs).toHaveLength(2);
    for (const roof of prepared?.roofs ?? []) expect(roof.rings[0].length).toBe(6);
  });

  test('fitPlane: exact on a plane, null on a line', () => {
    const plane = fitPlane([0, 10, 0, 10], [0, 0, 10, 10], [1, 3, 2, 4]);
    expect(plane?.a).toBeCloseTo(0.2, 9);
    expect(plane?.b).toBeCloseTo(0.1, 9);
    expect(plane?.c).toBeCloseTo(1, 9);
    expect(plane?.residual).toBeCloseTo(0, 9);
    expect(fitPlane([0, 1, 2], [0, 1, 2], [0, 1, 2])).toBeNull();
  });

  test('ingest: CRS from each file, area filter, a SHA-256 per file', () => {
    const source = { ...LOD2_SOURCES['nyc-3dbm'], defaultSrs: undefined, idAttributes: ['BIN'] };
    const all = ingest(
      source,
      [join(FIXTURES, 'tiny.gml'), join(FIXTURES, 'tiny.city.json')],
      undefined,
    );
    expect(all.buildings.map((b) => b.sourceId)).toEqual(['B1', 'B2', 'box', 'B1']);
    expect(all.crs).toEqual(['EPSG:25831']);
    expect(all.files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    // A box around the house only.
    const some = ingest(source, [join(FIXTURES, 'tiny.gml')], [2.1746, 41.3865, 2.17495, 41.3867]);
    expect(some.buildings.map((b) => b.sourceId)).toEqual(['B1']);
    expect(some.outside).toBe(2);
  });
});

/** Shift a local-metre test ring into EPSG:25831 near Barcelona. */
function offset(ring: Float64Array): Float64Array {
  const out = new Float64Array(ring);
  for (let i = 0; i < out.length; i += 3) {
    out[i] += 431000;
    out[i + 1] += 4582000;
  }
  return out;
}

test('metresPerMercator is the circumference scaled by cos(latitude)', () => {
  expect(metresPerMercator(0.5)).toBeCloseTo(2 * Math.PI * 6371008.8, 0);
});
