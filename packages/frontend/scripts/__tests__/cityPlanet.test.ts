/**
 * The planet build's pieces that decide WHERE: coverage trees, a region's
 * ownership from its polygon, parts, the region catalogue and the manifest.
 *
 * Ownership is checked against the polygon itself with a point-in-polygon
 * sampler, not against a second implementation of the same descent, so a
 * bug in `polygonOwnership` cannot be agreed with by its own copy.
 */
import { describe, expect, test } from 'bun:test';

import {
  coarsenCoverageTree,
  countCoverageTiles,
  type CoverageNode,
  coverageAt,
  coverageCells,
  coverageTreeBounds,
  decodeCoverageTree,
  EMPTY,
  encodeCoverageTree,
  FULL,
  intersectCoverageTrees,
  MIXED,
  unionCoverageTrees,
} from '../../worker/coverageTree.js';
import { ARCHIVE_KEY, mergeManifest } from '../build-city-manifest';
import { archiveKey, partId, type RegionEntry, STAMP } from '../build-city-region';
import {
  ownsTile,
  parsePoly,
  partOwnership,
  polygonOwnership,
  type Ring,
  rectOwnership,
  segmentCrossesRect,
  splitByDensity,
} from '../citygen/ownership';
import { batchRegions, CITY_REGIONS, REGION_ID, selectRegions } from '../citygen/regions';

// ── Helpers ────────────────────────────────────────────────────────────────

/** A random tree, for codec properties. Deterministic (xorshift). */
function randomTree(maxZoom: number, seed: number): CoverageNode {
  let state = seed;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  const visit = (z: number): CoverageNode => {
    const r = random();
    if (z === maxZoom || r < 0.3) return r < 0.15 ? EMPTY : FULL;
    const children = [visit(z + 1), visit(z + 1), visit(z + 1), visit(z + 1)];
    if (children.every((c) => c === FULL)) return FULL;
    if (children.every((c) => c === EMPTY)) return EMPTY;
    return children;
  };
  return visit(0);
}

/** Every tile at `zoom` as a set, by brute force over coverageAt. */
function tileSet(tree: CoverageNode, maxZoom: number): Set<string> {
  const out = new Set<string>();
  const n = 2 ** maxZoom;
  for (let x = 0; x < n; x++)
    for (let y = 0; y < n; y++)
      if (coverageAt(tree, maxZoom, maxZoom, x, y) === FULL) out.add(`${x}/${y}`);
  return out;
}

const tileWest = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const tileNorth = (y: number, z: number) =>
  (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

function inside(rings: readonly Ring[], x: number, y: number): boolean {
  let c = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
  }
  return c;
}

/** A k×k grid of points strictly inside tile (z, x, y), in degrees. */
function tileSamples(z: number, x: number, y: number, k = 6): [number, number][] {
  const w = tileWest(x, z);
  const e = tileWest(x + 1, z);
  const n = tileNorth(y, z);
  const s = tileNorth(y + 1, z);
  const out: [number, number][] = [];
  for (let i = 0; i < k; i++)
    for (let j = 0; j < k; j++)
      out.push([w + ((i + 0.5) / k) * (e - w), s + ((j + 0.5) / k) * (n - s)]);
  return out;
}

// ── The codec ──────────────────────────────────────────────────────────────

describe('coverage trees', () => {
  test('round-trip through the text encoding', () => {
    for (let seed = 1; seed < 40; seed++) {
      const tree = randomTree(6, seed * 7919);
      const encoded = encodeCoverageTree(tree, 6);
      expect(decodeCoverageTree(encoded)).toEqual(tree);
    }
    expect(decodeCoverageTree(encodeCoverageTree(EMPTY, 15))).toBe(EMPTY);
    expect(decodeCoverageTree(encodeCoverageTree(FULL, 15))).toBe(FULL);
  });

  test('refuses anything but exactly one well-formed tree', () => {
    const good = encodeCoverageTree([FULL, EMPTY, EMPTY, [FULL, FULL, EMPTY, FULL]], 2);
    expect(() => decodeCoverageTree({ ...good, maxZoom: 1 })).toThrow(/mixed node at z1/);
    expect(() => decodeCoverageTree({ maxZoom: 2, bits: 'not base64!' })).toThrow(/base64/);
    expect(() => decodeCoverageTree({ maxZoom: 99, bits: good.bits })).toThrow(/zoom/);
    // Truncated: the root says "mixed" and nothing follows.
    expect(() => decodeCoverageTree({ maxZoom: 2, bits: btoa(String.fromCharCode(2)) })).toThrow(
      /ends inside/,
    );
    // A second tree after the first.
    expect(() => decodeCoverageTree({ maxZoom: 2, bits: btoa(String.fromCharCode(1, 1)) })).toThrow(
      /after the end/,
    );
    // An unknown node code (3).
    expect(() => decodeCoverageTree({ maxZoom: 2, bits: btoa(String.fromCharCode(3)) })).toThrow(
      /unknown/,
    );
  });

  test('union, intersection, coarsening and counting agree with brute force', () => {
    for (let seed = 1; seed < 12; seed++) {
      const a = randomTree(5, seed * 104729);
      const b = randomTree(5, seed * 1299709);
      const sa = tileSet(a, 5);
      const sb = tileSet(b, 5);
      expect(tileSet(unionCoverageTrees(a, b), 5)).toEqual(new Set([...sa, ...sb]));
      expect(tileSet(intersectCoverageTrees(a, b), 5)).toEqual(
        new Set([...sa].filter((t) => sb.has(t))),
      );
      expect(countCoverageTiles(a, 5)).toBe(sa.size);
      // Coarsened: a z4 tile is covered iff all four of its z5 tiles were.
      const coarse = coarsenCoverageTree(a, 4);
      for (let x = 0; x < 16; x++) {
        for (let y = 0; y < 16; y++) {
          const all = [0, 1, 2, 3].every((i) => sa.has(`${x * 2 + (i & 1)}/${y * 2 + (i >> 1)}`));
          expect(coverageAt(coarse, 4, 4, x, y) === FULL).toBe(all);
        }
      }
    }
  });

  test('answers MIXED above the leaves and the ancestor’s answer below them', () => {
    const tree: CoverageNode = [FULL, EMPTY, EMPTY, EMPTY];
    expect(coverageAt(tree, 1, 0, 0, 0)).toBe(MIXED);
    expect(coverageAt(tree, 1, 1, 0, 0)).toBe(FULL);
    expect(coverageAt(tree, 1, 5, 7, 3)).toBe(FULL);
    expect(coverageAt(tree, 1, 5, 16, 3)).toBe(EMPTY);
    expect(coverageAt(tree, 1, 1, 2, 0)).toBe(EMPTY); // outside the world
  });

  test('bounds and cells describe the owned area', () => {
    const tree = rectOwnership({ zoom: 15, x0: 16384, y0: 16384, x1: 16386, y1: 16385 });
    expect(coverageCells(tree)).toEqual([
      [15, 16384, 16384],
      [15, 16385, 16384],
    ]);
    const [w, s, e, n] = coverageTreeBounds(tree) as number[];
    expect(w).toBeCloseTo(0, 9);
    expect(e).toBeCloseTo(2 * (360 / 2 ** 15), 9);
    expect(n).toBeCloseTo(0, 9);
    expect(s).toBeLessThan(0);
    expect(coverageTreeBounds(EMPTY)).toBeNull();
  });
});

// ── Ownership ─────────────────────────────────────────────────────────────

const PORTUGALISH: Ring = [
  [-9.6, 36.9],
  [-7.4, 37.1],
  [-7.0, 39.6],
  [-6.2, 41.9],
  [-8.9, 42.2],
  [-9.6, 36.9],
];

describe('a region’s ownership', () => {
  test('owns exactly tiles wholly inside its polygon (checked by sampling, at z11)', () => {
    const rings = [PORTUGALISH];
    const tree = polygonOwnership(rings, 11);
    let owned = 0;
    let wholly = 0;
    let missed = 0;
    const z = 11;
    for (let x = 960; x < 1000; x++) {
      for (let y = 740; y < 790; y++) {
        const samples = tileSamples(z, x, y);
        const allIn = samples.every(([lon, lat]) => inside(rings, lon, lat));
        const isOwned = coverageAt(tree, 11, 11, x, y) === FULL;
        if (isOwned) {
          owned++;
          // Never owned with any part of it outside: that would be buildings
          // the extract does not hold, served as if it did.
          expect({ x, y, allIn }).toEqual({ x, y, allIn: true });
        }
        if (allIn) {
          wholly++;
          if (!isOwned) {
            // Unowned yet every sample inside: only if an edge really cuts
            // through it, between the samples.
            missed++;
            const w = tileWest(x, z);
            const e = tileWest(x + 1, z);
            const n = tileNorth(y, z);
            const s = tileNorth(y + 1, z);
            const cut = PORTUGALISH.slice(0, -1).some(([ax, ay], i) => {
              const [bx, by] = PORTUGALISH[i + 1];
              return segmentCrossesRect(ax, ay, bx, by, w, s, e, n);
            });
            expect({ x, y, cut }).toEqual({ x, y, cut: true });
          }
        }
      }
    }
    expect(owned).toBeGreaterThan(300);
    expect(missed).toBeLessThan(wholly / 10);
  });

  test('a hole is not owned', () => {
    const outer: Ring = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ];
    const hole: Ring = [
      [4, 4],
      [6, 4],
      [6, 6],
      [4, 6],
      [4, 4],
    ];
    const tree = polygonOwnership([outer, hole], 8);
    const at = (lon: number, lat: number) => {
      const n = 2 ** 8;
      const x = Math.floor(((lon + 180) / 360) * n);
      const phi = (lat * Math.PI) / 180;
      const y = Math.floor(((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n);
      return coverageAt(tree, 8, 8, x, y);
    };
    expect(at(2, 2)).toBe(FULL);
    expect(at(5, 5)).toBe(EMPTY);
    expect(at(11, 5)).toBe(EMPTY);
  });

  test('two regions sharing a border: no tile owned by both, the border’s tiles by neither', () => {
    // A border that runs diagonally through tiles, like a real one.
    const west: Ring = [
      [0, 0],
      [3, 0],
      [5, 8],
      [0, 8],
      [0, 0],
    ];
    const east: Ring = [
      [3, 0],
      [8, 0],
      [8, 8],
      [5, 8],
      [3, 0],
    ];
    const a = polygonOwnership([west], 9);
    const b = polygonOwnership([east], 9);
    expect(countCoverageTiles(intersectCoverageTrees(a, b), 9)).toBe(0);
    // Every tile whose samples straddle the border is owned by neither.
    const z = 9;
    for (let x = 256; x < 270; x++) {
      for (let y = 244; y < 256; y++) {
        const samples = tileSamples(z, x, y);
        const inWest = samples.filter(([lon, lat]) => inside([west], lon, lat)).length;
        const inEast = samples.filter(([lon, lat]) => inside([east], lon, lat)).length;
        if (inWest > 0 && inEast > 0) {
          expect(coverageAt(a, 9, 9, x, y)).toBe(EMPTY);
          expect(coverageAt(b, 9, 9, x, y)).toBe(EMPTY);
        }
      }
    }
  });

  test('a border lying exactly on a tile edge leaves no gap', () => {
    // lon 0 is a tile edge at every zoom: both sides' tiles are owned.
    const west: Ring = [
      [-10, 10],
      [0, 10],
      [0, 20],
      [-10, 20],
      [-10, 10],
    ];
    const east: Ring = [
      [0, 10],
      [10, 10],
      [10, 20],
      [0, 20],
      [0, 10],
    ];
    const a = polygonOwnership([west], 10);
    const b = polygonOwnership([east], 10);
    const y = 469; // ~15°N at z10
    expect(coverageAt(a, 10, 10, 511, y)).toBe(FULL);
    expect(coverageAt(b, 10, 10, 512, y)).toBe(FULL);
    expect(countCoverageTiles(intersectCoverageTrees(a, b), 10)).toBe(0);
  });

  test('the crossing test is strict: along an edge or through a corner is not through the tile', () => {
    expect(segmentCrossesRect(0, 0, 0, 10, 0, 0, 1, 1)).toBe(false); // along the west side
    expect(segmentCrossesRect(-1, -1, 0, 0, 0, 0, 1, 1)).toBe(false); // ends at a corner
    expect(segmentCrossesRect(-1, 0.5, 2, 0.5, 0, 0, 1, 1)).toBe(true); // straight through
    expect(segmentCrossesRect(0.2, 0.2, 0.3, 0.3, 0, 0, 1, 1)).toBe(true); // wholly inside
    expect(segmentCrossesRect(2, 2, 3, 3, 0, 0, 1, 1)).toBe(false);
  });

  test('reads a Geofabrik .poly, holes included', () => {
    const text = [
      'test',
      '1',
      '   0.0E+00   0.0E+00',
      '   1.0E+01   0.0E+00',
      '   1.0E+01   1.0E+01',
      'END',
      '!2',
      '   1 1',
      '   2 1',
      '   2 2',
      'END',
      'END',
    ].join('\n');
    const rings = parsePoly(text);
    expect(rings).toHaveLength(2);
    expect(rings[0][1]).toEqual([10, 0]);
    expect(() => parsePoly('x\n1\n 1 2')).toThrow(/END/);
    expect(() => parsePoly('x\nEND\n')).toThrow(/no rings/);
    expect(() => parsePoly('x\n1\n a b\nEND\nEND\n')).toThrow(/unreadable/);
  });
});

describe('parts', () => {
  test('split where the weight is, cover the region exactly, and never overlap', () => {
    // A "city" of heavy tiles in the west of a 16×8 grid.
    const weights = new Map<string, number>();
    for (let x = 0; x < 16; x++)
      for (let y = 0; y < 8; y++) weights.set(`${x}/${y}`, x < 4 ? 100 : 1);
    const bounds = { zoom: 4, x0: 0, y0: 0, x1: 16, y1: 8 };
    const rects = splitByDensity(weights, bounds, 2);
    expect(rects).toHaveLength(2);
    // The cut falls inside the heavy west, not at the middle of the area.
    expect(rects[0].x1).toBeLessThanOrEqual(4);
    const cells = new Set<string>();
    for (const rect of rects) {
      for (let x = rect.x0; x < rect.x1; x++)
        for (let y = rect.y0; y < rect.y1; y++) {
          const key = `${x}/${y}`;
          expect(cells.has(key)).toBe(false);
          cells.add(key);
        }
    }
    expect(cells.size).toBe(16 * 8);
  });

  test('parts’ ownerships partition the region’s', () => {
    const region = polygonOwnership([PORTUGALISH], 12);
    const bounds = { zoom: 8, x0: 121, y0: 94, x1: 124, y1: 99 };
    const rects = splitByDensity(
      new Map([
        ['121/96', 5],
        ['123/97', 5],
      ]),
      bounds,
      3,
    );
    const parts = rects.map((rect) => partOwnership(region, rect));
    let union: CoverageNode = EMPTY;
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        expect(countCoverageTiles(intersectCoverageTrees(parts[i], parts[j]), 12)).toBe(0);
      }
      union = unionCoverageTrees(union, parts[i]);
    }
    expect(union).toEqual(intersectCoverageTrees(region, rectOwnership({ ...bounds }, 12)));
  });

  test('keepTile reads a tree at its leaf zoom', () => {
    const keep = ownsTile(rectOwnership({ zoom: 15, x0: 10, y0: 10, x1: 12, y1: 11 }));
    expect(keep(10, 10)).toBe(true);
    expect(keep(11, 10)).toBe(true);
    expect(keep(12, 10)).toBe(false);
    expect(keep(10, 11)).toBe(false);
  });
});

// ── The catalogue ─────────────────────────────────────────────────────────

describe('the region catalogue', () => {
  const regions = CITY_REGIONS.regions;

  test('is planned, and every region fits the machine in its parts', () => {
    expect(regions.length).toBeGreaterThan(300);
    const { maxPartBytes } = CITY_REGIONS.budget;
    expect(maxPartBytes).toBeGreaterThan(0);
    for (const region of regions) {
      expect({ id: region.id, ok: REGION_ID.test(region.id) }).toEqual({ id: region.id, ok: true });
      expect(region.parts).toBeGreaterThanOrEqual(1);
      expect(region.pbfBytes / region.parts).toBeLessThanOrEqual(maxPartBytes);
    }
    expect(new Set(regions.map((r) => r.id)).size).toBe(regions.length);
  });

  test('builds members, not the groupings over them', () => {
    const ids = new Set(regions.map((r) => r.id));
    for (const grouping of ['north-america/us', 'europe/dach', 'europe/britain-and-ireland']) {
      expect(ids.has(grouping)).toBe(false);
    }
    expect(ids.has('europe/portugal')).toBe(true);
    expect(ids.has('north-america/us/california/norcal')).toBe(true);
  });

  test('tags official data only where it exists', () => {
    const catastro = regions.filter((r) => r.official.includes('es-catastro')).map((r) => r.id);
    expect(catastro).toContain('europe/spain/cataluna');
    expect(catastro).toContain('africa/canary-islands');
    expect(catastro).not.toContain('europe/spain/pais-vasco');
    expect(
      catastro.every((id) => id.startsWith('europe/spain') || id === 'africa/canary-islands'),
    ).toBe(true);
  });

  test('selects by id and prefix, and refuses a typo', () => {
    expect(selectRegions('europe/portugal').map((r) => r.id)).toEqual(['europe/portugal']);
    expect(selectRegions('europe/spain/').length).toBeGreaterThan(10);
    expect(selectRegions('all')).toHaveLength(regions.length);
    expect(() => selectRegions('europe/portgual')).toThrow(/names no region/);
    // Taking regions back out — the ones already published with official data.
    const rest = selectRegions('europe/spain/,-europe/spain/madrid,-europe/spain/cataluna');
    expect(rest.map((r) => r.id)).not.toContain('europe/spain/madrid');
    expect(rest).toHaveLength(selectRegions('europe/spain/').length - 2);
    expect(selectRegions('all,-europe/')).toHaveLength(
      regions.length - selectRegions('europe/').length,
    );
    expect(() => selectRegions('all,-europe/portgual')).toThrow(/names no region/);
    expect(() => selectRegions('-europe/')).toThrow(/no regions selected/);
  });

  test('batches within the matrix limit, every region exactly once', () => {
    const batches = batchRegions(regions, 2e9, 256);
    expect(batches.length).toBeLessThanOrEqual(256);
    const seen = batches.flat().map((r) => r.id);
    expect(new Set(seen).size).toBe(regions.length);
    expect(seen).toHaveLength(regions.length);
    // Balanced: no batch more than the target plus its single largest region.
    const largest = Math.max(...regions.map((r) => r.pbfBytes));
    for (const batch of batches) {
      expect(batch.reduce((sum, r) => sum + r.pbfBytes, 0)).toBeLessThanOrEqual(2e9 + largest);
    }
  });
});

// ── The manifest ──────────────────────────────────────────────────────────

function entry(id: string, rect: { x0: number; y0: number; x1: number; y1: number }): RegionEntry {
  const tree = rectOwnership({ zoom: 15, ...rect });
  const encoded = encodeCoverageTree(tree, 15);
  const stamp = '20261011-t';
  const ref = (kind: 'city' | 'city-roads') => ({
    key: archiveKey(kind, stamp, id),
    receipt: `${archiveKey(kind, stamp, id)}.receipt.json`,
    bytes: 10,
    sha256: 'a'.repeat(64),
    tiles: 1,
    seconds: 1,
    peakRssMb: 1,
  });
  return {
    id,
    name: id,
    region: id.replace(/~.*/, ''),
    part: null,
    stamp,
    bbox: coverageTreeBounds(tree) as [number, number, number, number],
    ownership: { maxZoom: 15, nodes: encoded.nodes, bits: encoded.bits },
    ownedTiles: countCoverageTiles(tree, 15),
    source: { extract: '', polygon: { url: '', sha256: '' } },
    official: [],
    city: ref('city'),
    roads: ref('city-roads'),
    builtAt: '',
  };
}

describe('the manifest', () => {
  test('keys are dated, and the builder’s keys are the ones the Worker accepts', () => {
    expect(STAMP.test('20261011')).toBe(true);
    expect(STAMP.test('20261011-123')).toBe(true);
    expect(STAMP.test('2026-10-11')).toBe(false);
    const key = archiveKey('city', '20261011-1', partId('europe/netherlands', 1, 2));
    expect(key).toBe('city/20261011-1/europe/netherlands~1of2.pmtiles');
    expect(ARCHIVE_KEY.test(key)).toBe(true);
    expect(ARCHIVE_KEY.test('planet/20260921.pmtiles')).toBe(false);
    expect(ARCHIVE_KEY.test('city/latest/europe/portugal.pmtiles')).toBe(false);
    expect(partId('europe/portugal', 1, 1)).toBe('europe/portugal');
  });

  test('a run replaces its regions, keeps the rest, and lists what it retired', () => {
    const first = mergeManifest(
      null,
      [
        entry('a/one', { x0: 0, y0: 0, x1: 4, y1: 4 }),
        entry('a/two', { x0: 4, y0: 0, x1: 8, y1: 4 }),
      ],
      't1',
    ).manifest;
    const rebuilt = { ...entry('a/two', { x0: 4, y0: 0, x1: 8, y1: 4 }) };
    rebuilt.stamp = '20261012-t';
    rebuilt.city = {
      ...(rebuilt.city as NonNullable<RegionEntry['city']>),
      key: 'city/20261012-t/a/two.pmtiles',
      receipt: 'city/20261012-t/a/two.pmtiles.receipt.json',
    };
    rebuilt.roads = null;
    const { manifest, retired } = mergeManifest(first, [rebuilt], 't2');
    expect(manifest.regions.map((r) => [r.id, r.stamp])).toEqual([
      ['a/one', '20261011-t'],
      ['a/two', '20261012-t'],
    ]);
    expect(retired).toEqual([
      'city/20261011-t/a/two.pmtiles',
      'city/20261011-t/a/two.pmtiles.receipt.json',
      'city-roads/20261011-t/a/two.pmtiles',
      'city-roads/20261011-t/a/two.pmtiles.receipt.json',
    ]);
    // Roads coverage lost a/two with its road archive; buildings did not.
    const city = decodeCoverageTree(manifest.coverage);
    const roads = decodeCoverageTree(manifest.roadsCoverage);
    expect(coverageAt(city, 14, 14, 3, 0)).toBe(FULL);
    expect(coverageAt(roads, 14, 14, 3, 0)).toBe(EMPTY);
    expect(coverageAt(roads, 14, 14, 1, 0)).toBe(FULL);
  });

  test('a region rebuilt in parts replaces the whole region', () => {
    const first = mergeManifest(
      null,
      [entry('b/big', { x0: 0, y0: 0, x1: 8, y1: 8 })],
      't1',
    ).manifest;
    const parts = [
      entry('b/big~1of2', { x0: 0, y0: 0, x1: 4, y1: 8 }),
      entry('b/big~2of2', { x0: 4, y0: 0, x1: 8, y1: 8 }),
    ];
    const { manifest } = mergeManifest(first, parts, 't2');
    expect(manifest.regions.map((r) => r.id)).toEqual(['b/big~1of2', 'b/big~2of2']);
  });

  test('refuses an entry whose ownership does not say what it claims', () => {
    const bad = entry('c/x', { x0: 0, y0: 0, x1: 2, y1: 2 });
    bad.ownedTiles = 5;
    expect(() => mergeManifest(null, [bad], 't')).toThrow(/does not own/);
    const wrongKey = entry('c/y', { x0: 0, y0: 0, x1: 2, y1: 2 });
    (wrongKey.city as NonNullable<RegionEntry['city']>).key = 'city/20261011-t/c/other.pmtiles';
    expect(() => mergeManifest(null, [wrongKey], 't')).toThrow(/does not name/);
  });
});
