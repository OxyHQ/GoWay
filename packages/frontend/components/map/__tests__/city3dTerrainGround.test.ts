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
  GROUND,
  type GroundTile,
  gridAt,
  largestChange,
  polygonGround,
  sampleGroundGrid,
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

describe('sampleGroundGrid', () => {
  test('row-major from the north-west corner, at the tile edges', () => {
    const tile = { z: 2, x: 1, y: 1 };
    const seen: [number, number][] = [];
    const grid = sampleGroundGrid(tile, 3, (lng, lat) => {
      seen.push([lng, lat]);
      return seen.length;
    });
    // West edge of x=1 at z2 is -90°, east edge 0°; north edge is y=1/4 of the world.
    expect(seen[0][0]).toBeCloseTo(-90, 9);
    expect(seen[2][0]).toBeCloseTo(0, 9);
    expect(seen[0][1]).toBeCloseTo(latFromMercatorY(0.25), 9);
    expect(seen[8][1]).toBeCloseTo(latFromMercatorY(0.5), 9);
    expect(seen[0][1]).toBeGreaterThan(seen[8][1]);
    expect([...grid]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test('a sampler that answers nonsense is flat ground, not NaN', () => {
    const grid = sampleGroundGrid({ z: 14, x: 0, y: 0 }, 2, () => Number.NaN);
    expect([...grid]).toEqual([0, 0, 0, 0]);
  });
});

describe('gridAt', () => {
  // West 0 → east 10, north 0 → south 100: a plane, which bilinear reads exactly.
  const grid = Float32Array.from([0, 10, 100, 110]);
  test('corners, centre, and clamping outside the tile', () => {
    expect(gridAt(grid, 2, 0, 0)).toBe(0);
    expect(gridAt(grid, 2, 1, 0)).toBe(10);
    expect(gridAt(grid, 2, 0, 1)).toBe(100);
    expect(gridAt(grid, 2, 0.5, 0.5)).toBeCloseTo(55, 6);
    expect(gridAt(grid, 2, -3, 9)).toBe(100);
  });
});

describe('polygonGround', () => {
  const size = 2;
  const tileM = 1000;
  test('flat ground: lifted by the ground, sunk by the floor only', () => {
    const grid = Float32Array.from([420, 420, 420, 420]);
    const placed = polygonGround(grid, size, tileM, Float32Array.from([100, -200, 150, -150]));
    expect(placed.anchor[0]).toBeCloseTo(420, 4);
    expect(placed.sink[0]).toBe(GROUND.minSinkM);
  });

  test('on a slope the foot reaches the lowest corner, plus the margin', () => {
    // Rising 1 m per metre eastward: 0 at the west edge, 1000 at the east.
    const grid = Float32Array.from([0, 1000, 0, 1000]);
    // A 50 m box centred 125 m east: centre 125, lowest corner 100.
    const placed = polygonGround(grid, size, tileM, Float32Array.from([100, -10, 150, -40]));
    expect(placed.anchor[0]).toBeCloseTo(125, 3);
    expect(placed.sink[0]).toBeCloseTo(25 + GROUND.sinkMarginM, 3);
  });

  test('local y is north-up: a box near the north edge reads the north row', () => {
    const grid = Float32Array.from([5, 5, 900, 900]); // north row 5, south row 900
    const north = polygonGround(grid, size, tileM, Float32Array.from([0, -2, 10, 0]));
    const south = polygonGround(grid, size, tileM, Float32Array.from([0, -1000, 10, -998]));
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
    grounder.setSampler(() => 50);
    expect(grounder.isCurrent('a')).toBe(false);
    const first = grounder.ground('a', groundTile);
    expect(first?.changed).toBe(true);
    expect(first?.max).toBeCloseTo(50, 4);
    expect(grounder.isCurrent('a')).toBe(true);
    grounder.setSampler(() => 50);
    expect(grounder.isCurrent('a')).toBe(false);
    expect(grounder.hasGround('a')).toBe(true);
  });

  test('a refresh that moves nothing is not re-uploaded; one that does, is — in place', () => {
    const grounder = new TileGrounder();
    let height = 300;
    grounder.setSampler(() => height);
    const first = grounder.ground('a', groundTile);
    grounder.setSampler(() => height + GROUND.epsilonM / 2);
    const same = grounder.ground('a', groundTile);
    expect(same?.changed).toBe(false);
    expect(same?.values).toBe(first?.values);
    height = 310;
    grounder.setSampler(() => height);
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
    grounder.setSampler(ground(300, 5));
    const before = grounder.ground('a', groundTile);
    expect(before?.max).toBeCloseTo(300, 2);
    expect(before?.min).toBeCloseTo(295, 2);

    // Centre −0.2 m, sink +0.2 m: each within epsilon, the foot 0.4 m lower.
    grounder.setSampler(ground(299.8, 5.2));
    const after = grounder.ground('a', groundTile);
    expect(after?.changed).toBe(true);
    expect(after?.min).toBeCloseTo(294.6, 2);

    // Centre and sink up together by 0.2: the foot does not move, the roof
    // by 0.2 — within epsilon, so nothing is uploaded.
    grounder.setSampler(ground(300, 5.4));
    expect(grounder.ground('a', groundTile)?.changed).toBe(false);
  });

  test('largestChange', () => {
    expect(largestChange(Float32Array.from([1, 2]), Float32Array.from([1, 5]))).toBe(3);
    expect(largestChange(Float32Array.from([1]), Float32Array.from([1, 5]))).toBe(Infinity);
  });
});
