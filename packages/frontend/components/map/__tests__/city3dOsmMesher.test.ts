/**
 * The OSM city-tile mesher (`engine/city3d/osmMesher.ts`) and the decoder's
 * defence against bad properties (`osmTiles.ts`): whole buildings, roofs that
 * meet their walls, colour weights, and — the honesty rule — openings only
 * where storeys are recorded, and never on a wall a neighbour stands against.
 */
import { describe, expect, test } from 'bun:test';

import { bayCount, COLOUR_WEIGHT, facadeFor } from '@/components/map/engine/city3d/facades';
import type { Point2 } from '@/components/map/engine/city3d/mesher';
import { meshOsmBuildings, type OsmTileMesh } from '@/components/map/engine/city3d/osmMesher';
import { buildingFromProperties, type OsmBuilding } from '@/components/map/engine/city3d/osmTiles';

/** One tile unit is one metre, so footprints read in metres. */
const OPTIONS = { extent: 4096, tileSizeMetres: 4096 };

/** A box in TILE units (y down), exterior positive per the MVT rule. */
function box(x0: number, y0: number, w: number, h: number): Point2[] {
  return [
    [x0, y0],
    [x0 + w, y0],
    [x0 + w, y0 + h],
    [x0, y0 + h],
  ];
}

function building(overrides: Partial<OsmBuilding> = {}): OsmBuilding {
  return { id: 12, rings: [box(0, 0, 20, 10)], top: 12, base: 0, ...overrides };
}

function mesh(buildings: OsmBuilding[]): OsmTileMesh {
  const result = meshOsmBuildings(buildings, OPTIONS);
  if (!result) throw new Error('nothing meshed');
  return result;
}

function vertices(m: OsmTileMesh) {
  const out = [];
  for (let v = 0; v < m.positions.length / 3; v++) {
    out.push({
      x: m.positions[v * 3],
      y: m.positions[v * 3 + 1],
      z: m.positions[v * 3 + 2],
      nx: m.normals[v * 3] / 127,
      nz: m.normals[v * 3 + 2] / 127,
      weight: m.colors[v * 4 + 3],
      rgb: [m.colors[v * 4], m.colors[v * 4 + 1], m.colors[v * 4 + 2]],
      facade: [...m.facade.subarray(v * 4, v * 4 + 4)],
    });
  }
  return out;
}

describe('meshOsmBuildings', () => {
  test('a flat building: whole, from base to top, consistent buffers', () => {
    const m = mesh([building()]);
    const vs = vertices(m);
    expect(Math.max(...vs.map((v) => v.z))).toBeCloseTo(12, 4);
    expect(Math.min(...vs.map((v) => v.z))).toBe(0);
    expect(m.bounds.max[0]).toBeCloseTo(20, 4);
    expect(m.bounds.min[1]).toBeCloseTo(-10, 4); // y north: the tile's rows run south
    const count = m.positions.length / 3;
    expect(m.colors.length).toBe(count * 4);
    expect(m.facade.length).toBe(count * 4);
    expect(Math.max(...m.indices)).toBeLessThan(count);
    expect(m.indices.length % 3).toBe(0);
  });

  test('no recorded storeys, no openings — anywhere', () => {
    const vs = vertices(mesh([building()]));
    expect(vs.every((v) => v.facade.every((value) => value === 0))).toBe(true);
  });

  test('recorded storeys put the count, and only the count, on the walls', () => {
    const vs = vertices(mesh([building({ levels: 4, top: 4 * 3 })]));
    const walls = vs.filter((v) => v.facade[3] > 0);
    expect(walls.length).toBeGreaterThan(0);
    for (const v of walls) {
      expect(v.facade[3]).toBe(4);
      expect(v.facade[2]).toBe(300); // 3 m storeys, in centimetres
      expect(Math.abs(v.nz)).toBeLessThan(0.01); // walls only
    }
    // The roof carries none.
    expect(vs.filter((v) => v.nz > 0.99).every((v) => v.facade[3] === 0)).toBe(true);
  });

  test('a count that cannot fit the height is not drawn as one', () => {
    const vs = vertices(mesh([building({ levels: 10, top: 6 })]));
    expect(vs.every((v) => v.facade[3] === 0)).toBe(true);
  });

  test('a party wall is blind; the street walls are not', () => {
    // Two houses sharing the edge x = 20 (the same two tile-unit points).
    const left = building({ id: 1, levels: 4, top: 12 });
    const right = building({ id: 2, rings: [box(20, 0, 20, 10)], levels: 4, top: 12 });
    const vs = vertices(mesh([left, right]));
    // Walls ON the shared edge face east or west (the corner vertices of the
    // street walls also sit at x = 20, facing north or south).
    const onShared = vs.filter((v) => Math.abs(v.x - 20) < 1e-6 && Math.abs(v.nx) > 0.99);
    expect(onShared.length).toBeGreaterThan(0);
    expect(onShared.every((v) => v.facade[3] === 0)).toBe(true);
    const street = vs.filter((v) => Math.abs(v.y) < 1e-6 && Math.abs(v.nz) < 0.01);
    expect(street.some((v) => v.facade[3] === 4)).toBe(true);
  });

  test('a part stacked ON another keeps its openings (the edge is shared, the heights are not)', () => {
    const podium = building({ id: 1, levels: 2, top: 6 });
    const tower = building({ id: 2, base: 6, top: 18, levels: 6, minLevel: 2 });
    const vs = vertices(mesh([podium, tower]));
    expect(vs.some((v) => v.z > 6 && v.facade[3] === 4)).toBe(true);
  });

  test('gabled: the ridge reaches the top, the gable walls rise to meet it', () => {
    const m = mesh([building({ top: 10, roof: { shape: 'gabled', height: 4, across: false } })]);
    const vs = vertices(m);
    expect(Math.max(...vs.map((v) => v.z))).toBeCloseTo(10, 4);
    // A WALL vertex (horizontal normal) at the ridge height: the gable apex.
    const apex = vs.filter((v) => Math.abs(v.nz) < 0.01 && Math.abs(v.z - 10) < 1e-3);
    expect(apex.length).toBeGreaterThan(0);
    // Eaves are at 6 m along the long walls.
    const eaves = vs.filter((v) => Math.abs(v.nz) < 0.01 && v.z > 0 && Math.abs(v.y) < 1e-6);
    expect(eaves.every((v) => Math.abs(v.z - 6) < 1e-3)).toBe(true);
    // Roof faces slope (not flat, not vertical) and face up.
    const roof = vs.filter((v) => v.nz > 0.1 && v.nz < 0.99);
    expect(roof.length).toBeGreaterThan(0);
  });

  test('every planar shape builds, and none pokes above its top', () => {
    for (const shape of [
      'skillion',
      'gabled',
      'saltbox',
      'hipped',
      'half-hipped',
      'pyramidal',
      'gambrel',
      'mansard',
      'round',
    ] as const) {
      const m = mesh([building({ top: 10, roof: { shape, height: 4, across: false } })]);
      expect(m.bounds.max[2]).toBeLessThanOrEqual(10 + 1e-4);
      expect(m.bounds.max[2]).toBeGreaterThan(9.9);
    }
  });

  test('a dome on a round footprint rises to the top; over a courtyard it becomes a pyramid', () => {
    const round: Point2[] = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * 2 * Math.PI; // positive shoelace in tile units = exterior
      round.push([50 + 8 * Math.cos(a), 50 + 8 * Math.sin(a)]);
    }
    const dome = mesh([
      {
        id: 3,
        rings: [round],
        top: 20,
        base: 0,
        roof: { shape: 'dome', height: 8, across: false },
      },
    ]);
    expect(dome.bounds.max[2]).toBeCloseTo(20, 3);
    const courtyard = mesh([
      building({
        rings: [box(0, 0, 20, 20), box(8, 8, 4, 4).reverse()],
        top: 10,
        roof: { shape: 'dome', height: 4, across: false },
      }),
    ]);
    expect(courtyard.bounds.max[2]).toBeLessThanOrEqual(10 + 1e-4);
  });

  test('a tagged colour outweighs a material; untagged is the ramp', () => {
    const tagged = vertices(mesh([building({ colour: 0xff0000 })]));
    expect(
      tagged.filter((v) => Math.abs(v.nz) < 0.01).every((v) => v.weight === COLOUR_WEIGHT.tagged),
    ).toBe(true);
    expect(tagged.find((v) => Math.abs(v.nz) < 0.01)?.rgb).toEqual([255, 0, 0]);
    const material = vertices(mesh([building({ material: 'brick', roofMaterial: 'slate' })]));
    expect(material.every((v) => v.weight === COLOUR_WEIGHT.material)).toBe(true);
    const plain = vertices(mesh([building()]));
    expect(plain.every((v) => v.weight === 0)).toBe(true);
  });

  test('a building with a hole keeps it', () => {
    const m = mesh([building({ rings: [box(0, 0, 30, 30), box(10, 10, 10, 10).reverse()] })]);
    // A wall faces into the courtyard: some wall vertex sits on x = 10 inside the outer.
    const vs = vertices(m);
    expect(
      vs.some((v) => Math.abs(v.x - 10) < 1e-6 && v.y < -10 && v.y > -20 && Math.abs(v.nz) < 0.01),
    ).toBe(true);
  });

  test('an empty tile meshes to null', () => {
    expect(meshOsmBuildings([], OPTIONS)).toBeNull();
  });
});

describe('buildingFromProperties (untrusted tile properties)', () => {
  const rings = [box(0, 0, 10, 10)];

  test('good values come through', () => {
    const b = buildingFromProperties(5, rings, {
      render_height: 20,
      render_min_height: 4,
      levels: 5,
      roof_shape: 'hipped',
      roof_height: 3,
      colour: '#112233',
      material: 'glass',
    });
    expect(b).toMatchObject({ top: 20, base: 4, levels: 5, colour: 0x112233, material: 'glass' });
    expect(b.roof).toEqual({ shape: 'hipped', height: 3, direction: undefined, across: false });
  });

  test('bad values are dropped, not believed', () => {
    const b = buildingFromProperties(5, rings, {
      render_height: 'tall',
      render_min_height: 99,
      levels: 2.5,
      min_level: -1,
      roof_shape: 'spiky',
      roof_height: 3,
      colour: 'red',
      roof_colour: '#12345',
      material: 'cardboard',
    });
    expect(b.top).toBe(5);
    expect(b.base).toBe(0);
    expect(b.levels).toBeUndefined();
    expect(b.minLevel).toBeUndefined();
    expect(b.roof).toBeUndefined();
    expect(b.colour).toBeUndefined();
    expect(b.roofColour).toBeUndefined();
    expect(b.material).toBeUndefined();
  });

  test('a roof cannot be taller than its building', () => {
    const b = buildingFromProperties(5, rings, {
      render_height: 6,
      roof_shape: 'gabled',
      roof_height: 40,
    });
    expect(b.roof?.height).toBe(6);
  });
});

describe('facade rules', () => {
  test('a rhythm only from a recorded count that fits the height', () => {
    expect(facadeFor(undefined, undefined, 0, 12)).toBeNull();
    expect(facadeFor(0, undefined, 0, 12)).toBeNull();
    expect(facadeFor(4, undefined, 0, 12)).toEqual({ base: 0, storey: 3, count: 4 });
    expect(facadeFor(8, 3, 11, 29)).toEqual({ base: 11, storey: 3.6, count: 5 });
    expect(facadeFor(3, 3, 0, 12)).toBeNull();
    expect(facadeFor(2, undefined, 0, 40)).toBeNull(); // 20 m storeys: the data disagrees
  });

  test('facades divide into whole bays; slivers get none', () => {
    expect(bayCount(1.5)).toBe(0);
    expect(bayCount(2)).toBe(1);
    expect(bayCount(16)).toBe(5);
  });
});
