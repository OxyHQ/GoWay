import { expect, test } from 'bun:test';
import {
  Buffers,
  MODE,
  packMarkings,
  packSurfaces,
  STREET_LIFT_M,
} from '../engine/cityStreets/meshBuffers';
import { StreetSurface } from '../engine/cityStreets/streetSurface';
import { latFromMercatorY, tileSizeMetres } from '../engine/city3d/tileMath';

const tile = { z: 15, x: 16582, y: 12237 },
  key = '15/16582/12237';
const rectangle = (
  b: Buffers,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  span: number,
  markings = false,
) => {
  const start = b.vertexCount;
  for (const [x, y] of [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ])
    b.vertex(
      x,
      y,
      0,
      [0, markings ? MODE.flat : 255, 1, span],
      markings ? [0, 0] : undefined,
      markings ? [x, y] : undefined,
    );
  b.triangle(start, start + 1, start + 2);
  b.triangle(start, start + 2, start + 3);
};

function fixture() {
  const b = new Buffers();
  rectangle(b, 0, 100, 0, -10, 1);
  rectangle(b, 0, 100, 0, -10, 0);
  const mesh = packSurfaces([b], []);
  mesh.bridges = [
    [
      [0, -5],
      [100, -5],
    ],
  ];
  const surface = new StreetSurface();
  surface.set(key, tile, mesh);
  surface.setGround(key, (x) => 20 - 8 * Math.sin((x * Math.PI) / 100));
  surface.activate([key]);
  return surface;
}

test('a bridge decal crossing its boundary is clipped to the deck, never grounded below it', () => {
  const surface = fixture();
  const b = new Buffers();
  rectangle(b, 30, 70, -8, -12, 1, true);
  const paint = surface.markings(key, packMarkings([b], []));
  if (!paint) throw new Error('Expected a registered street surface');
  expect(paint.indices.length).toBeGreaterThan(0);
  let area = 0;
  for (let i = 0; i < paint.positions.length; i += 3) {
    const [x, y, z] = paint.positions.subarray(i, i + 3);
    expect(y).toBeGreaterThanOrEqual(-10);
    expect(z).toBeCloseTo(20.003, 4);
    expect(paint.uvs[(i / 3) * 2]).toBeCloseTo(x, 4);
    expect(paint.uvs[(i / 3) * 2 + 1]).toBeCloseTo(y, 4);
  }
  for (let i = 0; i < paint.indices.length; i += 3) {
    const [a, b, c] = paint.indices.subarray(i, i + 3);
    const p = paint.positions;
    area +=
      Math.abs(
        (p[b * 3] - p[a * 3]) * (p[c * 3 + 1] - p[a * 3 + 1]) -
          (p[c * 3] - p[a * 3]) * (p[b * 3 + 1] - p[a * 3 + 1]),
      ) / 2;
  }
  expect(area).toBeCloseTo(80, 4);
});

test('a decal without a matching street stratum produces no triangles', () => {
  const b = new Buffers();
  rectangle(b, 10, 20, -1, -9, 2, true);
  expect(fixture().markings(key, packMarkings([b], []))?.indices.length).toBe(0);
});

test('geographic traffic contact uses north-positive local metres inside a southern tile', () => {
  const surface = fixture(),
    size = tileSizeMetres(tile);
  const lng = ((tile.x + 50 / size) / 2 ** 15) * 360 - 180;
  const lat = latFromMercatorY((tile.y + 5 / size) / 2 ** 15);
  expect(surface.sample(lng, lat, true)).toBeCloseTo(20 + STREET_LIFT_M, 4);
  expect(surface.sample(lng, lat, false)).not.toBeNull();
});

test('a wide tint follows both facets of a folded street, including triangle interiors', () => {
  const road = new Buffers();
  rectangle(road, 0, 10, 0, -10, 0);
  road.positions[2 * 3 + 2] = 10;
  const surface = new StreetSurface();
  surface.set(key, tile, packSurfaces([road], []));
  const mark = new Buffers();
  rectangle(mark, 1, 9, -2, -8, 0, true);
  const result = surface.markings(key, packMarkings([], [mark]));
  if (!result) throw new Error('Expected a registered street surface');
  expect(result.simpleCount).toBe(0);
  expect(result.indices.length).toBeGreaterThan(6);
  for (let i = 0; i < result.indices.length; i += 3) {
    const ids = Array.from(result.indices.subarray(i, i + 3));
    const mean = (axis: number) =>
      ids.reduce((sum, id) => sum + result.positions[id * 3 + axis], 0) / 3;
    expect(mean(2) + STREET_LIFT_M).toBeCloseTo(
      (surface.at(key, mean(0), mean(1), false) ?? NaN) + 0.003,
      5,
    );
  }
});

test('a completely supported planar decal keeps its original triangle count', () => {
  const road = new Buffers();
  rectangle(road, 0, 100, 0, -100, 0);
  const surface = new StreetSurface();
  surface.set(key, tile, packSurfaces([road], []));
  surface.setGround(key, (x, y) => 20 + x * 0.1 - y * 0.05);
  const mark = new Buffers();
  rectangle(mark, 20, 80, -40, -60, 0, true);
  const result = surface.markings(key, packMarkings([mark], []));
  expect(result?.indices.length).toBe(6);
  expect(result?.positions.length).toBe(12);
});

test('vehicle contact ignores an unsupported wheel instead of tilting toward the valley floor', async () => {
  const { groundPose } = await import('../engine/cityLife/groundPose');
  const plane = (x: number, y: number) => 20 + 0.1 * x - 0.05 * y;
  const pose = groundPose((x, y) => (x > 0 && y > 0 ? null : plane(x, y)), 0, 0, 0, 4, 1);
  if (!pose) throw new Error('Expected contact on the remaining deck');
  expect(pose[0]).toBeCloseTo(20, 6);
  expect(pose[1]).toBeCloseTo(0.1, 6);
  expect(pose[2]).toBeCloseTo(-0.05, 6);
  expect(groundPose(() => null, 0, 0, 0, 4, 1)).toBeNull();
});
