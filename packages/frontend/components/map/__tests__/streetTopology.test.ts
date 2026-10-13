import { describe, expect, test } from 'bun:test';
import { Buffers, SURFACE } from '../engine/cityStreets/meshBuffers';
import { StreetTopology } from '../engine/cityStreets/surfaceTopology';

const rectangle = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];
const area = (buffer: Buffers, material: number, span = 0) => {
  let result = 0;
  for (let i = 0; i < buffer.indices.length; i += 3) {
    const ids = buffer.indices.slice(i, i + 3);
    if (buffer.attrs[ids[0] * 4] !== material || buffer.attrs[ids[0] * 4 + 3] !== span) continue;
    const [a, b, c] = ids.map((id) => buffer.positions.slice(id * 3, id * 3 + 3));
    result += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  }
  return result;
};

describe('one partition of street space', () => {
  test('overlapping streets dissolve once; sidewalk and paving occupy only the remaining space', () => {
    const t = new StreetTopology(50, 12),
      surface = new Buffers(),
      faces = new Buffers();
    t.add(rectangle(5, -5, 15, -15), 0, SURFACE.asphalt, 0);
    t.add(rectangle(10, -5, 20, -15), 0, SURFACE.asphalt, 0);
    t.add(rectangle(0, 0, 20, -20), 0.15, SURFACE.sidewalk, 0);
    t.add(rectangle(0, 0, 25, -20), 0, SURFACE.paving, 0);
    // Exactly the same position, another level: the bridge remains a bridge.
    t.add(rectangle(5, -5, 15, -15), 0, SURFACE.asphalt, 1);
    t.build(surface, faces);
    expect(area(surface, SURFACE.asphalt)).toBeCloseTo(150);
    expect(area(surface, SURFACE.sidewalk)).toBeCloseTo(250);
    expect(area(surface, SURFACE.paving)).toBeCloseTo(100);
    expect(area(surface, SURFACE.asphalt, 1)).toBeCloseTo(100);
    expect(faces.positions.some((z, i) => i % 3 === 2 && z < 0)).toBe(true);
  });

  test('a real island survives the union and tile clipping never invents a kerb', () => {
    const t = new StreetTopology(10, 4),
      surface = new Buffers(),
      faces = new Buffers();
    for (const ring of [
      rectangle(-2, 0, 12, -2),
      rectangle(-2, -8, 12, -10),
      rectangle(0, 0, 2, -10),
      rectangle(8, 0, 10, -10),
    ]) {
      t.add(ring, 0.15, SURFACE.sidewalk, 0);
    }
    t.build(surface, faces);
    expect(area(surface, SURFACE.sidewalk)).toBeCloseTo(64);
    for (let i = 0; i < faces.positions.length; i += 3) {
      const x = faces.positions[i],
        y = faces.positions[i + 1];
      expect(x > 0 && x < 10 && y < 0 && y > -10).toBe(true);
    }
    // The four inside boundaries only; no faces on artificial tessellation seams.
    expect(faces.indices.length).toBe(4 * 6);
  });

  test('neighbouring tiles own complementary parts of a crossing surface', () => {
    const a = new StreetTopology(30, 12),
      b = new StreetTopology(30, 12);
    a.add(rectangle(-10, -10, 50, -20), 0, SURFACE.asphalt, 0);
    b.add(rectangle(-40, -10, 20, -20), 0, SURFACE.asphalt, 0);
    const aa = new Buffers(),
      bb = new Buffers();
    a.build(aa, new Buffers());
    b.build(bb, new Buffers());
    expect(area(aa, SURFACE.asphalt)).toBeCloseTo(300);
    expect(area(bb, SURFACE.asphalt)).toBeCloseTo(200);
    for (const buffer of [aa, bb])
      for (let i = 0; i < buffer.positions.length; i += 3) {
        expect(buffer.positions[i]).toBeGreaterThanOrEqual(0);
        expect(buffer.positions[i]).toBeLessThanOrEqual(30);
      }
  });
});
