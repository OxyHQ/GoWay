import { describe, expect, test } from 'bun:test';
import {
  Buffers,
  LAYER,
  packSurfaces,
  subdivideSurfaces,
  STREET_LIFT_M,
  SURFACE,
} from '../engine/cityStreets/meshBuffers';
import { StreetSurface } from '../engine/cityStreets/streetSurface';
import { tileSizeMetres } from '../engine/city3d/tileMath';
import { groundPose } from '../engine/cityLife/groundPose';
import { streetCoverage, mountStreetOwnership } from '../streetOwnership.web';
import { buildLayers } from '@/lib/map/style/layers';
import { CARTOGRAPHY_PALETTES } from '@/lib/map/style/palette';
import { resolveMapStyleAsset } from '@/lib/map/provider';
import { bridgeProfile } from '../engine/cityStreets/bridgeProfile';

describe('one drawn street surface', () => {
  test('adaptive triangles follow a crest without raising the whole carriageway', () => {
    const tile = { z: 15, x: 16582, y: 12237 },
      key = '15/16582/12237';
    const b = new Buffers();
    for (const [x, y] of [
      [0, 0],
      [30, 0],
      [0, -30],
    ])
      b.vertex(x, y, 0, [0, 255, 1, 0]);
    b.triangle(0, 1, 2);
    const surface = new StreetSurface();
    surface.set(key, tile, packSurfaces([b], []));
    const ground = (x: number, y: number) =>
      20 + Math.max(0, 2 - Math.abs(x - 13) * 0.5) + 0.008 * x * y;
    surface.setGround(key, ground, { errorM: 0.015, minEdgeM: 0.25 });
    for (let x = 0.1; x < 30; x += 1)
      for (let y = -0.1; y > x - 30; y -= 1) {
        const height = surface.at(key, x, y) as number;
        expect(height).toBeGreaterThan(ground(x, y));
        expect(Math.abs(height - STREET_LIFT_M - ground(x, y))).toBeLessThan(0.015);
      }
    expect(surface.at(key, 0, 0)).toBeCloseTo(ground(0, 0) + STREET_LIFT_M);
  });
  test('a bridge spans a depression, joins its abutments and retains an upper crest', () => {
    const valley = (x: number) => 20 - 8 * Math.sin((x / 100) * Math.PI);
    const deck = bridgeProfile(
      [
        [0, 0],
        [100, 0],
      ],
      valley,
    );
    expect(deck(0, 0)).toBeCloseTo(20);
    expect(deck(100, 0)).toBeCloseTo(20);
    expect(deck(50, 0)).toBeCloseTo(20);
    expect(deck(50, 0) - valley(50)).toBeCloseTo(8);
    const crest = bridgeProfile(
      [
        [0, 0],
        [60, 0],
      ],
      (x) => 20 + Math.max(0, 5 - Math.abs(x - 30)),
    );
    expect(crest(30, 0)).toBe(25);
    expect(crest(0, 0)).toBe(20);
  });

  test('a deck clears a lateral crest while both abutments retain their crossfall', () => {
    const ground = (x: number, y: number) =>
      20 +
      0.02 * x +
      0.1 * y -
      3 * Math.sin((x / 100) * Math.PI) +
      Math.max(0, 1 - Math.abs(x - 50) / 10) * Math.max(0, y) * 2;
    const footprint: [number, number][] = [];
    for (let x = 0; x <= 100; x += 2) for (const y of [-4, 0, 4]) footprint.push([x, y]);
    const deck = bridgeProfile(
      [
        [0, 0],
        [100, 0],
      ],
      ground,
      footprint,
    );
    for (const [x, y] of footprint) expect(deck(x, y)).toBeGreaterThanOrEqual(ground(x, y) - 1e-8);
    for (const x of [0, 100])
      for (const y of [-4, 0, 4]) expect(deck(x, y)).toBeCloseTo(ground(x, y));
    expect(deck(50, 4)).toBeGreaterThan(ground(50, 0) + 5);
  });

  test('deck cross-sections stay planar beside a bank dropping away from the approach', () => {
    const ground = (x: number, y: number) =>
      20 + 0.02 * x + 0.01 * y - (Math.abs(y) > 3 ? 5 : 0) - 3 * Math.sin((x / 100) * Math.PI);
    const deck = bridgeProfile(
      [
        [0, 0],
        [100, 0],
      ],
      ground,
      [],
      [
        [
          [0, -8],
          [100, -8],
          [100, 8],
          [0, 8],
        ],
      ],
      { errorM: 0.015, minEdgeM: 0.25 },
    );
    for (const x of [0, 25, 50, 75, 100]) {
      expect(deck(x, 8) - deck(x, 0)).toBeCloseTo(0.08, 5);
      expect(deck(x, -8) - deck(x, 0)).toBeCloseTo(-0.08, 5);
    }
    expect(deck(50, 0)).toBeGreaterThan(ground(50, 0) + 2);
  });

  test('a bridge footprint resolves crests between the initial terrain samples', () => {
    const ground = (x: number, y: number) =>
      20 + 2 * Math.max(0, 1 - Math.abs(x - 3) / 2) * Math.max(0, 1 - Math.abs(y - 2) / 2);
    const deck = bridgeProfile(
      [
        [0, 0],
        [24, 0],
      ],
      ground,
      [],
      [
        [
          [0, -4],
          [24, -4],
          [24, 4],
          [0, 4],
        ],
      ],
      { errorM: 0.015, minEdgeM: 0.25 },
    );
    for (let x = 0; x <= 24; x += 0.25)
      for (let y = -4; y <= 4; y += 0.25)
        expect(deck(x, y)).toBeGreaterThanOrEqual(ground(x, y) - 0.03);
    expect(deck(0, 2)).toBe(ground(0, 2));
    expect(deck(24, 2)).toBe(ground(24, 2));
  });

  test('a bridge cut into two meshes shares its full-span height constraints', () => {
    const ground = (x: number, y: number) =>
      20 - 3 * Math.sin((x / 100) * Math.PI) + 8 * Math.max(0, 1 - Math.abs(x - 75) / 10) + 0.1 * y;
    const surface = new StreetSurface();
    for (const [key, from, to] of [
      ['left', 0, 50],
      ['right', 50, 100],
    ] as const) {
      const b = new Buffers();
      for (const [x, y] of [
        [from, -2],
        [to, -2],
        [to, -8],
        [from, -8],
      ])
        b.vertex(x, y, 0, [SURFACE.asphalt, 255, LAYER.asphalt, 1]);
      b.triangle(0, 1, 2);
      b.triangle(0, 2, 3);
      subdivideSurfaces(b, 6);
      const mesh = packSurfaces([b], []);
      mesh.bridges = [
        [
          [0, -5],
          [100, -5],
        ],
      ];
      mesh.bridgeDomains = [
        [
          [
            [0, -2],
            [100, -2],
            [100, -8],
            [0, -8],
          ],
        ],
      ];
      surface.set(key, { z: 15, x: 16580, y: 12237 }, mesh);
      surface.setGround(key, ground, { errorM: 0.015, minEdgeM: 0.25 });
    }
    expect(surface.at('left', 50, -5, true)).toBeCloseTo(
      surface.at('right', 50, -5, true) as number,
      5,
    );
    expect(surface.at('left', 50, -5, true)).toBeGreaterThan(ground(50, -5) + 3);
  });

  test('bridge and ground traffic contact different triangles at the same coordinates', () => {
    const tile = { z: 15, x: 16580, y: 12237 },
      key = '15/16580/12237';
    const b = new Buffers();
    for (const span of [0, 1]) {
      const start = b.vertexCount;
      for (const [x, y] of [
        [0, 0],
        [100, 0],
        [0, -10],
        [100, -10],
      ])
        b.vertex(x, y, 0, [SURFACE.asphalt, 255, LAYER.asphalt, span]);
      b.triangle(start, start + 1, start + 2);
      b.triangle(start + 1, start + 3, start + 2);
    }
    subdivideSurfaces(b, 6);
    const mesh = packSurfaces([b], []);
    mesh.bridges = [
      [
        [0, -5],
        [100, -5],
      ],
    ];
    const surface = new StreetSurface();
    surface.set(key, tile, mesh);
    surface.setGround(key, (x) => 20 - 8 * Math.sin((x / 100) * Math.PI));
    expect(surface.at(key, 50, -5, true)).toBeCloseTo(20 + STREET_LIFT_M);
    expect(surface.at(key, 50, -5, false)).toBeLessThan(12.1);
    surface.setGround(key, () => 30);
    expect(surface.at(key, 50, -5, true)).toBeCloseTo(30 + STREET_LIFT_M);
    surface.setGround(key, null);
    expect(surface.at(key, 50, -5, true)).toBeCloseTo(STREET_LIFT_M);
  });
  test('contact reads the rendered triangle, not a second bilinear ground surface', () => {
    const tile = { z: 15, x: 16580, y: 12237 };
    const key = '15/16580/12237';
    const size = tileSizeMetres(tile);
    const b = new Buffers();
    for (const [x, y] of [
      [0, 0],
      [size, 0],
      [0, -size],
    ])
      b.vertex(x, y, 0, [SURFACE.asphalt, 255, LAYER.asphalt, 0]);
    b.triangle(0, 1, 2);
    const surface = new StreetSurface();
    surface.set(key, tile, packSurfaces([b], []));
    surface.setGround(key, (x, y) => (((x / size) * -y) / size) * 10);
    // Bilinear at this point is 0.625 m, but all three drawn vertices are 0.
    expect(surface.at(key, size / 4, -size / 4)).toBeCloseTo(STREET_LIFT_M);
    surface.setGround(key, () => 25);
    expect(surface.at(key, size / 4, -size / 4)).toBeCloseTo(25 + STREET_LIFT_M);
    surface.delete(key);
    expect(surface.at(key, size / 4, -size / 4)).toBeNull();
  });

  test('a vehicle follows a grade and crossfall at any heading, including its centre', () => {
    const sample = (x: number, y: number) => 17 + 0.1 * x - 0.05 * y;
    for (const heading of [0, Math.PI / 4, Math.PI / 2, Math.PI]) {
      const pose = groundPose(sample, 10, 20, heading, 5, 1);
      expect(pose[0]).toBeCloseTo(17);
      expect(pose[1]).toBeCloseTo(0.1);
      expect(pose[2]).toBeCloseTo(-0.05);
    }
    const crest = groundPose((x, y) => (x === 0 && y === 0 ? 2 : 0), 0, 0, 0, 5, 1);
    expect(crest[0]).toBe(2);
  });

  test('coverage joins adjacent tiles and keeps an unloaded hole', () => {
    const tiles = Array.from({ length: 9 }, (_, i) => ({
      x: 16580 + (i % 3),
      y: 12237 + Math.floor(i / 3),
    })).filter((_, i) => i !== 4);
    const coverage = streetCoverage(tiles);
    expect(coverage.coordinates).toHaveLength(1);
    expect(coverage.coordinates[0]).toHaveLength(2);
    const joined = streetCoverage([
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ]);
    expect(joined.coordinates).toHaveLength(1);
  });

  test('basemap streets return when their replacement unloads; tunnels and rail retain their owner', () => {
    const original = ['==', ['get', 'class'], 'minor'];
    const filters = new Map<string, unknown>([['road-local', original]]);
    const map = {
      getStyle: () => ({ layers: [{ id: 'road-local' }, { id: 'road-rail' }] }),
      getLayer: () => true,
      getFilter: (id: string) => filters.get(id),
      setFilter: (id: string, filter: unknown) => filters.set(id, filter),
    };
    const owner = mountStreetOwnership(map as never);
    owner.set([{ x: 16580, y: 12237 }]);
    expect(JSON.stringify(filters.get('road-local'))).not.toContain('bridge');
    expect(filters.has('road-rail')).toBe(false);
    owner.set([]);
    expect(filters.get('road-local')).toBe(original);
    owner.remove();
  });
});

describe('cartographic place badges', () => {
  test('both appearances pair category icon and name in one collision and tap target', () => {
    for (const [theme, palette] of Object.entries(CARTOGRAPHY_PALETTES)) {
      const layers = buildLayers(palette, 'basemap');
      expect(layers.some((l) => l.id === 'poi-dot')).toBe(false);
      const poi = layers.find((l) => l.id === 'label-poi');
      if (poi?.type !== 'symbol') throw new Error('missing POI symbol');
      expect(JSON.stringify(poi.layout?.['icon-image'])).toContain(`goway-poi-${theme}-`);
      expect(poi.layout?.['icon-optional']).toBe(false);
      expect(poi.layout?.['text-optional']).toBe(false);
      expect(poi.layout?.['text-anchor']).toBe('left');
    }
  });

  test('preview styles load their matching generated assets while map data stays at its source', () => {
    const style = 'https://preview.example/map/goway-light.json';
    expect(resolveMapStyleAsset('https://goway.to/map/sprites/goway@2x.png', style)).toBe(
      'https://preview.example/map/sprites/goway@2x.png',
    );
    expect(resolveMapStyleAsset('https://goway.to/map/tiles/14/1/2.pbf', style)).toBe(
      'https://goway.to/map/tiles/14/1/2.pbf',
    );
    expect(resolveMapStyleAsset('https://example.com/map/sprites/other.png', style)).toBe(
      'https://example.com/map/sprites/other.png',
    );
  });
});
