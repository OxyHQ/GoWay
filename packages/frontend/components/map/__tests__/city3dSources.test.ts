/**
 * The city tiles draw only where their archives cover the ground; everywhere
 * else the basemap's buildings do (owner report: with `?cityTiles=1` Madrid
 * was flat — the city layer hid `building-3d` and drew nothing, because no
 * city tile exists there). One source per z14 tile, so the two never draw the
 * same ground twice or leave a gap.
 */
import { describe, expect, test } from 'bun:test';

import type { LodTile } from '@/components/map/engine/city3d/lod';
import { assignSources } from '@/components/map/engine/city3d/sources';
import { parseCityCoverage, tileCovered } from '@/lib/map/cityTiles';

const BARCELONA: [number, number, number, number] = [2.052, 41.317, 2.228, 41.468];
const CITY = { tileZoom: 15, coverage: [BARCELONA] };

/** The z14 tile under a point. */
function tileAt(lng: number, lat: number, lod: 0 | 1 | 2 = 0): LodTile {
  const n = 2 ** 14;
  const phi = (lat * Math.PI) / 180;
  return {
    z: 14,
    x: Math.floor(((lng + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n),
    wrap: 0,
    lod,
    r: 1,
  };
}

describe('assignSources', () => {
  test('Madrid, outside every archive: the OpenMapTiles buildings, not nothing', () => {
    const madrid = tileAt(-3.7038, 40.4168);
    expect(assignSources([madrid], CITY)).toEqual([{ ...madrid, format: 'openmaptiles' }]);
  });

  test('inside the coverage, at full detail: its four city tiles and nothing else', () => {
    const eixample = tileAt(2.1686, 41.3874);
    const out = assignSources([eixample], CITY);
    expect(out.map((t) => [t.z, t.x, t.y, t.format])).toEqual([
      [15, eixample.x * 2, eixample.y * 2, 'goway'],
      [15, eixample.x * 2 + 1, eixample.y * 2, 'goway'],
      [15, eixample.x * 2, eixample.y * 2 + 1, 'goway'],
      [15, eixample.x * 2 + 1, eixample.y * 2 + 1, 'goway'],
    ]);
    // An empty one among them (sea, fields) is empty ground: there is no
    // basemap tile for the same ground to fall back to.
    expect(out.some((t) => t.format === 'openmaptiles')).toBe(false);
  });

  test('straddling the archive’s edge: the basemap tile, whole', () => {
    // The coverage's west edge runs through this tile.
    const edge = tileAt(2.052, 41.4);
    expect(tileCovered(edge, [BARCELONA])).toBe(false);
    expect(assignSources([edge], CITY)[0].format).toBe('openmaptiles');
  });

  test('covered but far (a coarser level): the basemap at that level — city tiles have none', () => {
    const far = tileAt(2.1686, 41.3874, 1);
    expect(assignSources([far], CITY)).toEqual([{ ...far, format: 'openmaptiles' }]);
  });

  test('a mixed view: each z14 tile from exactly one source', () => {
    const inside = tileAt(2.1686, 41.3874);
    const madrid = tileAt(-3.7038, 40.4168);
    const out = assignSources([inside, madrid], CITY);
    const groundOf = (t: { z: number; x: number; y: number }) =>
      `${t.x >> (t.z - 14)}/${t.y >> (t.z - 14)}`;
    const sources = new Map<string, Set<string>>();
    for (const t of out) {
      const key = groundOf(t);
      sources.set(key, (sources.get(key) ?? new Set()).add(t.format));
    }
    for (const formats of sources.values()) expect(formats.size).toBe(1);
  });

  test('no city source or no coverage: all basemap', () => {
    const inside = tileAt(2.1686, 41.3874);
    expect(assignSources([inside], null)[0].format).toBe('openmaptiles');
    expect(assignSources([inside], { tileZoom: 15, coverage: [] })[0].format).toBe('openmaptiles');
  });
});

describe('parseCityCoverage', () => {
  test('keeps well-formed boxes, drops the rest', () => {
    expect(
      parseCityCoverage({
        archives: [
          { coverage: BARCELONA },
          { coverage: [3, 2, 1, 4] },
          { coverage: ['a', 1, 2, 3] },
          {},
        ],
      }),
    ).toEqual([BARCELONA]);
    expect(parseCityCoverage(null)).toEqual([]);
  });
});
