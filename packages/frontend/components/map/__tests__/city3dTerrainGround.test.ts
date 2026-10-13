/**
 * City-3D buildings on terrain: the grid is read the right way round, every
 * building gets ONE lift (flat roofs, as in the data), only its foot sinks and
 * by the slope it stands on, and a terrain refresh that moves nothing uploads
 * nothing. Plus the mesher's half of it: each polygon's vertices are one
 * contiguous run, recorded with its footprint's box.
 */
import { describe, expect, test } from 'bun:test';

import {
  type BuildingFeature,
  meshBuildings,
  type Point2,
} from '@/components/map/engine/city3d/mesher';
import { meshOsmBuildings } from '@/components/map/engine/city3d/osmMesher';
import { buildingFromProperties } from '@/components/map/engine/city3d/osmTiles';
import {
  createGround,
  GROUND,
  type GroundGrid,
  type GroundTile,
  gridAt,
  latticeCells,
  largestChange,
  polygonGround,
  sampleGroundGrid,
  TERRAIN_LATTICE,
  TileGrounder,
  vertexGround,
} from '@/components/map/engine/city3d/terrainGround';
import { latFromMercatorY, tileSizeMetres } from '@/components/map/engine/city3d/tileMath';

const OPTIONS = { extent: 4096, tileSizeMetres: 4096 };

function tileRect(x0: number, y0: number, x1: number, y1: number): Point2[] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
  ];
}

function building(rings: Point2[][], height = 20, base = 0): BuildingFeature {
  return { rings, properties: { render_height: height, render_min_height: base } };
}

/** A sampler as the engine hands it over: with its grid cache. */
const groundOf = (sample: Parameters<typeof createGround>[0]) => createGround(sample);

/**
 * A grid of `cells` DEM pixels over the tile whose samples read `f(u, v)` — u
 * east, v south, 0–1 across the tile; sample k sits at (k − ½) / cells.
 */
function planeGrid(cells: number, f: (u: number, v: number) => number): GroundGrid {
  const size = cells + 2;
  const values = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) values[j * size + i] = f((i - 0.5) / cells, (j - 0.5) / cells);
  }
  return { values, cells, size };
}

describe('sampleGroundGrid', () => {
  test('row-major from the north-west, at the pixel centres, one past each edge', () => {
    const tile = { z: 2, x: 1, y: 1 };
    const seen: [number, number][] = [];
    const grid = sampleGroundGrid(tile, 1, (lng, lat) => {
      seen.push([lng, lat]);
      return seen.length;
    });
    // One pixel across x=1 at z2 (−90° … 0°): its centre −45°, and the
    // centres of its neighbours' pixels, −135° and 45°.
    expect(grid.size).toBe(3);
    expect(grid.cells).toBe(1);
    expect(seen[0][0]).toBeCloseTo(-135, 9);
    expect(seen[1][0]).toBeCloseTo(-45, 9);
    expect(seen[2][0]).toBeCloseTo(45, 9);
    expect(seen[0][1]).toBeCloseTo(latFromMercatorY(0.125), 9);
    expect(seen[8][1]).toBeCloseTo(latFromMercatorY(0.625), 9);
    expect(seen[0][1]).toBeGreaterThan(seen[8][1]);
    expect([...grid.values]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test('a sampler that answers nonsense is flat ground, not NaN', () => {
    const grid = sampleGroundGrid({ z: 14, x: 0, y: 0 }, 1, () => Number.NaN);
    expect([...grid.values]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test("the grid's cells are the DEM's pixels across the tile, within the budget", () => {
    expect(latticeCells({ z: 15 }, TERRAIN_LATTICE)).toBe(64);
    expect(latticeCells({ z: 14 }, TERRAIN_LATTICE)).toBe(128);
    expect(latticeCells({ z: 16 }, TERRAIN_LATTICE)).toBe(32);
    expect(latticeCells({ z: 13 }, TERRAIN_LATTICE)).toBe(GROUND.maxCells);
    expect(latticeCells({ z: 30 }, TERRAIN_LATTICE)).toBe(1);
  });
});

describe('gridAt', () => {
  // West 0 → east 10, north 0 → south 100: a plane, which bilinear reads exactly.
  const grid = planeGrid(1, (u, v) => 10 * u + 100 * v);
  test('corners, centre, and held at the last sample past the edge', () => {
    expect(gridAt(grid, 0, 0)).toBeCloseTo(0, 5);
    expect(gridAt(grid, 1, 0)).toBeCloseTo(10, 5);
    expect(gridAt(grid, 0, 1)).toBeCloseTo(100, 5);
    expect(gridAt(grid, 0.5, 0.5)).toBeCloseTo(55, 5);
    // The grid reaches half a cell past each edge (its samples at −½ and 1½).
    expect(gridAt(grid, -0.25, 0)).toBeCloseTo(-2.5, 5);
    expect(gridAt(grid, -3, 9)).toBeCloseTo(-5 + 150, 5);
  });
});

describe('polygonGround', () => {
  const tileM = 1000;
  test('flat ground: lifted by the ground, sunk by the floor only', () => {
    const grid = planeGrid(4, () => 420);
    const placed = polygonGround(grid, tileM, Float32Array.from([100, -200, 150, -150]));
    expect(placed.anchor[0]).toBeCloseTo(420, 4);
    expect(placed.sink[0]).toBe(GROUND.minSinkM);
  });

  test('on a slope the foot reaches the lowest corner, plus the margin', () => {
    // Rising 1 m per metre eastward: 0 at the west edge, 1000 at the east.
    const grid = planeGrid(4, (u) => 1000 * u);
    // A 50 m box centred 125 m east: centre 125, lowest corner 100.
    const placed = polygonGround(grid, tileM, Float32Array.from([100, -10, 150, -40]));
    expect(placed.anchor[0]).toBeCloseTo(125, 3);
    expect(placed.sink[0]).toBeCloseTo(25 + GROUND.sinkMarginM, 3);
  });

  test('local y is north-up: a box near the north edge reads the north row', () => {
    const grid = planeGrid(4, (_u, v) => 5 + 895 * v); // north edge 5, south edge 900
    const north = polygonGround(grid, tileM, Float32Array.from([0, -2, 10, 0]));
    const south = polygonGround(grid, tileM, Float32Array.from([0, -1000, 10, -998]));
    expect(north.anchor[0]).toBeLessThan(10);
    expect(south.anchor[0]).toBeGreaterThan(890);
  });
});

describe('vertexGround', () => {
  test('one lift per polygon; only the foot (z ≈ 0) sinks', () => {
    // Polygon 0: vertices 0–2 (a foot, a wall top, a roof); polygon 1: 3–4 floating.
    const positions = Float32Array.from([0, 0, 0, 0, 0, 12, 1, 1, 15, 2, 2, 30, 2, 2, 40]);
    const out = vertexGround(positions, Uint32Array.from([0, 3]), {
      anchor: Float32Array.from([100, 200]),
      sink: Float32Array.from([3, 5]),
    });
    expect([...out.values]).toEqual([97, 100, 100, 200, 200]);
    expect(out.min).toBe(97);
    expect(out.max).toBe(200);
  });

  test('writes into a buffer of the right length, so the upload can be in place', () => {
    const positions = Float32Array.from([0, 0, 0]);
    const buffer = new Float32Array(1);
    const out = vertexGround(
      positions,
      Uint32Array.from([0]),
      {
        anchor: Float32Array.from([7]),
        sink: Float32Array.from([2]),
      },
      buffer,
    );
    expect(out.values).toBe(buffer);
    expect(buffer[0]).toBe(5);
  });
});

describe('meshBuildings records each polygon for the ground', () => {
  test('starts are contiguous runs that tile the vertex buffer; boxes hold the footprint', () => {
    const mesh = meshBuildings(
      [
        building([tileRect(100, 100, 140, 160)]),
        building([tileRect(1000, 2000, 1030, 2010), tileRect(3000, 3000, 3020, 3020)], 9),
      ],
      OPTIONS,
    );
    if (!mesh) throw new Error('expected a mesh');
    expect(mesh.polygonStarts.length).toBe(mesh.polygons);
    expect(mesh.polygonStarts.length).toBe(3);
    expect(mesh.polygonStarts[0]).toBe(0);
    const vertices = mesh.positions.length / 3;
    for (let p = 0; p < mesh.polygonStarts.length; p++) {
      const start = mesh.polygonStarts[p];
      const end = p + 1 < mesh.polygonStarts.length ? mesh.polygonStarts[p + 1] : vertices;
      expect(end).toBeGreaterThan(start);
      const [minX, minY, maxX, maxY] = mesh.polygonBoxes.subarray(p * 4, p * 4 + 4);
      // Every vertex of the run lies within its footprint's box (the roof is inset).
      for (let v = start; v < end; v++) {
        expect(mesh.positions[v * 3]).toBeGreaterThanOrEqual(minX - 1e-3);
        expect(mesh.positions[v * 3]).toBeLessThanOrEqual(maxX + 1e-3);
        expect(mesh.positions[v * 3 + 1]).toBeGreaterThanOrEqual(minY - 1e-3);
        expect(mesh.positions[v * 3 + 1]).toBeLessThanOrEqual(maxY + 1e-3);
      }
    }
    // The first box is the first footprint, in ENU (y north, so negated).
    expect([...mesh.polygonBoxes.subarray(0, 4)]).toEqual([100, -160, 140, -100]);
  });
});

describe('the city-tile mesher records each BUILDING for the ground', () => {
  test('one unit per building — a pitched roof included — boxed in ENU', () => {
    const pitched = buildingFromProperties(1, [tileRect(100, 100, 140, 160)], {
      render_height: 12,
      'roof:shape': 'gabled',
      'roof:height': 4,
    });
    const flat = buildingFromProperties(2, [tileRect(1000, 2000, 1030, 2010)], {
      render_height: 9,
    });
    const mesh = meshOsmBuildings([pitched, flat], OPTIONS);
    if (!mesh) throw new Error('expected a mesh');
    expect(mesh.polygonStarts.length).toBe(2);
    expect(mesh.polygonStarts[0]).toBe(0);
    expect(mesh.polygonStarts[1]).toBeGreaterThan(0);
    expect(mesh.polygonStarts[1]).toBeLessThan(mesh.positions.length / 3);
    expect([...mesh.polygonBoxes.subarray(0, 4)]).toEqual([100, -160, 140, -100]);
    expect([...mesh.polygonBoxes.subarray(4, 8)]).toEqual([1000, -2010, 1030, -2000]);
  });
});

describe('TileGrounder', () => {
  const tile = { z: 14, x: 8290, y: 6119 };
  const mesh = meshBuildings([building([tileRect(1000, 1000, 1100, 1100)])], {
    extent: 4096,
    tileSizeMetres: tileSizeMetres(tile),
  });
  if (!mesh) throw new Error('expected a mesh');
  const groundTile: GroundTile = {
    tile,
    tileSizeM: tileSizeMetres(tile),
    positions: mesh.positions,
    polygonStarts: mesh.polygonStarts,
    polygonBoxes: mesh.polygonBoxes,
  };

  test('no sampler, no ground; a sampler makes every tile stale', () => {
    const grounder = new TileGrounder();
    expect(grounder.active).toBe(false);
    expect(grounder.ground('a', groundTile)).toBeNull();
    grounder.setGround(groundOf(() => 50));
    expect(grounder.isCurrent('a')).toBe(false);
    const first = grounder.ground('a', groundTile);
    expect(first?.changed).toBe(true);
    expect(first?.max).toBeCloseTo(50, 4);
    expect(grounder.isCurrent('a')).toBe(true);
    grounder.setGround(groundOf(() => 50));
    expect(grounder.isCurrent('a')).toBe(false);
    expect(grounder.hasGround('a')).toBe(true);
  });

  test('a refresh that moves nothing is not re-uploaded; one that does, is — in place', () => {
    const grounder = new TileGrounder();
    let height = 300;
    grounder.setGround(groundOf(() => height));
    const first = grounder.ground('a', groundTile);
    grounder.setGround(groundOf(() => height + GROUND.epsilonM / 2));
    const same = grounder.ground('a', groundTile);
    expect(same?.changed).toBe(false);
    expect(same?.values).toBe(first?.values);
    height = 310;
    grounder.setGround(groundOf(() => height));
    const moved = grounder.ground('a', groundTile);
    expect(moved?.changed).toBe(true);
    expect(moved?.values).toBe(first?.values);
    expect(moved?.max).toBeCloseTo(310, 3);
  });

  test('the FOOT is compared too: centre and sink each under epsilon can still move it 0.4 m', () => {
    // PR #124 review. Ground linear in longitude (which bilinear reads
    // exactly), so the box's centre and its lowest corner — hence its sink —
    // are set by hand: sink = drop to the low corner + margin.
    const n = 2 ** tile.z;
    const lngAt = (u: number) => ((tile.x + u) / n) * 360 - 180;
    const centreLng = lngAt(1050 / 4096);
    const halfWidthLng = centreLng - lngAt(1000 / 4096);
    const ground = (centre: number, sink: number) => (lng: number) =>
      centre + ((sink - GROUND.sinkMarginM) / halfWidthLng) * (lng - centreLng);

    const grounder = new TileGrounder();
    grounder.setGround(groundOf(ground(300, 5)));
    const before = grounder.ground('a', groundTile);
    expect(before?.max).toBeCloseTo(300, 2);
    expect(before?.min).toBeCloseTo(295, 2);

    // Centre −0.2 m, sink +0.2 m: each within epsilon, the foot 0.4 m lower.
    grounder.setGround(groundOf(ground(299.8, 5.2)));
    const after = grounder.ground('a', groundTile);
    expect(after?.changed).toBe(true);
    expect(after?.min).toBeCloseTo(294.6, 2);

    // Centre and sink up together by 0.2: the foot does not move, the roof
    // by 0.2 — within epsilon, so nothing is uploaded.
    grounder.setGround(groundOf(ground(300, 5.4)));
    expect(grounder.ground('a', groundTile)?.changed).toBe(false);
  });

  test('largestChange', () => {
    expect(largestChange(Float32Array.from([1, 2]), Float32Array.from([1, 5]))).toBe(3);
    expect(largestChange(Float32Array.from([1]), Float32Array.from([1, 5]))).toBe(Infinity);
  });
});

describe('one ground for everything standing on it', () => {
  test('a tile is sampled once, whoever asks: the grounder and city life share it', () => {
    let calls = 0;
    const ground = createGround(() => {
      calls++;
      return 40;
    });
    const tile = { z: 15, x: 16580, y: 12238 };
    expect(ground.hasGrid(tile)).toBe(false);
    const grounder = new TileGrounder();
    grounder.setGround(ground);
    grounder.ground('15/16580/12238@0', {
      tile,
      tileSizeM: 917,
      polygonBoxes: new Float32Array(0),
    });
    const sampled = calls;
    // GoWay's DEM over a z15 tile: 64 pixels across, one more each side.
    expect(sampled).toBe(66 * 66);
    // City life's read of the same tile: no new samples.
    expect(ground.hasGrid(tile)).toBe(true);
    expect(ground.grid(tile).values[0]).toBe(40);
    expect(calls).toBe(sampled);
  });

  test('the cache keeps the most recently used tiles', () => {
    const ground = createGround(() => 0, TERRAIN_LATTICE, 2);
    const a = { z: 15, x: 1, y: 1 };
    const b = { z: 15, x: 2, y: 1 };
    const c = { z: 15, x: 3, y: 1 };
    ground.grid(a);
    ground.grid(b);
    ground.grid(a);
    ground.grid(c);
    expect(ground.hasGrid(a)).toBe(true);
    expect(ground.hasGrid(b)).toBe(false);
    expect(ground.hasGrid(c)).toBe(true);
  });
});
