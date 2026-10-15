/**
 * The street mesher (`engine/cityStreets/streetMesher.ts`) on a hand-made
 * crossroads: junction cuts, crossing placement, stop lines, arrows and names
 * from data only, tile ownership, and the level-of-detail ordering of the
 * index buffers. Plus the renderer's level choice (`streetLodPolicy`).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { selectLodTiles } from '@/components/map/engine/city3d/lod';
import type { DecodedRoadTile, RoadNode, RoadPiece } from '@/components/map/engine/roads/roadTiles';
import { parseTurnLanes } from '@/components/map/engine/roads/roadTiles';
import { simFrame } from '@/components/map/engine/roads/roadGraph';
import {
  Buffers,
  MODE,
  packMarkings,
  packSurfaces,
  STREET_Z_PER_M,
} from '@/components/map/engine/cityStreets/meshBuffers';
import { StreetAtlas } from '@/components/map/engine/cityStreets/streetAtlas';
import {
  meshStreetTile,
  paintableScript,
  paintedName,
  resample,
  STREET,
} from '@/components/map/engine/cityStreets/streetMesher';
import { streetLodPolicy } from '@/components/map/engine/cityStreets/streetRenderer';
import { decodeGlyphs } from '@/scripts/mapgen/glyph-pbf';

import { QUALITY_PRESETS } from '@/lib/map/quality/profile';

import { camera } from './fixtures/mapCamera';

const TILE = { x: 16580, y: 12238 };
const E = 4096;
const OX = TILE.x * E;
const OY = TILE.y * E;
/** ~0.224 m per unit here: 44 units ≈ 10 m. */
const at = (x: number, y: number): [number, number] => [OX + x, OY + y];

const road = (points: [number, number][], tags: Partial<RoadPiece> = {}): RoadPiece => ({
  way: 0,
  highway: 'secondary',
  car: true,
  foot: false,
  roundabout: false,
  tunnel: false,
  lanes: 2,
  points,
  ...tags,
});

const RHT = { drivingSide: 'right', yellowCentre: false } as const;

function glyphAtlas(): StreetAtlas {
  const atlas = new StreetAtlas();
  const file = join(
    import.meta.dir,
    '..',
    '..',
    '..',
    'public',
    'map',
    'fonts',
    'Inter Bold',
    '0-255.pbf',
  );
  for (const stack of decodeGlyphs(new Uint8Array(readFileSync(file))))
    atlas.addGlyphs(stack.glyphs);
  return atlas;
}

/** A crossroads at the tile's middle, a mapped crossing ~16 m east on the east arm. */
function crossroads(options: {
  crossing?: Partial<RoadNode>;
  crossingWay?: Partial<RoadPiece>;
  signals?: boolean;
  turns?: string;
  name?: string;
}): DecodedRoadTile {
  const c = 2048;
  const k = c + 70;
  // One OSM way east of the junction, split at the crossing node: both pieces carry its tags.
  const east: Partial<RoadPiece> = {
    name: options.name,
    ...(options.turns
      ? { lanesForward: 1, lanesBackward: 1, turnLanesBackward: parseTurnLanes(options.turns) }
      : {}),
  };
  const pieces: RoadPiece[] = [
    road([at(c, c), at(k, c)], east),
    road([at(k, c), at(3900, c)], east),
    road([at(c, c), at(200, c)], { name: options.name }),
    road([at(c, c), at(c, 200)], { highway: 'tertiary' }),
    road([at(c, c), at(c, 3900)], { highway: 'tertiary' }),
  ];
  const nodes: RoadNode[] = [];
  if (options.crossing) {
    const [x, y] = at(k, c);
    nodes.push({ kind: 'crossing', x, y, ...options.crossing });
  }
  if (options.crossingWay) {
    for (const [a, b] of [
      [at(k, c - 60), at(k, c)],
      [at(k, c), at(k, c + 60)],
    ]) {
      pieces.push(
        road([a, b], {
          highway: 'footway',
          car: false,
          foot: true,
          footway: 'crossing',
          lanes: undefined,
          ...options.crossingWay,
        }),
      );
    }
  }
  if (options.signals) {
    const [x, y] = at(c, c);
    nodes.push({ kind: 'signals', x, y });
  }
  return { pieces, nodes, restrictions: [] };
}

const mesh = (data: DecodedRoadTile, tile = TILE, atlas = new StreetAtlas()) =>
  meshStreetTile({ tile, tiles: [{ ...TILE, data }], rules: RHT, atlas });

/** Marking vertices (tile metres) of a mode, from the packed buffers. */
function markingPoints(m: ReturnType<typeof mesh>, mode: number): [number, number][] {
  const out: [number, number][] = [];
  const { positions, attrs } = m.markings;
  for (let i = 0; i < positions.length / 2; i++) {
    if (attrs[i * 4 + 1] === mode) out.push([positions[i * 2], positions[i * 2 + 1]]);
  }
  return out;
}

describe('junctions and surfaces', () => {
  test('one crossroads, cut back and filled; every triangle indexes a real vertex', () => {
    const m = mesh(crossroads({}));
    expect(m.stats.junctions).toBe(1);
    expect(m.stats.surfaceTriangles).toBeGreaterThan(20);
    const vertices = m.surfaces.positions.length / 2;
    expect(m.surfaces.attrs.length).toBe(vertices * 4);
    expect(Math.max(...m.surfaces.indices)).toBeLessThan(vertices);
    for (const v of m.surfaces.positions) expect(Number.isFinite(v)).toBe(true);
  });

  test("a surface's height is in its attr's last byte, in millimetres: the kerb's 150", () => {
    const street = road([at(200, 2048), at(3900, 2048)], { sidewalk: 'both' });
    const m = mesh({ pieces: [street], nodes: [], restrictions: [] });
    expect(m.stats.sidewalks).toBeGreaterThan(0);
    const heights = new Set<number>();
    for (let v = 0; v < m.surfaces.attrs.length / 4; v++) heights.add(m.surfaces.attrs[v * 4 + 3]);
    expect([...heights].sort((a, b) => a - b)).toEqual([0, STREET.kerbM * STREET_Z_PER_M]);
    // Markings lie on the ground: x and y only, and their last byte unused.
    const markings = m.markings;
    expect(markings.positions.length).toBe((markings.attrs.length / 4) * 2);
    for (let v = 0; v < markings.attrs.length / 4; v++) expect(markings.attrs[v * 4 + 3]).toBe(0);
  });

  test('a height the byte cannot hold is an error, never a silently wrong vertex', () => {
    const one = (z: number) => {
      const b = new Buffers();
      b.triangle(
        b.vertex(0, 0, z, [0, 0, 0]),
        b.vertex(1, 0, z, [0, 0, 0]),
        b.vertex(0, 1, z, [0, 0, 0]),
      );
      return b;
    };
    expect(packSurfaces([one(0.255)], []).attrs[3]).toBe(255);
    expect(() => packSurfaces([one(0.3)], [])).toThrow();
    expect(() => packSurfaces([one(-0.01)], [])).toThrow();
    expect(() => packMarkings([one(0.001)], [])).toThrow();
  });

  test('a tile draws only what lies in it: its neighbour draws none of this crossroads', () => {
    const neighbour = meshStreetTile({
      tile: { x: TILE.x + 1, y: TILE.y },
      tiles: [{ ...TILE, data: crossroads({ crossing: { crossing: 'zebra' }, signals: true }) }],
      rules: RHT,
      atlas: new StreetAtlas(),
    });
    expect(neighbour.stats.junctions).toBe(0);
    expect(neighbour.stats.crossings).toBe(0);
    expect(neighbour.surfaces.indices.length).toBe(0);
  });
});

describe('crossings, from data only', () => {
  test('no crossing mapped, none drawn', () => {
    expect(mesh(crossroads({})).stats.crossings).toBe(0);
  });

  test('an unmarked crossing is not painted', () => {
    expect(mesh(crossroads({ crossing: { crossing: 'unmarked' } })).stats.crossings).toBe(0);
  });

  test('a zebra at its node, bars spanning the carriageway, square to the road', () => {
    const plain = mesh(crossroads({}));
    const m = mesh(crossroads({ crossing: { crossing: 'zebra' } }));
    expect(m.stats.crossings).toBe(1);
    const lines = markingPoints(m, MODE.line);
    const before = markingPoints(plain, MODE.line);
    const metres = simFrame(TILE.x, TILE.y).metresPerUnit;
    const xNode = 2118 * metres;
    const yRoad = -2048 * metres;
    // Line points are centre points: the centre line's lie on the road's axis,
    // a bar's are off it.
    const fresh = lines.filter(([x, y]) => Math.abs(y - yRoad) > 0.5 && Math.abs(x - xNode) < 3);
    expect(before.filter(([x, y]) => Math.abs(y - yRoad) > 0.5 && Math.abs(x - xNode) < 3)).toEqual(
      [],
    );
    // Every new line point lies within the 3 m crossing around the node…
    for (const [x] of fresh) expect(Math.abs(x - xNode)).toBeLessThan(1.6 + 0.2);
    // …and the bars (centres 1 m apart) reach across the carriageway (two 3.25 m lanes).
    const ys = fresh.map(([, y]) => y - yRoad);
    expect(Math.max(...ys)).toBeGreaterThan(2.4);
    expect(Math.min(...ys)).toBeLessThan(-2.4);
  });

  test('a crossing way’s markings count when the node has none (New York records them there)', () => {
    const m = mesh(
      crossroads({
        crossing: { crossing: 'traffic_signals' },
        crossingWay: { crossingMarkings: 'zebra' },
      }),
    );
    expect(m.stats.crossings).toBe(1);
  });

  test('a stop line where a signal is recorded, and only there', () => {
    expect(mesh(crossroads({ crossing: { crossing: 'zebra' } })).stats.stopLines).toBe(0);
    const m = mesh(crossroads({ crossing: { crossing: 'zebra' }, signals: true }));
    // One per approach of each arm at the signalled junction.
    expect(m.stats.stopLines).toBe(4);
  });
});

describe('arrows, words and names', () => {
  test('arrows only from recorded turn lanes', () => {
    expect(mesh(crossroads({ signals: true })).stats.arrows).toBe(0);
    const m = mesh(crossroads({ signals: true, turns: 'left' }));
    expect(m.stats.arrows).toBeGreaterThan(0);
  });

  test('a name is painted on a long straight link, in the map’s glyphs', () => {
    const m = mesh(crossroads({ name: 'Carrer de Mallorca' }), TILE, glyphAtlas());
    expect(m.stats.names).toBeGreaterThan(0);
    // Without its glyphs, never drawn with holes.
    expect(mesh(crossroads({ name: 'Carrer de Mallorca' })).stats.names).toBe(0);
  });

  test('arrows and letters are full detail: after the simple level in the index buffer', () => {
    const m = mesh(
      crossroads({ signals: true, turns: 'left', name: 'Carrer de Mallorca' }),
      TILE,
      glyphAtlas(),
    );
    const { indices, attrs, simpleCount } = m.markings;
    expect(simpleCount).toBeGreaterThan(0);
    expect(simpleCount).toBeLessThan(indices.length);
    for (let i = 0; i < indices.length; i++) {
      const sdf = attrs[indices[i] * 4 + 1] === MODE.sdf;
      expect(sdf).toBe(i >= simpleCount);
    }
  });

  test('names as painted: upper case, US suffixes abbreviated; scripts that need shaping skipped', () => {
    expect(paintedName('6th Avenue')).toBe('6TH AVE');
    expect(paintedName('Passeig de Gràcia')).toBe('PASSEIG DE GRÀCIA');
    expect(paintedName('Avenue')).toBe('AVENUE');
    expect(paintableScript('Carrer de Mallorca')).toBe(true);
    expect(paintableScript('明治通り')).toBe(true);
    expect(paintableScript('شارع')).toBe(false);
  });
});

describe('geometry helpers', () => {
  test('resampling keeps every vertex and caps each step', () => {
    const out = resample(
      [
        [0, 0],
        [20, 0],
        [20, 3],
      ],
      6,
    );
    expect(out[0]).toEqual([0, 0]);
    expect(out.at(-1)).toEqual([20, 3]);
    expect(out).toContainEqual([20, 0]);
    for (let i = 1; i < out.length; i++) {
      expect(Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1])).toBeLessThanOrEqual(
        6,
      );
    }
  });
});

describe('levels of detail', () => {
  const at = (zoom: number, pitch = 0) => {
    const view = camera({ lng: 2.164, lat: 41.3925, zoom, pitch });
    return selectLodTiles(
      view,
      15,
      streetLodPolicy(41.3925, QUALITY_PRESETS.high.streets.maxTiles),
    ).filter((t) => t.lod < 2);
  };
  test('full detail from z17, simplified at z16, none below', () => {
    expect(at(17.5).length).toBeGreaterThan(0);
    expect(at(17.5).every((t) => t.lod === 0)).toBe(true);
    const z16 = at(16.4);
    expect(z16.length).toBeGreaterThan(0);
    expect(z16.every((t) => t.lod === 1)).toBe(true);
    expect(at(15.5)).toEqual([]);
  });

  test('pitched, the far tiles step down to the simplified level', () => {
    const tiles = at(17.2, 60);
    expect(tiles.some((t) => t.lod === 0)).toBe(true);
    expect(tiles.some((t) => t.lod === 1)).toBe(true);
  });

  test('at a road archive’s edge, unpublished tiles never take a published one’s place', () => {
    const view = camera({ lng: 2.164, lat: 41.3925, zoom: 17.2, pitch: 60 });
    const every = selectLodTiles(view, 15, streetLodPolicy(41.3925, 99));
    expect(every.length).toBeGreaterThanOrEqual(4);
    // A budget one short of the view, and its two nearest tiles unpublished.
    const policy = streetLodPolicy(41.3925, every.length - 1);
    const nearest = new Set(every.slice(0, 2).map((t) => `${t.x}/${t.y}`));
    const published = selectLodTiles(
      view,
      15,
      policy,
      undefined,
      (t) => !nearest.has(`${t.x}/${t.y}`),
    );
    // Every published tile in view is drawn — not the budget minus the two
    // unpublished ones a filter after selection would have left.
    expect(published.length).toBe(every.length - 2);
    expect(published.some((t) => nearest.has(`${t.x}/${t.y}`))).toBe(false);
  });
});

describe('schema 3: cycle tracks and painted-name spans', () => {
  test('a separate cycleway is drawn as a tinted track', () => {
    const data = crossroads({});
    data.pieces.push(
      road([at(300, 300), at(1500, 300)], {
        highway: 'cycleway',
        car: false,
        foot: false,
        cycle: true,
        lanes: undefined,
        width: 2.5,
      }),
    );
    const m = mesh(data);
    expect(m.stats.cycleways).toBe(1);
    expect(mesh(crossroads({})).stats.cycleways).toBe(0);
  });

  test('every painted name reports where it lies, along its text, inside the tile', () => {
    const m = mesh(crossroads({ name: 'Carrer de Mallorca' }), TILE, glyphAtlas());
    expect(m.stats.names).toBeGreaterThan(0);
    expect(m.paintedNames.length).toBeGreaterThan(m.stats.names);
    const size = simFrame(TILE.x, TILE.y).metresPerUnit * 4096;
    for (const [x, y] of m.paintedNames) {
      expect(x).toBeGreaterThan(-5);
      expect(x).toBeLessThan(size + 5);
      // On the east–west street's axis (the name sits in a lane of it).
      expect(Math.abs(y - -2048 * simFrame(TILE.x, TILE.y).metresPerUnit)).toBeLessThan(6);
    }
    expect(mesh(crossroads({})).paintedNames).toEqual([]);
  });
});
